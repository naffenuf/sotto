/**
 * Claiming the question out loud (PRD V3-015).
 *
 *     open_question -> search starts (V3-003)
 *                   -> first gap within 5 s -> "I'll check the drive time."
 *                   -> no gap            -> nothing said; the card is the sign
 *
 *     the search came back with nothing -> next gap -> "Nothing solid on the
 *                                                      drive time, sorry."
 *     the search came back with an answer -> real pause -> "On the drive time:
 *                                                      about two hours fifteen."
 *
 * The third line is V3-004 and it is the one the whole fast path is for: a
 * sourced one- or two-sentence answer, said to the room at a real pause while
 * the question is still what the room is thinking about. It differs from the
 * claim in four ways, all of them because it is worth more and arrives later:
 * it waits for {@link SPEAK_PAUSE_MS} rather than the policy's gap, it expires
 * on {@link ANSWER_STALE_MS} or {@link ANSWER_STALE_TURNS} rather than on a
 * five-second window, it is retried once after a human voice cuts it off, and
 * it is not said at all unless the cached still-current verdict says the room
 * still wants it. It spends nothing when the claim already did: the claim and
 * its answer are one contribution.
 *
 * The point is social rather than technical: somebody wonders something
 * aloud, and a colleague who is about to look it up says so, which is what
 * stops everybody else reaching for a phone. So the line has to arrive while
 * the question is still what the room is thinking about — hence
 * {@link RESERVE_WINDOW_MS}, five seconds, after which the claim is simply
 * dropped. The answer still follows (V3-004); only the claim expires.
 *
 * Four decisions worth knowing about.
 *
 * **The words are written here, not asked for.** The classifier already
 * produced a three-to-five-word `topic` for exactly this sentence (V3-002), so
 * a reservation costs no model call and no waiting — which is the whole of why
 * it can be said inside five seconds.
 *
 * **It waits for a gap, the policy's own gap.** {@link inPause} on the
 * corrected silence, read off the same getter interjections and research cards
 * use, so Sotto's own voice playing counts as somebody talking (V2-006). The
 * gap is *armed* the way the policy arms its re-checks: a timer for the rest
 * of the pause while the room is quiet, and nothing at all while somebody is
 * talking, because the turn closing is what arrives next.
 *
 * **It is the contribution, and the answer is its completion.** One spend
 * against the frequency's cooldown and allowance (V2-017), taken at the moment
 * the claim is actually made — a reservation nobody could hear (muted, no page
 * attached) spends nothing, because nothing was heard.
 *
 * **It yields to any human voice and is never retried.** The first human
 * partial the echo filter lets through cancels the utterance
 * ({@link Reservations.yieldToHuman}); what the room heard of it still goes
 * into the transcript, and the claim is over. Being talked over while saying
 * "I'll check that" is the room telling Sotto it has the floor back.
 */
import { isSottoTurn, sottoTurn, type PauseState, type TurnUpdate } from "../../shared/turns.js";
import { RESEARCH_NO_ANSWER, type ResearchIdea, type ResearchPacket } from "../../shared/research.js";
import type { PolicySettings } from "../../shared/policy.js";
import type { Clock } from "../clock.js";
import { PAUSE_MS, SPEAK_PAUSE_MS, inPause } from "../interject/policy.js";
import type { SpendVerdict } from "../interject/policy.js";
import type { VoiceOut, VoiceSpoken, VoiceUtterance } from "../voice/voiceOut.js";
import type { StillCurrentState } from "./StillCurrentWatcher.js";

type Logger = Pick<Console, "log" | "warn">;

/**
 * How long after the classifier's verdict a reservation is still worth saying.
 *
 * Five seconds, the PRD's number: a claim on a question is about *this*
 * moment in the conversation, and "I'll check the drive time" ten seconds
 * later is Sotto raising a topic rather than reserving one — which is the
 * interruption V3-004 exists to avoid. The search is already running either
 * way, so nothing is lost but the sentence.
 */
export const RESERVE_WINDOW_MS = 5_000;

/** The label a reservation's speech is tracked under on the clock. */
export const RESERVE_TRACK_LABEL = "reserve";

