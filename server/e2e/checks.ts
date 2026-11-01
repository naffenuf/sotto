/**
 * What has to be true after a fixture has gone through the whole loop from
 * audio (PRD US-021).
 *
 * Every assertion the story names already exists as an integration test
 * against a *capture*; this is the same set against the real transcription,
 * which is the only part those tests fake. So the checks are written in terms
 * of the published contracts rather than of internals: the session folder
 * (US-008), `board.json` (US-009), the decision log (US-014), `answers.jsonl`
 * (US-018) and `artifacts/` (US-020). If a check here fails and its
 * integration test passes, the difference is the transcription.
 *
 * Pure, so `npm test` covers the judgement and the network only has to be
 * paid for the evidence.
 */
import { ANSWER_HEADLINE_MAX_CHARS } from "../../shared/answers.js";
import type { Board, Item } from "../../shared/board.js";
import type { StageCard } from "../../shared/cards.js";
import type {
  E2eCheck,
  E2eFiles,
  E2eObserved,
  E2eResearch,
  Stamped,
} from "../../shared/e2e.js";
import { QUESTION_FIXTURE, RESEARCH_FIXTURE } from "../../shared/e2e.js";
import type { MomentRecord } from "../../shared/eval.js";
import { CARD_ID_PREFIX } from "../interject/delivery.js";

/** Everything one fixture's checks are decided from. */
export interface E2eCheckInput {
  observed: E2eObserved;
  files: E2eFiles;
  /** The fixture's planted moments, placed against the turns it produced. */
  moments: MomentRecord[];
}

/**
 * Transcript lines a fixture has to produce.
 *
 * US-008's criterion is ten, which the two long conversations get as written;
 * the two 45-second ones get five, loose enough that a couple of lines merged
 * by the endpointer is not a failure and tight enough that a half-transcribed
 * conversation is.
 */
export const MIN_TRANSCRIPT_LINES: Record<string, number> = {
  brainstorm: 10,
  "moment-contradiction": 10,
  "ask-search": 5,
  "ask-diagram": 5,
  [QUESTION_FIXTURE]: 10,
  [RESEARCH_FIXTURE]: 10,
};

/** How many times each fixture addresses Sotto by name (US-017). */
export const EXPECTED_WAKE_TRIGGERS: Record<string, number> = {
  brainstorm: 0,
  "moment-contradiction": 0,
  "ask-search": 1,
  "ask-diagram": 1,
  // `offsite-plan` ends by asking Sotto to lay the dependencies out (US-017).
  [QUESTION_FIXTURE]: 1,
  [RESEARCH_FIXTURE]: 1,
};

/**
 * Words a board item may run to before it stops being glanceable.
 *
 * The prompt asks for twelve; this is the same allowance
 * `board.integration.test.ts` makes, which catches a model writing paragraphs
 * rather than one going a word over.
 */
const MAX_ITEM_WORDS = 20;

/** The budget the `moment-contradiction` script plants and then contradicts. */
const PLANTED_BUDGET = /\b(4,?000|four thousand)\b/i;

function check(name: string, ok: boolean, detail: string): E2eCheck {
  return { name, ok, detail };
}

/** Every item on the board that has not been dropped. */
function live(items: readonly Item[]): Item[] {
  return items.filter((item) => item.status !== "dropped");
}

function allItems(board: Board): Item[] {
  return [...board.constraints, ...board.points, ...board.questions, ...board.decisions];
}

/** The last push of each card, by id: what the stage ended up showing. */
export function finalCards(cards: readonly Stamped<StageCard>[]): StageCard[] {
  const latest = new Map<string, StageCard>();
  for (const { value } of cards) latest.set(value.id, value);
  return [...latest.values()];
}

/**
 * How many questions were handed to the answer agent out loud.
 *
 * Read off `answers.jsonl` rather than off the wake indicator: the indicator
 * goes up on a partial and can come back down as the speaker says more
 * (US-017), while a logged answer with a `turnId` is a trigger that was acted
 * on, which is what "exactly one trigger" means.
 */
