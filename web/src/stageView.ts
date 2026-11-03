/**
 * The pure part of the stage (US-011): what order cards are in, and which
 * glows have gone quiet enough to fold into the tray.
 *
 * A card's `createdAtMs` is on the session clock — an offset into the
 * conversation, which a `max`-speed replay runs far ahead of the wall — so it
 * cannot say how old a card is on screen. The stage stamps each arrival with
 * `Date.now()` instead, the same way the board panel's freshness line does.
 */
import type { StageCard, TurnUpdate, WaitingLine } from "../../shared/index.js";
import type { VoiceState } from "../../shared/voice.js";
import { sottoTurnId } from "../../shared/turns.js";

/** A card, plus when the browser got it. */
export interface StageCardView extends StageCard {
  /** `Date.now()` when the card reached this page. */
  receivedAtMs: number;
}

/**
 * Folds one card into the stage.
 *
 * A card with an id already there is replaced in place, keeping the arrival
 * time it was first stamped with, so an answer that lands in pieces
 * (thinking, headline, detail) neither doubles itself nor jumps to the top of
 * the stack each time.
 *
 * `forward` is the one exception (V2-015): a research card that somebody has
 * just asked for is stamped again, so it comes back to the top of the stage
 * while Sotto briefs the room on it.
 */