/**
 * How long a sourced answer is still worth saying out loud (PRD V3-004).
 *
 * Ninety seconds from the packet being ready, the same number the policy's
 * {@link STALE_MS} gives a candidate — and for the same reason: after that it
 * is Sotto raising a topic rather than answering one. The card stays either
 * way, so nothing is lost but the sentence.
 */
export const ANSWER_STALE_MS = 90_000;

/** And the faster of the two: six more final turns is a different subject. */
export const ANSWER_STALE_TURNS = 6;

/**
 * How many times a human voice may cut an answer off before it gives up.
 *
 * Twice. The first is somebody who happened to start talking at the same
 * instant, which a different pause fixes; the second is the room telling Sotto
 * it does not want to hear this, and the card is the only sign from there.
 */
export const MAX_ANSWER_YIELDS = 2;

/** The kinds of unprompted line this module says. */
export const spokenContributionKinds = ["reserve", "no_answer", "answer"] as const;
export type SpokenContributionKind = (typeof spokenContributionKinds)[number];

/**
 * Why a reservation was not said, for `timing.jsonl`.
 *
 * - `boldness`: a `cautious` session, which contributes on screen only.
 * - `cooldown` / `budget`: the frequency setting's, spent on something else.
 * - `no_gap`: nobody stopped talking inside {@link RESERVE_WINDOW_MS}.
 * - `unheard`: muted, or no page attached to play it — the card is the sign.
 * - `moved_on`: the room is somewhere else now, so the card is the only sign.
 * - `answered`: somebody present answered the question and the search agrees,
 *   so the card says `confirmed` and nothing is said (V3-004).
 * - `disagrees`: somebody present answered it and the search does not agree.
 *   The correction belongs on the screen, where it can be read twice.
 * - `expired`: ninety seconds or six final turns went by without a pause.
 * - `yielded`: cut off by a voice in the room twice (V3-004).
 * - `overtaken`: the search came back with nothing before the claim could be
 *   made, so there is nothing left to claim.
 * - `session_ended`: still waiting for a gap when the conversation stopped.
 */
export const reserveSkipReasons = [
  "boldness",
  "cooldown",
  "budget",
  "no_gap",
  "unheard",
  "moved_on",
  "answered",
  "disagrees",
  "expired",
  "yielded",
  "overtaken",
  "session_ended",
] as const;
export type ReserveSkipReason = (typeof reserveSkipReasons)[number];

/** One `spoken_contribution` line of `timing.jsonl` (V3-015). */
export interface SpokenContributionRecord {
  stage: "spoken_contribution";
  kind: SpokenContributionKind;
  /** When it was said, or when it was given up on, on the session clock. */
  atMs: number;
  ideaId: string;
  /** The turn the question was heard in. */
  turnId: string;
  topic: string;
  /**
   * Whether it was said at all: an utterance was opened and the words handed
   * to the voice. What the room got of it is {@link heard}.
   */
  spoken: boolean;
  /** The words, whether or not they were said. */
  text: string;
  /**
   * The question turn going final to the first audio of this line, on the
   * session clock. Only on a claim or a closing line that was really said.
   */
  questionToReserveMs?: number;
  /** The same for an answer (V3-004): wondering aloud to hearing it back. */
  questionToSpeechMs?: number;
  /** How long this line waited for a pause to be said in (V3-004). */
  pauseWaitMs?: number;
  /** The cached verdict the decision to speak was made on (V3-004). */
  stillCurrent?: StillCurrentState;
  /** True when a human voice cut it off (V3-004's rule). */
  yielded?: boolean;
  /** How many times a voice in the room has cut this line off (V3-004). */
  yields?: number;
  /** True when it was the barge-in that cancelled it (V2-007 on top). */
  bargedIn?: boolean;
  /** True on an answer that was cut off and will be tried again (V3-004). */
  retrying?: boolean;
  /** What the room actually heard, when that is less than {@link text}. */
  heard?: string;
  /** Why nothing was said, when nothing was. */
  reason?: ReserveSkipReason;
}

