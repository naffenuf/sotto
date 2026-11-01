/**
 * The record of what Sotto did, and almost did (V2-018).
 *
 *     candidates.jsonl ─┐
 *     research.jsonl   ─┼─> SessionDigest ─> digest.md   (on Stop)
 *     answers.jsonl    ─┤                 \
 *     board.json       ─┘                  -> spokenSummary()  ("Sotto, wrap us up")
 *
 * A session folder already holds everything that happened, one line at a
 * time, in the order it happened. A digest is the same material read the
 * other way round — by subject rather than by minute — so a group that has
 * stopped talking can see where they got to, what Sotto raised, what it held
 * back and why, and what the searches found.
 *
 * Three decisions worth knowing about.
 *
 * **It is collected, not read back.** {@link SessionDigest} is handed each
 * record as it is written, so the digest exists even for a session whose
 * folder could never be opened — which is what makes "Sotto, wrap us up"
 * work on a laptop with a full disk, and what keeps this off the one path
 * where re-reading files would be slowest.
 *
 * **"Almost said" is scored and reasoned, never guessed.** A suppressed
 * candidate's score and reason come from the policy's own last decision
 * about it ({@link DecisionLogRecord}), the gate's verdict, or — for one that
 * never reached the policy — {@link candidateScore} over the scores it
 * carried. The reasons are the policy's vocabulary (`below_threshold`,
 * `cooldown`, `stale`, …) with the underscores taken out.
 *
 * **A `research_hook` is not something Sotto almost said.** It left the
 * interjection path by design (V2-011): it is an idea to look something up,
 * and whatever became of it belongs under "Research produced".
 */
import type { Board, Item } from "../../shared/board.js";
import type { Citation } from "../../shared/cards.js";
import {
  type Candidate,
  type CandidateGateLogRecord,
  type CandidateLogLine,
  type CandidateType,
  type DecisionLogRecord,
  type SuppressedCandidate,
  type VerificationLogRecord,
} from "../../shared/candidates.js";
import { TYPED_ASKER, type AnswerLogRecord } from "../../shared/answers.js";
import type { ResearchLogLine, ResearchPacket } from "../../shared/research.js";
import { candidateScore } from "../interject/policy.js";

/**
 * The seven headings, in the PRD's order. Spelled once, so the file, the
 * integration test and anything that reads it back agree.
 */
export const DIGEST_SECTIONS = [
  "Summary",
  "Decisions",
  "Open questions",
  "What Sotto said",
  "On-screen interjections",
  "What Sotto almost said",
  "Research produced",
] as const;

/** The PRD's five: a longer list would be a log rather than a digest. */
export const MAX_SUPPRESSED = 5;

/** What stands in for a section the conversation produced nothing for. */
export const NOTHING = "_None recorded._";

/** The marker a line of Sotto's speech the room only heard part of carries. */
const INTERRUPTED = "_(interrupted)_";

/** One thing Sotto said out loud, or would have said with the voice on. */
export interface DigestSpoken {
  /** The question it answers, or the request that asked for it. */
  question: string;
  /** Whoever asked, as the transcript names them. */
  askedBy: string;
  /** The card's headline, when it had one. */
  headline: string;
  /**
   * The words themselves: the spoken half of an answer (V2-005), or only as
   * much of it as the room heard when somebody cut it off.
   */
  spoken: string;
  /** True when the room was cut off before the end (V2-007). */
  interrupted: boolean;
  /** Research packets the answer leaned on, which is what makes it a briefing. */
  packetIds: readonly string[];
  /** Why there is no answer, when there is none. */
  error?: string;
}

/** One candidate that reached the stage. */
export interface DigestDelivered {
  headline: string;
  detail: string;
  type: CandidateType;
  /** `interject` or `glow`: which of the two kinds of card it was. */
  level: string;
  score: number;
}

/** Everything a digest is rendered from. */
export interface DigestInput {
  board: Board | null;
  spoken: readonly DigestSpoken[];
  delivered: readonly DigestDelivered[];
  suppressed: readonly SuppressedCandidate[];
  packets: readonly ResearchPacket[];
  /** Searches that came back with nothing usable, by outcome (V2-013). */
  discarded: { unsourced: number; failed: number };
}

/**
 * Collects what one session produced, as it is produced.
 *
 * Fed from the same call sites that write the session folder's logs, so
 * nothing new is computed and nothing is read back. Every method is safe to
 * call for a session with no folder, no model and no voice.
 */
