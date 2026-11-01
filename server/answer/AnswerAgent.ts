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
import { sottoTurn, type TurnUpdate } from "../../shared/turns.js";
import { renderBoardMarkdown } from "../board/markdown.js";
import { systemClock, type Clock } from "../clock.js";
import { CARD_ID_PREFIX } from "../interject/delivery.js";
import { searchedIndex, resolveCitation } from "../interject/Verifier.js";
import { citationTitle, type FunctionTool, type ModelClient } from "../model/client.js";
import { PROMPTS, loadPrompt } from "../prompts/index.js";
import type { VoiceOut } from "../voice/voiceOut.js";
import { chooseAcknowledgment } from "./ack.js";
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
    // Out before the model has written a word: ten to twenty seconds of
    // silence after somebody says Sotto's name reads as "it didn't hear me".
    if (!asked.resume) speech?.acknowledge(chooseAcknowledgment(answer.question));

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
      const reply = await this.model.prose({
        label: ANSWER_TRACK_LABEL,
        system: loadPrompt(PROMPTS.answer),
        user: this.render(answer, asked.resume === true),
        maxTokens: ANSWER_MAX_TOKENS,
        functions: this.functions(answer, artifacts, () => pushedHeadline, () => spokenText),
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
            spokenText,
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
      this.recordVoiceLatency(answer, queued, spoken);
      const done: Answer = {
        ...answer,
        headline: text.headline,
        detailMd: text.detailMd,
        citations: this.citations(answer, text, reply.citations, reply.searchedUrls),
        artifacts: [...artifacts],
        status: "done",
        latencyMs: this.elapsed(answer),
        spokenText,
        ...voiceTimings(spoken),
      };
      this.recordSpeech(answer, spoken, spokenText, spokeAtStreamMs);
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
      this.recordVoiceLatency(answer, queued, spoken);
      const failed: Answer = {
        ...answer,
        // Whatever reached the stage stays there — including a diagram that
        // was drawn before the words failed; the message says the rest is not
        // coming.
        headline: pushedHeadline,
        artifacts: [...artifacts],
        status: "error",
        latencyMs: this.elapsed(answer),
        spokenText,
        ...voiceTimings(spoken),
        error: detail,
      };
      this.recordSpeech(answer, spoken, spokenText, spokeAtStreamMs);
      this.logger.warn(`[answer] ${answer.id} failed: ${detail}`);
      this.failedSinceIdle = true;
      this.options.onModelState?.("error", detail);
      this.finish(failed, asked);
    } finally {
      if (this.activeSpeech === speech) this.activeSpeech = undefined;
    }
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
  private render(answer: Answer, resume: boolean): string {
    const turns = recentTurns(this.options.transcript());
    const request = renderAnswerRequest(this.options.board(), turns, this.options.speakers(), answer);
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

/**
 * The voice's part of one answer record, for whichever of the two paths out of
 * {@link AnswerAgent.answer} got there. `spokenSoFar` is only written when the
 * answer really was cut off: on a complete one it would just repeat
 * `spokenText`, and on a muted one it would claim the room heard nothing,
 * which is true but is already said by `firstAudioMs` being null.
 */
function voiceTimings(spoken: SpokenResult | undefined): Partial<Answer> {
  if (spoken === undefined) return { ackMs: null, firstAudioMs: null };
  return {
    ackMs: spoken.ackMs,
    firstAudioMs: spoken.firstAudioMs,
    ...(spoken.interrupted ? { spokenSoFar: spoken.spokenSoFar } : {}),
  };
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
    `Answer it out loud under "${SPOKEN_HEADING_TEXT}", then put the headline,` +
      ` the detail and the pages you used under "${SCREEN_HEADING_TEXT}".`,
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