export interface ReservationsOptions {
  /** The session's clock — simulated for a replay, real for a live session. */
  clock: Clock;
  /** Where Sotto's voice goes, or `null` for a session that only shows things. */
  voice: VoiceOut | null;
  /** Whether anybody is talking, including Sotto: the policy's own getter. */
  pauseState: () => PauseState;
  /**
   * Now, on the transcription stream's timeline (V2-008a) — not the clock,
   * which in a live session counts from the start of the process.
   */
  streamNow: () => number;
  /** The frequency and boldness the header last set (V2-017). */
  settings: () => PolicySettings;
  /** Whether the frequency's cooldown and allowance leave room for this. */
  allowed: () => SpendVerdict;
  /** Spends the contribution; called once, where the claim is made. */
  noteContribution: () => void;
  /** Writes Sotto's own line into the conversation (V2-008a). */
  onSpoken: (turn: TurnUpdate) => void;
  /** One `spoken_contribution` line of `timing.jsonl`. */
  onRecord: (record: SpokenContributionRecord) => void;
  /**
   * Whether Sotto is already answering somebody (US-018).
   *
   * Opening an utterance stops whatever was being said, so a reservation must
   * not land on top of an answer being written: while one is, this is not a
   * gap, and the window runs out as it would in a room that never went quiet.
   */
  answering?: () => boolean;
  /**
   * The cached verdict about whether the room still wants this answer
   * (V3-004), read off {@link StillCurrentWatcher}.
   *
   * Read synchronously, in the instant between noticing a pause and opening
   * an utterance, which is why it is a cache and not a call: the PRD's "no
   * model call between pause detected and first audio". Absent, or
   * `undefined` for a question nobody is watching, means current — a missing
   * verdict must cost judgment rather than speech.
   */
  stillCurrent?: (ideaId: string) => StillCurrentState | undefined;
  /**
   * Somebody in the room answered the question themselves (V3-004).
   *
   * The answer is not said; the card says so instead — `confirmed` when the
   * search agrees with them, and the correction on screen when it does not.
   */
  onAnswered?: (ideaId: string, state: StillCurrentState) => void;
  windowMs?: number;
  logger?: Logger;
}

/** One question the room wondered aloud, as the lines about it are built from. */
export interface Asked {
  /** The turn it was heard in. */
  turnId: string;
  /** Three to five words naming it, which every line is written from. */
  topic: string;
  /** The question itself, which the still-current check is made against. */
  question: string;
  /** Session clock when the turn went final; every latency counts from here. */
  askedAtMs: number;
}

/** When a line waiting for a gap stops being worth saying. */
interface Expiry {
  afterMs: number;
  /** Final turns since it started waiting; the faster of the two wins. */
  afterTurns?: number;
  /** What the log calls it, which is not the same thing for all three kinds. */
  reason: ReserveSkipReason;
}

/** One line waiting for a gap to be said in. */
interface Pending {
  kind: SpokenContributionKind;
  ideaId: string;
  turnId: string;
  topic: string;
  text: string;
  /** The question turn going final, which the latency is measured from. */
  askedAtMs: number;
  /**
   * When this line started waiting. For a reservation that is the
   * classifier's verdict, and {@link RESERVE_WINDOW_MS} runs from here; for an
   * answer it is the packet being ready.
   */
  sinceMs: number;
  /** How quiet the room has to be before this line is said. */
  pauseMs: number;
  /** When it is given up on, or `null` for a line that waits as long as it takes. */
  expiry: Expiry | null;
  /** Final turns gone by since {@link sinceMs}. */
  turnsWaited: number;
  /** How many times a voice in the room has cut this line off. */
  yields: number;
}

