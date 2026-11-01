# V2-008 checkpoint: live voice test, attempt 2 (retest)

**Date:** 2026-10-31, 22:52 session (`sessions/2026-10-31_2252-mic`), about 4 minutes
**Setup:** one person (Craig), MacBook speakers, one Sotto tab, Chrome. Runs on the attempt-1
fixes (Spark address classifier, answer-context clock fix, no answer-length pressure, "This is
Craig" introductions). Attempt 1 is archived as `checkpoint-voice-fail-1.md`.

**Deviation from the story:** this was a solo test, not two people. Side talk between people and
overlapping speech (crosstalk) are **deferred** to the first session with a second person, and
need checking then. Everything that one person can test was tested.

RESULT: PASS

## Findings

| Area | Result |
|---|---|
| Voice leaking into the transcript | **None.** No Sotto speech reached the transcript, and the self-echo filter logged no matches. Chrome's echo cancellation removes it before transcription. |
| Wake word, no comma or mid-sentence | **Works.** "…I think it was the 2019 one Soto, what should I watch out for with that?" → `request` (Spark, 2.6 s). |
| Wake word split across a pause | **Works.** "Soto, can you give me the bull and bear case for" / "the Anthropic IPO?" → `request`. The question text was cut at the pause, but the answer used context and covered the Anthropic IPO. |
| Mentions ignored | **Works.** "Soto, I was going to ask you about that." → `mention`. "I think Soto's being a bit cherry" during an answer did **not** barge in. "So what was I talking about before the car?" (no name) was ignored. |
| Conversation context (clock fix) | **Works.** Asked about "that", the first answer covered the 2019 Outback. "What was I talking about before the car?" → "the Halloween parade in Greenwich Village". |
| Barge-in | **Works.** Three barge-ins, each classified `new_question` and answered correctly. Flush 3–7 ms after detection (`wakeToSilenceMs` 3–40 ms). That figure starts when the partial is *detected*, so the felt delay also includes about 0.6–0.7 s of transcription lag. It felt immediate. |
| False barge-ins | **None** observed. |
| Answer length | **Fixed.** The bull/bear case ran 663 spoken words, uncut, until the user interrupted it. |
| Speaker naming | **Fixed.** "I'm Craig" named the speaker; answers address "Craig". |

## Latency, for later stories (not blocking)

- **Name → acknowledgment: about 4 s.** End-of-speech detection (about 0.5 s) plus transcription
  lag (about 0.65 s) plus Spark address classification (2.6–3.3 s) plus the acknowledgment
  (0.25–0.48 s). The classifier is the biggest piece. Idea: start classifying on the partial once
  the name is heard, or play the acknowledgment as soon as a partial clearly starts with the name.
- **Acknowledgment → first real sentence:** 3.5–4.7 s for conversation-only answers, 8–13 s when
  searching. Speaking an early first line while the search runs is already proposed in
  progress.txt.

## Notes

- Sotto's own speech isn't in the transcript yet; that's V2-008a.
- Untested until a second person is available: human side talk during Sotto's speech, and how
  transcription labels two people talking at once.