export class SessionDigest {
  private currentBoard: Board | null = null;
  /** Observer candidates by id, in the order they arrived. */
  private readonly candidates = new Map<string, Candidate>();
  /** The last decision the policy took about each candidate. */
  private readonly decisions = new Map<string, DecisionLogRecord>();
  /** The last check, for a candidate that was verified (US-013). */
  private readonly checks = new Map<string, VerificationLogRecord>();
  /** The gate's verdict, for a candidate that never reached the policy. */
  private readonly gates = new Map<string, CandidateGateLogRecord>();
  /** Answers by id, so a record rewritten is not a second entry. */
  private readonly answers = new Map<string, AnswerLogRecord>();
  /** Wrap-ups and anything else Sotto said that is not an answer. */
  private readonly extras: DigestSpoken[] = [];
  private readonly packets: ResearchPacket[] = [];
  private unsourced = 0;
  private failed = 0;

  /** The board as it now stands, which is the Summary and the two lists. */
  board(board: Board): void {
    this.currentBoard = board;
  }

  /** One line of `candidates.jsonl`, whichever of the four kinds it is. */
  candidate(line: CandidateLogLine): void {
    switch (line.kind) {
      case "candidate":
        this.candidates.set(line.candidate.id, line.candidate);
        return;
      case "decision":
        this.decisions.set(line.candidateId, line);
        return;
      case "verification":
        this.checks.set(line.candidateId, line);
        return;
      case "gate":
        this.gates.set(line.candidateId, line);
        return;
    }
  }

  /** One line of `research.jsonl`: only the finished jobs matter here. */
  research(line: ResearchLogLine): void {
    if (line.kind !== "packet") return;
    if (line.outcome === "ready" && line.packet !== undefined) this.packets.push(line.packet);
    else if (line.outcome === "unsourced") this.unsourced += 1;
    else if (line.outcome === "failed") this.failed += 1;
  }

  /** One line of `answers.jsonl` (US-018, V2-005). */
  answer(record: AnswerLogRecord): void {
    this.answers.set(record.id, record);
  }

  /** Something Sotto said that is not an answer: the wrap-up itself. */
  spoke(entry: DigestSpoken): void {
    this.extras.push(entry);
  }

  /** Everything the digest is made of, as it stands right now. */
  input(): DigestInput {
    return {
      board: this.currentBoard,
      spoken: [...[...this.answers.values()].map(spokenFromAnswer), ...this.extras],
      delivered: this.delivered(),
      suppressed: this.suppressed(),
      packets: [...this.packets],
      discarded: { unsourced: this.unsourced, failed: this.failed },
    };
  }

  /** `digest.md`, as it would be written now. */
  render(): string {
    return renderDigest(this.input());
  }

  /**
   * What Sotto has held back so far, best first (V3-016).
   *
   * The same list the digest's "What Sotto almost said" renders, which is the
   * point: the stage's "almost said" tray shows restraint while the
   * conversation is still going, so the list is published as it changes
   * rather than only written down at the end.
   */
  almostSaid(): SuppressedCandidate[] {
    return this.suppressed();
  }

  /** The short spoken wrap-up ("Sotto, wrap us up"). */
  spokenSummary(): string {
    return spokenSummary(this.input());
  }

  /** The candidates that reached the stage, oldest first. */
  private delivered(): DigestDelivered[] {
    const list: DigestDelivered[] = [];
    for (const [id, candidate] of this.candidates) {
      const decision = this.decisions.get(id);
      if (decision === undefined) continue;
      if (decision.decision !== "interject" && decision.decision !== "glow") continue;
      list.push({
        headline: candidate.headline,
        detail: candidate.detail,
        type: candidate.type,
        level: decision.decision,
        score: decision.score,
      });
    }
    return list;
  }

  /** The top {@link MAX_SUPPRESSED} candidates Sotto held back, best first. */
  private suppressed(): SuppressedCandidate[] {
    const list: SuppressedCandidate[] = [];
    for (const [id, candidate] of this.candidates) {
      // A hook was never for the stage (V2-011): it went to the research
      // pipeline, and what became of it is in "Research produced".
      if (candidate.type === "research_hook") continue;
      const decision = this.decisions.get(id);
      if (decision?.decision === "interject" || decision?.decision === "glow") continue;
      const reason = this.reasonFor(id, candidate, decision);
      if (reason === null) continue;
      list.push({
        candidateId: id,
        headline: candidate.headline,
        type: candidate.type,
        score: this.scoreFor(id, candidate, decision),
        reason,
      });
    }
    return list
      .sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId))
      .slice(0, MAX_SUPPRESSED);
  }

  /**
   * Why this candidate was never said: the policy's own last reason where
   * there is one, and otherwise whatever stopped it before the policy.
   */
  private reasonFor(
    id: string,
    candidate: Candidate,
    decision: DecisionLogRecord | undefined,
  ): string | null {
    if (candidate.duplicateOf !== undefined) return `duplicate of ${candidate.duplicateOf}`;
    if (decision !== undefined) return words(decision.reason);
    const check = this.checks.get(id);
    if (check?.outcome === "unverified") return "checked against the web and not wrong";
    if (check?.outcome === "failed") return "the fact check did not come back";
    const gate = this.gates.get(id);
    if (gate?.error !== undefined) return "the judgment gate did not come back";
    return "no decision was recorded";
  }

  /** What it was worth: the policy's number, the gate's, or the observer's. */
  private scoreFor(
    id: string,
    candidate: Candidate,
    decision: DecisionLogRecord | undefined,
  ): number {
    if (decision !== undefined) return decision.score;
    const gate = this.gates.get(id);
    if (gate !== undefined) return gate.score;
    return candidateScore(candidate.scores);
  }
}

