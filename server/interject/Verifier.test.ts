import { describe, expect, it } from "vitest";
import {
  CORRECTION_LABEL,
  type Candidate,
  type VerificationLogRecord,
} from "../../shared/candidates.js";
import { SimulatedClock } from "../clock.js";
import type { GroundedCall, GroundedReply, ModelClient } from "../model/client.js";
import { VERIFY_MAX_TOKENS, VERIFY_TRACK_LABEL, Verifier, renderVerificationRequest } from "./Verifier.js";

/** A grounded reply, with everything the tests do not care about defaulted. */
function reply(overrides: Partial<GroundedReply> & { value: unknown }): GroundedReply {
  return { citations: [], searchedUrls: [], searched: true, ...overrides };
}

/** The usual shape of a verdict, as the model returns it. */
function verdict(
  value: "wrong" | "right" | "unclear",
  correction = "",
  citations: unknown[] = [],
): unknown {
  return { verdict: value, correction, citations };
}

/** A model whose grounded calls are answered from a script. */
class FakeModel implements ModelClient {
  readonly calls: GroundedCall[] = [];
  /** Resolves the n-th call, so a test can hold one check open. */
  private readonly gates: ((value: GroundedReply) => void)[] = [];

  constructor(readonly replies: (() => Promise<GroundedReply>)[]) {}

  async structured(): Promise<never> {
    throw new Error("the verifier never makes an ungrounded call");
  }

  async prose(): Promise<never> {
    throw new Error("the verifier never asks for prose");
  }

  async grounded(call: GroundedCall): Promise<GroundedReply> {
    this.calls.push(call);
    const next = this.replies.shift();
    if (next === undefined) throw new Error(`unexpected grounded call ${this.calls.length}`);
    return next();
  }

  /** A reply that only arrives when the test says so. */
  held(): { answer: (value: GroundedReply) => void } {
    const gate = { answer: (_value: GroundedReply) => {} };
    this.replies.push(
      () =>
        new Promise<GroundedReply>((resolve) => {
          gate.answer = resolve;
        }),
    );
    this.gates.push(gate.answer);
    return gate;
  }
}

interface Harness {
  clock: SimulatedClock;
  model: FakeModel;
  verifier: Verifier;
  /** Every line written to `candidates.jsonl`, in order. */
  records: VerificationLogRecord[];
  /** The candidates that went on to the policy. */
  verified: Candidate[];
  states: [state: string, detail: string][];
  warnings: string[];
}

function harness(replies: (() => Promise<GroundedReply>)[] = []): Harness {
  const clock = new SimulatedClock(0);
  const model = new FakeModel(replies);
  const records: VerificationLogRecord[] = [];
  const verified: Candidate[] = [];
  const states: [string, string][] = [];
  const warnings: string[] = [];
  const verifier = new Verifier({
    clock,
    model,
    onRecord: (record) => records.push(record),
    onVerified: (candidate) => verified.push(candidate),
    onModelState: (state, detail) => states.push([state, detail]),
    logger: { log: () => {}, warn: (text: string) => warnings.push(text) },
  });
  return { clock, model, verifier, records, verified, states, warnings };
}

/** A `factual_error` candidate as the observer hands it over. */
function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "cand-1",
    createdAtMs: 1_000,
    run: 1,
    type: "factual_error",
    headline: "Instagram launched in 2010, not 2014",
    detail: "The growth curve is being costed off a launch date four years late.",
    whyNow: "The roadmap is being hung on that curve",
    evidenceTurnIds: ["0:5"],
    evidence: [
      {
        turnId: "0:5",
        speaker: "B",
        quote: "Instagram launched in 2014, and inside about two years they were past a hundred million users.",
      },
    ],
    relatedBoardItemIds: ["p2"],
    scores: { relevance: 0.9, novelty: 0.8, importance: 0.7, confidence: 0.8 },
    ...overrides,
  };
}