export class Reservations {
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly windowMs: number;
  /** Lines waiting for a gap, oldest first. */
  private waiting: Pending[] = [];
  /** Every open question this session has heard, by idea id (V3-004). */
  private readonly questions = new Map<string, Asked>();
  /** Questions whose claim the room actually heard, by idea id. */
  private readonly claimed = new Map<string, Pending>();
  /**
   * Questions whose claim really spent the frequency's allowance.
   *
   * The claim and its answer are one contribution (V3-015's rule), so an
   * answer behind a claim the room heard charges nothing. A claim that was
   * never said — muted, no gap — spent nothing, so its answer pays.
   */
  private readonly spent = new Set<string>();
  /** Answers already handed over, so a packet pushed twice says one thing. */
  private readonly answered = new Set<string>();
  /** The utterance a human voice would cancel, while there is one. */
  private utterance: VoiceUtterance | undefined;
  /**
   * True from the moment a line is handed to the voice until its record is
   * written. The utterance itself only exists a few hundred milliseconds
   * later, and a second line started in between would be a second utterance
   * — which, since opening one stops the last, would be neither.
   */
  private opening = false;
  /** Set by {@link yieldToHuman}, so a stop is never mistaken for a yield. */
  private yielded = false;
  /** Set by {@link interrupt}: the yield was the barge-in's (V2-007). */
  private bargedIn = false;
  /** Everything being said, in order; `flush` waits on it. */
  private speaking: Promise<void> = Promise.resolve();
  private cancelTimer: (() => void) | undefined;
  private stopped = false;

  constructor(private readonly options: ReservationsOptions) {
    this.clock = options.clock;
    this.logger = options.logger ?? console;
    this.windowMs = options.windowMs ?? RESERVE_WINDOW_MS;
  }

  /**
   * The room wondered something aloud and the search has started (V3-003):
   * claim it at the first gap in the next five seconds.
   */
  claim(idea: ResearchIdea, asked: { turnId: string; topic: string; askedAtMs: number }): void {
    if (this.stopped) return;
    const question = this.noteQuestion(idea, asked);
    if (question === null) return;
    this.waiting.push({
      ...this.line(idea.id, question, "reserve", reserveLine(question.topic)),
      pauseMs: PAUSE_MS,
      expiry: { afterMs: this.windowMs, reason: "no_gap" },
    });
    this.review();
  }

  /**
   * Remembers an open question without claiming it out loud (V3-004).
   *
   * What {@link answer} needs is the question's own words and the moment it
   * was asked, and those arrive at the classifier's verdict rather than with
   * the packet twenty seconds later. {@link claim} registers it on the way
   * past; a question whose answer Sotto already had (V3-003's `reused`) is
   * registered here, because there is nothing to claim but there is still
   * something to say.
   */
  noteQuestion(
    idea: ResearchIdea,
    asked: { turnId: string; topic: string; askedAtMs: number },
  ): Asked | null {
    if (this.stopped) return null;
    const existing = this.questions.get(idea.id);
    if (existing !== undefined) return existing;
    const question: Asked = {
      turnId: asked.turnId,
      topic: asked.topic.trim() === "" ? idea.topic : asked.topic,
      question: idea.question,
      askedAtMs: asked.askedAtMs,
    };
    this.questions.set(idea.id, question);
    return question;
  }

  /** The open question behind one idea, for the still-current check (V3-004). */
  questionFor(ideaId: string): Asked | null {
    return this.questions.get(ideaId) ?? null;
  }

  /**
   * A sourced answer to one of the room's own questions is ready (V3-004):
   * say it at the next real pause.
   *
   * Does nothing for a packet nobody asked for out loud — the planner's and
   * the observer's ideas are research cards and have always been (V2-014) —
   * and nothing for a packet whose model left the spoken line blank, which is
   * the one field of a packet written to be heard rather than read.
   */
  answer(packet: ResearchPacket): void {
    if (this.stopped || this.answered.has(packet.ideaId)) return;
    const question = this.questions.get(packet.ideaId);
    const spoken = packet.spokenAnswer?.trim() ?? "";
    if (question === undefined || spoken === "") return;
    this.answered.add(packet.ideaId);
    this.waiting.push({
      ...this.line(packet.ideaId, question, "answer", answerLine(question.topic, spoken)),
      pauseMs: SPEAK_PAUSE_MS,
      expiry: {
        afterMs: ANSWER_STALE_MS,
        afterTurns: ANSWER_STALE_TURNS,
        reason: "expired",
      },
    });
    this.review();
  }

  /** One line about one question, waiting from now, with nothing yet decided. */
  private line(
    ideaId: string,
    question: Asked,
    kind: SpokenContributionKind,
    text: string,
  ): Pending {
    return {
      kind,
      ideaId,
      turnId: question.turnId,
      topic: question.topic,
      text,
      askedAtMs: question.askedAtMs,
      sinceMs: this.clock.now(),
      pauseMs: PAUSE_MS,
      expiry: null,
      turnsWaited: 0,
      yields: 0,
    };
  }

