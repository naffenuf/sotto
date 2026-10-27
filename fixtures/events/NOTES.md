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
run. The 60-minute session limit arrives as 1011 with the reason
`Max session duration reached`, which the retry path already covers — no capture here is
long enough to have hit it, so that path is only covered by the unit tests.
