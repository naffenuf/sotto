/**
 * What one evaluation run records (PRD US-016).
 *
 * `npm run eval` replays the captured conversations through the whole
 * interjection engine and writes everything it saw to
 * `eval/runs/<timestamp>.json`. This module is the shape of that file, plus
 * the judge's reply schema — the model call that decides whether a card Sotto
 * showed is about a moment the fixture planted.
 *
 * Scoring is deliberately *not* here. A run file is the raw record — what was
 * delivered, when, into what, and which planted moments a judge matched it to
 * — so that the report (US-016 part 2) can be recomputed, and the thresholds
 * it gates on changed, without replaying a single conversation again.
 */
import { z } from "zod";
import type { CandidateGateWhere, CandidateType, GateMode } from "./candidates.js";
import type { ExpectedLevel, MomentType } from "./fixtures.js";
import type { DecisionReason, DeliveredLevel, PolicySettings } from "./policy.js";
import type { PauseState } from "./turns.js";

/** The `json_schema.name` a judge request sends. */
export const JUDGE_SCHEMA_NAME = "moment_match";

/** Words of reason. It is read in a report, not by anything that acts on it. */
export const JUDGE_REASON_MAX_WORDS = 40;

/** Collapses whitespace, as the observer's fields do: one line in a table. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The judge's whole reply: did this card raise this moment, and why. */
export const JudgeReplySchema = z.strictObject({
  matches: z.boolean(),
  reason: z.string().transform((text) => clipWords(oneLine(text), JUDGE_REASON_MAX_WORDS)),
});
export type JudgeReply = z.infer<typeof JudgeReplySchema>;

/** `text`, cut to `max` words with an ellipsis. */
function clipWords(text: string, max: number): string {
  const words = text.split(" ");
  if (words.length <= max) return text;
  return `${words.slice(0, max).join(" ")}…`;
}

/**
 * {@link JudgeReplySchema} as a JSON Schema, in the subset strict structured
 * output accepts: closed, every property required, no length keywords. The
 * word limit lives in the description and is enforced by the zod schema
 * above; `shared/eval.test.ts` holds the two in agreement.
 */
export const judgeMatchJsonSchema = {
  type: "object",
  properties: {
    matches: {
      type: "boolean",
      description:
        "True only if the card raises this planted moment: the same issue, " +
        "however differently worded. False if it raises something else, even " +
        "something correct and useful.",
    },
    reason: {
      type: "string",
      description: `One sentence of at most ${JUDGE_REASON_MAX_WORDS} words saying why.`,
    },
  },
  required: ["matches", "reason"],
  additionalProperties: false,
} as const;

/**
 * The level a card the harness scored went out at.
 *
 * A policy delivery is a `glow` or an `interject` (V2-017's {@link
 * DeliveredLevel}); a research-ready card (V2-014) is neither — nothing about
 * it is a decision to take the floor — so it has its own level here, which is
 * also the level a `research_hook` moment expects. One type so a moment's
 * outcome can name what caught it, whichever half of the stage it came from.
 */
export type ScoredLevel = DeliveredLevel | "research";

/** One card Sotto put on the stage during a replay. */
export interface DeliveryRecord {
  /** The stage card's id, `card-<candidateId>`. */
  cardId: string;
  candidateId: string;
  /** What the policy filed it as; `null` if the decision log was unreadable. */
  type: CandidateType | null;
  /** The level it actually went out at, which the budget may have turned down. */
  level: DeliveredLevel;
  headline: string;
  detail: string;
  whyNow: string;
  /** When the policy delivered it, on the session (simulated) clock. */
  deliveredAtMs: number;
  /**
   * Whether nobody was talking when it went out, reconstructed from the turns
   * rather than taken from the policy's own word: the PRD's "every delivery
   * happened during a pause" is a claim about the conversation, so it is
   * measured against the conversation.
   */
  inPause: boolean;
  /** The reconstructed pause state at {@link deliveredAtMs}. */
  pause: PauseState;
  /** The policy's reason: `delivered`, or `cooldown`/`budget` for a downgrade. */
  reason: DecisionReason | null;
  /** The score the decision was made on, or `null` if the log was unreadable. */
  score: number | null;
}