  /**
   * Whether saying this line spends the frequency's cooldown and allowance
   * (V2-017).
   *
   * A claim asks for the floor, so it pays. The closing line and the answer
   * are the *completion* of a claim the room heard, so they pay only when no
   * claim was ever made — muted, or no gap inside the window. Read at the
   * moment of speaking rather than when the line was queued, because the
   * claim may have been said in between.
   */
  private charges(line: Pending): boolean {
    if (line.kind === "reserve") return true;
    if (line.kind === "no_answer") return false;
    return !this.spent.has(line.ideaId);
  }


  /**
   * The search behind a claim came back with nothing showable (V3-003).
   *
   * Only a question the room *heard* Sotto claim gets a spoken answer to it:
   * a loop nobody knows is open does not need closing, and the card already
   * says so. It waits for a real pause rather than a five-second window —
   * "nothing solid on the drive time" is still true later, where the claim
   * itself would not be.
   */
  noAnswer(ideaId: string, why = RESEARCH_NO_ANSWER): void {
    if (this.stopped) return;
    // The search got there first, which a fast failure can: there is nothing
    // to claim now, so the claim is dropped rather than said and immediately
    // taken back. The card is already saying it came back with nothing.
    const waiting = this.waiting.find(
      (line) => line.kind === "reserve" && line.ideaId === ideaId,
    );
    if (waiting !== undefined) {
      this.waiting = this.waiting.filter((line) => line !== waiting);
      this.skip(waiting, "overtaken");
      return;
    }
    const claim = this.claimed.get(ideaId);
    if (claim === undefined) return;
    this.claimed.delete(ideaId);
    this.logger.log(`[reserve] ${ideaId} came back with nothing (${why})`);
    this.waiting.push({
      ...claim,
      kind: "no_answer",
      text: noAnswerLine(claim.topic),
      sinceMs: this.clock.now(),
      turnsWaited: 0,
      pauseMs: PAUSE_MS,
      expiry: null,
    });
    this.review();
  }

  /** How many claims the room has heard and not yet heard the end of. */
  claimedCount(): number {
    return this.claimed.size;
  }

  /** How many lines are still waiting for a gap. */
  waitingCount(): number {
    return this.waiting.length;
  }

  /**
   * Takes one turn snapshot. Every snapshot counts, partials included: a
   * `speechEnd` arrives as a partial and it is the one that opens a pause.
   */
  acceptTurn(turn: TurnUpdate): void {
    // A final turn is also one of the six an answer may wait through
    // (V3-004). Sotto's own line is not one of them: it is in the transcript
    // (V2-008a) but it is not the room moving on.
    if (turn.final && !isSottoTurn(turn)) {
      for (const line of this.waiting) {
        if (line.turnId !== turn.turnId) line.turnsWaited += 1;
      }
    }
    this.review();
  }

  /** Playback can end without an ASR frame arriving to say so (V2-006). */
  playbackChanged(): void {
    this.review();
  }

  /**
   * A human voice: stop talking, now (V3-004's rule).
   *
   * Called for the first human partial the self-echo filter lets through, at
   * any point in the utterance — no wake word and no classification, because
   * anything Sotto says unasked is worth less than the sentence it would be
   * talking over. What was heard still reaches the transcript, and the claim
   * is not retried.
   */
  yieldToHuman(): void {
    if (!this.opening) return;
    this.yielded = true;
    this.logger.log(`[reserve] yielding to a voice in the room`);
    // A yield that arrives while the voice is still opening is remembered
    // rather than lost: {@link speak} cancels the utterance as it gets it.
    this.utterance?.cancel();
  }

  /**
   * The barge-in cancelled it (V2-007, which still applies on top of V3-004).
   *
   * In practice the first human partial has already yielded by the time the
   * barge-in has classified anything, so this mostly records *which* rule did
   * it. It is still the cancellation for an utterance opened in the
   * milliseconds between the two.
   */
  interrupt(): void {
    if (!this.opening) return;
    this.bargedIn = true;
    this.yieldToHuman();
  }

