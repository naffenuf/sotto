/**
 * Wake-phrase detection (PRD US-017): deciding whether a turn is addressed to
 * Sotto, and pulling the question out of it.
 *
 * Pure and synchronous — it is handed the text of a turn and nothing else —
 * so the same function reads partials and finals alike. The stateful half
 * (one trigger per turn, the "Sotto is listening…" indicator, the courtesy
 * hook) lives in `server/wakeWatcher.ts` for sessions without a model.
 * V2-008 uses `answer/AddressWatcher.ts` with a model: `detectsAddress` is
 * only a lexical hint, while `detect` and its strict rules remain the fallback
 * if final-turn classification fails.
 *
 * The rules come from what the transcription API actually produced, recorded
 * in `fixtures/events/NOTES.md`:
 *
 * - **Punctuation is optional.** The scripted `Sotto, what do the main
 *   competitors charge per month?` came back as
 *   `" Sotto what do the main competitors charge per month. "` — no comma and
 *   no question mark — so a rule that insists on either would miss half the
 *   wake fixtures. A comma *or* a question is enough, and "a question" means
 *   the words, not the mark.
 * - **Position carries the weight.** `sotto voce` transcribes to exactly the
 *   spelling of the wake word, and `Soto` turns up as somebody's name. What
 *   separates an address from a look-alike is where it sits (the start of a
 *   sentence, or right after "hey"/"okay"/"ok") and what follows it.
 */

/**
 * The spellings the transcription model has been seen to produce for the wake
 * word, plus the near-misses worth catching. `sotto`, `soto` and `sato` all
 * appear in the captures — `research-business-idea`'s one wake line came back
 * as `" Sato, what did you find on competitors? "` on two captures of two
 * renders, while `offsite-plan`'s, in the same voice, kept `Sotto` — and
 * `sota` never has, and is here because it is the obvious fourth way to hear
 * the word.
 */
export const DEFAULT_WAKE_SPELLINGS: readonly string[] = ["sotto", "soto", "sato", "sota", "sado", "sana"];

/**
 * The name heard as two words. The checkpoint session (`2026-11-01_1928-mic`)
 * transcribed "Sotto, where are we at" as `" So to where where are we at "`,
 * and nothing matched; the repeat ten seconds later came back `Soto?` and did.
 * {@link words} folds the pair into one word when it opens a sentence or
 * follows an {@link ADDRESS_WORDS} word — "so to recap" at the start of a turn
 * is caught too, and left to the classifier, which is the real gate (V2-008).
 */
const TWO_WORD_SPELLING: readonly [string, string] = ["so", "to"];

/** Words that may introduce the wake word: "hey Sotto", "okay Sotto, …". */
export const ADDRESS_WORDS: readonly string[] = ["hey", "okay", "ok"];

/**
 * Words that, following the wake word, mean it was not the wake word.
 *
 * One entry, and it earns its place: "sotto voce" is transcribed with the
 * same spelling and the same capitalisation as an address, and in the
 * `no-wake` capture it lands at the start of a sentence
 * (`" Exactly. Sotto voce, if you want to be fancy about it. "`), which is
 * the one position that would otherwise qualify.
 */
export const BLOCKED_FOLLOWING_WORDS: readonly string[] = ["voce"];

/**
 * Interrogatives: the words that make a question out of what follows them
 * even when the transcription has swallowed the question mark, which it does
 * (`" Sotto what do the main competitors charge per month. "`).
 *
 * Deliberately *only* the wh-words. Auxiliaries would catch one more shape —
 * "Sotto can you sketch the flow" with both the comma and the mark lost — but
 * they also turn every sentence about Sotto into a question for it ("Sotto is
 * being too chatty", "Sotto should stay quiet"), and a group talking about
 * Sotto is exactly what the `no-wake` fixture is. Answering when nobody asked
 * is the failure this product exists to avoid; a missed address can be
 * repeated, or typed (US-019).
 */
const QUESTION_OPENERS: ReadonlySet<string> = new Set([
  "what",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "why",
  "how",
  "which",
]);

/**
 * The auxiliaries that open a yes/no question *of* Sotto, for the lexical
 * fallback only (V2-008's six-second classifier timeout). "Sotto, did you
 * look up any of the things we were talking about" came back with no comma
 * and was read as a mention when the classifier timed out
 * (`2026-11-03_0915-mic`). Deliberately without "is"/"are"/"should"/"has"/
 * "will": "Sotto is being too chatty", "Sotto should stay quiet" and "Sotto
 * has been quiet today" are about Sotto, and those are what the `no-wake`
 * fixture is made of.
 */
const LOOSE_QUESTION_OPENERS: ReadonlySet<string> = new Set([
  "did", "do", "does", "can", "could", "would",
]);

/** Punctuation that ends a sentence, so that what follows starts one. */
const SENTENCE_ENDERS = new Set([".", "!", "?", "…", ";", ":", "\n", "\r"]);