describe("Verifier", () => {
  it("asks for a grounded, structured check with a generous budget", async () => {
    const { verifier, model } = harness([async () => reply({ value: verdict("right") })]);
    verifier.verify(candidate());
    await verifier.flush();

    const call = model.calls[0] as GroundedCall;
    expect(call.label).toBe(VERIFY_TRACK_LABEL);
    expect(call.maxTokens).toBe(VERIFY_MAX_TOKENS);
    expect(call.system).toContain("You check one factual claim");
    expect(call.user).toContain("Instagram launched in 2010, not 2014");
  });

  it("passes a wrong claim on, with the correction in its detail", async () => {
    const { verifier, verified, records } = harness([
      async () =>
        reply({
          value: verdict("wrong", "Instagram launched in October 2010, not 2014.", [
            { url: "https://en.wikipedia.org/wiki/Instagram", title: "Instagram - Wikipedia" },
          ]),
          searchedUrls: ["https://en.wikipedia.org/wiki/Instagram"],
        }),
    ]);
    verifier.verify(candidate());
    await verifier.flush();

    expect(verified).toHaveLength(1);
    const checked = verified[0] as Candidate;
    expect(checked.id).toBe("cand-1");
    expect(checked.detail).toContain("costed off a launch date four years late");
    expect(checked.detail).toContain(`${CORRECTION_LABEL} Instagram launched in October 2010`);
    expect(checked.citations).toEqual([
      { url: "https://en.wikipedia.org/wiki/Instagram", title: "Instagram - Wikipedia" },
    ]);
    expect(checked.verification?.verdict).toBe("wrong");
    expect(records[0]?.outcome).toBe("verified");
  });

  for (const settled of ["right", "unclear"] as const) {
    it(`marks a ${settled} claim unverified and stops there`, async () => {
      const { verifier, verified, records } = harness([
        async () => reply({ value: verdict(settled) }),
      ]);
      verifier.verify(candidate());
      await verifier.flush();

      expect(verified).toEqual([]);
      expect(records).toHaveLength(1);
      expect(records[0]?.outcome).toBe("unverified");
      expect(records[0]?.verification?.verdict).toBe(settled);
      expect(records[0]?.candidateId).toBe("cand-1");
    });
  }

  it("writes the check down with the time it came back", async () => {
    const { verifier, clock, records, model } = harness();
    const gate = model.held();
    verifier.verify(candidate());
    clock.advanceBy(2_500);
    gate.answer(reply({ value: verdict("right") }));
    await verifier.flush();
    expect(records[0]?.atMs).toBe(2_500);
  });

  it("stops a claim it could not check, and says why", async () => {
    const { verifier, verified, records, warnings, states } = harness([
      () => Promise.reject(new Error("the search timed out")),
    ]);
    verifier.verify(candidate());
    await verifier.flush();

    expect(verified).toEqual([]);
    expect(records[0]?.outcome).toBe("failed");
    expect(records[0]?.error).toContain("the search timed out");
    expect(records[0]?.verification).toBeUndefined();
    expect(warnings.join(" ")).toContain("cand-1 could not be checked");
    expect(states.at(-1)).toEqual(["error", "the search timed out"]);
  });

  it("stops a claim whose verdict did not fit the schema", async () => {
    const { verifier, verified, records } = harness([
      async () => reply({ value: { verdict: "false", correction: 7 } }),
    ]);
    verifier.verify(candidate());
    await verifier.flush();
    expect(verified).toEqual([]);
    expect(records[0]?.outcome).toBe("failed");
    expect(records[0]?.error).toContain("did not match the schema");
  });

  it("does not let one check hold up the next", async () => {
    const { verifier, model, verified } = harness();
    const first = model.held();
    model.replies.push(async () =>
      reply({ value: verdict("wrong", "It is fifteen percent after the first year.") }),
    );
    verifier.verify(candidate());
    verifier.verify(candidate({ id: "cand-2", headline: "The App Store takes 30%, not 40%" }));

    // The second check runs and lands while the first is still out.
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(verified.map((one) => one.id)).toEqual(["cand-2"]);
    expect(verifier.pending()).toBe(1);

    first.answer(reply({ value: verdict("right") }));
    await verifier.flush();
    expect(verifier.pending()).toBe(0);
  });

  it("registers every check on the clock, so a max-speed replay waits", async () => {
    const { verifier, clock, model } = harness();
    const gate = model.held();
    verifier.verify(candidate());
    expect(clock.inFlight()).toEqual([VERIFY_TRACK_LABEL]);
    gate.answer(reply({ value: verdict("right") }));
    await clock.settle();
    expect(clock.inFlight()).toEqual([]);
  });

  it("shows the model dot busy until the last check is back", async () => {
    const { verifier, model, states } = harness();
    const first = model.held();
    const second = model.held();
    verifier.verify(candidate());
    verifier.verify(candidate({ id: "cand-2" }));
    expect(states).toEqual([["connecting", 'checking "Instagram launched in 2010, not 2014"']]);

    first.answer(reply({ value: verdict("right") }));
    second.answer(reply({ value: verdict("right") }));
    await verifier.flush();
    expect(states.at(-1)).toEqual(["active", "model client ready"]);
    expect(states.filter(([state]) => state === "active")).toHaveLength(1);
  });

  it("makes no call once it has stopped", async () => {
    const { verifier, model } = harness();
    verifier.stop();
    verifier.verify(candidate());
    await verifier.flush();
    expect(model.calls).toEqual([]);
    expect(verifier.checks()).toBe(0);
  });

  describe("citations", () => {
    it("prefers the reply's own annotations", async () => {
      const annotated = { url: "https://example.com/a", title: "A" };
      const { verifier, verified } = harness([
        async () =>
          reply({
            value: verdict("wrong", "Not so.", [{ url: "https://example.com/a", title: "Wrong name" }]),
            citations: [annotated],
            searchedUrls: ["https://example.com/a"],
          }),
      ]);
      verifier.verify(candidate());
      await verifier.flush();
      expect(verified[0]?.citations).toEqual([annotated]);
    });

    it("accepts a listed page the search really returned", async () => {
      const { verifier, verified } = harness([
        async () =>
          reply({
            value: verdict("wrong", "Not so.", [
              { url: "https://example.com/a ", title: "A" },
            ]),
            searchedUrls: ["https://example.com/a"],
          }),
      ]);
      verifier.verify(candidate());
      await verifier.flush();
      expect(verified[0]?.citations).toEqual([{ url: "https://example.com/a", title: "A" }]);
    });

    /**
     * Measured against the real API: asked for a full URL the model usually
     * gives one, but it also names the site a page is on and nothing else.
     */
    it("resolves a site named on its own to the page the search returned", async () => {
      const { verifier, verified, warnings } = harness([
        async () =>
          reply({
            value: verdict("wrong", "Not so.", [
              { url: "en.wikipedia.org", title: "Instagram - Wikipedia" },
            ]),
            searchedUrls: [
              "https://techcrunch.com/2012/04/09/instagram-story/",
              "https://en.wikipedia.org/w/index.php?title=Instagram&oldid=1372354549",
              "https://en.wikipedia.org/wiki/Kevin_Systrom",
            ],
          }),
      ]);
      verifier.verify(candidate());
      await verifier.flush();
      // The first page the search returned from that host, not the second.
      expect(verified[0]?.citations).toEqual([
        {
          url: "https://en.wikipedia.org/w/index.php?title=Instagram&oldid=1372354549",
          title: "Instagram - Wikipedia",
        },
      ]);
      expect(warnings).toEqual([]);
    });

    /** A hallucinated URL would be shown as a link, and somebody would click it. */
    it("drops a page the model never opened", async () => {
      const { verifier, verified, warnings } = harness([
        async () =>
          reply({
            value: verdict("wrong", "Not so.", [
              { url: "https://invented.example/post", title: "Made up" },
            ]),
            searchedUrls: ["https://example.com/a"],
          }),
      ]);
      verifier.verify(candidate());
      await verifier.flush();
      expect(verified[0]?.citations).toEqual([]);
      expect(warnings.join(" ")).toContain("cited a page it never opened");
    });

    it("drops one unreadable entry and keeps the rest", async () => {
      const { verifier, verified, warnings } = harness([
        async () =>
          reply({
            value: verdict("wrong", "Not so.", ["junk", { url: "https://example.com/a", title: "A" }]),
            searchedUrls: ["https://example.com/a"],
          }),
      ]);
      verifier.verify(candidate());
      await verifier.flush();
      expect(verified[0]?.citations).toEqual([{ url: "https://example.com/a", title: "A" }]);
      expect(warnings.join(" ")).toContain("unreadable citation");
    });

    it("records whether the model searched at all", async () => {
      const { verifier, records } = harness([
        async () => reply({ value: verdict("right"), searched: false }),
      ]);
      verifier.verify(candidate());
      await verifier.flush();
      expect(records[0]?.verification?.searched).toBe(false);
    });
  });
});

