/**
 * Decides what a read-back carries, and when there is to be one (PRD V3-013).
 *
 * The signal arrives from V3-002's classifier the instant the turn goes final
 * — `closing: true` plus the decision in a few words — so this never waits
 * for a board update, which is the whole reason the detection rides that
 * call. What happens here is the matching and the rationing:
 *
 *  1. the candidates that passed the gate are kept, newest last;
 *  2. a closing decision takes the one that is most *about* it
 *     ({@link decisionRelevance}), preferring the room's own unsettled
 *     business over Sotto's reading of it;
 *  3. an `own` attachment is pinned to the stage there and then, because that
 *     is where V3-008 says Sotto's own corrections live, whether or not a word
 *     is ever said;
 *  4. the two limits are applied — one spoken read-back every five minutes,
 *     one attached question every ten — and what is left is handed to
 *     {@link Reservations}, which owns the pause, the yield, the budget and
 *     the boldness.
 *
 * The limits are read when the read-back is *queued* rather than when it is
 * said, which is the one approximation in here: a read-back lives for twenty
 * seconds at the most, so the two windows have barely moved by the time it is
 * spoken, and checking at the pause would mean carrying a third text for the
 * case where the attachment ages out mid-wait.
 *
 * An attachment that is hit by the ten-minute limit degrades to a bare
 * read-back rather than being dropped; the five-minute one stops the
 * read-back outright, and the decision just lands on the board as it always
 * has.
 */
import type { Candidate } from "../../shared/candidates.js";
import type { Clock } from "../clock.js";
import type { DecisionClosing } from "../question/question.js";
import type { SpokenContributionRecord } from "../question/Reservations.js";
import {
  attachmentFor,
  decisionId,
  decisionRelevance,
  groupAttachedLine,
  ownAttachedLine,
  readBackLine,
  ATTACHED_COOLDOWN_MS,
  DECISION_RELEVANCE,
  READBACK_COOLDOWN_MS,
  type ReadBackAttachment,
  type ReadBackRequest,
} from "./readback.js";

type Logger = Pick<Console, "log" | "warn">;

export interface ReadBacksOptions {
  clock: Clock;
  /** Says it at the next real pause, under V3-004's rules. */
  speak: (request: ReadBackRequest) => void;
  /**
   * Pins one of Sotto's own corrections beside the read-back, on screen
   * (V3-008). Called whatever the frequency and the boldness: the card is the
   * contribution, and the sentence is the exception.
   */
  pinCard: (candidateId: string, decision: string) => void;
  /**
   * Whether this candidate is already on the stage as a card, which decides
   * whether saying its question costs the frequency anything (V2-017).
   */
  delivered?: (candidateId: string) => boolean;
  /** One `decision_closing` line of `timing.jsonl`. */
  onTiming: (record: Record<string, unknown>) => void;
  logger?: Logger;
}

/** One candidate scored against one decision. */
interface Match {
  candidate: Candidate;
  attachment: ReadBackAttachment;
  relevance: number;
}

/** One per session, retired on Stop like every other loop. */
export class ReadBacks {
  private readonly logger: Logger;
  /** Everything the gate passed, oldest first: the attachment candidates. */
  private readonly candidates: Candidate[] = [];
  /** Candidates already attached to a read-back, which are no longer open. */
  private readonly attached = new Set<string>();
  /** The closest thing to a match that did not qualify, for the log. */
  private nearMiss: Match | null = null;
  /** When a read-back was last really heard, for the five-minute limit. */
  private spokenAtMs: number | null = null;
  /** And when one last carried a question, for the ten-minute limit. */
  private attachedAtMs: number | null = null;
  private stopped = false;

  constructor(private readonly options: ReadBacksOptions) {
    this.logger = options.logger ?? console;
  }

  /**
   * A candidate the gate passed (V2-016), which is the PRD's bar for an
   * attachment: the second opinion has already agreed it is worth raising.
   *
   * Kept whether or not the policy delivered it — a question the policy is
   * still holding for a pause is exactly the unsettled business a decision
   * read-back should carry.
   */
  accept(candidate: Candidate): void {
    if (this.stopped || attachmentFor(candidate.type) === null) return;
    if (this.candidates.some((earlier) => earlier.id === candidate.id)) return;
    this.candidates.push(candidate);
  }