/** Punctuation that may sit between the wake word and the question. */
const SEPARATORS = new Set([",", ":", ";", "-", "–", "—", "…"]);

/** Quotes and brackets to look past when deciding what came before a word. */
const OPENERS = new Set(['"', "'", "“", "‘", "(", "[", "«"]);

export interface WakeOptions {
  /**
   * Also read an auxiliary after the name as opening a question ("Sotto did
   * you…"). For the address classifier's lexical fallback only — the wake
   * watcher's partials stay on the wh-words.
   */
  looseQuestions?: boolean;
  /** Accepted spellings, lower-case. Defaults to {@link DEFAULT_WAKE_SPELLINGS}. */
  spellings?: readonly string[];
}

/** What {@link detect} made of one turn's text. */
export interface WakeMatch {
  /** True when this text addresses Sotto with something to answer. */
  triggered: boolean;
  /** Everything after the wake word, trimmed; `null` when not triggered. */
  question: string | null;
}

const NOT_TRIGGERED: WakeMatch = { triggered: false, question: null };

/** V2-008: a lexical hint yields the floor immediately; final intent needs a classifier. */
export function detectsAddress(text: string): boolean {
  const all = words(text);
  return all.some((word) => {
    if (!DEFAULT_WAKE_SPELLINGS.includes(word.lower)) return false;
    // The tokenizer reads letters; digits and underscores still belong to a word.
    if (/[\p{L}\p{N}_]/u.test(text[word.start - 1] ?? "")) return false;
    if (/[\p{L}\p{N}_]/u.test(text[word.end] ?? "")) return false;
    const rest = text.slice(word.end);
    if (/^['’]s\b/i.test(rest)) return false;
    if (BLOCKED_FOLLOWING_WORDS.includes(words(rest)[0]?.lower ?? "")) return false;
    return true;
  });
}

/**
 * Decides whether `text` addresses Sotto, and with what question.
 *
 * Triggers when one of the `spellings` appears as a whole word either at the
 * start of a sentence or right after an {@link ADDRESS_WORDS} word, is not
 * followed by {@link BLOCKED_FOLLOWING_WORDS} or a possessive `'s`, and is
 * followed either by a separator (a comma, typically) or by a question. The
 * question is everything after the wake word, with any separator removed; a
 * wake word with nothing after it is not a question and does not trigger.
 *
 * The first qualifying occurrence wins, so "Soto's restaurant — Sotto, what
 * was his rule?" asks about the rule.
 */
export function detect(text: string, options: WakeOptions = {}): WakeMatch {
  const spellings = options.spellings ?? DEFAULT_WAKE_SPELLINGS;
  if (spellings.length === 0) return NOT_TRIGGERED;

  const all = words(text);
  for (const [index, word] of all.entries()) {
    if (!spellings.includes(word.lower)) continue;
    if (!isAddressed(text, word, all[index - 1])) continue;
    const question = questionAfter(text, word.end, options.looseQuestions === true);
    if (question !== null) return { triggered: true, question };
  }
  return NOT_TRIGGERED;
}

/**
 * The name as the transcript should show it, whatever the API heard.
 *
 * A spelling in an address position — opening a sentence or following
 * "hey"/"okay", not a possessive, not `sotto voce` — is rewritten to `Sotto`;
 * the two-word form is rewritten only where {@link detect} would trigger on
 * it (a separator or a question word follows), so "So to speak" survives.
 * Everything else in the text, spacing and punctuation included, is kept.
 * `Soto's Restaurant` and "I asked Soto earlier" are left alone: they are
 * not addresses, and the transcript should say what was said.
 */
export function normalizeWakeSpelling(text: string, options: WakeOptions = {}): string {
  const spellings = options.spellings ?? DEFAULT_WAKE_SPELLINGS;
  const all = words(text);
  let out = "";
  let from = 0;
  for (const [index, word] of all.entries()) {
    if (!spellings.includes(word.lower)) continue;
    if (!isAddressed(text, word, all[index - 1])) continue;
    const rest = text.slice(word.end);
    if (/^['’]s\b/i.test(rest)) continue;
    if (BLOCKED_FOLLOWING_WORDS.includes(words(rest)[0]?.lower ?? "")) continue;
    if (word.folded === true && questionAfter(text, word.end) === null) continue;
    out += text.slice(from, word.start) + "Sotto";
    from = word.end;
  }
  return out + text.slice(from);
}

interface Word {
  /** The word lower-cased, with no surrounding punctuation. */
  lower: string;
  /** Index of its first character in the original text. */
  start: number;
  /** Index one past its last character. */
  end: number;
  /** True for the two-word spelling folded into one. */
  folded?: true;
}

/**
 * Every run of letters in `text`, in order, with where it sits — with the
 * {@link TWO_WORD_SPELLING} of the name folded into one word where it could
 * be an address, so every reader sees `soto` at the pair's offsets.
 */
function words(text: string): Word[] {
  const found: Word[] = [];
  const pattern = /\p{L}+/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const word = {
      lower: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    };
    const previous = found[found.length - 1];
    if (
      previous !== undefined &&
      previous.lower === TWO_WORD_SPELLING[0] &&
      word.lower === TWO_WORD_SPELLING[1] &&
      text.slice(previous.end, word.start).trim() === "" &&
      (startsSentence(text, previous.start) ||
        ADDRESS_WORDS.includes(found[found.length - 2]?.lower ?? ""))
    ) {
      found[found.length - 1] = { lower: "soto", start: previous.start, end: word.end, folded: true };
      continue;
    }
    found.push(word);
  }
  return found;
}

/**
 * Whether the wake word at `word` is being used to address Sotto: it starts a
 * sentence, or it follows "hey"/"okay"/"ok". Anything mid-sentence is somebody
 * talking *about* something — `Soto's Restaurant`, in the `no-wake` capture.
 */
function isAddressed(text: string, word: Word, previous: Word | undefined): boolean {
  if (startsSentence(text, word.start)) return true;
  if (previous === undefined || !ADDRESS_WORDS.includes(previous.lower)) return false;
  // "hey" and the wake word have to be next to each other: only spaces and a
  // comma may come between them.
  return text
    .slice(previous.end, word.start)
    .split("")
    .every((character) => character.trim() === "" || character === ",");
}

/** Whether the character at `index` opens a sentence. */
function startsSentence(text: string, index: number): boolean {
  for (let at = index - 1; at >= 0; at -= 1) {
    const character = text[at] as string;
    if (character.trim() === "" || OPENERS.has(character)) continue;
    return SENTENCE_ENDERS.has(character);
  }
  // Nothing but space before it: the start of the turn, which is where a
  // wake phrase usually is.
  return true;
}

/**
 * The question following a wake word that ends at `from`, or `null` when what
 * follows disqualifies it.
 *
 * Returns `null` for a possessive (`Soto's`), for a blocked following word
 * (`voce`), for a remainder that is neither introduced by a separator nor
 * shaped like a question, and for a wake word with nothing after it at all —
 * which is every partial up to the moment the speaker says more.
 */
function questionAfter(text: string, from: number, loose = false): string | null {
  const rest = text.slice(from);
  if (/^['’]s\b/i.test(rest)) return null;

  let at = 0;
  let separated = false;
  while (at < rest.length) {
    const character = rest[at] as string;
    if (character.trim() === "") {
      at += 1;
      continue;
    }
    if (SEPARATORS.has(character)) {
      separated = true;
      at += 1;
      continue;
    }
    break;
  }

  const question = rest.slice(at).trim();
  if (question === "") return null;

  const first = words(question)[0];
  if (first !== undefined && first.start === 0 && BLOCKED_FOLLOWING_WORDS.includes(first.lower)) {
    return null;
  }
  if (separated) return question;

  // No comma, so the words have to carry it: either it reads as a question
  // or it ends in a question mark.
  if (question.endsWith("?")) return question;
  if (first !== undefined && first.start === 0 && QUESTION_OPENERS.has(first.lower)) return question;
  if (loose && first !== undefined && first.start === 0 && LOOSE_QUESTION_OPENERS.has(first.lower)) {
    return question;
  }
  return null;
}

/**
 * Everything after the name, whether or not {@link detect} would trigger.
 *
 * V2-008b reuses an early classification when the final turn only *extends*
 * the partial it ran on, and the model's `question` was written before those
 * last words existed. The question has to come from the final text instead,
 * and it has to come out of text that the strict rules in {@link detect} may
 * well reject — a name mid-sentence, no comma, no wh-word. So this is the
 * loose reading: the first whole-word spelling that is not a possessive and
 * not `sotto voce`, and everything after it with any separator removed.
 *
 * Empty when there is no usable name in the text, which leaves the caller
 * with the model's own wording.
 */
export function questionAfterName(text: string, options: WakeOptions = {}): string {
  const spellings = options.spellings ?? DEFAULT_WAKE_SPELLINGS;
  const all = words(text);
  for (const word of all) {
    if (!spellings.includes(word.lower)) continue;
    const rest = text.slice(word.end);
    if (/^['’]s\b/i.test(rest)) continue;
    const next = words(rest)[0];
    if (next !== undefined && BLOCKED_FOLLOWING_WORDS.includes(next.lower)) continue;
    let at = 0;
    while (at < rest.length) {
      const character = rest[at] as string;
      if (character.trim() === "" || SEPARATORS.has(character)) {
        at += 1;
        continue;
      }
      break;
    }
    const question = rest.slice(at).trim();
    if (question !== "") return question;
  }
  return "";
}