/**
 * One research-ready card a replay put on the stage (V2-019).
 *
 * Deliberately not a {@link DeliveryRecord}: a research card is not a
 * decision the policy took, so it has no candidate behind it, no level the
 * budget could have turned down and no reason — and it must not be counted
 * among the deliveries the precision and pause gates are about. What it does
 * have is a planted `research_hook` moment it may or may not be an answer to,
 * which is what the judge is asked.
 *
 * It is read off the session folder's `research.jsonl` rather than off the
 * stage, because a packet brought forward when somebody asks for it (V2-015)
 * replaces its own card — same id, later `createdAtMs` — and the time that
 * matters here is when the group first saw it.
 */
export interface ResearchDeliveryRecord {
  /** The stage card's id, `research-<packetId>`. */
  cardId: string;
  packetId: string;
  ideaId: string;
  title: string;
  /** The question the packet answers, from the `packet` line of the log. */
  question: string;
  /** The card's one line, which is what a reader sees closed. */
  teaser: string;
  /** The key points, as the card's markdown. */
  detail: string;
  /** How many sources the packet carried. A packet with none is discarded. */
  sources: number;
  /** When the card went up, on the session (simulated) clock. */
  deliveredAtMs: number;
  /** Whether nobody was talking then, reconstructed from the turns. */
  inPause: boolean;
  /** The reconstructed pause state at {@link deliveredAtMs}. */
  pause: PauseState;
  /** True when it went up in the drain, after the conversation had ended. */
  atSessionEnd: boolean;
}

/**
 * What the research pipeline did in one replay (V2-019), off `research.jsonl`.
 *
 * The PRD asks the report for packets per conversation and the unsourced
 * count, and both are decisions the pipeline logged rather than anything the
 * stage shows: an unsourced packet is thrown away without a card ever
 * existing (V2-013).
 */
export interface ResearchRunRecord {
  /** Ideas the session thought of, duplicates included. */
  ideas: number;
  /** Ideas the gate let through. */
  queued: number;
  /** Ideas the gate turned down. */
  rejected: number;
  /** Gate calls that did not come back; the idea stopped there too. */
  gateFailed: number;
  /** Gate verdicts that ran on the local model, which is billed at nothing. */
  localGateCalls: number;
  /** Sourced packets: the searches that produced something showable. */
  packets: number;
  /** Packets discarded for having no source the search really returned. */
  unsourced: number;
  /** Searches that did not come back at all. */
  failed: number;
  /** The cards those packets became, oldest first. */
  cards: ResearchDeliveryRecord[];
}

/**
 * One planted moment, with its window resolved onto both timelines.
 *
 * The scripted times come from `<fixture>.timing.json` and are positions in
 * the *audio*; a delivery time is on the session clock, which runs a little
 * ahead of the audio because a frame arrives 600–760 ms after the audio it
 * describes (`fixtures/events/NOTES.md`). The turns overlapping each line are
 * recorded alongside so that a report can place the window on the session
 * clock instead, and say how late a catch was in the terms the policy saw.
 */
export interface MomentRecord {
  id: string;
  type: MomentType;
  expectedLevel: ExpectedLevel;
  description: string;
  triggerLine: number;
  deadlineLine: number;
  /** Scripted end of `triggerLine`, in the audio. A catch counts from here. */
  triggerEndMs: number;
  /** Scripted end of `deadlineLine`. A catch after this one is late. */
  deadlineEndMs: number;
  /** Final turns overlapping the setup lines, oldest first. */
  setupTurnIds: string[];
  /** Final turns overlapping the trigger line. */
  triggerTurnIds: string[];
  /** Session-clock end of the last turn overlapping `triggerLine`, if any. */
  triggerTurnEndMs: number | null;
  /** Session-clock end of the last turn overlapping `deadlineLine`, if any. */
  deadlineTurnEndMs: number | null;
}

/** What the judge made of one (card, moment) pair. */
export interface JudgeMatchRecord {
  cardId: string;
  momentId: string;
  matches: boolean;
  reason: string;
  /** True when the verdict came off disk rather than from the model. */
  cached: boolean;
  /** Set instead of a verdict when the judge call itself failed. */
  error?: string;
}

