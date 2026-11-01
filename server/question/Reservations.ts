/**
 * Claiming the question out loud (PRD V3-015).
 *
 *     open_question -> search starts (V3-003)
 *                   -> first gap within 5 s -> "I'll check the drive time."
 *                   -> no gap            -> nothing said; the card is the sign
 *
 *     the search came back with nothing -> next gap -> "Nothing solid on the
 *                                                      drive time, sorry."
 *
 * The point is social rather than technical: somebody wonders something
 * aloud, and a colleague who is about to look it up says so, which is what
 * stops everybody else reaching for a phone. So the line has to arrive while
 * the question is still what the room is thinking about — hence
 * {@link RESERVE_WINDOW_MS}, five seconds, after which the claim is simply
 * dropped. The answer still follows (V3-004); only the claim expires.
 *
 * Four decisions worth knowing about.
 *
 * **The words are written here, not asked for.** The classifier already
 * produced a three-to-five-word `topic` for exactly this sentence (V3-002), so
 * a reservation costs no model call and no waiting — which is the whole of why
 * it can be said inside five seconds.
 *
 * **It waits for a gap, the policy's own gap.** {@link inPause} on the
 * corrected silence, read off the same getter interjections and research cards
 * use, so Sotto's own voice playing counts as somebody talking (V2-006). The
 * gap is *armed* the way the policy arms its re-checks: a timer for the rest
 * of the pause while the room is quiet, and nothing at all while somebody is
 * talking, because the turn closing is what arrives next.
 *
 * **It is the contribution, and the answer is its completion.** One spend
 * against the frequency's cooldown and allowance (V2-017), taken at the moment
 * the claim is actually made — a reservation nobody could hear (muted, no page
 * attached) spends nothing, because nothing was heard.
 *
 * **It yields to any human voice and is never retried.** The first human
 * partial the echo filter lets through cancels the utterance
 * ({@link Reservations.yieldToHuman}); what the room heard of it still goes
 * into the transcript, and the claim is over. Being talked over while saying
 * "I'll check that" is the room telling Sotto it has the floor back.
 */
import { sottoTurn, type PauseState, type TurnUpdate } from "../../shared/turns.js";
import { RESEARCH_NO_ANSWER, type ResearchIdea } from "../../shared/research.js";
import type { PolicySettings } from "../../shared/policy.js";
import type { Clock } from "../clock.js";
import { PAUSE_MS, inPause } from "../interject/policy.js";
import type { SpendVerdict } from "../interject/policy.js";
import type { VoiceOut, VoiceSpoken, VoiceUtterance } from "../voice/voiceOut.js";

type Logger = Pick<Console, "log" | "warn">;

/**
 * How long after the classifier's verdict a reservation is still worth saying.
 *
 * Five seconds, the PRD's number: a claim on a question is about *this*
 * moment in the conversation, and "I'll check the drive time" ten seconds
 * later is Sotto raising a topic rather than reserving one — which is the
 * interruption V3-004 exists to avoid. The search is already running either
 * way, so nothing is lost but the sentence.
 */
export const RESERVE_WINDOW_MS = 5_000;

/** The label a reservation's speech is tracked under on the clock. */
export const RESERVE_TRACK_LABEL = "reserve";

/** The kinds of unprompted line this module says; V3-004 adds the answer. */
export const spokenContributionKinds = ["reserve", "no_answer"] as const;
export type SpokenContributionKind = (typeof spokenContributionKinds)[number];

/**
 * Why a reservation was not said, for `timing.jsonl`.
 *
 * - `boldness`: a `cautious` session, which contributes on screen only.
 * - `cooldown` / `budget`: the frequency setting's, spent on something else.
 * - `no_gap`: nobody stopped talking inside {@link RESERVE_WINDOW_MS}.
 * - `unheard`: muted, or no page attached to play it — the card is the sign.
 * - `moved_on`: the closing line only; the room is somewhere else now.
 * - `overtaken`: the search came back with nothing before the claim could be
 *   made, so there is nothing left to claim.
 * - `session_ended`: still waiting for a gap when the conversation stopped.
 */