describe("renderVerificationRequest", () => {
  /**
   * The headline usually *is* the correction, so leading with it gets a
   * verdict of `right` on a conversation that was wrong — measured against
   * the real model before the quotes were put in front of it.
   */
  it("leads with what was said, then the listener's doubt about it", () => {
    const text = renderVerificationRequest(candidate());
    expect(text).toContain("## What was said");
    expect(text).toContain("> **Speaker B:** Instagram launched in 2014");
    expect(text).toContain("## What a listener made of it");
    expect(text).toContain("Instagram launched in 2010, not 2014");
    expect(text.indexOf("## What was said")).toBeLessThan(
      text.indexOf("## What a listener made of it"),
    );
    expect(text).toContain("## Why it matters here");
  });

  it("says so when the words were not recorded", () => {
    const text = renderVerificationRequest(candidate({ evidence: [] }));
    expect(text).toContain("The exact words were not recorded");
    expect(text).toContain("Instagram launched in 2010, not 2014");
  });

  it("attributes a quote with no speaker label to nobody in particular", () => {
    const text = renderVerificationRequest(
      candidate({ evidence: [{ turnId: "0:5", quote: "It launched in 2014." }] }),
    );
    expect(text).toContain("> **Someone:** It launched in 2014.");
  });

  it("leaves out a why-now that is not there", () => {
    expect(renderVerificationRequest(candidate({ whyNow: "  " }))).not.toContain(
      "## Why it matters here",
    );
  });
});
