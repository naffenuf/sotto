/**
 * Raising a hand, and being called on (PRD V3-017).
 *
 * Everything Sotto notices about the conversation goes on screen and stays
 * there (V3-008): a contradiction, a wrong number, an assumption nobody
 * checked, a question nobody answered, a search that came back while the room
 * was mid-sentence. None of it is said out loud at the default settings, and
 * the risk of that promise is that a group reading its own board never
 * notices Sotto has anything at all. So the header shows a **hand**: Sotto is
 * holding *n* things, and anybody can ask for the latest.
 *
 * Two halves, and they are deliberately different objects.
 *
 *   - **The count is the browser's**, derived from {@link StageCard.raised}
 *     on the cards it already has — a card the reader has opened has been
 *     heard from, and the stage is the only thing that knows which those are.
 *   - **The queue is the server's**, which is this. A `call_on` has to be
 *     answered in one sentence with no model call and no file read, so each
 *     raised card arrives here with the line it would be said in already
 *     written.
 *
 * Nothing in here is spoken: {@link Reservations} says the line, under the
 * rules for an answer to a direct question rather than the ones for something
 * nobody asked for. The room asked.
 */
import type { StageCard } from "../../shared/cards.js";
import type { ResearchPacket } from "../../shared/research.js";

/**
 * What Sotto says when it is called on with nothing in hand.
 *
 * Said rather than shown, and short: somebody has just asked a question out
 * loud and silence would read as a broken app.
 */
export const NOTHING_RAISED_LINE = "Nothing right now.";

/** One thing Sotto is holding, and the sentence it would be said in. */
export interface RaisedItem {
  /** The card on the stage, which is also what `feedback.jsonl` knows it as. */
  cardId: string;
  /** When the hand last went up for it, on the session clock. */
  atMs: number;
  /** What Sotto says when the room calls on it. */
  line: string;
}

/**
 * The cards Sotto is holding and has not said, newest last.
 *
 * Driven entirely by published cards: {@link RaisedHand.observe} is called
 * with every card that goes to the stage, and a card without
 * {@link StageCard.raised} leaves the queue — which is what makes "spoken"
 * and "expired" one rule rather than three.
 */
export class RaisedHand {
  private readonly items = new Map<string, RaisedItem>();

  /**
   * Folds one published card in. A raised card joins the queue (or refreshes
   * its place in it); anything else leaves, including a card that was raised
   * a moment ago and has just been said.
   *
   * `line` is what calling on this card would be answered with, so a card
   * with nothing sayable on it never raises a hand it could not honour.
   */
  observe(card: StageCard, line: string, atMs: number): void {
    if (card.raised !== true || line.trim() === "") {
      this.items.delete(card.id);
      return;
    }
    // Deleted first so the insertion order says which is newest, for a queue
    // read back by {@link RaisedHand.items}.
    this.items.delete(card.id);
    this.items.set(card.id, { cardId: card.id, atMs, line });
  }

  /** Said, or written off: the hand comes down for this one. */
  lower(cardId: string): boolean {
    return this.items.delete(cardId);
  }

  /** How many things Sotto is holding. */
  count(): number {
    return this.items.size;
  }

  /**
   * The most recent one, which is what a `call_on` is answered with, or
   * `null` for {@link NOTHING_RAISED_LINE}.
   *
   * Most recent rather than most important: the room asking "what have you
   * got?" is asking about the conversation it is in, and the thing Sotto
   * noticed a minute ago has had its chance on screen.
   */
  latest(): RaisedItem | null {
    let latest: RaisedItem | null = null;
    for (const item of this.items.values()) {
      if (latest === null || item.atMs >= latest.atMs) latest = item;
    }
    return latest;
  }

  /** Everything being held, oldest first. */
  held(): readonly RaisedItem[] {
    return [...this.items.values()];
  }

  /** The session is over; nothing is being held any more. */
  clear(): void {
    this.items.clear();
  }
}

/**
 * The sentence one interjection card would be said in: its headline and its
 * detail, which is what the PRD asks for and is also simply the card read out.
 *
 * Written locally, like every other line Sotto says about its own judgment
 * (V3-008, V3-015): a model call between "Sotto, go ahead" and the first
 * audio would cost the only thing being asked for.
 */
export function calledOnCardLine(card: StageCard): string {
  // An answer that was never said (`Answer.late`) carries the half that was
  // written to be heard; that is the line, not the headline and the bullets.
  if (card.variant === "answer" && (card.spokenText ?? "").trim() !== "") {
    return card.spokenText?.trim() ?? "";
  }
  const headline = spokenText(card.headline);
  const detail = spokenText(card.detailMd ?? "");
  if (headline === "") return detail === "" ? "" : sentence(detail);
  if (detail === "") return sentence(headline);
  return `${sentence(headline)} ${sentence(detail)}`;
}

/**
 * The sentence one research card would be said in: the packet's own spoken
 * answer (V3-003 writes it to be heard), or a briefing read off its title and
 * teaser when the search left that field blank (V2-015's move, without the
 * model).
 */
export function calledOnPacketLine(packet: ResearchPacket): string {
  const spoken = spokenText(packet.spokenAnswer ?? "");
  if (spoken !== "") return sentence(spoken);
  const title = spokenText(packet.title);
  const teaser = spokenText(packet.teaser);
  if (title === "") return teaser === "" ? "" : sentence(teaser);
  return teaser === "" ? sentence(title) : `On ${title}: ${sentence(teaser)}`;
}

/**
 * One line of plain words, from text written to be read.
 *
 * A detail can carry the little markdown a card renders (V2-014's key points
 * are a bulleted list) and ElevenLabs would read the asterisks, so the marks
 * come off and a list becomes sentences. A URL is dropped outright: nobody
 * can write one down from speech, and the card has them numbered.
 */
function spokenText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Said rather than read, so it ends in a stop: the voice reads punctuation. */
function sentence(text: string): string {
  const trimmed = text.replace(/[…]+$/, "").trim();
  if (trimmed === "") return "";
  return /[.?!]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