export const reserveSkipReasons = [
  "boldness",
  "cooldown",
  "budget",
  "no_gap",
  "unheard",
  "moved_on",
  "overtaken",
  "session_ended",
] as const;
export type ReserveSkipReason = (typeof reserveSkipReasons)[number];

/** One `spoken_contribution` line of `timing.jsonl` (V3-015). */
export interface SpokenContributionRecord {
  stage: "spoken_contribution";
  kind: SpokenContributionKind;
  /** When it was said, or when it was given up on, on the session clock. */
  atMs: number;
  ideaId: string;
  /** The turn the question was heard in. */
  turnId: string;
  topic: string;
  /**
   * Whether it was said at all: an utterance was opened and the words handed
   * to the voice. What the room got of it is {@link heard}.
   */
  spoken: boolean;
  /** The words, whether or not they were said. */
  text: string;
  /**
   * The question turn going final to the first audio of this line, on the
   * session clock. Only on a line that was really said.
   */
  questionToReserveMs?: number;
  /** True when a human voice cut it off (V3-004's rule). */
  yielded?: boolean;
  /** What the room actually heard, when that is less than {@link text}. */
  heard?: string;
  /** Why nothing was said, when nothing was. */
  reason?: ReserveSkipReason;
}

export interface ReservationsOptions {
  /** The session's clock — simulated for a replay, real for a live session. */
  clock: Clock;
  /** Where Sotto's voice goes, or `null` for a session that only shows things. */
  voice: VoiceOut | null;
  /** Whether anybody is talking, including Sotto: the policy's own getter. */
  pauseState: () => PauseState;
  /**
   * Now, on the transcription stream's timeline (V2-008a) — not the clock,
   * which in a live session counts from the start of the process.
   */
  streamNow: () => number;
  /** The frequency and boldness the header last set (V2-017). */
  settings: () => PolicySettings;
  /** Whether the frequency's cooldown and allowance leave room for this. */
  allowed: () => SpendVerdict;
  /** Spends the contribution; called once, where the claim is made. */
  noteContribution: () => void;
  /** Writes Sotto's own line into the conversation (V2-008a). */
  onSpoken: (turn: TurnUpdate) => void;
  /** One `spoken_contribution` line of `timing.jsonl`. */
  onRecord: (record: SpokenContributionRecord) => void;
  /**
   * Whether Sotto is already answering somebody (US-018).
   *
   * Opening an utterance stops whatever was being said, so a reservation must
   * not land on top of an answer being written: while one is, this is not a
   * gap, and the window runs out as it would in a room that never went quiet.
   */
  answering?: () => boolean;
  /**
   * Whether the room is still on the question (V3-004's seam).
   *
   * Read when the closing line is about to be said, which is the only place
   * V3-015 needs it: a group that moved on three turns ago does not want
   * "nothing solid on the drive time". Absent, every question is current,
   * which is what it is until V3-004's check exists.
   */
  isCurrent?: (ideaId: string) => boolean;
  windowMs?: number;
  logger?: Logger;
}

/** One line waiting for a gap to be said in. */
interface Pending {
  kind: SpokenContributionKind;
  ideaId: string;
  turnId: string;
  topic: string;
  text: string;
  /** The question turn going final, which the latency is measured from. */
  askedAtMs: number;
  /**
   * When this line started waiting. For a reservation that is the
   * classifier's verdict, and {@link RESERVE_WINDOW_MS} runs from here.
   */
  sinceMs: number;
  /** Whether it is given up on once the window has passed. */
  expires: boolean;
}