  /** Resolves once everything being said has been said and written down. */
  async flush(): Promise<void> {
    await this.speaking;
  }

  /**
   * The end of the session: stop talking, stop waiting for a gap, and write
   * down what never got said.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.disarm();
    const stranded = this.waiting;
    this.waiting = [];
    for (const line of stranded) this.skip(line, "session_ended");
    this.utterance?.cancel();
  }

  /** Looks at everything waiting, and arms the next look. */
  private review(): void {
    if (this.stopped || this.waiting.length === 0) return;
    const nowMs = this.clock.now();
    const pause = this.options.pauseState();
    const free = this.options.answering?.() !== true;
    const keep: Pending[] = [];
    // One line at a time: two utterances would be one utterance, since
    // opening the second stops the first. Deliberately *not* in strict queue
    // order — a claim whose gap has not come must not hold up an answer whose
    // has, since the two wait on different thresholds and for different
    // lengths of time.
    let said = false;
    // An answer waits behind the claim on its own question, however much
    // sooner its own gap arrives: "On the drive time: …" ahead of "I'll check
    // the drive time" would be nonsense, and the claim's window is five
    // seconds at the most. (In a `max` replay this is every time — simulated
    // time stands still inside a tracked model call, so a twenty-second search
    // comes back before a seven-hundred-millisecond pause timer fires.)
    const claiming = new Set(
      this.waiting.filter((line) => line.kind === "reserve").map((line) => line.ideaId),
    );
    for (const line of this.waiting) {
      const expired = this.expiry(line, nowMs);
      if (expired !== null) {
        this.skip(line, expired);
        continue;
      }
      if (said || this.opening || !free || !inPause(pause, line.pauseMs)) {
        keep.push(line);
        continue;
      }
      if (line.kind === "answer" && claiming.has(line.ideaId)) {
        keep.push(line);
        continue;
      }
      const reason = this.reasonNotToSpeak(line);
      if (reason !== null) {
        this.skip(line, reason);
        continue;
      }
      this.say(line, nowMs);
      said = true;
    }
    this.waiting = keep;
    this.schedule(nowMs, pause);
  }

  /** Whether this line has waited too long, and what the log calls that. */
  private expiry(line: Pending, nowMs: number): ReserveSkipReason | null {
    const expiry = line.expiry;
    if (expiry === null) return null;
    if (nowMs - line.sinceMs >= expiry.afterMs) return expiry.reason;
    if (expiry.afterTurns !== undefined && line.turnsWaited >= expiry.afterTurns) {
      return expiry.reason;
    }
    return null;
  }

  /** Everything but the gap that can stop a line being said. */
  private reasonNotToSpeak(line: Pending): ReserveSkipReason | null {
    // A cautious session contributes on screen only, which is the same
    // promise {@link boldnessAllows} keeps for a candidate.
    if (this.options.settings().boldness === "cautious") return "boldness";
    // Whether the room still wants this (V3-004). Read, never asked for: the
    // verdict is already cached, so nothing between here and the first audio
    // waits on a model. Not asked about a claim: that lives inside a
    // five-second window, and no room moves on inside five seconds.
    const current = line.kind === "reserve" ? undefined : this.options.stillCurrent?.(line.ideaId);
    if (current?.verdict === "moved_on") return "moved_on";
    if (current?.verdict === "answered") {
      // Somebody present answered it. The card carries the verdict either
      // way: `confirmed` when the search agrees, the correction when it does
      // not — read twice on a screen rather than argued with out loud.
      if (line.kind === "answer") this.options.onAnswered?.(line.ideaId, current);
      return current.agrees ? "answered" : "disagrees";
    }
    if (!this.charges(line)) return null;
    const spend = this.options.allowed();
    return spend === "ok" ? null : spend;
  }

  /** Says one line, and records what the room got of it. */
  private say(line: Pending, nowMs: number): void {
    this.opening = true;
    this.yielded = false;
    this.bargedIn = false;
    this.speaking = this.clock.track(
      RESERVE_TRACK_LABEL,
      this.speaking.then(() => this.speak(line, nowMs)),
    );
  }