  /** The group just settled something (V3-013): read it back, with whatever fits. */
  closing(closing: DecisionClosing): void {
    if (this.stopped) return;
    const decision = closing.decision.trim();
    if (decision === "") return;
    const nowMs = this.options.clock.now();
    const match = this.related(decision);
    const found = match?.attachment ?? null;
    // V3-008 keeps Sotto's own corrections on the screen, so the card is
    // pinned before anything is decided about speech — including when the
    // read-back itself is about to be rationed away.
    if (match !== null && found === "own") {
      this.options.pinCard(match.candidate.id, decision);
    }
    if (match !== null) this.attached.add(match.candidate.id);
    let attached: ReadBackAttachment | null = found;
    const attachedBlocked =
      attached !== null &&
      this.attachedAtMs !== null &&
      nowMs - this.attachedAtMs < ATTACHED_COOLDOWN_MS;
    if (attachedBlocked) attached = null;
    const blocked =
      this.spokenAtMs !== null && nowMs - this.spokenAtMs < READBACK_COOLDOWN_MS;
    const bareText = readBackLine(decision);
    const text =
      attached === "group" && match !== null
        ? groupAttachedLine(decision, match.candidate, match.candidate.evidence[0]?.speaker ?? null)
        : attached === "own" && match !== null
          ? ownAttachedLine(decision, match.candidate)
          : bareText;
    this.options.onTiming({
      stage: "decision_closing",
      atMs: closing.decidedAtMs,
      turnId: closing.turnId,
      decision,
      decidedBy: closing.decidedBy,
      found,
      attached,
      candidateId: match?.candidate.id ?? null,
      relevance: match === null ? null : Number(match.relevance.toFixed(2)),
      ...(match === null && this.nearMiss !== null
        ? {
            bestCandidateId: this.nearMiss.candidate.id,
            bestRelevance: Number(this.nearMiss.relevance.toFixed(2)),
          }
        : {}),
      ...(blocked ? { skipped: "readback_limit" } : {}),
      ...(attachedBlocked ? { degraded: "attached_limit" } : {}),
    });
    this.logger.log(
      `[readback] ${closing.turnId} decided: ${decision}` +
        ` (${found === null ? "nothing attached" : `${found}: ${match?.candidate.id ?? ""}`})` +
        (blocked ? " — not read back, one went out inside five minutes" : ""),
    );
    if (blocked) return;
    this.options.speak({
      id: decisionId(closing.turnId),
      turnId: closing.turnId,
      decision,
      attached,
      candidateId: match?.candidate.id ?? null,
      text,
      bareText,
      alreadyDelivered:
        match !== null && this.options.delivered?.(match.candidate.id) === true,
    });
  }

  /**
   * What became of a read-back, so the two limits count what the room really
   * heard rather than what Sotto queued.
   *
   * A read-back held back by the budget, the boldness or a missing pause
   * spends neither window: nothing was said, so nothing is owed.
   */
  observe(record: SpokenContributionRecord): void {
    if (record.kind !== "readback" || !record.spoken) return;
    this.spokenAtMs = record.atMs;
    if (record.attached !== null && record.attached !== undefined) {
      this.attachedAtMs = record.atMs;
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * The open candidate this decision is most about, or `null`.
   *
   * The room's own unsettled business wins a tie with Sotto's reading of it,
   * because it can be said out loud at every frequency and Sotto's cannot —
   * and among equals the most recent wins, which is the one the group is most
   * likely to remember saying.
   */
  private related(decision: string): Match | null {
    let best: Match | null = null;
    this.nearMiss = null;
    for (const candidate of this.candidates) {
      if (this.attached.has(candidate.id)) continue;
      const attachment = attachmentFor(candidate.type);
      if (attachment === null) continue;
      const relevance = decisionRelevance(decision, candidate);
      if (relevance < DECISION_RELEVANCE) {
        // Written down even though it lost: "the bar is in the wrong place"
        // and "the observer noticed nothing" look identical in the log
        // otherwise, and only one of them is fixable here.
        if (relevance > (this.nearMiss?.relevance ?? 0)) {
          this.nearMiss = { candidate, attachment, relevance };
        }
        continue;
      }
      if (
        best === null ||
        (attachment === "group" && best.attachment === "own") ||
        (attachment === best.attachment && relevance >= best.relevance)
      ) {
        best = { candidate, attachment, relevance };
      }
    }
    return best;
  }
}