export function spokenTriggers(files: E2eFiles): number {
  return files.answers.filter((answer) => answer.turnId !== null).length;
}

/** The checks every fixture gets: it ran, it was heard, it was written down. */
function commonChecks(input: E2eCheckInput): E2eCheck[] {
  const { observed, files } = input;
  const minLines = MIN_TRANSCRIPT_LINES[observed.fixture] ?? 1;
  const finals = observed.turns.map((stamped) => stamped.value);
  const ordered = finals.every(
    (turn, index) => index === 0 || turn.startMs >= (finals[index - 1] as typeof turn).startMs,
  );
  const wanted = EXPECTED_WAKE_TRIGGERS[observed.fixture] ?? 0;
  const triggers = spokenTriggers(files);

  return [
    check(
      "no errors",
      observed.error === undefined && observed.errors.length === 0,
      observed.error ?? observed.errors.join("; ") ?? "nothing went wrong",
    ),
    check(
      "session folder",
      files.session !== null && files.session.endedAt !== null && files.events > 0,
      files.session === null
        ? `no ${observed.sessionDir ?? "session folder"}`
        : `${files.events} frame(s), endedAt ${files.session.endedAt ?? "NOT SET"}`,
    ),
    check(
      "transcript",
      files.transcriptLines >= minLines &&
        finals.length > 0 &&
        finals.every((turn) => turn.text.trim() !== "") &&
        ordered,
      `${files.transcriptLines} line(s) (want >= ${minLines}), ${finals.length} final turn(s)` +
        (ordered ? "" : ", OUT OF ORDER"),
    ),
    check(
      "wake triggers",
      triggers === wanted,
      `${triggers} (want ${wanted}); indicator rose ${observed.wakeAtMs.length} time(s)`,
    ),
    // V2-021: Sotto spoke, and the spoken-so-far tracking worked. A line in
    // the transcript labelled `Sotto` exists only because something reported
    // *playing* the utterance (V2-008a), so it is the proof the alignment came
    // back and was read; the hello gives every conversation one.
    check(
      "voice",
      observed.voice.utterances > 0 &&
        observed.voice.characters > 0 &&
        observed.sottoTurns.length > 0 &&
        observed.sottoTurns.every((stamped) => stamped.value.text.trim() !== ""),
      `${observed.voice.utterances} utterance(s), ${observed.voice.characters} character(s), ` +
        `${observed.sottoTurns.length} line(s) heard`,
    ),
  ];
}

/** The board checks US-009 states for `brainstorm`, plus the generic ones. */
function boardChecks(input: E2eCheckInput): E2eCheck[] {
  const { observed, files } = input;
  const board = files.board;
  if (board === null) return [check("board updated", false, "no board.json")];

  const items = allItems(board);
  const tooLong = (item: Item): boolean =>
    item.text.trim() === "" ||
    item.text.split(/\s+/).length > MAX_ITEM_WORDS ||
    item.sourceTurnIds.length === 0;
  const checks = [
    check(
      "board updated",
      items.length > 0 && observed.boardPushes > 0,
      `${items.length} item(s), ${observed.boardPushes} push(es)`,
    ),
    check(
      "board items",
      !items.some(tooLong),
      items
        .filter(tooLong)
        .map((item) => JSON.stringify(item.text))
        .join(", ") || "all short and attributed",
    ),
  ];

  if (observed.fixture !== "brainstorm") return checks;

  const points = live(board.points).length;
  const decisions = live(board.decisions).length;
  const questions = live(board.questions).length;
  const summary = board.summary.trim();
  return [
    ...checks,
    check(
      "board shape",
      points >= 4 && decisions >= 1 && questions >= 1 && summary !== "",
      `${points} point(s) (want >= 4), ${decisions} decision(s), ${questions} question(s), ` +
        `summary ${summary === "" ? "EMPTY" : `${summary.length} chars`}`,
    ),
    check(
      "board.md",
      files.boardMarkdown.includes("# Board") &&
        live(board.points).every((item) => files.boardMarkdown.includes(item.text)),
      `${files.boardMarkdown.length} chars`,
    ),
  ];
}

