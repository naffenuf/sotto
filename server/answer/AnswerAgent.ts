/**
 * Answering a question somebody asked Sotto out loud (PRD US-018).
 *
 * The wake watcher (US-017) hands over a question; this makes the call and
 * puts the reply on the stage. Three things make it unlike the rest of the
 * pipeline:
 *
 *   - **The reply is prose, and it is searched.** `ModelClient.prose` is the
 *     Responses API with `web_search` and no schema, because the PRD's shape
 *     for an answer — "line 1 is a headline, then markdown" — is text, and
 *     text is the only kind of reply the API attaches `url_citation`
 *     annotations to (measured; `CLAUDE.md`).
 *   - **It arrives in pieces.** The card goes up `thinking` the moment the
 *     question lands, gets its headline as soon as line 1 is complete, and is
 *     finished when the model stops. One card id throughout, so the stage
 *     replaces it in place rather than growing three.
 *   - **It has its own queue.** An answer never waits for a board update or
 *     an observer look, and the group never waits for the board loop to let
 *     go of the model. Questions are answered one at a time, in order.
 *
 * While an answer is being written the interjection policy (US-014) holds
 * whatever it was going to say: Sotto talking over its own answer is the one
 * thing worse than Sotto staying quiet.
 */
import {
  TYPED_ASKER,
  splitAnswer,
  type Answer,
  type AnswerLogRecord,
  type AnswerText,
} from "../../shared/answers.js";
import {
  SHOW_HTML_TOOL,
  ShowHtmlArgsSchema,
  showHtmlJsonSchema,
  type Artifact,
  type ShowHtmlArgs,
} from "../../shared/artifacts.js";
import type { Board } from "../../shared/board.js";
import type { Citation, StageCard } from "../../shared/cards.js";
import type { SpeakerNames } from "../../shared/events.js";
import type { TurnUpdate } from "../../shared/turns.js";
import { renderBoardMarkdown } from "../board/markdown.js";
import type { Clock } from "../clock.js";
import { CARD_ID_PREFIX } from "../interject/delivery.js";
import { searchedIndex, resolveCitation } from "../interject/Verifier.js";
import { citationTitle, type FunctionTool, type ModelClient } from "../model/client.js";
import { PROMPTS, loadPrompt } from "../prompts/index.js";

/** The label an answer is tracked under on the clock, and in the model logs. */
export const ANSWER_TRACK_LABEL = "answer";

/**
 * How much of the conversation an answer is given: the last ten minutes of
 * final turns, as the PRD asks. A question means what it means in the
 * conversation it was asked in, and ten minutes is where that conversation is.
 */
export const ANSWER_CONTEXT_MS = 10 * 60_000;

/**
 * Reasoning + search + output budget for one answer. The model reasons,
 * searches several times, reads pages and then writes: measured against the
 * real API, one `ask-search`-style question took 19 s and four rounds of
 * search before the answer began.
 */
export const ANSWER_MAX_TOKENS = 12_288;

/**
 * The item-id prefix the model's *answer* carries, as opposed to the
 * narration it writes on the way there.
 *
 * A grounded reply is several `message` items — "I'll look up current
 * pricing", "the official pages didn't show it, I'll search inside them" —
 * interleaved with searches, and only the last one is the answer. Measured
 * against the real API (recorded in `CLAUDE.md`): the narration items are
 * `message`s whose ids begin `rs_`, the answer's begins `msg_`, and nothing
 * else in the stream tells them apart while it is still running. Each narration item also completes within a millisecond or two of
 * starting, so showing the first complete line of one would put
 * "I'll look up current pricing" on the stage as the headline for the fifteen
 * seconds it takes to write the real answer.
 *
 * So the streamed headline is only taken from an item whose id starts with
 * this. If the API ever renames them, the cost is the early headline — the
 * finished answer is read from the response's last message either way.
 */
export const ANSWER_ITEM_PREFIX = "msg_";