export class Reservations {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly windowMs: number;
  /** Lines waiting for a gap, oldest first. */
  private waiting: Pending[] = [];
  /** Questions whose claim the room actually heard, by idea id. */
  private readonly claimed = new Map<string, Pending>();
  /** The utterance a human voice would cancel, while there is one. */
  private utterance: VoiceUtterance | undefined;
  /**
   * True from the moment a line is handed to the voice until its record is
   * written. The utterance itself only exists a few hundred milliseconds
   * later, and a second line started in between would be a second utterance
   * — which, since opening one stops the last, would be neither.
   */
  private opening = false;
  /** Set by {@link yieldToHuman}, so a stop is never mistaken for a yield. */
  private yielded = false;
  /** Everything being said, in order; `flush` waits on it. */
  private speaking: Promise<void> = Promise.resolve();
  private cancelTimer: (() => void) | undefined;
  private stopped = false;

  constructor(private readonly options: ReservationsOptions) {
    this.clock = options.clock;
    this.logger = options.logger ?? console;
    this.windowMs = options.windowMs ?? RESERVE_WINDOW_MS;
  }

  /**
   * The room wondered something aloud and the search has started (V3-003):
   * claim it at the first gap in the next five seconds.
   */
  claim(idea: ResearchIdea, asked: { turnId: string; topic: string; askedAtMs: number }): void {
    if (this.stopped) return;
    const topic = asked.topic.trim() === "" ? idea.topic : asked.topic;
    this.waiting.push({
      kind: "reserve",
      ideaId: idea.id,
      turnId: asked.turnId,
      topic,
      text: reserveLine(topic),
      askedAtMs: asked.askedAtMs,
      sinceMs: this.clock.now(),
      expires: true,
    });
    this.review();
  }

  /**
   * The search behind a claim came back with nothing showable (V3-003).
   *
   * Only a question the room *heard* Sotto claim gets a spoken answer to it:
   * a loop nobody knows is open does not need closing, and the card already
   * says so. It waits for a real pause rather than a five-second window —
   * "nothing solid on the drive time" is still true later, where the claim
   * itself would not be.
   */
  noAnswer(ideaId: string, why = RESEARCH_NO_ANSWER): void {
    if (this.stopped) return;
    // The search got there first, which a fast failure can: there is nothing
    // to claim now, so the claim is dropped rather than said and immediately
    // taken back. The card is already saying it came back with nothing.
    const waiting = this.waiting.find(
      (line) => line.kind === "reserve" && line.ideaId === ideaId,
    );
    if (waiting !== undefined) {
      this.waiting = this.waiting.filter((line) => line !== waiting);
      this.skip(waiting, "overtaken");
      return;
    }
    const claim = this.claimed.get(ideaId);
    if (claim === undefined) return;
    this.claimed.delete(ideaId);
    this.logger.log(`[reserve] ${ideaId} came back with nothing (${why})`);
    this.waiting.push({
      ...claim,
      kind: "no_answer",
      text: noAnswerLine(claim.topic),
      sinceMs: this.clock.now(),
      expires: false,
    });
    this.review();
  }

  /** How many claims the room has heard and not yet heard the end of. */
  claimedCount(): number {
    return this.claimed.size;
  }

  /** How many lines are still waiting for a gap. */
  waitingCount(): number {
    return this.waiting.length;
  }

  /**
   * Takes one turn snapshot. Every snapshot counts, partials included: a
   * `speechEnd` arrives as a partial and it is the one that opens a pause.
   */
  acceptTurn(_turn: TurnUpdate): void {
    this.review();
  }

  /** Playback can end without an ASR frame arriving to say so (V2-006). */
  playbackChanged(): void {
    this.review();
  }

  /**
   * A human voice: stop talking, now (V3-004's rule).
   *
   * Called for the first human partial the self-echo filter lets through, at
   * any point in the utterance — no wake word and no classification, because
   * anything Sotto says unasked is worth less than the sentence it would be
   * talking over. What was heard still reaches the transcript, and the claim
   * is not retried.
   */
  yieldToHuman(): void {
    if (!this.opening) return;
    this.yielded = true;
    this.logger.log(`[reserve] yielding to a voice in the room`);
    // A yield that arrives while the voice is still opening is remembered
    // rather than lost: {@link speak} cancels the utterance as it gets it.
    this.utterance?.cancel();
  }