/** `moment-contradiction`: the constraint went on the board and was defended. */
function momentChecks(input: E2eCheckInput): E2eCheck[] {
  const { observed, files, moments } = input;
  const moment = moments[0];
  if (moment === undefined) return [];

  const setup = new Set(moment.setupTurnIds);
  const constraints = files.board === null ? [] : live(files.board.constraints);
  const budget = constraints.filter((item) => PLANTED_BUDGET.test(item.text));
  const sourced = budget.filter((item) => item.sourceTurnIds.some((id) => setup.has(id)));
  const caught = deliveredForMoment(input, moment);

  return [
    check(
      "planted constraint",
      sourced.length > 0,
      sourced.length > 0
        ? sourced.map((item) => JSON.stringify(item.text)).join(", ")
        : "no $4,000 constraint citing a setup turn among " +
          JSON.stringify(constraints.map((item) => item.text)),
    ),
    check(
      `${moment.id} caught`,
      caught !== null,
      caught === null
        ? `nothing delivered about it; ${files.candidates} candidate(s), ` +
          `${interjections(observed).length} card(s)`
        : `${caught.variant} ${JSON.stringify(caught.headline)}`,
    ),
  ];
}

/** Every interjection or glow the policy delivered, last push of each. */
export function interjections(observed: E2eObserved): StageCard[] {
  return finalCards(observed.cards).filter(
    (card) => card.variant === "interject" || card.variant === "glow",
  );
}

/**
 * The card that raised `moment`, or `null`.
 *
 * Structural rather than judged: the delivered candidate has to be of the
 * moment's own type *and* rest its case on one of the turns the moment was
 * planted in. That is deliberately not a paraphrase test — `npm run eval` has
 * a judge for that — because this check has to come out the same every run.
 */
export function deliveredForMoment(
  input: E2eCheckInput,
  moment: MomentRecord,
): StageCard | null {
  const cited = new Set([...moment.setupTurnIds, ...moment.triggerTurnIds]);
  for (const card of interjections(input.observed)) {
    const decision = input.files.decisions[candidateIdOf(card.id)];
    if (decision?.type !== moment.type) continue;
    if ((card.evidence ?? []).some((quote) => cited.has(quote.turnId))) return card;
  }
  return null;
}

/** The candidate a delivered card was made from (US-015's derived id). */
export function candidateIdOf(cardId: string): string {
  return cardId.startsWith(CARD_ID_PREFIX) ? cardId.slice(CARD_ID_PREFIX.length) : cardId;
}

/** `brainstorm`: nothing worth raising a hand for, so no hand is raised. */
function quietChecks(input: E2eCheckInput): E2eCheck[] {
  const loud = interjections(input.observed).filter((card) => card.variant === "interject");
  return [
    check(
      "no interjections",
      loud.length === 0,
      loud.map((card) => JSON.stringify(card.headline)).join(", ") || "none",
    ),
  ];
}

/** `ask-search` / `ask-diagram`: the answer agent's contract (US-018). */
function answerChecks(input: E2eCheckInput, asks: RegExp): E2eCheck[] {
  const { files, observed } = input;
  const answers = files.answers;
  const answer = answers[0];
  const pushes = observed.cards.filter((stamped) => stamped.value.variant === "answer");
  const last = pushes.at(-1)?.value;

  const checks = [
    check(
      "one answer",
      answers.length === 1 &&
        answer !== undefined &&
        answer.status === "done" &&
        asks.test(answer.question),
      answer === undefined
        ? "nothing was answered"
        : `${answers.length} answer(s), status ${answer.status}` +
          (answer.error === undefined ? "" : ` (${answer.error})`) +
          `, asked ${JSON.stringify(answer.question)}`,
    ),
  ];
  if (answer === undefined) return checks;

  const headline = answer.headline.trim();
  checks.push(
    check(
      "answer shape",
      headline !== "" &&
        headline.length <= ANSWER_HEADLINE_MAX_CHARS &&
        !answer.headline.includes("\n"),
      `headline ${headline.length} chars (max ${ANSWER_HEADLINE_MAX_CHARS}): ` +
        JSON.stringify(headline),
    ),
    check(
      "answer card",
      pushes.length >= 2 &&
        new Set(pushes.map((stamped) => stamped.value.id)).size === 1 &&
        pushes[0]?.value.state === "thinking" &&
        last?.state === "ready" &&
        last.headline === answer.headline,
      `${pushes.length} push(es), ended ${last?.state ?? "nowhere"}`,
    ),
  );
  return checks;
}

