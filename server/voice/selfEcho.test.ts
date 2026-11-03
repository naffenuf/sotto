/**
 * V2-006's pure matcher contract: short ASR excerpts should match speech,
 * while unrelated turns that borrow a few words must remain human context.
 */
import { describe, expect, it } from "vitest";
import { echoOverlap, isSelfEcho } from "./selfEcho.js";

const spoken = "I'm Sotto. The north entrance is closed; please use the garden gate instead.";

describe("self-echo token overlap", () => {
  it.each([
    ["exact echo", spoken],
    ["partial echo", "Use the garden gate instead"],
    ["ASR errors", "the north entrance was close please use a garden gate instead"],
    ["punctuation and case", "I’M SOTTO!"],
  ])("recognizes %s", (_name, captured) => {
    expect(isSelfEcho(captured, [spoken])).toBe(true);
  });

  it.each([
    ["unrelated side talk", "Alex cannot attend Thursday afternoon"],
    ["quoting a few words", "You mentioned garden gate but Alex needs parking directions tomorrow"],
    ["empty text", "..."],
  ])("keeps %s", (_name, captured) => {
    expect(isSelfEcho(captured, [spoken])).toBe(false);
  });

  it("includes the 0.6 boundary and does not inflate repeated words", () => {
    expect(echoOverlap("one two three extra words", "one two three")).toBe(0.6);
    expect(isSelfEcho("one two three extra words", ["one two three"])).toBe(true);
    expect(echoOverlap("gate gate gate gate", "garden gate")).toBe(0.25);
    expect(isSelfEcho("hello", [])).toBe(false);
  });

  it("does not let function words match a long answer", () => {
    // The checkpoint session: a room member's line said over Sotto's status
    // answer, which shares only "and the has to on the page" with it.
    const answer =
      "Here's where you're at on the launch workshop. You're three weeks out and you've decided " +
      "on the Makerspace. It has a hard cap of thirty people, the grant covers thirty kits, and " +
      "Saturday is two hundred dollars flat. The plan is to start at eleven and feed people, and " +
      "you want the Bend crowd there. For tickets you're talking about opening fifty at five " +
      "dollars each, with the page going up tonight and invites Friday, and you expect twenty " +
      "alone from Bend. The open tension is fifty tickets for a thirty cap room, with the idea " +
      "that no shows make the oversell fine and a five dollar ticket";
    expect(isSelfEcho(" Oh wait and the kits list has to go on the page? ", [answer])).toBe(false);
    // The same answer, heard back in part, still matches.
    expect(isSelfEcho("the grant covers thirty kits and Saturday is two hundred dollars flat", [answer])).toBe(true);
  });

  it("reads Sotto's own name however it was spelled (2026-11-03_0915-mic)", () => {
    const hello =
      "Hi, I'm Sotto. I'm listening and keeping notes, and I'll only speak up when it's worth " +
      "it. If you wonder something out loud I can look up, I may chime in; I'll stop the moment " +
      "anyone talks, and any of you can say \"Sotto, not now\" to keep me quiet for the rest of " +
      "the meeting. If you want me, just say \"Sotto\".";
    // The last sentence of the hello, heard back as its own turn, which cut
    // the hello off as a barge-in and was then answered as a question.
    expect(isSelfEcho(" If you want me just say Soto ", [hello])).toBe(true);
    // The acknowledgment and the answer heard back as one turn: it has to
    // match the answer on its own, since unrelated utterances never pool.
    const answer = "Got it, just say Sotto whenever you need me and I'll jump in.";
    expect(isSelfEcho(" Let me check. Got it. Just say Soto whenever you need me and I'll. ", ["Let me check.", answer])).toBe(true);
    // Somebody really addressing Sotto over its own speech is still a person
    // — as long as their words are not the hello's own: "Sotto, not now"
    // said during the hello is textually the hello's "Sotto, not now", and
    // no matcher on words can tell those apart.
    expect(isSelfEcho(" Soto hold on ", [hello])).toBe(false);
    expect(isSelfEcho(" Soto not now ", [answer])).toBe(false);
  });

  it("does not pool unrelated utterances into a match", () => {
    expect(isSelfEcho("one two three four five", ["one two", "three four"])).toBe(false);
  });
});
