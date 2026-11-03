/**
 * Who is in the room, read by the model rather than by a regex.
 *
 * "I'm Craig" is a pattern and the session applies it the instant the turn
 * lands (`speakerIntroductions.ts`). What a pattern cannot read is the room
 * fixing the transcription: "And I'm EJ" came back as `AJ` and Craig's "No,
 * that was EJ" went nowhere (`2026-11-03_0945-mic`); "it's E, J", "you got
 * her name wrong" and "EJ with an E" are all things people say.
 *
 * So this makes **one** model call once the introductions have settled —
 * {@link INTRO_SETTLE_MS} after the first human turn, or sooner when
 * {@link INTRO_SETTLE_TURNS} have gone by — with every turn so far and the
 * names the patterns already gave, and applies what comes back. After that
 * it only calls again when a turn looks like it is about a name
 * ({@link aboutAName}): somebody's current name said in it, "name" in its
 * first few words, or a correction shape. One or two calls a meeting, never
 * one per turn, and never one in the way of anything the room is waiting on.
 */
import { z } from "zod";
import type { SpeakerNames } from "../../shared/events.js";
import { isSottoTurn, type TurnUpdate } from "../../shared/turns.js";
import type { Clock } from "../clock.js";
import type { ModelClient } from "../model/client.js";
import { loadPrompt, PROMPTS } from "../prompts/index.js";
import { DEFAULT_WAKE_SPELLINGS } from "../wake.js";
import { correctedName } from "./speakerIntroductions.js";

/** How long after the first human turn the introductions are read. */
export const INTRO_SETTLE_MS = 30_000;
/** Or how many human turns, whichever comes first. */
export const INTRO_SETTLE_TURNS = 6;
/** How many of the latest turns a later check is shown. */
export const INTRO_RECENT_TURNS = 8;
/** The least time between two checks, so a run of name talk is one call. */
export const INTRO_MIN_GAP_MS = 8_000;
/** The call's own deadline, on the wall clock: nothing waits on it, but a stuck call must end. */
export const INTRO_TIMEOUT_MS = 20_000;

export const IntroductionsSchema = z.object({
  speakers: z.array(
    z.object({
      label: z.string().trim(),
      name: z.string().trim(),
    }),
  ),
});
export type Introductions = z.infer<typeof IntroductionsSchema>;

/** Strict structured output: closed objects, everything required, no lengths. */
export const introductionsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["speakers"],
  properties: {
    speakers: {
      type: "array",
      description: "One entry per label shown, in the order shown.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "name"],
        properties: {
          label: { type: "string", description: "The voice label exactly as shown: A, B, C…" },
          name: {
            type: "string",
            description:
              "This person's name as the transcript gives it, corrections applied; an empty string when nobody has said it.",
          },
        },
      },
    },
  },
} as const;

export interface IntroductionReaderOptions {
  clock: Clock;
  /** Real time, for the deadline; the session clock stands still inside a tracked call in a replay. */
  wallClock: Clock;
  model: ModelClient;
  /** The names as they stand, which the model is told and may change. */
  speakers: () => SpeakerNames;
  /** Applies one name; the session's own `renameSpeaker`. */
  rename: (label: string, name: string) => void;
  onTiming?: (event: Record<string, unknown>) => void;
  logger?: Pick<Console, "log" | "warn">;
}

export class IntroductionReader {
  private readonly turns: TurnUpdate[] = [];
  private firstAtMs: number | null = null;
  private settled = false;
  private cancelSettle: (() => void) | undefined;
  private inFlight: Promise<void> | undefined;
  private lastCallAtMs = Number.NEGATIVE_INFINITY;
  private stopped = false;
  private readonly logger: Pick<Console, "log" | "warn">;

  constructor(private readonly options: IntroductionReaderOptions) {
    this.logger = options.logger ?? console;
  }

  /** Reads one final human turn. */
  acceptTurn(turn: TurnUpdate): void {
    if (this.stopped || !turn.final || isSottoTurn(turn) || turn.speaker === null) return;
    if (this.turns.some((one) => one.turnId === turn.turnId)) return;
    this.turns.push(turn);
    const now = this.options.clock.now();
    if (!this.settled) {
      if (this.firstAtMs === null) {
        this.firstAtMs = now;
        this.cancelSettle = this.options.clock.setTimeout(() => this.settle("time"), INTRO_SETTLE_MS);
      }
      if (this.turns.length >= INTRO_SETTLE_TURNS) this.settle("turns");
      return;
    }
    if (aboutAName(turn.text, this.options.speakers())) this.check("mentioned", this.turns.slice(-INTRO_RECENT_TURNS));
  }