/**
 * What the model is told `show_html` is for (US-020).
 *
 * The *when* matters more than the *what*: the tool is there for answers that
 * are not sentences — a flow, a comparison, a layout — and offering it on
 * every question would turn "what do rivals charge" into a bar chart nobody
 * asked for.
 */
export const SHOW_HTML_DESCRIPTION =
  "Render a diagram, table, chart or screen mockup on the group's shared screen." +
  " Call this only when the answer is a shape rather than a sentence — a flow, a" +
  " comparison, a layout, a timeline — and at most once. After it is shown, write" +
  " your text answer as usual: the headline says what the picture shows.";

type Logger = Pick<Console, "log" | "warn">;

/** A question for Sotto, spoken (US-017) or typed (US-019). */
export interface AskedQuestion {
  /** Everything after the wake word, or the whole typed line. */
  question: string;
  /**
   * Who asked: a diarization label for a spoken question, so the name the
   * group has given it can be resolved now, or {@link TYPED_ASKER}.
   */
  askedBy: string | null;
  /** The turn it was asked in, or `null` when it was typed. */
  turnId: string | null;
}

export interface AnswerAgentOptions {
  /** The session's clock — simulated for a replay, real for a live session. */
  clock: Clock;
  model: ModelClient;
  /** The board as it stands, which is the question's context (US-009). */
  board: () => Board;
  /** Every final turn so far; the last {@link ANSWER_CONTEXT_MS} are used. */
  transcript: () => readonly TurnUpdate[];
  /** The names the group has given its diarization labels (US-007). */
  speakers: () => SpeakerNames;
  /**
   * Pushes the answer to the stage. Called several times for one answer — as
   * `thinking`, as a headline, and finished — always with the same id.
   */
  onCard: (card: StageCard, answer: Answer) => void;
  /** Records the finished answer in `answers.jsonl`, once (US-008). */
  onRecord: (record: AnswerLogRecord) => void;
  /**
   * Saves one piece of generated HTML and says where it can be read (US-020).
   *
   * `null` means it could not be saved — a session with no folder has nowhere
   * to put it — and the model is told so, in time to answer in words instead.
   * Absent means `show_html` is not offered at all.
   */
  onArtifact?: (artifact: ShowHtmlArgs) => Artifact | null;
  /**
   * The courtesy hook (US-014): true while an answer is being written, false
   * when the last one is done. Nothing is interjected in between.
   */
  onThinking?: (thinking: boolean) => void;
  /** The model status dot, shared with the board loop and the observer. */
  onModelState?: (state: "connecting" | "active" | "error", detail: string) => void;
  logger?: Logger;
}

/** One question waiting its turn, with the answer already on the stage. */
interface Queued {
  answer: Answer;
  asked: AskedQuestion;
}

export class AnswerAgent {
  private readonly clock: Clock;
  private readonly model: ModelClient;
  private readonly options: AnswerAgentOptions;
  private readonly logger: Logger;

  /** Questions asked but not started, oldest first. */
  private readonly queue: Queued[] = [];
  /** The answer being written, so {@link flush} can wait for it. */
  private running: Promise<void> | undefined;
  private asked = 0;
  private finished = 0;
  /**
   * Whether an answer has failed since the dot last went idle, so the queue
   * running dry does not quietly paint over the reason with "ready".
   */
  private failedSinceIdle = false;
  /** Whether the courtesy hook has been told an answer is being written. */
  private thinking = false;
  private stopped = false;

  constructor(options: AnswerAgentOptions) {
    this.clock = options.clock;
    this.model = options.model;
    this.options = options;
    this.logger = options.logger ?? console;
  }

  /** How many answers have finished, whether done or failed. */
  answers(): number {
    return this.finished;
  }

  /** How many questions are waiting or being answered. */
  pending(): number {
    return this.queue.length + (this.running === undefined ? 0 : 1);
  }

