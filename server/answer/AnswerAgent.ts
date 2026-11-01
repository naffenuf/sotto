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
 *
 * V2-015 gave it the session's background research (V2-013). Every question
 * is answered with the packets in context, and a question that *asks* what
 * Sotto found is a **briefing**: the packets it is about come forward on the
 * stage, open, and the spoken half starts within a few hundred milliseconds,
 * because there is nothing to search for and so neither an acknowledgment nor
 * a holding line to wait through.
 *
 * V2-005 gave it a voice, which changes the shape of the reply rather than
 * adding a step after it. The model now writes **two halves** — the sentences
 * Sotto says out loud, then the headline and detail the stage shows
 * ({@link splitSpokenAnswer}) — and the spoken half comes first precisely so
 * that it can be read out a sentence at a time while the screen half is still
 * being written. An acknowledgment covers the ten to twenty seconds before
 * the first sentence exists ({@link chooseAcknowledgment}), and a muted Sotto
 * skips all of it and behaves exactly as the core build did.
 */
import {
  SCREEN_HEADING_TEXT,
  SPOKEN_HEADING_TEXT,
  TYPED_ASKER,
  splitAnswer,
  splitSpokenAnswer,
  type Answer,
  type AnswerLogRecord,
  type AnswerText,
  type SpokenAnswerText,
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
import {
  briefingOpener,
  packetSourceUrls,
  packetsForBriefing,
  renderPacketsForAnswer,
  type ResearchPacket,
} from "../../shared/research.js";
import { sottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { renderBoardMarkdown } from "../board/markdown.js";
import { systemClock, type Clock } from "../clock.js";
import { CARD_ID_PREFIX } from "../interject/delivery.js";
import { searchedIndex, resolveCitation } from "../interject/Verifier.js";
import { citationTitle, type FunctionTool, type ModelClient } from "../model/client.js";
import { PROMPTS, loadPrompt } from "../prompts/index.js";
import type { VoiceOut } from "../voice/voiceOut.js";
import { chooseAcknowledgment, searchLikely } from "./ack.js";
import { writeFirstLine } from "./firstLine.js";
import { splitSentences } from "./sentences.js";
import { SpokenAnswer, type SpokenResult } from "./SpokenAnswer.js";
import { classifyCommand } from "./command.js";

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
 * How long the searched answer waits for the holding line before going out
 * without it (V2-008c).
 *
 * The two calls run together, but the second one is worth a moment's head
 * start: a continuation that was *told* what the room has already heard does
 * not repeat it, and nothing else can tell it — the searched call is built
 * once, long before the line it would have to be told about exists.
 *
 * Four seconds, from measurement rather than taste. Across four real
 * `ask-search` runs the line reached the voice **1.9–3.3 s** after the
 * question, and the line itself is about five seconds of speech — so a head
 * start inside that is hidden behind speech the room is already listening to
 * and costs the room nothing. 1.5 s and 3 s both expired just short of some of
 * those and threw the context away for nothing. Four is also the PRD's target
 * for the acknowledgment-to-first-sentence wait: a line slower than this has
 * already missed its own point, so there is nothing to gain by waiting longer.
 *
 * On the **wall** clock, like every other number the room feels: a `max`-speed
 * replay's session clock does not move while a model call is in flight.
 */
export const FIRST_LINE_CONTEXT_WAIT_MS = 4_000;

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
  /** V2-007: continue resumes after heard text rather than repeating the original reply. */
  resume?: boolean;
  /**
   * V2-008b: real time the question's `speechEnd` reached the server, so the
   * log can say what the room waited from the end of the question to the
   * first sound. Absent for a typed question and for a replay.
   */
  heardAtMs?: number;
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
   * Every research packet this session has produced (V2-013, V2-015).
   *
   * Handed to the model with *every* question, not only the ones that ask for
   * it: the research is about what the group is doing, so it is context in the
   * same way the board is. Absent means a session with no research pipeline,
   * which answers exactly as the core build did.
   */
  packets?: () => readonly ResearchPacket[];
  /**
   * Somebody asked for research, and these are the packets being briefed from
   * (V2-015). Called once per answer, before a word is said, so their cards
   * can come forward on the stage while Sotto talks about them.
   */
  onBriefing?: (packets: readonly ResearchPacket[]) => void;
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
  /**
   * Where the answer is said out loud (V2-005). Absent means screen only,
   * which is also what a muted or unattended voice resolves to at `begin()`.
   */
  voice?: VoiceOut;
  /**
   * Real time, for `ackMs` and `firstAudioMs`. Defaults to {@link systemClock}
   * and is never the session clock: a `max`-speed replay's session clock does
   * not move while a model call is in flight, so it would report zero for
   * speech that really did take a second.
   */
  wallClock?: Clock;
  /**
   * Where "now" is on the transcription stream's timeline (V2-008a), which is
   * what {@link TurnUpdate.startMs} always means. Read when playback of the
   * answer starts, so Sotto's own line lands beside the turns it answers
   * rather than at the server's uptime. Defaults to the session clock, which
   * is the same timeline in a replay and offset from it in a live session.
   */
  streamNow?: () => number;
  /**
   * One line of Sotto's own speech, for the transcript (V2-008a).
   *
   * Called once per answer that was really heard, with Sotto's **own** text —
   * never the microphone's version of it — and only after the utterance is
   * over, because whether it was cut off decides what the entry holds. A
   * muted answer, and an acknowledgment, produce nothing here.
   */
  onSpoken?: (turn: TurnUpdate) => void;
  onTiming?: (event: Record<string, unknown>) => void;
  logger?: Logger;
}

/** One question waiting its turn, with the answer already on the stage. */
interface Queued {
  answer: Answer;
  asked: AskedQuestion;
  /** When it arrived, in real time, which is what the voice latencies count from. */
  askedAtWallMs: number;
}

export class AnswerAgent {
  private readonly clock: Clock;
  private readonly wallClock: Clock;
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
  /** Kept until playback completes, so barge-in can cancel even after model generation ends. */
  private activeSpeech: SpokenAnswer | undefined;
  /** The previous cut-off answer survives a stop command for later follow-ups. */
  private interrupted: Answer | undefined;
  /** Commands stay ordered even if classification finishes at different speeds. */
  private commands: Promise<void> = Promise.resolve();
  /** A newer interruption supersedes a command still being classified. */
  private commandVersion = 0;

  /** V2-007: yields the floor immediately, including during acknowledgment or socket opening. */
  interrupt(): Promise<number | null> {
    this.commandVersion += 1;
    const flushed = this.options.voice?.interrupt?.() ?? Promise.resolve(null);
    this.activeSpeech?.cancel();
    return flushed;
  }

  /** Classifies only final human text, once cancellation has already happened. */
  command(asked: AskedQuestion): void {
    if (this.stopped) return;
    // The acknowledgment may already have ended while the model is still
    // thinking. A final stop in that silent gap must cancel the future speech too.
    if (this.activeSpeech !== undefined) void this.interrupt();
    const version = ++this.commandVersion;
    this.commands = this.commands.then(async () => {
      try {
        const command = await classifyCommand(this.model, asked.question);
        if (this.stopped || version !== this.commandVersion) return;
        this.options.onTiming?.({
          stage: "voice_command", atMs: this.clock.now(), turnId: asked.turnId,
          command: command.command,
        });
        if (command.command === "stop") return;
        // Let the interrupted answer finish recording its flushed position before
        // rendering context for the follow-up. Its speech feeder stays cancelled.
        if (this.running !== undefined) await this.running;
        if (this.stopped || version !== this.commandVersion) return;
        if (command.command === "continue") {
          if (this.interrupted === undefined) return;
          this.ask({ ...asked, question: "Continue from where you were cut off.", resume: true });
        } else {
          this.ask({ ...asked, question: command.question });
        }
      } catch (error) {
        this.logger.warn(`[voice] could not classify command: ${message(error)}`);
      }
    });
    void this.clock.track("voice_command", this.commands);
  }

  constructor(options: AnswerAgentOptions) {
    this.clock = options.clock;
    this.wallClock = options.wallClock ?? systemClock;
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
      spokenText: "",
      ackMs: null,
      firstAudioMs: null,
      firstLineMs: null,
      continuationMs: null,
      packetIds: [],
      usedPacketIds: [],
    };
    this.logger.log(`[answer] ${answer.id} ${answer.askedBy} asked: ${question}`);
    this.options.onTiming?.({ stage: "answer_queued", atMs: this.clock.now(), answerId: answer.id, turnId: asked.turnId });
    // Thinking goes up before anything is known, because the point of it is
    // that the group can see their question was heard.
    this.setThinking(true);
    this.push(answer);
    this.queue.push({ answer, asked, askedAtWallMs: this.wallClock.now() });
    this.pump();
  }

  /** Waits for every answer asked for so far, including the queued ones. */
  async flush(): Promise<void> {
    await this.commands;
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
    this.options.onTiming?.({ stage: "answer_start", atMs: this.clock.now(), answerId: answer.id, turnId: asked.turnId });
    let pushedHeadline = "";
    /** The spoken half as far as it has been handed to the voice. */
    let spokenText = "";
    /**
     * Stream time when the answer's first sentence went to the voice, which is
     * playback start to within ElevenLabs' first chunk (measured at 299 ms).
     * Null while nothing has been said, which is also the muted case.
     */
    let spokeAtStreamMs: number | null = null;
    // Filled in as the model draws (US-020), so a diagram can be on the stage
    // while the sentence under it is still being written.
    const artifacts: Artifact[] = [];
    const speech = this.speech(queued);
    this.activeSpeech = speech;
    // V2-015: the research this session has done is context for every
    // question, and when the question is *asking* for it the packets it is
    // asking about also come forward on the stage, open, while Sotto talks.
    const packets = this.options.packets?.() ?? [];
    const briefing = asked.resume === true ? [] : packetsForBriefing(answer.question, packets);
    if (briefing.length > 0) {
      this.logger.log(
        `[answer] ${answer.id} briefing from ${briefing.map((one) => one.id).join(", ")}`,
      );
      this.options.onTiming?.({
        stage: "answer_briefing", atMs: this.clock.now(), answerId: answer.id,
        turnId: asked.turnId, packetIds: briefing.map((one) => one.id),
      });
      this.options.onBriefing?.(briefing);
    }
    // Out before the model has written a word: ten to twenty seconds of
    // silence after somebody says Sotto's name reads as "it didn't hear me".
    // A briefing has nothing to wait for, so it says something real instead
    // ({@link briefingOpener}) rather than acknowledging and then pausing.
    if (!asked.resume && briefing.length === 0) {
      speech?.acknowledge(chooseAcknowledgment(answer.question));
    }

    // V2-008c: a searched answer leaves the room in silence for eight to
    // thirteen seconds after the acknowledgment. A second, far cheaper call
    // writes one orienting sentence from the conversation alone, said while
    // the search is still running — and the searched answer is told what it
    // was, so it carries straight on rather than starting again.
    const holding = new AbortController();
    /** The holding line, once it has really been taken by the voice. */
    let firstLineText = "";
    /** Whether the searched call was told about it; see {@link FIRST_LINE_CONTEXT_WAIT_MS}. */
    let inContext = false;
    /** Everything the room hears, which is the holding line and then the answer. */
    const aloud = (): string =>
      firstLineText === "" ? spokenText : `${firstLineText} ${spokenText}`;
    const wantsFirstLine = briefing.length > 0 || this.wantsFirstLine(queued);
    // A briefing's opening line is written here rather than by a model: the
    // findings are already in hand, so the only thing left to wait for is the
    // voice, and that is what makes it the fastest answer Sotto gives.
    const opening = briefing.length > 0
      ? Promise.resolve(speech === undefined ? "" : briefingOpener(briefing))
      : wantsFirstLine
        ? this.holdingLine(queued, holding.signal)
        : noLine();
    const firstLine = opening
      .then((line) => {
        if (line === "" || speech?.sayFirstLine(line) !== true) return;
        firstLineText = line;
        spokeAtStreamMs ??= this.streamNow();
        this.options.onTiming?.({
          stage: "answer_first_line", atMs: this.clock.now(), answerId: answer.id,
          turnId: asked.turnId, words: line.split(/\s+/).length,
        });
        this.push({ ...answer, spokenText: aloud(), latencyMs: this.elapsed(answer) });
      });

    /** True once the whole spoken half has gone to the voice. */
    let said = false;
    /**
     * Hands the voice every sentence of the spoken half that is finished, and
     * says whether anything new went over — which is also when the card is
     * worth pushing again, so the transcript of the answer fills in a
     * sentence at a time rather than a token at a time.
     */
    const feed = (halves: SpokenAnswerText): boolean => {
      if (said) return false;
      if (!halves.spoken.startsWith(spokenText)) {
        // The first line only became a heading once its colon arrived. Carry
        // on from here: saying a sentence twice is worse than losing one.
        this.logger.warn(`[answer] ${answer.id} re-read the start of its spoken half`);
        spokenText = halves.spoken;
        return false;
      }
      const rest = halves.spoken.slice(spokenText.length);
      // The answer has written a sentence of its own: whatever the holding
      // line was going to be, it is too late to be worth saying.
      if (rest.trim() !== "") holding.abort();
      if (halves.spokenComplete) {
        said = true;
        spokenText = halves.spoken;
        const tail = rest.trim();
        if (tail !== "") {
          spokeAtStreamMs ??= this.streamNow();
          speech?.say(tail);
        }
        return tail !== "";
      }
      const { sentences, tail } = splitSentences(rest);
      if (sentences.length === 0) return false;
      spokeAtStreamMs ??= this.streamNow();
      for (const sentence of sentences) speech?.say(sentence);
      spokenText = halves.spoken.slice(0, halves.spoken.length - tail.length);
      return true;
    };

    try {
      // A moment's head start, so the continuation can be told what the room
      // has already heard. Bounded: a slow line never holds the answer up.
      if (wantsFirstLine) await this.atMost(firstLine, FIRST_LINE_CONTEXT_WAIT_MS);
      // Whether it got there in time, which is the one thing that decides
      // whether the continuation can know not to say it again.
      inContext = firstLineText !== "";
      const reply = await this.model.prose({
        label: ANSWER_TRACK_LABEL,
        system: loadPrompt(PROMPTS.answer),
        user: this.render(answer, asked.resume === true, firstLineText, packets, briefing),
        maxTokens: ANSWER_MAX_TOKENS,
        functions: this.functions(answer, artifacts, () => pushedHeadline, aloud),
        onText: ({ itemId, text }) => {
          // Narration, not the answer: see ANSWER_ITEM_PREFIX.
          if (!itemId.startsWith(ANSWER_ITEM_PREFIX)) return;
          const halves = splitSpokenAnswer(text);
          const spoke = feed(halves);
          // Only a *complete* first line of the screen half goes out: a
          // headline still being typed must not reach the stage half-said.
          const partial = halves.screen === "" ? undefined : splitAnswer(halves.screen);
          const headline =
            partial !== undefined && partial.headlineComplete && partial.headline !== pushedHeadline;
          if (headline) pushedHeadline = partial.headline;
          if (!spoke && !headline) return;
          this.push({
            ...answer,
            headline: pushedHeadline,
            spokenText: aloud(),
            artifacts: [...artifacts],
            latencyMs: this.elapsed(answer),
          });
        },
      });
      const halves = splitSpokenAnswer(reply.text);
      // Whatever the stream never completed a sentence of: the reply is
      // finished now, so the rest of it is sayable.
      feed({ ...halves, spokenComplete: true });
      const text = halves.screen === "" ? screenFromSpoken(halves.spoken) : splitAnswer(halves.screen);
      const spoken = await speech?.done();
      this.recordVoiceLatency(answer, queued, spoken, inContext);
      const citations = this.citations(answer, text, reply.citations, reply.searchedUrls, briefing);
      const done: Answer = {
        ...answer,
        headline: text.headline,
        detailMd: text.detailMd,
        citations,
        ...packetsUsed(packets, briefing, citations),
        artifacts: [...artifacts],
        status: "done",
        latencyMs: this.elapsed(answer),
        spokenText: aloud(),
        ...voiceTimings(spoken),
      };
      this.recordSpeech(answer, spoken, aloud(), spokeAtStreamMs);
      this.finish(done, asked);
      this.logger.log(
        `[answer] ${done.id} answered in ${done.latencyMs} ms` +
          ` (${done.citations.length} citation(s)${reply.searched ? "" : ", no search"}` +
          `${done.artifacts.length === 0 ? "" : `, ${done.artifacts.length} artifact(s)`}` +
          `${spoken?.spoke === true ? `, spoken after ${done.firstAudioMs ?? "?"} ms` : ", on screen only"}` +
          `${spoken?.interrupted === true ? ", cut off" : ""})` +
          `: ${done.headline}`,
      );
    } catch (error) {
      const detail = message(error);
      // Whatever has already been said is still being said: the words that
      // reached the room were true when they were spoken, and cutting the
      // voice off mid-sentence would be the only audible sign of a failure
      // the card is about to explain anyway.
      const spoken = await speech?.done();
      this.recordVoiceLatency(answer, queued, spoken, inContext);
      const failed: Answer = {
        ...answer,
        // Whatever reached the stage stays there — including a diagram that
        // was drawn before the words failed; the message says the rest is not
        // coming.
        headline: pushedHeadline,
        artifacts: [...artifacts],
        status: "error",
        latencyMs: this.elapsed(answer),
        spokenText: aloud(),
        ...voiceTimings(spoken),
        ...packetsUsed(packets, briefing, []),
        error: detail,
      };
      this.recordSpeech(answer, spoken, aloud(), spokeAtStreamMs);
      this.logger.warn(`[answer] ${answer.id} failed: ${detail}`);
      this.failedSinceIdle = true;
      this.options.onModelState?.("error", detail);
      this.finish(failed, asked);
    } finally {
      // Nothing may outlive the answer it belongs to: a `max`-speed replay
      // tracks this whole method, and a line arriving after it would have
      // nowhere to be said.
      holding.abort();
      await firstLine;
      if (this.activeSpeech === speech) this.activeSpeech = undefined;
    }
  }

  /**
   * Whether this question gets a holding line (V2-008c).
   *
   * Only a question that looks like a search leaves a gap worth filling —
   * "what did we decide" is answered from the board in a second or two. There
   * is no point writing one with no voice configured, since nothing would say
   * it, and a `continue` after a barge-in is already mid-sentence.
   *
   * A briefing (V2-015) never gets here: its opening line is
   * {@link briefingOpener}, which costs no call because the findings are
   * already in hand.
   */
  private wantsFirstLine(queued: Queued): boolean {
    if (this.options.voice === undefined) return false;
    if (queued.asked.resume === true) return false;
    return searchLikely(queued.answer.question);
  }

  /** The holding line for one question, or `""`. Never rejects. */
  private async holdingLine(queued: Queued, signal: AbortSignal): Promise<string> {
    const { answer } = queued;
    try {
      const line = await writeFirstLine(
        this.model,
        renderFirstLineRequest(
          this.options.board(),
          recentTurns(this.options.transcript()),
          this.options.speakers(),
          answer,
        ),
        signal,
      );
      // Abandoned while it was being written: the answer is already talking.
      return signal.aborted ? "" : line;
    } catch (error) {
      if (!signal.aborted) {
        this.logger.warn(`[answer] ${answer.id} had no first line: ${message(error)}`);
      }
      return "";
    }
  }

  /**
   * Waits for `work`, but never longer than `ms` of real time.
   *
   * The timer is on the wall clock, never the session's: a tracked task may
   * not await one of the session clock's timers, and this runs inside one.
   */
  private async atMost(work: Promise<unknown>, ms: number): Promise<void> {
    let reached!: () => void;
    const deadline = new Promise<void>((resolve) => {
      reached = resolve;
    });
    // Both, always: cancelling a timer is not resolving its promise.
    const cancel = this.wallClock.setTimeout(() => reached(), ms);
    await Promise.race([work.then(() => {}, () => {}), deadline]);
    cancel();
    reached();
  }

  /**
   * The voice for one answer, or `undefined` when there is none configured.
   *
   * A {@link SpokenAnswer} is built per answer rather than per session: it
   * holds the two utterances and the latencies of exactly one reply, and the
   * next question starts again from silence.
   */
  private speech(queued: Queued): SpokenAnswer | undefined {
    const voice = this.options.voice;
    if (voice === undefined) return undefined;
    return new SpokenAnswer({
      voice,
      wallClock: this.wallClock,
      askedAtMs: queued.askedAtWallMs,
      logger: this.logger,
    });
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
    spokenText: () => string,
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
            spokenText: spokenText(),
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
    if (answer.spokenSoFar !== undefined) this.interrupted = answer;
    else if (answer.status === "done") this.interrupted = undefined;
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

  /** Stream time now; the session clock is the same timeline in a replay. */
  private streamNow(): number {
    return this.options.streamNow?.() ?? this.clock.now();
  }

  /**
   * Writes down what Sotto actually said out loud, as one final turn on the
   * conversation's timeline (V2-008a).
   *
   * Nothing is recorded unless the room heard it: a muted or unattended
   * answer never opened an utterance, and a cut-off one holds only
   * `spokenSoFar` — what playback confirmed — rather than the sentences the
   * model was still writing.
   */
  private recordSpeech(
    answer: Answer,
    spoken: SpokenResult | undefined,
    spokenText: string,
    startMs: number | null,
  ): void {
    if (spoken?.spoke !== true || startMs === null) return;
    const text = spoken.interrupted ? spoken.spokenSoFar : spokenText;
    // Cut off before any report came back: nobody can say what was heard, so
    // claiming a line would be worse than leaving the transcript short.
    if (text.trim() === "") return;
    const turn = sottoTurn({
      utteranceId: answer.id,
      text,
      startMs,
      interrupted: spoken.interrupted,
    });
    this.options.onTiming?.({
      stage: "sotto_turn", atMs: this.clock.now(), answerId: answer.id,
      turnId: turn.turnId, startMs, interrupted: spoken.interrupted,
      characters: turn.text.length,
    });
    this.options.onSpoken?.(turn);
  }

  /**
   * What the room waited for, in the units the room felt (V2-008b).
   *
   * `ackMs` and `firstAudioMs` count from the question arriving at the answer
   * agent, which is a moment only the server knows. The number the PRD sets a
   * target for starts earlier: the end of the question, which is the
   * `speechEnd` the address watcher stamped on its way past
   * ({@link AskedQuestion.heardAtMs}). Null for a typed question, and for a
   * replay whose turns never closed in real time.
   */
  private recordVoiceLatency(
    answer: Answer,
    queued: Queued,
    spoken: SpokenResult | undefined,
    /** V2-008c: whether the searched call was told about the holding line. */
    firstLineInContext: boolean,
  ): void {
    if (spoken === undefined) return;
    const heardAtMs = queued.asked.heardAtMs;
    const toAsk = heardAtMs === undefined
      ? null
      : Math.max(0, queued.askedAtWallMs - heardAtMs);
    const from = (latency: number | null): number | null =>
      toAsk === null || latency === null ? null : toAsk + latency;
    this.options.onTiming?.({
      stage: "answer_voice", atMs: this.clock.now(), answerId: answer.id,
      turnId: queued.asked.turnId, ackMs: spoken.ackMs, firstAudioMs: spoken.firstAudioMs,
      firstLineMs: spoken.firstLineMs, continuationMs: spoken.continuationMs,
      firstLineInContext,
      // The PRD's V2-008c target, in the units it sets it in: the room waited
      // this long after the acknowledgment for a real sentence.
      ackToAnswerMs: spoken.ackMs === null || spoken.firstAudioMs === null
        ? null
        : spoken.firstAudioMs - spoken.ackMs,
      speechEndToAskMs: toAsk, speechEndToAckMs: from(spoken.ackMs),
      speechEndToAnswerMs: from(spoken.firstAudioMs),
    });
  }

  /** The name the group would use for whoever asked. */
  private askerName(askedBy: string | null): string {
    if (askedBy === null || askedBy.trim() === "") return TYPED_ASKER;
    if (askedBy === TYPED_ASKER) return TYPED_ASKER;
    return this.options.speakers()[askedBy] ?? askedBy;
  }

  /** The user message for one question. */
  private render(
    answer: Answer,
    resume: boolean,
    firstLine: string,
    packets: readonly ResearchPacket[],
    briefing: readonly ResearchPacket[],
  ): string {
    const turns = recentTurns(this.options.transcript());
    const request = renderAnswerRequest(
      this.options.board(), turns, this.options.speakers(), answer,
      { firstLine, packets, briefing },
    );
    if (this.interrupted === undefined) return request;
    return `${request}\n\n## Your previous answer was cut off\n${JSON.stringify({
      question: this.interrupted.question,
      fullAnswer: this.interrupted.spokenText,
      spokenSoFar: this.interrupted.spokenSoFar,
    })}\n${resume
      ? "Resume immediately after spokenSoFar, completing any interrupted sentence. Do not repeat what was heard."
      : "The room heard only spokenSoFar. Use this context to answer the new request."}`;
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
    briefing: readonly ResearchPacket[],
  ): Citation[] {
    const byUrl = new Map<string, Citation>();
    for (const citation of annotated) byUrl.set(citation.url, citation);
    // A briefing (V2-015) rests on pages the *research* search returned, not
    // on anything this call searched for — often it searched for nothing at
    // all. Those pages were resolved against a real search when the packet
    // was made, so they are admissible here exactly as this call's own are.
    const searched = searchedIndex([...searchedUrls, ...packetSourceUrls(briefing)]);
    for (const listed of text.sources) {
      const url = resolveCitation(listed.url, searched);
      if (url === undefined) {
        this.logger.warn(`[answer] ${answer.id} cited a page it never opened: ${listed.url}`);
        continue;
      }
      if (byUrl.has(url)) continue;
      byUrl.set(url, { url, title: citationTitle(listed.title, url) });
    }
    // The briefing's own sources go on the card whether the model listed them
    // or not: it was asked what the research found, and a finding the group
    // cannot follow back is the thing V2-013 discards packets over.
    for (const packet of briefing) {
      for (const source of packet.sources) {
        if (!byUrl.has(source.url)) byUrl.set(source.url, source);
      }
    }
    return [...byUrl.values()];
  }
}

/**
 * The voice's part of one answer record, for whichever of the two paths out of
 * {@link AnswerAgent.answer} got there. `spokenSoFar` is only written when the
 * answer really was cut off: on a complete one it would just repeat
 * `spokenText`, and on a muted one it would claim the room heard nothing,
 * which is true but is already said by `firstAudioMs` being null.
 */
function voiceTimings(spoken: SpokenResult | undefined): Partial<Answer> {
  if (spoken === undefined) {
    return { ackMs: null, firstAudioMs: null, firstLineMs: null, continuationMs: null };
  }
  return {
    ackMs: spoken.ackMs,
    firstAudioMs: spoken.firstAudioMs,
    firstLineMs: spoken.firstLineMs,
    continuationMs: spoken.continuationMs,
    ...(spoken.interrupted ? { spokenSoFar: spoken.spokenSoFar } : {}),
  };
}

/**
 * Which packets one answer had and which it leaned on (V2-015).
 *
 * The briefing's packets by definition — their cards came forward and the
 * model was told to brief from them — plus any packet whose pages the answer
 * ended up citing, which is how a question that never mentioned research
 * still records the research it was answered from.
 */
function packetsUsed(
  packets: readonly ResearchPacket[],
  briefing: readonly ResearchPacket[],
  citations: readonly Citation[],
): Pick<Answer, "packetIds" | "usedPacketIds"> {
  const cited = new Set(citations.map((citation) => citation.url));
  const used = new Set(briefing.map((packet) => packet.id));
  for (const packet of packets) {
    if (packet.sources.some((source) => cited.has(source.url))) used.add(packet.id);
  }
  return {
    packetIds: packets.map((packet) => packet.id),
    // In the order the packets were made, so the record reads with the file.
    usedPacketIds: packets.filter((packet) => used.has(packet.id)).map((packet) => packet.id),
  };
}

/** No holding line, already settled — the shape {@link writeFirstLine} returns. */
function noLine(): Promise<string> {
  return Promise.resolve("");
}

/**
 * The screen half of a reply that never wrote one.
 *
 * Nothing enforces the shape `server/prompts/answer.md` asks for, and an
 * answer the group can hear but cannot see would be a worse failure than a
 * headline that reads like speech. So the first sentence becomes the headline
 * and the rest becomes the detail, through the same clipping every other
 * answer goes through.
 */
export function screenFromSpoken(spoken: string): AnswerText {
  const { sentences } = splitSentences(`${spoken}\n`);
  const headline = sentences[0] ?? spoken.trim();
  const rest = spoken.slice(headline.length).trim();
  return splitAnswer(rest === "" ? headline : `${headline}\n\n${rest}`);
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
    ...(answer.spokenText.trim() === "" ? {} : { spokenText: answer.spokenText }),
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

/**
 * V2-008: measure conversation against its latest final turn, never server uptime.
 * Live ASR timestamps start at stream zero; the injected live clock does not.
 * This also keeps the last conversation available to questions typed after Stop.
 */
export function recentTurns(
  turns: readonly TurnUpdate[],
): readonly TurnUpdate[] {
  const finals = turns.filter((turn) => turn.final);
  const latestMs = finals.reduce((latest, turn) => Math.max(latest, turn.endMs ?? turn.startMs), 0);
  const from = latestMs - ANSWER_CONTEXT_MS;
  return finals.filter((turn) => (turn.endMs ?? turn.startMs) >= from);
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
  extra: {
    /**
     * V2-008c: the holding line the room is already hearing, when there is
     * one. This is the only way the searched answer can know not to say it
     * again.
     */
    firstLine?: string;
    /** V2-015: every packet this session has researched. */
    packets?: readonly ResearchPacket[];
    /** V2-015: the packets this question is asking about, when it is. */
    briefing?: readonly ResearchPacket[];
  } = {},
): string {
  const firstLine = extra.firstLine ?? "";
  const packets = extra.packets ?? [];
  const briefing = extra.briefing ?? [];
  const blocks = [
    ...contextBlocks(board, turns, speakers, answer),
    ...(packets.length === 0
      ? []
      : [
          "## Research you have already done",
          renderPacketsForAnswer(packets),
        ]),
    ...(briefing.length === 0
      ? []
      : [
          `## They are asking about ${briefing.map((one) => one.id).join(" and ")}`,
          (briefing.length === 1
            ? "That research is on their screen now, open, with its sources on it."
            : "Those are on their screen now, open, with their sources on them." +
              " Brief them on whichever of them answers what was asked, leading with" +
              " the one that matters most to what they are deciding.") +
            " Brief them from it: say what it found and what it means for what they" +
            " are deciding. Only search if they asked for something the research" +
            " does not cover, and say which part you had to go and find.",
        ]),
    ...(firstLine === ""
      ? []
      : [
          "## You have already started answering out loud, with this",
          firstLine,
          "The room has heard that. Carry straight on from it: do not repeat it," +
            " do not rephrase it, and do not restate the question.",
        ]),
    `Answer it out loud under "${SPOKEN_HEADING_TEXT}", then put the headline,` +
      ` the detail and the pages you used under "${SCREEN_HEADING_TEXT}".`,
  ];
  return blocks.join("\n\n");
}

/**
 * The user message for the holding line (V2-008c): the same context the
 * searched answer gets, asked for one sentence instead of an answer.
 *
 * It needs the conversation for the same reason the answer does — the line has
 * to be *about* what they are talking about to be worth saying — and the board
 * because that is where "the thing they just described" is written down.
 */
export function renderFirstLineRequest(
  board: Board,
  turns: readonly TurnUpdate[],
  speakers: SpeakerNames,
  answer: Answer,
): string {
  return [
    ...contextBlocks(board, turns, speakers, answer),
    "You are about to look that up, which will take a few seconds. Write the one or" +
      " two sentences you say while you do, or an empty string if there is nothing" +
      " worth saying without the facts. Do not answer the question.",
  ].join("\n\n");
}

/** The board, the conversation and the question — what both calls are given. */
function contextBlocks(
  board: Board,
  turns: readonly TurnUpdate[],
  speakers: SpeakerNames,
  answer: Answer,
): string[] {
  return [
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
  ];
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