  /** Resolves once everything being said has been said and written down. */
  async flush(): Promise<void> {
    await this.speaking;
  }

  /**
   * The end of the session: stop talking, stop waiting for a gap, and write
   * down what never got said.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.disarm();
    const stranded = this.waiting;
    this.waiting = [];
    for (const line of stranded) this.skip(line, "session_ended");
    this.utterance?.cancel();
  }

  /** Looks at everything waiting, and arms the next look. */
  private review(): void {
    if (this.stopped || this.waiting.length === 0) return;
    const nowMs = this.clock.now();
    const pause = this.options.pauseState();
    // One line at a time: two utterances would be one utterance, since
    // opening the second stops the first.
    const gap = inPause(pause) && this.options.answering?.() !== true;
    const keep: Pending[] = [];
    for (const line of this.waiting) {
      if (line.expires && nowMs - line.sinceMs >= this.windowMs) {
        this.skip(line, "no_gap");
        continue;
      }
      if (!gap || keep.length > 0 || this.opening) {
        keep.push(line);
        continue;
      }
      const reason = this.reasonNotToSpeak(line);
      if (reason !== null) {
        this.skip(line, reason);
        continue;
      }
      this.say(line, nowMs);
    }
    this.waiting = keep;
    this.schedule(nowMs, pause);
  }

  /** Everything but the gap that can stop a line being said. */
  private reasonNotToSpeak(line: Pending): ReserveSkipReason | null {
    // A cautious session contributes on screen only, which is the same
    // promise {@link boldnessAllows} keeps for a candidate.
    if (this.options.settings().boldness === "cautious") return "boldness";
    if (line.kind === "no_answer") {
      return this.options.isCurrent?.(line.ideaId) === false ? "moved_on" : null;
    }
    // The closing line is the claim's completion, so only a claim is charged.
    const spend = this.options.allowed();
    return spend === "ok" ? null : spend;
  }

  /** Says one line, and records what the room got of it. */
  private say(line: Pending, nowMs: number): void {
    this.opening = true;
    this.yielded = false;
    this.speaking = this.clock.track(
      RESERVE_TRACK_LABEL,
      this.speaking.then(() => this.speak(line, nowMs)),
    );
  }

  private async speak(line: Pending, decidedAtMs: number): Promise<void> {
    let utterance: VoiceUtterance | null = null;
    try {
      utterance = (await this.options.voice?.begin()) ?? null;
    } catch (error) {
      // A voice that was there and broke: the card is still up, so the room
      // is not left waiting on a sentence that cannot be said.
      this.logger.warn(`[reserve] could not be said out loud: ${message(error)}`);
    }
    if (utterance === null) {
      this.opening = false;
      this.skip(line, "unheard");
      return;
    }
    if (this.stopped) {
      utterance.cancel();
      this.opening = false;
      this.skip(line, "session_ended");
      return;
    }
    this.utterance = utterance;
    // A voice in the room while this was opening: it never gets a word out.
    if (this.yielded) utterance.cancel();
    // Playback starts inside ElevenLabs' first chunk (measured at 299 ms), so
    // this is where the line belongs on the conversation's timeline.
    const startMs = this.options.streamNow();
    utterance.append(line.text);
    if (line.kind === "reserve") {
      // The claim has been made, so this is the contribution (V2-017). The
      // answer that follows it is its completion, not a second one.
      this.options.noteContribution();
      this.claimed.set(line.ideaId, line);
    }
    this.logger.log(`[reserve] ${line.kind}: ${line.text}`);
    let spoken: VoiceSpoken | undefined;
    try {
      spoken = await utterance.finish();
    } catch (error) {
      this.logger.warn(`[reserve] was cut short: ${message(error)}`);
    }
    this.utterance = undefined;
    this.opening = false;
    const yielded = this.yielded;
    const heard = spoken === undefined ? "" : yielded ? spoken.spokenSoFar : spoken.text;
    this.options.onRecord({
      stage: "spoken_contribution",
      kind: line.kind,
      atMs: decidedAtMs,
      ideaId: line.ideaId,
      turnId: line.turnId,
      topic: line.topic,
      spoken: true,
      text: line.text,
      questionToReserveMs: decidedAtMs - line.askedAtMs,
      yielded,
      ...(heard === line.text ? {} : { heard }),
    });
    // Cut off before the page reported anything: nobody can say what was
    // heard, so the transcript stays short rather than claiming a line.
    if (heard.trim() === "") return;
    this.options.onSpoken(
      sottoTurn({
        utteranceId: reserveUtteranceId(line.kind, line.ideaId),
        text: heard,
        startMs,
        interrupted: yielded,
      }),
    );
    // The gap this took is over, and the next line may now be sayable.
    this.review();
  }