  /**
   * Takes one question and returns at once: the card is already on the stage
   * as `thinking`, and the call goes out behind it.
   */
  ask(asked: AskedQuestion): void {
    if (this.stopped) return;
    const question = asked.question.trim();
    if (question === "") return;
    this.asked += 1;
    const answer: Answer = {
      id: `ans-${this.asked}`,
      question,
      askedBy: this.askerName(asked.askedBy),
      headline: "",
      detailMd: "",
      citations: [],
      artifacts: [],
      status: "thinking",
      createdAtMs: this.clock.now(),
      latencyMs: 0,
    };
    this.logger.log(`[answer] ${answer.id} ${answer.askedBy} asked: ${question}`);
    // Thinking goes up before anything is known, because the point of it is
    // that the group can see their question was heard.
    this.setThinking(true);
    this.push(answer);
    this.queue.push({ answer, asked });
    this.pump();
  }

  /** Waits for every answer asked for so far, including the queued ones. */
  async flush(): Promise<void> {
    while (this.running !== undefined) await this.running;
  }

  /** No more questions. The answer in flight still finishes. Idempotent. */
  stop(): void {
    this.stopped = true;
  }

  /** Starts the next question if nothing is being answered. */
  private pump(): void {
    if (this.running !== undefined) return;
    const next = this.queue.shift();
    if (next === undefined) {
      this.setThinking(false);
      // A failure has already put its reason on the dot; leave it there to be
      // read rather than replacing it with "ready" a millisecond later.
      if (this.failedSinceIdle) this.failedSinceIdle = false;
      else if (!this.stopped) this.options.onModelState?.("active", "model client ready");
      return;
    }
    this.options.onModelState?.("connecting", `answering "${next.answer.question}"`);
    // Registered on the clock before `ask` returns, so a `max`-speed replay
    // does not run past a question it has only just heard.
    const running = this.answer(next).finally(() => {
      this.running = undefined;
      this.pump();
    });
    this.running = running;
    void this.clock.track(ANSWER_TRACK_LABEL, running);
  }

  /** Tells the policy whether an answer is being written, on a change only. */
  private setThinking(thinking: boolean): void {
    if (thinking === this.thinking) return;
    this.thinking = thinking;
    this.options.onThinking?.(thinking);
  }

  /** One answer, start to written-down finish. Never rejects. */
  private async answer(queued: Queued): Promise<void> {
    const { answer, asked } = queued;
    let pushedHeadline = "";
    // Filled in as the model draws (US-020), so a diagram can be on the stage
    // while the sentence under it is still being written.
    const artifacts: Artifact[] = [];
    try {
      const reply = await this.model.prose({
        label: ANSWER_TRACK_LABEL,
        system: loadPrompt(PROMPTS.answer),
        user: this.render(answer),
        maxTokens: ANSWER_MAX_TOKENS,
        functions: this.functions(answer, artifacts, () => pushedHeadline),
        onText: ({ itemId, text }) => {
          // Narration, not the answer: see ANSWER_ITEM_PREFIX.
          if (!itemId.startsWith(ANSWER_ITEM_PREFIX)) return;
          const partial = splitAnswer(text);
          // Only a *complete* first line goes out: a headline still being
          // typed must not reach the stage half-said.
          if (!partial.headlineComplete || partial.headline === pushedHeadline) return;
          pushedHeadline = partial.headline;
          this.push({
            ...answer,
            headline: partial.headline,
            artifacts: [...artifacts],
            latencyMs: this.elapsed(answer),
          });
        },
      });
      const text = splitAnswer(reply.text);
      const done: Answer = {
        ...answer,
        headline: text.headline,
        detailMd: text.detailMd,
        citations: this.citations(answer, text, reply.citations, reply.searchedUrls),
        artifacts: [...artifacts],
        status: "done",
        latencyMs: this.elapsed(answer),
      };
      this.finish(done, asked);
      this.logger.log(
        `[answer] ${done.id} answered in ${done.latencyMs} ms` +
          ` (${done.citations.length} citation(s)${reply.searched ? "" : ", no search"}` +
          `${done.artifacts.length === 0 ? "" : `, ${done.artifacts.length} artifact(s)`})` +
          `: ${done.headline}`,
      );
    } catch (error) {
      const detail = message(error);
      const failed: Answer = {
        ...answer,
        // Whatever reached the stage stays there — including a diagram that
        // was drawn before the words failed; the message says the rest is not
        // coming.
        headline: pushedHeadline,
        artifacts: [...artifacts],
        status: "error",
        latencyMs: this.elapsed(answer),
        error: detail,
      };
      this.logger.warn(`[answer] ${answer.id} failed: ${detail}`);
      this.failedSinceIdle = true;
      this.options.onModelState?.("error", detail);
      this.finish(failed, asked);
    }
  }

