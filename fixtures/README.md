# Fixtures

Scripted two-speaker conversations used to test and measure Sotto without
anyone talking into a microphone. The rendered audio is committed, so nothing
downstream needs a text-to-speech key.

```
fixtures/
  scripts/<name>.json          the script: lines, wake questions, planted moments
  audio/<name>.wav             mono, 16-bit PCM, 24 kHz
  audio/<name>.timing.json     startMs / endMs of every line
  events/<name>.jsonl          every frame the transcription API sent back
  events/NOTES.md              what those frames actually look like
  voices.json                  which ElevenLabs voice speaks each speaker letter
  live-scripts/<nn>-<name>.md  the same conversations for people to read aloud
```

The renderer itself is `scripts/render-fixture.ts`.

## Script format

Validated by `FixtureScriptSchema` in `shared/fixtures.ts`. All line references
are 0-based indexes into `lines`.

```json
{
  "lines": [{ "speaker": "A", "text": "...", "pauseAfterMs": 600 }],
  "wakeQuestions": [{ "line": 12, "question": "what do the main competitors charge per month?" }],
  "moments": [{
    "id": "budget-contradiction",
    "type": "contradiction",
    "setupLines": [3],
    "triggerLine": 18,
    "deadlineLine": 22,
    "expectedLevel": "interject",
    "description": "B said the budget is under $5K (line 3); at line 18 A proposes hiring a $20K agency."
  }]
}
```

- `speaker` is `A` or `B`, mapped to a voice by `voices.json`.
- `pauseAfterMs` is the silence inserted after the line.
- `type` is `contradiction`, `factual_error`, `untested_assumption`,
  `dropped_thread`, `unanswered_question` or `research_hook`; `expectedLevel` is
  `glow`, `interject` or `research`. A `research_hook` is the one type the
  interjection policy never delivers — it is caught by a research-ready card
  (v2 PRD V2-014) — so `research` and `research_hook` only ever appear
  together, which the schema enforces.
- A catch counts if it is delivered after `triggerLine` ends and before
  `deadlineLine` ends. Every `setupLines` entry must come before `triggerLine`,
  and `triggerLine` must be at or before `deadlineLine`.

## Generating audio

```bash
npm run fixture:render -- <name>
```

This calls ElevenLabs text-to-speech, one request per line, and writes
`fixtures/audio/<name>.wav` and `fixtures/audio/<name>.timing.json`. It needs
`ELEVENLABS_API_KEY` in `.env` and runs several times faster than real time
(measured: 19.4 s of audio in 3.5 s). The default model is `eleven_flash_v2_5`,
about half a credit per character.

Which voice speaks which letter is `voices.json`:

```json
{
  "model": "eleven_flash_v2_5",
  "seed": 1234,
  "voices": {
    "A": { "name": "Rachel", "voiceId": "21m00Tcm4TlvDq8ikWAM" },
    "B": { "name": "Adam", "voiceId": "pNInz6obpgDQGcFmaJgB" }
  }
}
```

Rachel and Adam are ElevenLabs library voices chosen to be obviously different
so diarization separates them. Voice ids are configuration rather than
something the renderer looks up: the API key is scoped to speech synthesis and
cannot list voices.

A script has no names in it — `A` and `B` are all the schema carries — so where
the speakers call each other something, the letters are the voices: in the two
v2 fixtures `A` (Rachel) is EJ and `B` (Adam) is Craig, which is how
`live-scripts/05-…` and `06-…` read them back.

Each utterance comes back padded with a little near-silence (measured 54–91 ms
at the head, 268–371 ms at the tail), which the renderer trims before inserting
`pauseAfterMs`. The scripted pauses have to be honest — pause detection and the
eval harness's windows both read a gap in the WAV as the gap the script wrote.

Commit both outputs. **Don't re-render a fixture that already has a capture:**
`fixtures/events/<name>.jsonl` is measured against the exact audio on disk, so a
fresh render invalidates it.

## Capturing transcription events

```bash
npm run capture -- brainstorm     # one fixture
npm run capture -- --all          # every fixture, about 15 minutes of audio
```

This replays the WAV through Meta's realtime transcription at real-time pace and
writes every server frame, with its arrival time, to `fixtures/events/<name>.jsonl`.
It calls the real API and costs about $0.18 per hour of audio. The committed
captures mean the turn assembler, fast replay and the eval harness never have to.
What the frames look like, and the quirks worth knowing, are in
[`events/NOTES.md`](events/NOTES.md).

## Checking

```bash
npm run fixtures:check
```

Validates every script against the schema, checks the moment line references,
and confirms each script has a matching WAV (mono/16-bit/24 kHz), a timing file
with one entry per line, and an event capture that ran to the end of the audio.
(A capture killed part-way through leaves a file that parses fine and silently
stops mid-conversation, so the check compares `audioProcessedMs` against the
WAV and insists on the `final: true` frame the server only sends after
`endStream`.)

## The fixtures

| Fixture | Contents |
|---|---|
| `brainstorm` | Healthy discussion of a product idea: five points, one decision, one open question. No moments, no wake phrase — Sotto should stay quiet. |
| `moment-contradiction` | A four thousand dollar budget set early, then a twenty thousand dollar design studio proposed for the same build (`interject`) |
| `moment-fact` | A growth argument resting on "Instagram launched in 2014" — it launched in 2010 (`interject`) |
| `moment-assumption` | Pricing built on "people will obviously pay monthly", never questioned (`glow`) |
| `moment-dropped` | Grocery chains paying for the shopping nudge, raised, cut off, never returned to; later they get stuck on having one revenue line (`glow`) |
| `moment-mixed` | Three minutes, two moments of different types (a demo-deadline contradiction and a nightly-photo assumption) with long stretches where Sotto should stay quiet |
| `ask-search` | Pricing discussion containing "Sotto, what do the main competitors charge per month?" |
| `ask-diagram` | User-flow walkthrough containing "Sotto, can you sketch the user flow we just described as a diagram?" |
| `no-wake` | Wake-phrase look-alikes ("so to speak", "Soto's restaurant", "sotto voce"). No wake phrase, no moments. |
| `research-business-idea` | Three minutes, Craig and EJ on a meeting tool: an unbacked market-size claim and a request for competitor gaps (both `research`), and an audience that moves from "smaller teams" to enterprise clinics (`interject`). Ends with "Sotto, what did you find on competitors?" |
| `rhetorical-questions` | Two minutes, Craig and EJ killing a status meeting: four rhetorical and four decision questions, one question answered by a person a turn later, and exactly one genuine lookup ("what does Loom actually charge per seat these days?"). No moments — Sotto must notice the one and stay quiet about the rest (V3-002). |
| `offsite-plan` | Nearly three minutes of offsite planning: drive time and venue availability nobody has checked (`research`), "who's handling food?" asked and dropped (`glow`), and a Thursday slot the group keeps planning around after it was withdrawn (`interject`). Ends with a request for a dependency list. |
