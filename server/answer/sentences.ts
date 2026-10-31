/**
 * Cutting a stream of text into the pieces the voice is fed (V2-005).
 *
 * The model writes an answer a token at a time; ElevenLabs will start speaking
 * as soon as it is handed something, and the whole point of the spoken half is
 * that the room hears the first sentence long before the last one exists. So
 * the agent needs one question answered over and over as the text grows: *what
 * is safely sayable now?*
 *
 * A sentence is the unit, because that is where a voice can take a breath
 * without the seam being audible. The boundary is deliberately conservative —
 * a terminator only counts once something follows it — so a half-written
 * "Notion is $12 a" is never handed over, and `$12.50` is never read as two
 * sentences. Splitting wrongly costs nothing but the flush timing anyway: the
 * pieces are concatenated into one continuous stream at the other end, so a
 * missed boundary is a slightly later flush, not a mispronounced word.
 */

/**
 * Characters a sentence must have before a full stop is believed.
 *
 * Three, so that an initial ("E. Haas"), a numbered list marker ("1.") and a
 * stray dot on a line of its own are not flushed as sentences — every one of
 * them is two characters or fewer, and the shortest real sentence a model
 * writes ("No.", "Yes.") is three.
 */
export const MIN_SENTENCE_CHARS = 3;

/** Characters that end a sentence. */
const TERMINATORS = ".!?…";

/** Closing punctuation that may sit after a terminator and still belong to it. */
const CLOSERS = "\"'”’)]»";

/** What {@link splitSentences} made of the text so far. */
export interface SplitSentences {
  /** Whole sentences, in order, trimmed. */
  sentences: string[];
  /** What is left over, which may still be growing. */
  tail: string;
}

/**
 * Every complete sentence in `text`, and the unfinished remainder.
 *
 * A line break ends a sentence as surely as a full stop does — a model writing
 * a short list puts one item per line, and waiting for a terminator that never
 * comes would hold the whole list back.
 */
export function splitSentences(text: string): SplitSentences {
  const sentences: string[] = [];
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] as string;
    if (char === "\n") {
      const piece = text.slice(start, at).trim();
      if (piece !== "") sentences.push(piece);
      start = at + 1;
      continue;
    }
    if (!TERMINATORS.includes(char)) continue;
    let end = at + 1;
    while (end < text.length && (TERMINATORS + CLOSERS).includes(text[end] as string)) {
      end += 1;
    }
    // Nothing after the terminator yet: the sentence may still be growing, and
    // "$12." is only a sentence once a space rather than a "50" follows it.
    if (end >= text.length || !/\s/.test(text[end] as string)) continue;
    const piece = text.slice(start, end).trim();
    if (piece.length < MIN_SENTENCE_CHARS) continue;
    sentences.push(piece);
    start = end;
    at = end - 1;
  }
  return { sentences, tail: text.slice(start) };
}