  private async speak(line: Pending, decidedAtMs: number): Promise<void> {
    let utterance: VoiceUtterance | null = null;
    try {
      utterance = (await this.options.voice?.begin()) ?? null;
    } catch (error) {
      // A voice that was there and broke: the card is still up, so the room
      // is not left waiting on a sentence that cannot be said.
      this.logger.warn(`[reserve] could not be said out loud: ${message(error)}`);
    }
    if (utterance === null) {
      this.opening = false;
      this.skip(line, "unheard");
      return;
    }
    if (this.stopped) {
      utterance.cancel();
      this.opening = false;
      this.skip(line, "session_ended");
      return;
    }
    this.utterance = utterance;
    // A voice in the room while this was opening: it never gets a word out.
    if (this.yielded) utterance.cancel();
    // Playback starts inside ElevenLabs' first chunk (measured at 299 ms), so
    // this is where the line belongs on the conversation's timeline.
    const startMs = this.options.streamNow();
    utterance.append(line.text);
    if (this.charges(line)) {
      // Asking for the floor is the contribution (V2-017), and the spend is
      // taken where the words are really handed over: a claim nobody could
      // hear spends nothing. A claim already charged for pays for its answer.
      this.options.noteContribution();
      if (line.kind === "reserve") this.spent.add(line.ideaId);
    }
    if (line.kind === "reserve") this.claimed.set(line.ideaId, line);
    this.logger.log(`[reserve] ${line.kind}: ${line.text}`);
    let spoken: VoiceSpoken | undefined;
    try {
      spoken = await utterance.finish();
    } catch (error) {
      this.logger.warn(`[reserve] was cut short: ${message(error)}`);
    }
    this.utterance = undefined;
    this.opening = false;
    const yielded = this.yielded;
    const bargedIn = this.bargedIn;
    const heard = spoken === undefined ? "" : yielded ? spoken.spokenSoFar : spoken.text;
    const yields = line.yields + (yielded ? 1 : 0);
    const current = this.options.stillCurrent?.(line.ideaId);
    // Cut off by a voice in the room, with a try left: the answer is still
    // the answer, so it waits for another pause (V3-004). Twice is the room
    // saying it does not want to hear this, and the card is then the only
    // sign.
    const retrying = yielded && line.kind === "answer" && yields < MAX_ANSWER_YIELDS;
    this.options.onRecord({
      stage: "spoken_contribution",
      kind: line.kind,
      atMs: decidedAtMs,
      ideaId: line.ideaId,
      turnId: line.turnId,
      topic: line.topic,
      spoken: true,
      text: line.text,
      ...(line.kind === "answer"
        ? {
            questionToSpeechMs: decidedAtMs - line.askedAtMs,
            pauseWaitMs: decidedAtMs - line.sinceMs,
            ...(current === undefined ? {} : { stillCurrent: current }),
          }
        : { questionToReserveMs: decidedAtMs - line.askedAtMs }),
      yielded,
      ...(yields === 0 ? {} : { yields }),
      ...(bargedIn ? { bargedIn } : {}),
      ...(retrying ? { retrying } : {}),
      ...(heard === line.text ? {} : { heard }),
    });
    if (retrying) {
      this.waiting.unshift({ ...line, yields });
    } else if (yielded && line.kind === "answer") {
      this.skip({ ...line, yields }, "yielded");
    }
    // Cut off before the page reported anything: nobody can say what was
    // heard, so the transcript stays short rather than claiming a line.
    if (heard.trim() !== "") {
      this.options.onSpoken(
        sottoTurn({
          // A retry is its own row: the first attempt is what the room heard
          // of it, and replacing that would lose it.
          utteranceId: reserveUtteranceId(line.kind, line.ideaId, line.yields),
          text: heard,
          startMs,
          interrupted: yielded,
        }),
      );
    }
    // The gap this took is over, and the next line may now be sayable.
    this.review();
  }

  /** Writes down a line that was never said, and why. */
  private skip(line: Pending, reason: ReserveSkipReason): void {
    this.logger.log(`[reserve] ${line.kind} not said (${reason}): ${line.text}`);
    const nowMs = this.clock.now();
    this.options.onRecord({
      stage: "spoken_contribution",
      kind: line.kind,
      atMs: nowMs,
      ideaId: line.ideaId,
      turnId: line.turnId,
      topic: line.topic,
      spoken: false,
      text: line.text,
      ...(line.kind === "answer" ? { pauseWaitMs: nowMs - line.sinceMs } : {}),
      ...(line.yields === 0 ? {} : { yields: line.yields }),
      reason,
    });
  }

