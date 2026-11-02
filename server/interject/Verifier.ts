/**
 * Checking a claim before the group is told it is wrong (PRD US-013).
 *
 * Every `factual_error` the observer notices comes through here on its way to
 * the policy, and most of them stop here: a claim the web cannot settle is
 * recorded as `unverified` and never reaches the stage, because interrupting
 * a brainstorm to correct something that was right is worse than staying
 * quiet. Only a `wrong` verdict goes on, carrying the correction and the
 * pages it rests on.
 *
 * Since V3-009 a check has two halves, and the first one is **the group's own
 * files**. A claim their price sheet contradicts is settled by that sheet —
 * the web cannot correct a company's own prices — and a correction that comes
 * out of their records is the one Sotto may say out loud at the default
 * boldness (V3-008's exception), phrased as the file's and cited by name. The
 * files are only consulted when they have lines about the same things, and a
 * verdict of anything but `wrong` falls straight through to the web check, so
 * a folder that knows nothing about the claim costs a conversation nothing.
 *
 * Unlike the board loop and the observer, checks run **concurrently**: one
 * candidate waiting on a search must not hold up the next one. Each check is
 * registered with {@link Clock.track} before {@link Verifier.verify} returns,
 * so a `max`-speed replay still stops for all of them.
 */
import {
  CORRECTION_MAX_WORDS,
  KNOWLEDGE_VERIFICATION_SCHEMA_NAME,
  KnowledgeVerificationReplySchema,
  ModelCitationSchema,
  VERIFICATION_SCHEMA_NAME,
  VerificationReplySchema,
  correctedDetail,
  knowledgeVerificationJsonSchema,
  verificationJsonSchema,
  type Candidate,
  type CandidateVerification,
  type VerificationLogRecord,
} from "../../shared/candidates.js";
import type { Citation, EvidenceQuote } from "../../shared/cards.js";
import {
  knowledgeCitation,
  resolveKnowledgeCitation,
  type KnowledgeSnippet,
} from "../../shared/knowledge.js";
import type { Clock } from "../clock.js";
import type { KnowledgeIndex } from "../knowledge/KnowledgeIndex.js";
import { ModelCallError, citationTitle, type ModelClient } from "../model/client.js";
import { PROMPTS, loadPrompt } from "../prompts/index.js";

/** The label a check is tracked under on the clock, and in the model logs. */
export const VERIFY_TRACK_LABEL = "verify";

/**
 * Reasoning + search + output budget for one check. Larger than a board or
 * observer call because the model reasons, searches, reads and reasons again:
 * measured runs against the real API spent 1,000–1,600 tokens on reasoning
 * alone before writing the verdict.
 */
export const VERIFY_MAX_TOKENS = 8_192;

/** The label the knowledge half of a check is tracked under (V3-009). */
export const KNOWLEDGE_TRACK_LABEL = "verify-files";

/**
 * Budget for the knowledge half. Far smaller than the web half's: there is no
 * search and no reading, only a handful of lines and one comparison.
 */
export const KNOWLEDGE_VERIFY_MAX_TOKENS = 4_096;

type Logger = Pick<Console, "log" | "warn">;

export interface VerifierOptions {
  /** The session's clock — simulated for a replay, real for a live session. */
  clock: Clock;
  model: ModelClient;
  /** Records the check in `candidates.jsonl`, whatever it decided. */
  onRecord: (record: VerificationLogRecord) => void;
  /**
   * Hands on a candidate whose claim really is wrong, with the correction in
   * its detail and the citations attached. The policy's input (US-014).
   */
  onVerified: (candidate: Candidate) => void;
  /** The model status dot, shared with the board loop and the observer. */
  onModelState?: (state: "connecting" | "active" | "error", detail: string) => void;
  /**
   * The group's own files (V3-009), when the session has a knowledge folder.
   * Present means they are checked before the web.
   */
  knowledge?: KnowledgeIndex | null;
  logger?: Logger;
}