  /** Writes down a line that was never said, and why. */
  private skip(line: Pending, reason: ReserveSkipReason): void {
    this.logger.log(`[reserve] ${line.kind} not said (${reason}): ${line.text}`);
    this.options.onRecord({
      stage: "spoken_contribution",
      kind: line.kind,
      atMs: this.clock.now(),
      ideaId: line.ideaId,
      turnId: line.turnId,
      topic: line.topic,
      spoken: false,
      text: line.text,
      reason,
    });
  }

  /**
   * Arms one timer for the soonest thing that could change an answer: the
   * silence reaching {@link PAUSE_MS}, or a claim's window running out. While
   * somebody is talking there is nothing to wait for — the turn closing is
   * what arrives next — so only the window is armed.
   */
  private schedule(nowMs: number, pause: PauseState): void {
    this.disarm();
    if (this.waiting.length === 0) return;
    const due: number[] = [];
    if (!pause.speaking && pause.silentForMs < PAUSE_MS) due.push(PAUSE_MS - pause.silentForMs);
    for (const line of this.waiting) {
      if (line.expires) due.push(Math.max(1, line.sinceMs + this.windowMs - nowMs));
    }
    if (due.length === 0) return;
    this.cancelTimer = this.clock.setTimeout(() => {
      this.cancelTimer = undefined;
      this.review();
    }, Math.min(...due));
  }

  private disarm(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }
}

/** The utterance id a reservation's transcript line is derived from (V2-008a). */
export function reserveUtteranceId(kind: SpokenContributionKind, ideaId: string): string {
  return `${kind}-${ideaId}`;
}

/** "I'll check the drive time." — the claim, from the classifier's topic. */
export function reserveLine(topic: string): string {
  return `I'll check ${asObject(topic)}.`;
}

/** "Nothing solid on the drive time, sorry." — the loop, closed. */
export function noAnswerLine(topic: string): string {
  return `Nothing solid on ${asObject(topic)}, sorry.`;
}

/**
 * Words that already say which thing is meant, so "the" in front of them
 * would be a second one.
 *
 * Determiners and possessives for a noun phrase ("the drive time"), and the
 * subordinators a topic phrased as a clause starts with ("whether they are
 * open on a Thursday"). A proper noun ("Loom pricing") needs no article
 * either, which is what the capital letter below is read as — the classifier
 * writes a topic "as it would be said out loud", so its case is meaningful.
 */
const NO_ARTICLE = new Set([
  "the", "a", "an", "our", "their", "its", "his", "her", "my", "your",
  "this", "that", "these", "those", "whether", "if", "how", "what", "when",
  "where", "who", "whom", "why", "which",
]);

/** The topic as the object of a sentence: "the drive time", "Loom pricing". */
function asObject(topic: string): string {
  const text = topic.replace(/\s+/g, " ").trim().replace(/[.?!,;:]+$/, "");
  if (text === "") return "that";
  const first = text.split(" ")[0] ?? "";
  if (NO_ARTICLE.has(first.toLowerCase())) return text;
  // A capital where the sentence does not need one is a name.
  if (/^[A-Z]/.test(first)) return text;
  return `the ${text}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