  /** The session is over; a verdict still on its way changes nothing. */
  stop(): void {
    this.stopped = true;
    this.cancelSettle?.();
  }

  /** Waits for a check in flight, for replays and tests. */
  async flush(): Promise<void> {
    await this.inFlight;
  }

  private settle(why: "time" | "turns"): void {
    if (this.settled || this.stopped) return;
    this.settled = true;
    this.cancelSettle?.();
    this.check(why, [...this.turns]);
  }

  private check(why: string, turns: readonly TurnUpdate[]): void {
    if (this.stopped || turns.length === 0) return;
    if (this.inFlight !== undefined) return;
    const now = this.options.clock.now();
    if (now - this.lastCallAtMs < INTRO_MIN_GAP_MS) return;
    this.lastCallAtMs = now;
    const labels = [...new Set(turns.map((turn) => turn.speaker as string))];
    const before = this.options.speakers();
    const started = this.options.wallClock.now();
    const run = this.call(turns, labels, before).then(
      (result) => {
        if (this.stopped) return;
        let changed = 0;
        for (const entry of result.speakers) {
          if (!labels.includes(entry.label)) continue;
          const name = cleanName(entry.name);
          if (name === "" || name === (before[entry.label] ?? "")) continue;
          this.options.rename(entry.label, name);
          changed += 1;
        }
        this.logger.log(`[introductions] read ${labels.length} voices (${why}): ${changed} name${changed === 1 ? "" : "s"} changed`);
        this.options.onTiming?.({
          stage: "introductions", atMs: this.options.clock.now(), why, labels, changed,
          latencyMs: this.options.wallClock.now() - started,
          names: Object.fromEntries(result.speakers.map((entry) => [entry.label, cleanName(entry.name)])),
        });
      },
      (error: unknown) => {
        this.logger.warn(`[introductions] could not read who is here: ${error instanceof Error ? error.message : String(error)}`);
        this.options.onTiming?.({
          stage: "introductions", atMs: this.options.clock.now(), why, labels, failed: true,
          latencyMs: this.options.wallClock.now() - started,
        });
      },
    );
    this.inFlight = run.finally(() => {
      this.inFlight = undefined;
    });
    void this.options.clock.track("introductions", this.inFlight);
  }

  private async call(
    turns: readonly TurnUpdate[],
    labels: readonly string[],
    before: SpeakerNames,
  ): Promise<Introductions> {
    const controller = new AbortController();
    const cancel = this.options.wallClock.setTimeout(() => controller.abort(), INTRO_TIMEOUT_MS);
    try {
      const value = await Promise.race([
        this.options.model.structured({
          label: "introductions",
          system: loadPrompt(PROMPTS.introductions),
          user: renderIntroductionsRequest(turns, labels, before),
          schemaName: "introductions",
          schema: introductionsJsonSchema,
          reasoningEffort: "low",
          maxTokens: 2_000,
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
        }),
      ]);
      return IntroductionsSchema.parse(value);
    } finally {
      cancel();
    }
  }
}

/** What the model is shown: the names so far, then the turns with their labels. */
export function renderIntroductionsRequest(
  turns: readonly TurnUpdate[],
  labels: readonly string[],
  before: SpeakerNames,
): string {
  const known = labels.map((label) => `${label}: ${before[label] ?? "(no name yet)"}`).join("\n");
  const lines = turns.map((turn) => `${turn.speaker}: ${turn.text.trim()}`).join("\n");
  return `Labels and the names so far:\n${known}\n\nThe turns, in order:\n${lines}`;
}

/**
 * Whether a turn is worth a second look at the names: it says somebody's
 * current name, says "name" near its start, or has the shape of a correction.
 */
export function aboutAName(text: string, speakers: SpeakerNames): boolean {
  if (correctedName(text) !== null) return true;
  const words = text.toLowerCase().match(/[\p{L}\p{N}'’]+/gu) ?? [];
  if (words.slice(0, 8).some((word) => word === "name" || word === "names" || word === "name's")) return true;
  const names = Object.values(speakers).map((name) => name.toLowerCase());
  return words.some((word) => names.includes(word));
}

/** A name the model gives, or "" when it gave a label, the wake word or nothing. */
function cleanName(name: string): string {
  const trimmed = name.trim().replace(/^["'“‘]|["'”’.]$/gu, "");
  if (trimmed === "" || /^[A-Z]$/.test(trimmed)) return "";
  if (DEFAULT_WAKE_SPELLINGS.includes(trimmed.toLowerCase())) return "";
  if (trimmed.split(/\s+/).length > 3) return "";
  return trimmed;
}
