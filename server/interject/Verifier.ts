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
 * Unlike the board loop and the observer, checks run **concurrently**: one
 * candidate waiting on a search must not hold up the next one. Each check is
 * registered with {@link Clock.track} before {@link Verifier.verify} returns,
 * so a `max`-speed replay still stops for all of them.
 */
import {
  CORRECTION_MAX_WORDS,
  ModelCitationSchema,
  VERIFICATION_SCHEMA_NAME,
  VerificationReplySchema,
  correctedDetail,
  verificationJsonSchema,
  type Candidate,
  type CandidateVerification,
  type VerificationLogRecord,
} from "../../shared/candidates.js";
import type { Citation, EvidenceQuote } from "../../shared/cards.js";
import type { Clock } from "../clock.js";
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
  logger?: Logger;
}

export class Verifier {
  private readonly clock: Clock;
  private readonly model: ModelClient;
  private readonly onRecord: (record: VerificationLogRecord) => void;
  private readonly onVerified: (candidate: Candidate) => void;
  private readonly onModelState: VerifierOptions["onModelState"];
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
        `${verification.searched ? "" : ", no search"}): ${candidate.headline}`,
    );
    if (!wrong || this.stopped) return;
    this.onVerified({
      ...candidate,
      detail: correctedDetail(candidate.detail, verification.correction),
      verification,
      citations: verification.citations,
    });
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
