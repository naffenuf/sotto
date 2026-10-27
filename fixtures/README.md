# Fixtures

Scripted two-speaker conversations used to test and measure Sotto without
anyone talking into a microphone. The rendered audio is committed, so nothing
downstream needs Chatterbox.

```
fixtures/
  scripts/<name>.json          the script: lines, wake questions, planted moments
  audio/<name>.wav             mono, 16-bit PCM, 24 kHz
  audio/<name>.timing.json     startMs / endMs of every line
  make_fixture.py              script -> wav + timings
```

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

- `speaker` is `A` or `B`. `A` is spoken with the cloned `maddie` voice,
  `B` with Chatterbox's built-in voice.
- `pauseAfterMs` is the silence inserted after the line.
- `type` is `contradiction`, `factual_error`, `untested_assumption` or
  `dropped_thread`; `expectedLevel` is `glow` or `interject`.
- A catch counts if it is delivered after `triggerLine` ends and before
  `deadlineLine` ends. Every `setupLines` entry must come before `triggerLine`,
  and `triggerLine` must be at or before `deadlineLine`.

## Generating audio

Chatterbox is not a dependency of this repo; run its virtualenv's Python
directly.

```bash
~/Developer/Chatterbox/venv/bin/python fixtures/make_fixture.py fixtures/scripts/<name>.json
```

This writes `fixtures/audio/<name>.wav` and `fixtures/audio/<name>.timing.json`.
It takes roughly five times the length of the conversation on CPU; pass
`--device mps` to use Metal, or set `CHATTERBOX_HOME` if Chatterbox lives
somewhere other than `~/Developer/Chatterbox`.

Commit both outputs.

## Checking

```bash
npm run fixtures:check
```

Validates every script against the schema, checks the moment line references,
and confirms each script has a matching WAV (mono/16-bit/24 kHz) and timing
file with one entry per line.

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
