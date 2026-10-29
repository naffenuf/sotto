# What Meta's realtime transcription actually sends

Recorded from the real API, not from the docs: every file in this directory was
produced by `npm run capture -- <fixture>`, which replays `fixtures/audio/<fixture>.wav`
through `wss://api.meta.ai/v1/asr/realtime` at real-time pace and writes down every
frame the server sent. Handshake used for all of these captures:

```json
{
  "authorization": { "accessToken": "Bearer <MODEL_API_KEY>" },
  "audioEncoding": "PCM_24KHZ",
  "model": "muse-voice-transcribe-1.0",
  "mode": "DIARIZATION",
  "keywords": ["Sotto"]
}
```

## File format

One JSON object per line (`shared/asr.ts` → `AsrFrameRecordSchema`):

```json
{ "atMs": 4330.26, "session": 0, "frame": { "type": "speaker", "label": "A", "audioProcessedMs": 4160 } }
```

- `atMs` — milliseconds from the start of the audio stream to the arrival of the frame.
- `session` — which ASR session the frame came from, from 0. Every capture here is a
  single session; more than one only appears after a reconnect.
- `frame` — the frame exactly as the server sent it.

## Frame shapes seen

Every frame is a JSON text frame. No binary frames, and no `error` frames in any capture.

| Frame | Fields | Notes |
|---|---|---|
| handshake ack | `sessionId` | The only frame with no `type`. `sessionId` looks like `voyager/duplex/874A29694F364697930A7000D9BAF5F5`. Arrives 200–510 ms after the socket opens (9 of 9 captures). |
| `speechStart` | `type`, `turnId`, `audioProcessedMs` | Opens a turn. `turnId` counts up from 0 within the session. |
| `transcript` | `type`, `transcript`, `final`, `audioProcessedMs` | Cumulative partial for the open turn. **No `turnId`** — see below. |
| `speaker` | `type`, `label`, `audioProcessedMs` | Diarization label (`A`, `B`). **No `turnId`.** |
| `speechEnd` | `type`, `turnId`, `audioProcessedMs` | Closes the turn. |
| `speechComplete` | `type`, `turnId`, `transcript`, `audioProcessedMs` | Final text for the turn. |
| `audioProgress` | `type`, `audioProcessedMs` | One per 80 ms audio chunk, so ~12.5/s and 78.7% of the 14,577 frames captured here. The docs say `emitAudioProgress` is on by default and can be turned off at handshake; it is left on here so the captures show the stream exactly as it comes. |

`audioProcessedMs` is a position in the *audio*, not wall-clock: how much audio the
server had consumed when it decided the thing the frame reports. `atMs` is when the
frame arrived. The two differ by the processing lag (below).

## Order within a turn

Exactly this, with no interleaving, in **198 of 198 turns** across all nine captures:

```
speechStart(turnId: n)
transcript (final: false)     × 2–31, cumulative
speaker(label)
speechEnd(turnId: n)
speechComplete(turnId: n, transcript)
```

- **Partials replace, they don't append.** Each `transcript` frame carries the whole
  turn so far (` So`, ` So walk`, ` So walk me through`, …). Leading and trailing spaces
  are part of the text, and so is the sentence punctuation the model adds.
- **The last partial always equals `speechComplete.transcript`** — 198 of 198 turns.
  `speechComplete` is still the one to trust, because it is the only text frame tied to a
  `turnId`.
- **`transcript` and `speaker` frames carry no `turnId`.** They belong to the turn
  opened by the most recent `speechStart` that has no `speechEnd` yet. This is what the
  docs mean when they say a `speaker` event "labels the audio behind it… from the
  previous start or speaker event through the current one".
- **Exactly one `speaker` frame per turn** in every capture — the span the docs describe
  is always the whole turn — and it arrives *before* `speechEnd`, so a turn's label is
  known by the time it goes final but **not while it is still a partial**. A partial turn
  has no speaker until its `speaker` frame lands; the UI has to show partials with no
  chip, or with the chip from the previous turn.
- `speaker` labels are per session only. In every capture the labels tracked the
  fixture's own A/B alternation exactly, with no errors — see the per-fixture table.
  Across a reconnect there is nothing tying one session's labels to the next one's, so
  the assembler maps them by **order of first appearance** and marks every turn from the
  later session `speakerMappingUncertain` (see "Close codes").
- **No overlapping turns were observed.** Fixture audio is rendered line by line, so
  two people never talk at once; the assembler still has to key partials by the open
  turn rather than assume there is only ever one.
- Every `speechComplete.transcript` is non-empty.

## Processing lag and pauses

`speechEnd` and `speechStart` frames arrive **~601–762 ms** after the audio
position they report (across all nine captures: min 601 ms, median 641 ms,
max 762 ms between `speechEnd.audioProcessedMs` and `atMs`, n=198). The lag is
near-constant for both, so the *gap* between turns measured on arrival times matches the
gap measured in audio time to within ~40 ms.