  /**
   * The tools this answer may use: `show_html`, or none (US-020).
   *
   * The handler is where an artifact becomes a file and a card. It never
   * throws — the model is told in words when the screen is unavailable or the
   * arguments did not fit, because an answer in sentences is a far better
   * outcome than no answer.
   */
  private functions(
    answer: Answer,
    artifacts: Artifact[],
    headline: () => string,
  ): FunctionTool[] {
    const save = this.options.onArtifact;
    if (save === undefined) return [];
    return [
      {
        name: SHOW_HTML_TOOL,
        description: SHOW_HTML_DESCRIPTION,
        parameters: showHtmlJsonSchema,
        run: (args) => {
          const parsed = ShowHtmlArgsSchema.safeParse(args);
          if (!parsed.success) {
            const why = parsed.error.issues.map((issue) => issue.message).join("; ");
            this.logger.warn(`[answer] ${answer.id} drew something unusable: ${why}`);
            return `That document could not be shown (${why}). Answer in words instead.`;
          }
          const artifact = save(parsed.data);
          if (artifact === null) {
            this.logger.warn(`[answer] ${answer.id} could not save "${parsed.data.title}"`);
            return "The shared screen is unavailable in this session, so nothing was shown. Answer in words instead.";
          }
          artifacts.push(artifact);
          this.logger.log(`[answer] ${answer.id} showed "${artifact.title}" (${artifact.path})`);
          // Straight to the stage: the group watches the diagram appear while
          // the model is still writing the line that goes under it.
          this.push({
            ...answer,
            headline: headline(),
            artifacts: [...artifacts],
            latencyMs: this.elapsed(answer),
          });
          return `"${artifact.title}" is on the screen now. Write your answer: the headline on line 1, then the detail.`;
        },
      },
    ];
  }

  /** The last push, and the one line in `answers.jsonl`. */
  private finish(answer: Answer, asked: AskedQuestion): void {
    this.finished += 1;
    this.push(answer);
    this.options.onRecord({ kind: "answer", ...answer, turnId: asked.turnId });
  }

  private push(answer: Answer): void {
    this.options.onCard(cardForAnswer(answer), answer);
  }

  private elapsed(answer: Answer): number {
    return Math.max(0, this.clock.now() - answer.createdAtMs);
  }

  /** The name the group would use for whoever asked. */
  private askerName(askedBy: string | null): string {
    if (askedBy === null || askedBy.trim() === "") return TYPED_ASKER;
    if (askedBy === TYPED_ASKER) return TYPED_ASKER;
    return this.options.speakers()[askedBy] ?? askedBy;
  }

  /** The user message for one question. */
  private render(answer: Answer): string {
    const turns = recentTurns(this.options.transcript(), this.clock.now());
    return renderAnswerRequest(this.options.board(), turns, this.options.speakers(), answer);
  }

