# V2-008 checkpoint: live voice test, attempt 1

**Date:** 2026-10-31, 16:18 session (`sessions/2026-10-31_1618-mic`)
**Setup:** one person (Craig), MacBook speakers, one Sotto tab, Chrome.
**Tested:** a few minutes of solo speech with spoken questions to Sotto.
**Not reached:** Sotto never answered, so echo, barge-in, false barge-in and side talk were not
tested at all. Two-person tests (side talk, overlapping speech) still need a second person, or a
phone playing a voice as a stand-in, at the retest.

RESULT: FAIL

## Second run, 16:35, still on the old detector (`sessions/2026-10-31_1635-mic`)

Sotto spoke this time, through a lucky wake match, a typed question and a barge-in.

- **Echo: good.** None of Sotto's speech reached the transcript, and the self-echo filter logged
  no matches. Chrome's echo cancellation seems to remove it before transcription.
- **Barge-in: good.** "Soto I didn't give you…" during an answer went silent in 236 ms
  (`wakeToSilenceMs`; flush confirmed in 3 ms) and was classified `new_question`. "Soto you can
  resume…" was classified `continue`.
- **Wake word: still poor.** Expected, since the classifier below hasn't been built yet.
  "Soto give me the bull and bear case…", "Hey Soto give me…" and "…from Anthropic Sotto can you
  tell me…" were all missed.