The endpointer needs roughly half a second of silence before it emits `speechEnd`, and
it reports the end of speech, not the start of the silence. The silence the API exposes
between turns is therefore **~0.5 s shorter than the pause actually in the audio**. Measured
twice on the same `brainstorm` line, which makes the offset look like a constant rather than
a ratio: a scripted `pauseAfterMs` of 1,600 ms surfaced as a 1,084 ms
`speechEnd → speechStart` gap, and 2,400 ms on the same line surfaced as 1,944 ms — 456 ms
and 516 ms of pause eaten. **Size pause thresholds against the captures, never against
`pauseAfterMs`.**

> **Why `brainstorm`'s last line pauses for 2,400 ms.** US-006's `pauseState` has to be
> tested against a pause of ≥ 1.5 s, and the first cut of this fixture had none: its longest
> scripted pause was 1,600 ms, which the endpointer shortened to 1,084 ms. US-006 lengthened
> the `pauseAfterMs` after line 18 ("Decided then. Photo to three suggestions…") from 1,600 ms
> to 2,400 ms — a beat after the decision, so the conversation reads the same — then
> re-rendered and re-captured. The gap is now 1,944 ms. Nothing else about the fixture changed.
> The other fixtures that clear 1.5 s on their own are marked in the table below.

### How late `speechEnd` is, measured against the audio (US-023)

The paragraph above measures the eaten pause *indirectly*, from two renders of one line.
Measured directly, against where each line was actually rendered in the WAV
(`fixtures/audio/<fixture>.timing.json`), `speechEnd.audioProcessedMs` lands **after the
talking stopped** by:

| | p10 | p25 | median | p75 | p90 | min | max |
|---|---|---|---|---|---|---|---|
| `speechEnd.audioProcessedMs` − true end of the line | 375 ms | 506 ms | **647 ms** | 841 ms | 1,155 ms | −140 ms | 2,296 ms |

n = 198 (every captured turn). Per fixture the median runs 472–735 ms. So `speechEnd` is
not an observation of silence starting, it is a *decision* taken after a hangover, and the
reported gap between two turns understates the real pause by that much. The spread is wide
and does **not** scale with the pause being eaten, so the only correction available at
runtime is the constant: `ENDPOINTER_HANGOVER_MS` in `server/asr/turns.ts`.

How much that matters: inside the six planted moments' windows, after the observer's look,
the longest gap the API reports is **104–487 ms**, while the longest stretch of real quiet
in that same stretch of WAV (RMS over 10 ms frames) is **930–1,610 ms**. Every one of those
is an unmistakable pause handed over as a rounding error — which is why US-023's recall was
capped at 1/6 until the hangover was subtracted.

The last `transcript` frame of a turn is no help as a better estimate: its
`audioProcessedMs` is exactly `speechEnd.audioProcessedMs + 500` in all 198 turns.

## End of stream

After `{"type":"endStream"}` the server flushes, sends one last
`{"type":"transcript","transcript":"","final":true,"audioProcessedMs":<total>}` — the
only frame in any capture with `final: true` — and closes with **1000**. Nothing was
ever dropped: the final turn's `speechComplete` always arrived before the close.

That empty `final: true` frame is the only in-band proof a capture ran to completion, so
`npm run fixtures:check` requires it (plus `audioProcessedMs` reaching the end of the
WAV). A capture whose process was killed part-way parses perfectly and simply stops
mid-conversation.

## Per fixture

| fixture | audio | frames | turns | labels | strict A/B alternation | longest silence |
|---|---|---|---|---|---|---|
| `ask-diagram` | 42.0 s | 684 | 11 | A/B | yes | 2,094 ms ✅ |
| `ask-search` | 48.5 s | 772 | 11 | A/B | yes | 2,191 ms ✅ |
| `brainstorm` | 120.9 s | 1916 | 24 | A/B | yes | 1,944 ms ✅ |
| `moment-assumption` | 104.3 s | 1652 | 23 | A/B | yes | 1,850 ms ✅ |
| `moment-contradiction` | 121.9 s | 1937 | 26 | A/B | yes | 934 ms |
| `moment-dropped` | 127.8 s | 2034 | 26 | A/B | yes | 1,204 ms |
| `moment-fact` | 112.8 s | 1790 | 24 | A/B | yes | 2,194 ms ✅ |
| `moment-mixed` | 194.7 s | 3063 | 41 | A/B | yes | 1,646 ms ✅ |
| `no-wake` | 44.9 s | 729 | 12 | A/B | yes | 433 ms |

`longest silence` is the largest `speechEnd → speechStart` gap on arrival times — the
longest pause the pipeline can actually see. ✅ marks the fixtures that clear the 1.5 s
threshold US-006's `pauseState` test wants.

## How "Sotto" came out

With `keywords: ["Sotto"]` the model spelled the wake word **`Sotto`**, correctly
capitalised, in both wake fixtures — but **it did not reproduce the scripted
punctuation**, and that matters for the wake-phrase matcher (US-024):