  /**
   * The sources the card shows, in the PRD's order of trust.
   *
   * The reply's `url_citation` annotations come first: those are the API's own
   * record of which page each sentence rests on, and a prose answer really
   * does carry them (measured — a JSON one never does). The pages the model
   * listed under "Sources:" fill in behind them, each **resolved against what
   * the search actually returned**, the same way a verification's citations
   * are (US-013): a URL the search never produced is dropped rather than shown
   * to a group as a link somebody will click.
   */
  private citations(
    answer: Answer,
    text: AnswerText,
    annotated: readonly Citation[],
    searchedUrls: readonly string[],
  ): Citation[] {
    const byUrl = new Map<string, Citation>();
    for (const citation of annotated) byUrl.set(citation.url, citation);
    const searched = searchedIndex(searchedUrls);
    for (const listed of text.sources) {
      const url = resolveCitation(listed.url, searched);
      if (url === undefined) {
        this.logger.warn(`[answer] ${answer.id} cited a page it never opened: ${listed.url}`);
        continue;
      }
      if (byUrl.has(url)) continue;
      byUrl.set(url, { url, title: citationTitle(listed.title, url) });
    }
    return [...byUrl.values()];
  }
}

/** The card id one answer gets, so the stage replaces it in place. */
export function answerCardId(answerId: string): string {
  return `${CARD_ID_PREFIX}${answerId}`;
}

/**
 * The card for one answer, at whatever stage it has reached — pure, and
 * called again for every piece that arrives.
 *
 * `thinking` with an empty headline is a card with nothing but the question
 * on it, which is exactly what the group should see while Sotto is reading.
 */
export function cardForAnswer(answer: Answer): StageCard {
  return {
    id: answerCardId(answer.id),
    variant: "answer",
    state: answer.status === "done" ? "ready" : answer.status,
    createdAtMs: answer.createdAtMs,
    headline: answer.headline,
    question: answer.question,
    askedBy: answer.askedBy,
    ...(answer.detailMd.trim() === "" ? {} : { detailMd: answer.detailMd }),
    ...(answer.citations.length === 0 ? {} : { citations: answer.citations }),
    ...(answer.artifacts.length === 0
      ? {}
      : {
          artifacts: answer.artifacts.map((artifact) => ({
            title: artifact.title,
            url: artifact.url,
          })),
        }),
    ...(answer.error === undefined || answer.error === ""
      ? {}
      : { message: answer.error }),
  };
}

/** The final turns from the last {@link ANSWER_CONTEXT_MS} of conversation. */
export function recentTurns(
  turns: readonly TurnUpdate[],
  nowMs: number,
): readonly TurnUpdate[] {
  const from = nowMs - ANSWER_CONTEXT_MS;
  return turns.filter((turn) => (turn.endMs ?? turn.startMs) >= from);
}

/**
 * The user message for one question: the board, the conversation, then the
 * question itself.
 *
 * The question goes last, and is the only thing in the message phrased as an
 * instruction, because everything above it is context the model is meant to
 * read the question *through* — "what do the main competitors charge" is
 * about the product on the board. Speakers are named as the group named them
 * (US-007), since the answer may have to address one of them by name.
 */
export function renderAnswerRequest(
  board: Board,
  turns: readonly TurnUpdate[],
  speakers: SpeakerNames,
  answer: Answer,
): string {
  const blocks = [
    "## The group's board",
    renderBoardMarkdown(board).trim(),
    "## What they have been saying",
    turns.length === 0
      ? "_nothing has been transcribed yet_"
      : turns.map((turn) => renderTurn(turn, speakers)).join("\n"),
    // A typed question (US-019) is the same question by another route, but
    // it has no speaker to name and nobody said it in the room.
    answer.askedBy === TYPED_ASKER
      ? "## Somebody just typed this question to you"
      : `## ${answer.askedBy} just asked you, out loud`,
    answer.question,
    "Answer it: the headline on line 1, then the detail, then the pages you used.",
  ];
  return blocks.join("\n\n");
}

/** `Maya (01:23): text` — a name, because the answer may have to use it. */
function renderTurn(turn: TurnUpdate, speakers: SpeakerNames): string {
  const label = turn.speaker;
  const who = label === null ? "?" : (speakers[label] ?? label);
  return `${who} (${stamp(turn.startMs)}): ${turn.text.replace(/\s+/g, " ").trim()}`;
}

function stamp(offsetMs: number): string {
  const seconds = Math.max(0, Math.round(offsetMs / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