export function foldCard(
  cards: readonly StageCardView[],
  card: StageCard,
  now: number,
  max: number,
): StageCardView[] {
  const index = cards.findIndex((existing) => existing.id === card.id);
  if (index !== -1) {
    const existing = cards[index] as StageCardView;
    const next = [...cards];
    next[index] = { ...card, receivedAtMs: card.forward === true ? now : existing.receivedAtMs };
    return next;
  }
  const next = [...cards, { ...card, receivedAtMs: now }];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** How long a glow stays on the stage before it collapses into the tray. */
export const QUIET_TRAY_MS = 120_000;

export interface StageArrangement {
  /** On the stage, newest first. */
  stack: StageCardView[];
  /** Folded into the "n quiet thoughts" tray, newest first. */
  tray: StageCardView[];
}

/**
 * Newest on top, with glows older than {@link QUIET_TRAY_MS} moved to the
 * tray. Answers and interjections stay on the stage however old they get:
 * they were worth saying out loud, so they are worth still being readable.
 */
export function arrangeCards(cards: readonly StageCardView[], now: number): StageArrangement {
  const newestFirst = [...cards].sort((a, b) => b.receivedAtMs - a.receivedAtMs);
  const stack: StageCardView[] = [];
  const tray: StageCardView[] = [];
  for (const card of newestFirst) {
    if (card.variant === "glow" && now - card.receivedAtMs >= QUIET_TRAY_MS) tray.push(card);
    else stack.push(card);
  }
  return { stack, tray };
}

/**
 * What Sotto is holding and has not said (PRD V3-017), newest first — the
 * stage's own order, so the first of them is the one a `call_on` would be
 * answered with.
 *
 * Three things take a card off this list, which is the whole of the PRD's
 * "opened, spoken or expired":
 *
 *   - **Opened**: the reader expanded it, so they have heard what Sotto had.
 *     That is the one of the three only the browser can know, which is why
 *     the count lives here rather than on the server.
 *   - **Spoken**: the server republishes the card without
 *     {@link StageCard.raised} the moment the sentence lands — because it was
 *     said in a `bold` session (V3-008), or because the room called on it.
 *   - **Expired**: a glow that has aged into the tray is no longer on the
 *     stage, and a hand still up for it would be asking about a thought the
 *     conversation left behind two minutes ago.
 */
export function raisedCards(
  cards: readonly StageCardView[],
  opened: ReadonlySet<string>,
  now: number,
): StageCardView[] {
  return arrangeCards(cards, now).stack.filter(
    (card) => card.raised === true && !opened.has(card.id),
  );
}

/** The tray's label. One thought is not "1 quiet thoughts". */
export function trayLabel(count: number): string {
  return `${count} quiet thought${count === 1 ? "" : "s"}`;
}

/**
 * When the stage next has to re-check the tray — the moment the youngest glow
 * still on the stage is due to collapse — or `null` when nothing can move.
 *
 * Glows that are already past due are left out on purpose: a due time in the
 * past is a timer that fires immediately and finds nothing to do, which is how
 * a render loop starts.
 */
export function nextTrayDueAt(cards: readonly StageCardView[], now: number): number | null {
  const dues = cards
    .filter((card) => card.variant === "glow")
    .map((card) => card.receivedAtMs + QUIET_TRAY_MS)
    .filter((due) => due > now);
  return dues.length === 0 ? null : Math.min(...dues);
}

/**
 * What Sotto is doing this second — the stage's Now zone.
 *
 * One of four, in this order of precedence:
 *
 *   - `speaking`: an utterance is open (`voice.speaking`), and `text` is what
 *     has been handed to it so far.
 *   - `working`: a card is on its way (`state: "thinking"`) — an answer being
 *     written, or a question the room wondered aloud being looked up.
 *   - `waiting`: a line is written and waiting for a gap to be said in; the
 *     first of the queue is the next one out.
 *   - `listening`: everything else, which is most of a meeting.
 *
 * Somebody addressing Sotto by name is `listening` too — `named` says so —
 * because the question is still being asked and nothing has been decided.
 * It outranks `working` and `waiting`: the person talking to Sotto is the
 * thing on the room's mind, and the answer card, when it comes, lands below.
 */
export type NowState =
  | { kind: "speaking"; text: string; heardChars: number; playing: boolean }
  | { kind: "working"; card: StageCard }
  | { kind: "waiting"; line: WaitingLine; behind: number }
  | { kind: "listening"; named: boolean; inConversation: boolean };

export function nowState(input: {
  voice: VoiceState;
  cards: readonly StageCard[];
  waiting: readonly WaitingLine[];
  listening: boolean;
  inConversation: boolean;
}): NowState {
  if (input.voice.speaking) {
    return {
      kind: "speaking",
      text: input.voice.text,
      heardChars: input.voice.heardChars ?? 0,
      playing: input.voice.playing,
    };
  }
  if (input.listening) {
    return { kind: "listening", named: !input.inConversation, inConversation: input.inConversation };
  }
  // The newest card on its way: an answer being written outranks a lookup
  // started earlier, because it is the one somebody is waiting on.
  const working = [...input.cards].reverse().find((card) => card.state === "thinking");
  if (working !== undefined) return { kind: "working", card: working };
  const line = input.waiting[0];
  if (line !== undefined) return { kind: "waiting", line, behind: input.waiting.length - 1 };
  return { kind: "listening", named: false, inConversation: false };
}

/**
 * The live line: the turn somebody is in the middle of saying, if any, else
 * the most recent one. What the Now zone fades through while listening, so
 * the room can see Sotto hears.
 */
export function liveTurn(turns: readonly TurnUpdate[]): TurnUpdate | null {
  if (turns.length === 0) return null;
  const open = [...turns].reverse().find((turn) => !turn.final);
  return open ?? turns[turns.length - 1] ?? null;
}

/**
 * Whether a card was said out loud, and whether the room cut it off, read off
 * Sotto's own transcript rows (V2-008a) and the card itself.
 *
 * An answer's utterance is its answer id, so `card-ans-1` was spoken when
 * `sotto:ans-1` is in the transcript; a card the server republished with
 * `raised: false` was said because the room called on it or a `bold` session
 * spoke it (V3-017). Everything else is screen only.
 */
export function spokenMark(
  card: StageCard,
  turns: readonly TurnUpdate[],
): "spoken" | "interrupted" | null {
  if (card.variant === "answer" && card.id.startsWith("card-")) {
    const turn = turns.find((one) => one.turnId === sottoTurnId(card.id.slice("card-".length)));
    if (turn !== undefined) return turn.interrupted === true ? "interrupted" : "spoken";
  }
  if (card.raised === false) return "spoken";
  return null;
}

/**
 * The stack with what Sotto is holding taken out, and without the card the
 * Now zone is already showing on its way: the Said zone.
 */
export function saidCards(
  stack: readonly StageCardView[],
  held: readonly StageCardView[],
  inNow?: string,
): StageCardView[] {
  const holding = new Set(held.map((card) => card.id));
  return stack.filter((card) => !holding.has(card.id) && card.id !== inNow);
}