- **NEW BUG, fix first: answers get an empty transcript in live sessions.** The first answer
  asked "which IPO?" although "Anthropic IPO" had been said in a final turn 7 s earlier. Sotto later
  explained that "nothing was transcribed". The cause is in `recentTurns()`
  (`server/answer/AnswerAgent.ts`): it compares `clock.now()` with turn `startMs/endMs`. Live, the
  clock is `systemClock` (`performance.now()`, i.e. server uptime: about 1,914,000 ms here), while
  turn times are on the transcription-stream timeline (about 40,000 ms). So
  `now - ANSWER_CONTEXT_MS` is later than every turn, and the answer sees **no conversation at
  all** once the server has been up more than about 10 minutes. Replays use `SimulatedClock(0)`, so
  the timelines agree and the tests pass. Fix: measure the window on the turn timeline (for
  example, relative to the latest final turn's `endMs`) and add a test whose live clock is offset
  from the stream timeline. Check that nothing else mixes the two timelines. The observer and
  board pass turns directly and look fine.
- **Minor:** "This is Craig…" didn't name speaker A, so Sotto called him "A". Look at why the
  speaker-introduction detection missed it; it's not blocking.

## Third run, 16:44, old detector (`sessions/2026-10-31_1644-mic`)

The wake word worked only because the transcription happened to keep commas ("Hey, Soto, can
you…", "Soto, stop."). The classifier fix is still required. Barge-in went silent in 98 ms and
163 ms. Mentions while Sotto spoke ("I guess Soto doesn't want to give me that") were correctly
ignored. Two more items:

- **Fix: answers still lean short.** Sotto opened with "the short version is…" when the user
  wanted the full case. Product decision: **no artificial length limits.** Spoken answers should be
  as long as the question deserves. Review `server/prompts/answer.md` and anything else that pushes
  toward brevity in the spoken part (keep the 90-character card headline). Add a test or eval note
  that a "give me the case for X" question isn't truncated to a summary.
- **Measure only, don't build yet: slow first sentence.** The acknowledgment played at 0.26–0.4 s,
  but the first real sentence came 15 s (search question) and 9 s (follow-up) later. Record in
  progress.txt where those seconds go (web search vs. generation before the first sentence) and
  propose an approach. Speaking a first line before the search returns is the likely one; that
  becomes a later story.

## What happened (first run, 16:18)

Sotto never heard itself addressed. `timing.jsonl` has no wake events. Live speech is transcribed
with almost no punctuation, and `server/wake.ts` (deliberately strict, tuned on fixtures with
cleaner punctuation) rejected every real address:

| Turn | Why `detect()` rejected it |
|---|---|
| "…it's a Saturday so the stock market is closed but I was wondering Soto can you tell me the bull case and the bear case for the upcoming anthropic IPO" | The name is mid-sentence, with no sentence break or "hey/okay" before it. "can you" is not a wh-word, and there's no comma or "?" |
| "Soto" *(pause)* | A wake word with nothing after it |
| "can you tell me the bull and bear case for the upcoming anthropic IPO" | No wake word: the pause split the address from the question |
| "oh Soto you're not doing well" | Correctly ignored (a remark, not a request) |

Adding more word rules would be brittle. The fix is to let a model decide.

## Fix list (do this before V2-009)

Replace rule-based wake detection with **a word check followed by a model classifier**.

1. **Word check stays instant.** Any whole-word spelling in `DEFAULT_WAKE_SPELLINGS`
   (`sotto|soto|sato|sota`) in a *partial* turn raises "Sotto is listening". It still drives
   V2-007 barge-in (`detectsAddress`): stopping playback is cheap and reversible, so it stays
   lexical and immediate. Possessive `'s` and `voce` may stay as cheap exclusions in the word check.
2. **Classifier on the final turn.** When a final turn contains the name, call **Muse Spark**
   (`muse-spark-1.3`, `reasoning_effort: "low"`, `max_tokens` about 2000, check
   `finish_reason === "stop"`) with structured output
   `{ kind: "request" | "name_only" | "mention", question: string }`, the latest turn, and the
   previous 3–4 final turns with speaker names. Put the prompt in `server/prompts/address.md`;
   the tested wording is below.
   - `request`: hand `question` to the answer agent exactly as a wake question is handled today
     (acknowledgment, spoken answer, card).
   - `name_only`: arm that speaker for about 8 s. Their next final turn goes to the classifier
     with the name-only turn as context, which usually returns `request`. Show "listening"
     while armed.
   - `mention`: do nothing; take "listening" down.
3. **Turns without the name.** The only time the classifier sees a turn without the name is the
   armed follow-up in step 2. Otherwise no model call: no cost and no false triggers.
4. **Fallback.** If Spark errors, times out (about 6 s) or returns an unusable result, fall back to
   today's `detect()` for that turn and log `address_fallback` in `timing.jsonl`.
5. **During playback** V2-007's command classifier (stop / continue / new_question) still owns
   final turns. Don't double-classify a turn. Sharing code between the two classifiers is fine.
6. **Log** every classification in `timing.jsonl`: `stage: "address"`, `turnId`, `kind`,
   `latencyMs`, `fallback`.
7. **Tests.**
   - Offline unit tests with a fake classifier: routing for each kind, name-only arming and
     expiry, fallback, and no model call for name-free turns.
   - Keep `detect()` and its tests as the fallback.
   - Integration test (real Spark, `npm run test:integration`) on the 15 cases below: all must
     match.
   - Real-API check that the `no-wake` capture still produces zero answers, and that the wake
     fixtures still answer.
8. **Then:** commit, rename this file to `tasks/checkpoint-voice-fail-1.md`, and leave V2-008
   `passes: false`, so the loop stops again for the retest. The retest also covers everything
   attempt 1 never reached (echo, barge-in, false barge-in, side talk).

## Evidence: classifier test, 2026-10-31

The same prompt, run on 15 turns:

| Model | Correct | Latency |
|---|---|---|
| Muse Spark 1.3, `reasoning_effort: "low"` | **15/15** | 0.9–4.9 s, typically about 2 s |
| Muse Glimmer (local Ollama), thinking off | 13/15, and unstable between runs | 2.5–4 s warm (15 s cold) |
| Muse Glimmer, low reasoning | not run on this set | about 14 s, too slow for addressing |

Use Spark here. Glimmer keeps the latency-tolerant judgment work.

Cases (`before` = previous turns; `want` = expected kind):

| Previous turns | Latest turn | want |
|---|---|---|
| | Hi, I'm Craig… it's a Saturday so the stock market is closed but I was wondering Soto can you tell me the bull case and the bear case for the upcoming anthropic IPO | request |
| | Soto | name_only |
| Craig: Soto | can you tell me the bull and bear case for the upcoming anthropic IPO | request |
| | oh Soto you're not doing well | mention |
| | honestly I think Sotto is being way too chatty today | mention |
| | we should go to Soto's after this the tacos are great | mention |
| | Exactly. Sotto voce if you want to be fancy about it | mention |
| | Sotto what do the main competitors charge per month | request |
| | hey Sato remind us what we decided about the budget | request |
| | I asked Soto earlier and it said the venue holds forty | mention |
| | Soto could you pull up the drive time to the lake house | request |
| | ok so Sotto flagged the caterer thing which was useful | mention |
| | Soto is right though we can't afford six gardens | mention |
| EJ: Soto | never mind | mention |
| | thanks Soto that was helpful can you also check the weather for Saturday | request |

Tested prompt (system message). The user message was
`Previous turns:\n<turns or (none)>\n\nLATEST turn:\n<turn>`:

```
Sotto is an AI assistant listening to a meeting through speech recognition, which often drops
punctuation and spells the name Sotto, Soto, Sato or Sota. Decide what the LATEST turn does with
the name.
- request: someone is asking or telling Sotto to do something (a question, a request, an
  instruction). Also request when the previous turn was only the name and this turn is the request.
- name_only: the turn just calls Sotto ("Sotto", "hey Sotto") and the request is still to come.
- mention: people are talking about Sotto or about something else called Soto (a restaurant, a
  person, 'sotto voce'), or remarking to it without asking for anything, or reporting what someone
  asked Sotto earlier ("I asked Soto earlier and it said...").
For request, question is the request in clean words without the name; otherwise empty.
```
