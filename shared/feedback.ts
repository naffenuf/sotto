/**
 * What the group thought of a card Sotto put up (PRD US-015).
 *
 * Three buttons on every delivered card — useful, not useful, wrong moment —
 * and every click is one line of `feedback.jsonl`. The point of the file is
 * tuning: a session folder ends up holding the candidate, the policy's
 * decision *and* the verdict on it, so "Sotto interrupts too much" becomes
 * something that can be counted rather than argued about.
 *
 * The browser sends only the card's id. Which candidate that was, and at what
 * level it went out, are the server's own record of the delivery — a tab must
 * not be able to write a verdict about a card that was never shown.
 */
import { z } from "zod";
import type { CandidateType } from "./candidates.js";
import type { DeliveredLevel } from "./policy.js";

/**
 * - `useful`: worth saying.
 * - `not_useful`: not worth saying at all.
 * - `wrong_moment`: a fair point, badly timed. The one the policy (US-014)
 *   learns the most from, which is why it is its own verdict and not a
 *   shade of "not useful".
 */
export const feedbackVerdicts = ["useful", "not_useful", "wrong_moment"] as const;
export type FeedbackVerdict = (typeof feedbackVerdicts)[number];

/** Body of `POST /api/feedback`. */
export const FeedbackRequestSchema = z.object({
  /** The {@link StageCard.id} of the card the buttons belong to. */
  cardId: z.string().trim().min(1).max(120),
  verdict: z.enum(feedbackVerdicts),
});
export type FeedbackRequest = z.infer<typeof FeedbackRequestSchema>;

/** Response to it. There is nothing to send back but the verdict as filed. */
export interface FeedbackResponse {
  recorded: true;
  verdict: FeedbackVerdict;
}

/**
 * One line of `feedback.jsonl`: the verdict, and enough of the card beside it
 * that the file reads without cross-referencing `candidates.jsonl`.
 */
export interface FeedbackLogRecord {
  kind: "feedback";
  /** When the click arrived, on the session clock. */
  atMs: number;
  cardId: string;
  candidateId: string;
  /** The level it was shown at, which is what `wrong_moment` is about. */
  level: DeliveredLevel;
  type: CandidateType;
  /** The headline as it was read, so the file stands on its own. */
  headline: string;
  /** When the card went up, on the session clock. */
  deliveredAtMs: number;
  verdict: FeedbackVerdict;
}