/**
 * One gate call during a replay (V2-016), read back off `candidates.jsonl`.
 *
 * The latency is the reason this is in the run record at all: a gate call
 * happens while the moment it is about is passing, so how long the local
 * model takes is part of what the eval measures, beside what its judgment
 * did to recall and precision.
 */
export interface GateCallRecord {
  candidateId: string;
  /** Which model answered, or `null` when there was none to ask. */
  gate: CandidateGateWhere | null;
  /** The score the policy then used: the gate's, mapped. */
  score: number;
  /** What the observer had proposed, so the difference is readable. */
  observerScore: number;
  /** Real milliseconds the call took. */
  latencyMs: number;
  /** Set when no verdict came back and the observer's scores stood. */
  error?: string;
}

/**
 * The one setting the harness had before V2-017 split it in two.
 *
 * Kept only so a run recorded then can still be read back and reported on
 * (`npm run eval:report <old id>`); nothing writes it any more. `quiet`,
 * `normal` and `active` carried exactly the three threshold pairs the three
 * {@link Boldness} settings carry now, and the cooldown and budget were
 * constants equal to `normal` frequency's — which is the mapping
 * `server/eval/score.ts` reads them with.
 */
export type LegacyChattiness = "quiet" | "normal" | "active";

/** One fixture replayed at one pair of settings. */
export interface FixtureRunRecord {
  fixture: string;
  /** How often and how boldly. Absent on runs recorded before V2-017. */
  settings?: PolicySettings;
  /** @deprecated What V2-017 replaced; present only on runs recorded before it. */
  chattiness?: LegacyChattiness;
  /** Where the session folder for this replay went, for reading afterwards. */
  sessionDir: string | null;
  /** The conversation's length on the session clock. */
  durationMs: number;
  /** How many final turns the assembler produced. */
  finalTurns: number;
  /** How many candidates the observer wrote down, duplicates included. */
  candidates: number;
  /** How many decisions the policy recorded. */
  decisions: number;
  /**
   * Every gate call the replay made (V2-016). Empty under `--gate spark`,
   * which makes none, and absent on runs recorded before V2-016.
   */
  gateCalls?: GateCallRecord[];
  deliveries: DeliveryRecord[];
  /**
   * What the research pipeline did (V2-019). Absent on runs recorded before
   * it, and on a replay whose session folder could not be read back.
   */
  research?: ResearchRunRecord;
  moments: MomentRecord[];
  /** Every (delivery, moment) pair the judge looked at. */
  matches: JudgeMatchRecord[];
  /** How long the replay took in real time, for the log. */
  elapsedMs: number;
  /** Set when the replay itself failed; the other fields are then empty. */
  error?: string;
}

/** One prompt file and the hash of the text the model was given. */
export interface PromptHash {
  /** Repo-relative, e.g. `server/prompts/observer.md`. */
  file: string;
  hash: string;
}

/** What a run spent at the model, as the API reported it. */
export interface RunTokenUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Part of {@link outputTokens}, not an addition to it. */
  reasoningTokens: number;
}

/** One `npm run eval`: every fixture, at every pair of settings asked for. */
export interface EvalRunRecord {
  /** The run's id, which is also its file name: `YYYY-MM-DD_HHMMSS`. */
  id: string;
  startedAt: string;
  finishedAt: string;
  /** `git rev-parse --short HEAD`, or `null` outside a checkout. */
  gitCommit: string | null;
  /** The settings asked for, in the order they were run. */
  settings?: PolicySettings[];
  /** @deprecated What V2-017 replaced; present only on runs recorded before it. */
  chattiness?: LegacyChattiness[];
  /**
   * Who scored the candidates (V2-016). Absent on runs recorded before it,
   * which all used the observer's own scores — i.e. `spark`.
   */
  gate?: GateMode;
  fixtures: string[];
  judge: {
    model: string;
    /** Hash of `server/prompts/judge.md`, which is part of every cache key. */
    promptHash: string;
    calls: number;
    cacheHits: number;
  };
  /**
   * Every prompt in `server/prompts/`, hashed — the other half of what the
   * numbers depend on, beside the commit. Optional because the two runs
   * written before US-016 part 2 do not have it.
   */
  promptHashes?: PromptHash[];
  /** What the whole run spent, replays and judge together. Optional as above. */
  usage?: RunTokenUsage;
  runs: FixtureRunRecord[];
}