export class Verifier {
  private readonly clock: Clock;
  private readonly model: ModelClient;
  private readonly onRecord: (record: VerificationLogRecord) => void;
  private readonly onVerified: (candidate: Candidate) => void;
  private readonly onModelState: VerifierOptions["onModelState"];
  private readonly knowledge: KnowledgeIndex | null;
  private readonly logger: Logger;

  /** The checks in flight, so {@link flush} can wait for all of them. */
  private readonly inFlight = new Set<Promise<void>>();
  /**
   * Whether a check has failed since the dot last went idle, so the last
   * check back does not quietly paint over a failure with "ready".
   */
  private failedSinceIdle = false;
  private stopped = false;
  private checkCount = 0;

  constructor(options: VerifierOptions) {
    this.clock = options.clock;
    this.model = options.model;
    this.onRecord = options.onRecord;
    this.onVerified = options.onVerified;
    this.onModelState = options.onModelState;
    this.knowledge = options.knowledge ?? null;
    this.logger = options.logger ?? console;
  }

  /** How many checks have come back. */
  checks(): number {
    return this.checkCount;
  }

  /** How many checks are still out. */
  pending(): number {
    return this.inFlight.size;
  }

  /**
   * Checks one candidate against the web.
   *
   * Returns as soon as the check is under way: the observer that handed it
   * over must not wait, and neither must the candidate behind it.
   */
  verify(candidate: Candidate): void {
    if (this.stopped) return;
    if (this.inFlight.size === 0) {
      this.onModelState?.("connecting", `checking "${candidate.headline}"`);
    }
    const check = this.check(candidate).finally(() => {
      this.inFlight.delete(check);
      if (this.inFlight.size > 0 || this.stopped) return;
      // A failure has already put its reason on the dot; leave it there to be
      // read rather than replacing it with "ready" a millisecond later.
      if (this.failedSinceIdle) this.failedSinceIdle = false;
      else this.onModelState?.("active", "model client ready");
    });
    this.inFlight.add(check);
    // Registered before returning, so a `max`-speed replay does not run past
    // a check that has only just started.
    void this.clock.track(VERIFY_TRACK_LABEL, check);
  }