/** One answer as the digest shows it. */
function spokenFromAnswer(record: AnswerLogRecord): DigestSpoken {
  return {
    question: record.question,
    askedBy: record.askedBy,
    headline: record.headline,
    // What the room actually heard: all of it, or only the part that was
    // spoken before a barge-in (V2-007). A muted session heard none of it and
    // still records what would have been said, which is the detail it showed.
    spoken: said(record),
    interrupted: record.spokenSoFar !== undefined,
    packetIds: record.usedPacketIds,
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

/** What the room heard of one answer. */
function said(record: AnswerLogRecord): string {
  if (record.spokenSoFar !== undefined) return record.spokenSoFar;
  return record.spokenText.trim() === "" ? record.detailMd : record.spokenText;
}

/** `digest.md`: the seven sections, always all seven of them. */
export function renderDigest(input: DigestInput): string {
  const blocks: string[] = ["# Digest"];
  for (const section of DIGEST_SECTIONS) {
    blocks.push(`## ${section}`, body(section, input));
  }
  return blocks.join("\n\n");
}

function body(section: (typeof DIGEST_SECTIONS)[number], input: DigestInput): string {
  switch (section) {
    case "Summary":
      return input.board === null || input.board.summary.trim() === ""
        ? NOTHING
        : input.board.summary.trim();
    case "Decisions":
      return list(open(input.board?.decisions).map((item) => `- ${item.text}`));
    case "Open questions":
      return list(
        (input.board?.questions ?? [])
          .filter((item) => item.status === "open")
          .map((item) => `- ${item.text}`),
      );
    case "What Sotto said":
      return list(input.spoken.map(saidBlock));
    case "On-screen interjections":
      return list(
        input.delivered.map(
          (card) =>
            `- **${card.headline}** — ${card.detail}\n  _(${words(card.type)}, ${card.level}, score ${score(card.score)})_`,
        ),
      );
    case "What Sotto almost said":
      return list(
        input.suppressed.map(
          (held) => `- **${held.headline}** — ${held.reason} _(${words(held.type)}, score ${score(held.score)})_`,
        ),
      );
    case "Research produced":
      return researchBlock(input);
  }
}

/** One answer, with who asked and what the room actually heard. */
function saidBlock(said: DigestSpoken): string {
  // `TYPED_ASKER` is the word "typed", which reads as a name here.
  const who = said.askedBy === TYPED_ASKER ? "typed into the box" : `asked by ${said.askedBy}`;
  const lines = [`### “${said.question}” — ${who}`];
  if (said.headline !== "") lines.push(said.headline);
  if (said.packetIds.length > 0) {
    lines.push(`_Briefed from ${said.packetIds.join(", ")}._`);
  }
  if (said.error !== undefined) lines.push(`_No answer: ${said.error}_`);
  const spoken = said.spoken.trim();
  if (spoken !== "") lines.push(said.interrupted ? `${spoken} ${INTERRUPTED}` : spoken);
  return lines.join("\n\n");
}

function researchBlock(input: DigestInput): string {
  const blocks = input.packets.map((packet) => {
    const lines = [`### ${packet.title}`, packet.teaser];
    if (packet.sources.length > 0) lines.push(packet.sources.map(sourceLine).join("\n"));
    return lines.join("\n\n");
  });
  const { unsourced, failed } = input.discarded;
  if (unsourced > 0 || failed > 0) {
    blocks.push(
      `_Discarded: ${unsourced} search(es) came back with no page the group could follow,` +
        ` ${failed} did not come back._`,
    );
  }
  return list(blocks);
}

function sourceLine(source: Citation): string {
  return `- [${source.title}](${source.url})`;
}

/** The items a reader still cares about: anything the group has not dropped. */
function open(items: readonly Item[] | undefined): readonly Item[] {
  return (items ?? []).filter((item) => item.status !== "dropped");
}

function list(blocks: readonly string[]): string {
  return blocks.length === 0 ? NOTHING : blocks.join("\n\n");
}

function score(value: number): string {
  return value.toFixed(2);
}

/** A reason or a type as a person reads it: `below_threshold` → below threshold. */
function words(value: string): string {
  return value.replaceAll("_", " ");
}

/* ------------------------------------------------------------------ *
 * "Sotto, wrap us up": the same material, written to be heard.
 * ------------------------------------------------------------------ */

/** Decisions, questions and findings one wrap-up mentions. Short is the point. */
const SPOKEN_MAX_ITEMS = 3;

/** What a wrap-up says when there is nothing to wrap up yet. */
export const NOTHING_TO_WRAP_UP =
  "We haven't got far enough for me to wrap up yet — nothing has landed on the board.";

/**
 * The spoken wrap-up: where the group got to, what is still open and what the
 * searches found.
 *
 * Built here rather than by a model for the same reason
 * {@link briefingOpener} is: the material is already in hand, so a call would
 * be the only thing left to wait for, and it is asked for at the end of a
 * conversation when everybody is standing up. Written to be heard — no
 * markdown, no URLs, no scores.
 */
export function spokenSummary(input: DigestInput): string {
  const sentences: string[] = [];
  const decisions = open(input.board?.decisions).slice(0, SPOKEN_MAX_ITEMS);
  const questions = (input.board?.questions ?? [])
    .filter((item) => item.status === "open")
    .slice(0, SPOKEN_MAX_ITEMS);
  const packets = input.packets.slice(0, SPOKEN_MAX_ITEMS);
  const summary = input.board?.summary.trim() ?? "";
  if (decisions.length === 0 && questions.length === 0 && packets.length === 0) {
    return summary === "" ? NOTHING_TO_WRAP_UP : `Here's where we got to. ${sentence(summary)}`;
  }
  sentences.push("Here's where we got to.");
  if (summary !== "") sentences.push(sentence(summary));
  if (decisions.length > 0) {
    const lead =
      decisions.length === 1 ? "You decided one thing" : `You decided ${count(decisions.length)} things`;
    sentences.push(sentence(`${lead}: ${phrases(decisions.map((item) => item.text))}`));
  }
  if (questions.length > 0) {
    const lead =
      questions.length === 1
        ? "One question is still open"
        : `${capitalize(count(questions.length))} questions are still open`;
    sentences.push(sentence(`${lead}: ${phrases(questions.map((item) => item.text))}`));
  }
  if (packets.length > 0) sentences.push("I also did some digging.");
  for (const packet of packets) {
    sentences.push(`${sentence(trimEnd(packet.title))} ${sentence(packet.teaser)}`);
  }
  return sentences.join(" ");
}

/** The numbers a wrap-up says out loud rather than spelling as digits. */
const NUMBERS = ["no", "one", "two", "three"];

function count(value: number): string {
  return NUMBERS[value] ?? String(value);
}

/**
 * Board items as one spoken list: "a, b, and c".
 *
 * The items keep their own capitals. A board line is a fragment somebody
 * wrote with a capital at the front, and lowercasing it would be right for
 * "Thursday works" and wrong for "Thursday" — which the voice does not care
 * about either way, since nobody reads this.
 */
function phrases(texts: readonly string[]): string {
  const items = texts.map(trimEnd);
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1) ?? ""}`;
}

/** Ends a fragment with a full stop, so the voice reads it as a sentence. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** A fragment with its full stop taken off, so it can go in a list. A
 * question keeps its question mark: the voice reads the intonation off it. */
function trimEnd(text: string): string {
  return text.trim().replace(/\.+$/, "");
}

function capitalize(text: string): string {
  return text.length === 0 ? text : (text[0]?.toUpperCase() ?? "") + text.slice(1);
}

/* ------------------------------------------------------------------ *
 * Being asked for one.
 * ------------------------------------------------------------------ */

/**
 * The ways somebody asks Sotto to wrap up.
 *
 * Matched on words rather than judged by a model, as the briefing match is
 * ({@link asksForResearch}): the material is already in hand, so a
 * classification call would be a second and a half of silence before the one
 * answer Sotto can give immediately. Deliberately narrow — "what did we
 * decide?" is a question about the board and belongs to the answer agent,
 * which answers it from the board anyway.
 */
const ASKS_FOR_WRAP_UP: readonly RegExp[] = [
  /\bwrap (?:us|this|it|things|us all)?\s*up\b/i,
  /\bsum (?:us|this|it|things) up\b/i,
  /\b(?:summarise|summarize|recap)\b/i,
  /\bgive (?:us|me) (?:a|the) (?:summary|recap|rundown|wrap[- ]?up)\b/i,
  /\bwhere (?:did|have) we (?:get|got|land|end) (?:to|up)\b/i,
];

/** Whether this request is asking Sotto to wrap the conversation up. */
export function asksForWrapUp(question: string): boolean {
  return ASKS_FOR_WRAP_UP.some((pattern) => pattern.test(question));
}