  /**
   * Arms one timer for the soonest thing that could change an answer: the
   * silence reaching {@link PAUSE_MS}, or a claim's window running out. While
   * somebody is talking there is nothing to wait for — the turn closing is
   * what arrives next — so only the window is armed.
   */
  private schedule(nowMs: number, pause: PauseState): void {
    this.disarm();
    if (this.waiting.length === 0) return;
    const due: number[] = [];
    for (const line of this.waiting) {
      if (!pause.speaking && pause.silentForMs < line.pauseMs) {
        due.push(line.pauseMs - pause.silentForMs);
      }
      if (line.expiry !== null) {
        due.push(Math.max(1, line.sinceMs + line.expiry.afterMs - nowMs));
      }
    }
    if (due.length === 0) return;
    this.cancelTimer = this.clock.setTimeout(() => {
      this.cancelTimer = undefined;
      this.review();
    }, Math.min(...due));
  }

  private disarm(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }
}

/**
 * The utterance id a reservation's transcript line is derived from (V2-008a).
 *
 * `attempt` numbers a retry after a yield (V3-004), so the first attempt's row
 * — what the room heard of it — is not replaced by the second's.
 */
export function reserveUtteranceId(
  kind: SpokenContributionKind,
  ideaId: string,
  attempt = 0,
): string {
  return attempt === 0 ? `${kind}-${ideaId}` : `${kind}-${ideaId}-${attempt + 1}`;
}

/**
 * "On the drive time: about two hours fifteen from the city." — the answer,
 * addressed to the room (V3-004).
 *
 * Never by name. Diarization labels are remapped on every reconnect
 * (`speakerMappingUncertain`), so "Craig, you asked about the drive time"
 * risks telling the wrong person they asked something; naming nobody costs
 * nothing. The topic goes first because the question was twenty seconds ago
 * and the room needs to know which one this answers.
 */
export function answerLine(topic: string, spokenAnswer: string): string {
  const answer = spokenAnswer.replace(/\s+/g, " ").trim();
  if (answer === "") return "";
  // Said rather than read, so it ends in a full stop even when the model's
  // line did not: ElevenLabs reads punctuation as prosody, and a sentence
  // that runs off the end is heard as one.
  const said = /[.?!]$/.test(answer) ? answer : `${answer}.`;
  const object = asObject(topic);
  return object === "that" ? said : `On ${object}: ${said}`;
}

/** "I'll check the drive time." — the claim, from the classifier's topic. */
export function reserveLine(topic: string): string {
  return `I'll check ${asObject(topic)}.`;
}

/** "Nothing solid on the drive time, sorry." — the loop, closed. */
export function noAnswerLine(topic: string): string {
  return `Nothing solid on ${asObject(topic)}, sorry.`;
}

/**
 * Words that already say which thing is meant, so "the" in front of them
 * would be a second one.
 *
 * Determiners and possessives for a noun phrase ("the drive time"), and the
 * subordinators a topic phrased as a clause starts with ("whether they are
 * open on a Thursday"). A proper noun ("Loom pricing") needs no article
 * either, which is what the capital letter below is read as — the classifier
 * writes a topic "as it would be said out loud", so its case is meaningful.
 */
const NO_ARTICLE = new Set([
  "the", "a", "an", "our", "their", "its", "his", "her", "my", "your",
  "this", "that", "these", "those", "whether", "if", "how", "what", "when",
  "where", "who", "whom", "why", "which",
]);

/** The topic as the object of a sentence: "the drive time", "Loom pricing". */
function asObject(topic: string): string {
  const text = topic.replace(/\s+/g, " ").trim().replace(/[.?!,;:]+$/, "");
  if (text === "") return "that";
  const first = text.split(" ")[0] ?? "";
  if (NO_ARTICLE.has(first.toLowerCase())) return text;
  // A capital where the sentence does not need one is a name.
  if (/^[A-Z]/.test(first)) return text;
  return `the ${text}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