  /** Waits for every check in flight, including ones started while waiting. */
  async flush(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** No more checks. The ones in flight still finish. Idempotent. */
  stop(): void {
    this.stopped = true;
  }

  /** One check, start to written-down finish. Never rejects. */
  private async check(candidate: Candidate): Promise<void> {
    // The group's own records first (V3-009). Only a `wrong` stops here: the
    // files not settling it is the ordinary case, and the web check is next.
    //
    // Not awaited when there is no folder, which is most sessions: an `await`
    // on the way to the web call would put a microtask between `verify()` and
    // the request, and the whole point of starting the check inside `verify`
    // is that it is under way by the time it returns.
    const fromFiles = this.knowledge === null ? null : await this.checkFiles(candidate);
    if (fromFiles !== null) {
      this.finish(candidate, fromFiles);
      return;
    }
    let verification: CandidateVerification;
    try {
      verification = await this.request(candidate);
    } catch (error) {
      const detail = message(error);
      this.logger.warn(`[verify] ${candidate.id} could not be checked: ${detail}`);
      this.checkCount += 1;
      // An unchecked claim stops, like an unclear one: the whole point of
      // this step is not telling a group they are wrong without knowing.
      this.onRecord({
        kind: "verification",
        atMs: this.clock.now(),
        candidateId: candidate.id,
        headline: candidate.headline,
        outcome: "failed",
        error: detail,
      });
      this.failedSinceIdle = true;
      this.onModelState?.("error", detail);
      return;
    }

    this.finish(candidate, verification);
  }

  /**
   * Writes one verdict down and, when it is `wrong`, hands the candidate on.
   *
   * Shared by both halves of a check (V3-009): a file-backed verdict and a
   * web-backed one are the same record and the same handover, and the only
   * thing that tells them apart downstream is
   * {@link CandidateVerification.file}.
   */
  private finish(candidate: Candidate, verification: CandidateVerification): void {
    this.checkCount += 1;
    const atMs = this.clock.now();
    const wrong = verification.verdict === "wrong";
    this.onRecord({
      kind: "verification",
      atMs,
      candidateId: candidate.id,
      headline: candidate.headline,
      outcome: wrong ? "verified" : "unverified",
      verification,
    });
    this.logger.log(
      `[verify] ${candidate.id} is ${verification.verdict}` +
        ` (${verification.citations.length} citation(s)` +
        `${verification.file === undefined ? (verification.searched ? "" : ", no search") : `, from ${verification.file}`})` +
        `: ${candidate.headline}`,
    );
    if (!wrong || this.stopped) return;
    this.onVerified({
      ...candidate,
      detail: correctedDetail(candidate.detail, verification.correction),
      verification,
      citations: verification.citations,
    });
  }

  /**
   * The group's own files, asked before the web (V3-009).
   *
   * Returns a verification only when a file really contradicts the claim;
   * `null` means "not settled here", which covers a folder with no lines
   * about this, a verdict of `right` or `unclear`, a correction the model
   * could not attach to a file it was shown, and a call that failed. All four
   * fall through to the web check — losing the knowledge half must never cost
   * the web half.
   */
  private async checkFiles(candidate: Candidate): Promise<CandidateVerification | null> {
    const knowledge = this.knowledge;
    if (knowledge === null) return null;
    const snippets = knowledge.search(claimText(candidate));
    // Nothing in the folder mentions any of it: no call, no cost.
    if (snippets.length === 0) return null;
    try {
      const reply = await this.model.structured({
        label: KNOWLEDGE_TRACK_LABEL,
        system: loadPrompt(PROMPTS.verifyKnowledge),
        user: renderKnowledgeVerificationRequest(candidate, snippets),
        schemaName: KNOWLEDGE_VERIFICATION_SCHEMA_NAME,
        schema: knowledgeVerificationJsonSchema,
        maxTokens: KNOWLEDGE_VERIFY_MAX_TOKENS,
      });
      const parsed = KnowledgeVerificationReplySchema.safeParse(reply);
      if (!parsed.success) {
        this.logger.warn(
          `[verify] ${candidate.id}: the file check did not match the schema: ${issues(parsed.error.issues)}`,
        );
        return null;
      }
      if (parsed.data.verdict !== "wrong") {
        this.logger.log(
          `[verify] ${candidate.id}: the group's files say ${parsed.data.verdict}; checking the web`,
        );
        return null;
      }
      const file = resolveKnowledgeCitation(
        parsed.data.file,
        snippets.map((snippet) => snippet.file),
      );
      // A correction nobody can trace to one of their own files is what the
      // web check exists for, so it is not one of these.
      if (file === undefined || parsed.data.correction === "") {
        this.logger.warn(
          `[verify] ${candidate.id}: the file check said wrong without a usable file; checking the web`,
        );
        return null;
      }
      return {
        verdict: "wrong",
        correction: parsed.data.correction,
        citations: [knowledgeCitation(file)],
        searched: false,
        file,
      };
    } catch (error) {
      // Not a failed check: the web half has not run yet.
      this.logger.warn(`[verify] ${candidate.id}: the file check failed: ${message(error)}`);
      return null;
    }
  }

  /** One grounded call, validated. */
  private async request(candidate: Candidate): Promise<CandidateVerification> {
    const reply = await this.model.grounded({
      label: VERIFY_TRACK_LABEL,
      system: loadPrompt(PROMPTS.verify),
      user: renderVerificationRequest(candidate),
      schemaName: VERIFICATION_SCHEMA_NAME,
      schema: verificationJsonSchema,
      maxTokens: VERIFY_MAX_TOKENS,
    });
    const parsed = VerificationReplySchema.safeParse(reply.value);
    if (!parsed.success) {
      throw new ModelCallError(
        `verification reply did not match the schema: ${issues(parsed.error.issues)}`,
      );
    }
    const correction = parsed.data.verdict === "wrong" ? parsed.data.correction : "";
    if (parsed.data.verdict === "wrong" && correction === "") {
      this.logger.warn(`[verify] ${candidate.id} came back wrong with no correction`);
    }
    return {
      verdict: parsed.data.verdict,
      correction,
      citations: this.citations(candidate, reply.citations, parsed.data.citations, reply.searchedUrls),
      searched: reply.searched,
    };
  }

  /**
   * The sources a verdict may be shown with.
   *
   * The reply's `url_citation` annotations come first — those are the API's
   * own record of what the answer rests on. A structured reply usually has
   * none of them, though (it is JSON, and an annotation is a range into
   * prose — measured, see `CLAUDE.md`), so the sources the model listed in
   * its JSON are the real supply, and each one has to be **resolved against
   * the pages the search actually returned** before it can be shown. A name
   * the search never produced is dropped: it would be shown to the group as
   * a link and somebody would click it.
   */
  private citations(
    candidate: Candidate,
    annotated: readonly Citation[],
    listed: readonly unknown[],
    searchedUrls: readonly string[],
  ): Citation[] {
    const byUrl = new Map<string, Citation>();
    for (const citation of annotated) byUrl.set(citation.url, citation);
    const searched = searchedIndex(searchedUrls);
    for (const raw of listed) {
      // One bad entry drops on its own, as a bad candidate does.
      const one = ModelCitationSchema.safeParse(raw);
      if (!one.success) {
        this.logger.warn(`[verify] ${candidate.id} listed an unreadable citation`);
        continue;
      }
      const named = one.data.url.trim();
      const url = resolveCitation(named, searched);
      if (url === undefined) {
        this.logger.warn(`[verify] ${candidate.id} cited a page it never opened: ${named}`);
        continue;
      }
      if (byUrl.has(url)) continue;
      byUrl.set(url, { url, title: citationTitle(one.data.title, url) });
    }
    return [...byUrl.values()];
  }
}

/** The pages one search turned up, looked up by URL and by host. */
export interface SearchedIndex {
  /** Every URL the search returned, exactly as it returned it. */
  urls: Set<string>;
  /** The first URL returned from each host, keyed by host without `www.`. */
  byHost: Map<string, string>;
}

export function searchedIndex(searchedUrls: readonly string[]): SearchedIndex {
  const urls = new Set<string>();
  const byHost = new Map<string, string>();
  for (const raw of searchedUrls) {
    const url = raw.trim();
    if (url === "") continue;
    urls.add(url);
    const host = hostOf(url);
    // First one wins: the search returns its best result for a site first.
    if (host !== undefined && !byHost.has(host)) byHost.set(host, url);
  }
  return { urls, byHost };
}

/**
 * The real page a listed citation points at, or `undefined` if the search
 * never returned one.
 *
 * The model is asked for the URL exactly as the search gave it, and often
 * obliges — but it also shortens one to its site ("en.wikipedia.org" for a
 * Wikipedia article it read, measured against the real API). That is a
 * genuine source named imprecisely, not an invention, so a host that the
 * search really returned resolves to the page it returned from that host.
 * Anything else is dropped.
 */
export function resolveCitation(named: string, searched: SearchedIndex): string | undefined {
  const url = named.trim();
  if (url === "") return undefined;
  if (searched.urls.has(url)) return url;
  const host = hostOf(url);
  if (host === undefined) return undefined;
  return searched.byHost.get(host);
}

/** A URL's host without `www.`, tolerating a bare "en.wikipedia.org". */
function hostOf(url: string): string | undefined {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const host = new URL(absolute).hostname.toLowerCase();
    return host === "" ? undefined : host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/**
 * The user message for one check: what was said, then what the listener made
 * of it.
 *
 * The quotes come first and are the thing under test. The observer's headline
 * is **not** the claim — it is the observer's reading of it, and it usually
 * states the correction already ("Instagram launched in 2010, not 2014"), so
 * handing it over as the claim gets a verdict of `right` on a conversation
 * that was wrong. Measured: that is exactly what the first replay of
 * `moment-fact` returned.
 *
 * A candidate with no quotes (every cited turn unknown) falls back to the
 * headline, with the prompt told that is what happened.
 */
export function renderVerificationRequest(candidate: Candidate): string {
  const blocks = ["## What was said"];
  if (candidate.evidence.length > 0) {
    blocks.push(
      "Said out loud in a brainstorm, in these words. The factual claim in here is what you check.",
      candidate.evidence.map(renderQuote).join("\n"),
    );
  } else {
    blocks.push(
      "The exact words were not recorded. All there is to go on is the note below, which " +
        "states what a listener believes the group got wrong — so work out what the group " +
        "claimed before you check it.",
    );
  }
  blocks.push(
    "## What a listener made of it",
    "This may be wrong. It is a reason to look, not a finding.",
    `${candidate.headline}\n\n${candidate.detail}`,
  );
  if (candidate.whyNow.trim() !== "") {
    blocks.push("## Why it matters here", candidate.whyNow);
  }
  blocks.push(
    `Check the claim against the web. Reply with the verdict, a correction of at most ` +
      `${CORRECTION_MAX_WORDS} words if it is wrong, and the pages you read.`,
  );
  return blocks.join("\n\n");
}

/**
 * The user message for the knowledge half: what was said, then the lines of
 * the group's own files that mention the same things (V3-009).
 *
 * The lines come with their file names and nothing else is offered — no web,
 * no general knowledge — because the question being asked is narrower than
 * the web check's: not "is this true" but "do these records say otherwise".
 */
export function renderKnowledgeVerificationRequest(
  candidate: Candidate,
  snippets: readonly KnowledgeSnippet[],
): string {
  const blocks = ["## What was said"];
  if (candidate.evidence.length > 0) {
    blocks.push(
      "Said out loud in a meeting, in these words. The claim in here is what you check.",
      candidate.evidence.map(renderQuote).join("\n"),
    );
  } else {
    blocks.push(
      "The exact words were not recorded. All there is to go on is the note below, which " +
        "states what a listener believes the group got wrong.",
    );
  }
  blocks.push(
    "## What a listener made of it",
    "This may be wrong. It is a reason to look, not a finding.",
    `${candidate.headline}\n\n${candidate.detail}`,
  );
  blocks.push(
    "## The group's own files",
    "Every line here is from a file they keep. Nothing else is available to you.",
    snippets
      .map((snippet) => `- **${snippet.file}** (line ${snippet.line}): ${snippet.text}`)
      .join("\n"),
  );
  blocks.push(
    `Reply with the verdict, the file it rests on, and — only if the files say otherwise — ` +
      `what the file says, in at most ${CORRECTION_MAX_WORDS} words.`,
  );
  return blocks.join("\n\n");
}

/**
 * The words the knowledge folder is searched with: what the room said, else
 * the listener's note.
 *
 * The quotes rather than the headline, for the reason the web check already
 * learned (US-013) — a headline states the *correction*, so searching for it
 * looks for the fact Sotto believes rather than the one the files might
 * disagree with.
 */
export function claimText(candidate: Candidate): string {
  const quotes = candidate.evidence
    .map((evidence) => evidence.quote.trim())
    .filter((quote) => quote !== "")
    .join(" ");
  return quotes === "" ? `${candidate.headline} ${candidate.detail}` : quotes;
}

/** One quote, attributed where the diarization gave it a label. */
function renderQuote(evidence: EvidenceQuote): string {
  const who = evidence.speaker === undefined ? "Someone" : `Speaker ${evidence.speaker}`;
  return `> **${who}:** ${evidence.quote}`;
}

function issues(list: readonly { path: PropertyKey[]; message: string }[]): string {
  return list.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