/** `ask-search` only: it has to have read the web (US-018). */
function citationChecks(input: E2eCheckInput): E2eCheck[] {
  const answer = input.files.answers[0];
  const citations = answer?.citations ?? [];
  return [
    check(
      "citations",
      citations.length > 0 && citations.every((one) => /^https?:\/\//.test(one.url)),
      citations.length === 0
        ? `none; the detail was ${JSON.stringify(answer?.detailMd ?? "")}`
        : citations.map((one) => one.url).join(", "),
    ),
  ];
}

/** `ask-diagram` only: it drew, and what it drew is a document (US-020). */
function artifactChecks(input: E2eCheckInput): E2eCheck[] {
  const { files } = input;
  const answer = files.answers[0];
  const artifacts = answer?.artifacts ?? [];
  const artifact = artifacts[0];
  const file = artifact === undefined ? undefined : (artifact.path.split("/").at(-1) as string);
  const html = file === undefined ? undefined : files.artifactHtml[file];
  const remote = /<(?:link[^>]+href|script[^>]+src|img[^>]+src)\s*=\s*["']https?:/i;

  return [
    check(
      "one artifact",
      artifacts.length === 1 && file !== undefined && files.artifacts.includes(file),
      artifacts.length === 1
        ? `${file} (${files.artifacts.length} file(s) in artifacts/)`
        : `${artifacts.length} artifact(s); the answer was ` +
          JSON.stringify(answer?.headline ?? ""),
    ),
    check(
      "artifact is a drawing",
      html !== undefined && (html.includes("<svg") || html.includes("<div")) && !remote.test(html),
      html === undefined ? "nothing on disk" : `${html.length} bytes of self-contained HTML`,
    ),
  ];
}

/** Every research-ready card that reached the stage, first push first. */
export function researchCards(observed: E2eObserved): Stamped<StageCard>[] {
  const seen = new Set<string>();
  return observed.cards.filter((stamped) => {
    if (stamped.value.variant !== "research" || seen.has(stamped.value.id)) return false;
    seen.add(stamped.value.id);
    return true;
  });
}

/**
 * What the research pipeline did, off its own log and the stage (V2-021).
 *
 * The counts are decisions rather than cards, because two of the three
 * outcomes never become one: a `rejected` idea never searches and an
 * `unsourced` packet is thrown away (V2-013). The cards are taken from the bus
 * instead, keeping each id's *first* push — a packet brought forward because
 * somebody asked for it (V2-015) pushes its own card again, and the time that
 * matters here is when the group first saw it.
 */
export function researchFrom(input: E2eCheckInput): E2eResearch {
  const log = input.files.research;
  const counted = (predicate: (line: (typeof log)[number]) => boolean): number =>
    log.filter(predicate).length;
  return {
    ideas: counted((line) => line.kind === "idea"),
    queued: counted((line) => line.kind === "gate" && line.decision === "queued"),
    rejected: counted((line) => line.kind === "gate" && line.decision === "rejected"),
    gateFailed: counted((line) => line.kind === "gate" && line.decision === "failed"),
    localGateCalls: counted((line) => line.kind === "gate" && line.where === "local"),
    packets: counted((line) => line.kind === "packet" && line.outcome === "ready"),
    unsourced: counted((line) => line.kind === "packet" && line.outcome === "unsourced"),
    failed: counted((line) => line.kind === "packet" && line.outcome === "failed"),
    cardAtMs: researchCards(input.observed).map((stamped) => stamped.atMs),
    // V3-003: only a question the room wondered aloud carries one, so this is
    // empty for every fixture that never asked itself anything.
    questionToPacketMs: log.flatMap((line) =>
      line.kind === "packet" && line.questionToPacketMs !== undefined
        ? [line.questionToPacketMs]
        : [],
    ),
  };
}

/**
 * When the room asked Sotto its question, on the wall clock.
 *
 * The wake indicator going up is the earliest sign: it rises on the first
 * partial that matched (US-017), before the question has finished being
 * asked. A run where it never rose but an answer happened anyway falls back to
 * the answer card, which is late by a model call but still after the question.
 */
export function askedAtMs(observed: E2eObserved): number | null {
  const wake = observed.wakeAtMs[0];
  if (wake !== undefined) return wake;
  const answer = observed.cards.find((stamped) => stamped.value.variant === "answer");
  return answer?.atMs ?? null;
}

/**
 * {@link RESEARCH_FIXTURE}: it looked things up, showed one, and briefed from
 * it when asked (V2-021).
 *
 * The three criteria of the story, each read off a published contract rather
 * than judged: the packets off `research.jsonl` and `research/`, the card off
 * the bus with the moment it arrived, and the briefing off `answers.jsonl` —
 * `usedPacketIds` is V2-015's record of which packets an answer leaned on, so
 * "a spoken briefing that uses a packet" is a non-empty one plus words that
 * were really spoken.
 */
function researchChecks(input: E2eCheckInput): E2eCheck[] {
  const { files, observed } = input;
  const research = researchFrom(input);
  const asked = askedAtMs(observed);
  const before = research.cardAtMs.filter((atMs) => asked !== null && atMs < asked);
  const answer = files.answers.find((one) => one.turnId !== null);
  const used = answer?.usedPacketIds ?? [];
  const spoken = (answer?.spokenText ?? "").trim();
  // One `.json` and one `.md` per packet (V2-013), so two files each.
  const saved = files.researchFiles.filter((name) => name.endsWith(".json")).length;

  return [
    check(
      "research packets",
      research.packets > 0 && saved === research.packets,
      `${research.ideas} idea(s), ${research.queued} queued, ${research.rejected} rejected, ` +
        `${research.packets} packet(s) (${research.unsourced} unsourced, ${research.failed} failed), ` +
        `${saved} saved in research/`,
    ),
    check(
      "research card before the question",
      before.length > 0,
      asked === null
        ? "nobody asked Sotto anything"
        : `${before.length} of ${research.cardAtMs.length} card(s) before ` +
          `${(asked / 1000).toFixed(0)}s: ` +
          (research.cardAtMs.map((atMs) => `${(atMs / 1000).toFixed(0)}s`).join(", ") || "none"),
    ),
    check(
      "spoken briefing from a packet",
      used.length > 0 && spoken !== "",
      answer === undefined
        ? "nothing was answered out loud"
        : `${used.length} packet(s) used of ${answer.packetIds.length} given, ` +
          `${spoken.length} character(s) spoken`,
    ),
  ];
}

/** Every check for one fixture, in the order a reader wants them. */
export function checkFixture(input: E2eCheckInput): E2eCheck[] {
  const checks = [...commonChecks(input), ...boardChecks(input)];
  switch (input.observed.fixture) {
    case "brainstorm":
      return [...checks, ...quietChecks(input)];
    case "moment-contradiction":
      return [...checks, ...momentChecks(input)];
    case "ask-search":
      return [...checks, ...answerChecks(input, /competitors charge/i), ...citationChecks(input)];
    case "ask-diagram":
      return [...checks, ...answerChecks(input, /sketch/i), ...artifactChecks(input)];
    case RESEARCH_FIXTURE:
      return [...checks, ...answerChecks(input, /did you find/i), ...researchChecks(input)];
    default:
      return checks;
  }
}