| Fixture | Scripted | Transcribed (`speechComplete`) |
|---|---|---|
| `ask-search` | `Sotto, what do the main competitors charge per month?` | `" Sotto what do the main competitors charge per month. "` |
| `ask-diagram` | `Sotto, can you sketch the user flow we just described as a diagram?` | `" Sotto, can you sketch the user flow we just described as a diagram? "` |

So **a wake-phrase rule that requires a comma or a question mark after the wake word
would miss `ask-search` entirely.** Treat the punctuation as optional: match the wake
word at the start of the turn (or right after "hey"/"okay"/"ok") and take everything
after it as the question, with or without a comma.

The look-alikes in `no-wake` came back as follows. This is the set the matcher has to
reject, and the first row is the hard one — **"sotto voce" transcribes to the same
spelling as the wake word**, so position and the following word both matter:

| Spoken | Transcribed | Why it must not fire |
|---|---|---|
| "Sotto voce, if you want to be fancy about it." | `" Exactly. Sotto voce, if you want to be fancy about it. "` | Same spelling as the wake word, mid-turn, followed by "voce" |
| "so to speak" (×3) | `" …quiet, so to speak. "`, `" …worth saying so to speak. "`, `" so to speak "` | Two words, not one; the last one is a whole turn on its own |
| "Soto's restaurant" | `" …a place called Soto's Restaurant and he had one rule… "` | `Soto` as a name, possessive, mid-sentence |
| "So to speak." (turn on its own) | `" Whoa to speak "` | Mis-transcribed; no look-alike left to match |

Taken together: of the configurable spellings US-024 defaults to (`sotto`, `soto`,
`sota`), only `sotto` and `soto` actually appeared, `sota` never did, and both of the
ones that appeared also appear in `no-wake` as non-wake words.

## Close codes

Only 1000 was seen in these captures. The client (`server/asr/realtimeClient.ts`)
handles the rest as the docs describe: 1008 is fatal (configuration or audio pacing);
1011 and 1013 are retried with 1 s, 2 s, 4 s backoff, at most three retries, with audio
produced during the backoff held and sent on the new session; anything else fails the
run.

The 60-minute session limit arrives as 1011 too, and the **reason text is the only thing
that tells it apart from a backend failure**: `Max session duration reached`. It is not a
failure, so the client treats it separately — it opens the next session immediately
(queued audio is waiting), and it spends none of the three-retry error budget, which a
multi-hour session would otherwise exhaust on its fourth hour. Because the reason is
load-bearing, the client matches it case-insensitively and allows trailing detail.

No capture here is long enough to have hit the limit, so both the reconnect and the
retry paths are covered only by unit tests. What they assume, from the docs plus the
per-session facts above, is that a new session restarts `turnId` from 0 *and* restarts
the diarization labels from `A` — hence the `"<session>:<turnId>"` turn keys and the
label mapping in `server/asr/turns.ts`. If a long live session ever shows otherwise,
this is the note to correct.

## The model API: `web_search` and function tools together (US-020)

The PRD allows for the API refusing to mix `web_search` with a function tool in one
Responses request, and describes an intent-routing fallback — a cheap classification call
picking `search` or `visual`, then the matching tool set. **That fallback is not used: the
API accepts both in one request.** Probed against the real endpoint with
`tools: [{ "type": "web_search" }, { "type": "function", "name": "show_html", "strict": true, … }]`
and the `ask-diagram` question; `status: "completed"` and a `show_html` call with 5.9 kB of
HTML, same as with the function tool alone. So `MuseClient.prose` always sends both.

What *does* need handling is the shape of the turn that calls a tool:

- **A round that ends in a `function_call` carries no answer at all.** Its `output` is
  `reasoning`, a narration `message` ("Sketching your fridge-to-steps flow — putting the
  diagram on screen") and the `function_call`, and nothing else. The answer only exists
  after the result goes back as a `function_call_output` — a second round, measured at
  1.8 s and 310 output tokens, whose message id begins `msg_` as usual. Hence
  `PROSE_MAX_ROUNDS`.
- **The follow-up turn needs three items, not the whole transcript**: the original user
  message, the `function_call` item verbatim, and the `function_call_output`. The model's
  own `reasoning` and narration items can be dropped (`store: false` means nothing is kept
  server-side, so what is resent is all there is).
- Streaming carries `response.function_call_arguments.delta`/`.done`, but the whole
  arguments string arrived in **one** delta for a 6 kB document, so there is nothing to
  gain by reading it incrementally; the `function_call` item on the final response is what
  `prose` uses.

Measured end to end on `ask-diagram` (`npm run verify:artifact`, one real answer): the
model draws a 2.6–2.9 kB self-contained document with inline CSS and no external
references, and the whole answer — wake phrase to a finished card with a frame on it —
takes 25–40 s.
