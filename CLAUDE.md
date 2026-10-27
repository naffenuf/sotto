# CLAUDE.md

Sotto: a local web app that listens to a group brainstorm and contributes only when it matters. Built during the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026). Full spec: `tasks/prd-sotto-core.md`. Loop state: `ralph/prd.json`, `ralph/progress.txt`.

## Stack

Node 22 + TypeScript (strict), Fastify + `@fastify/websocket` in `server/`, React 18 + Vite in `web/`, shared types in `shared/`, Vitest. Meta Model API via the `openai` SDK with `baseURL: "https://api.meta.ai/v1"` and `MODEL_API_KEY` from `.env` (server only).

## Conventions

- All time-based server code uses the injected `Clock`, never `Date.now()`.
- Model prompts live in `server/prompts/*.md`.
- Model output is validated with zod.
- `npm test` makes no network calls; real-API tests go in `test:integration`.

## Learnings

(Iterations append durable patterns and gotchas here.)

- **`muse-spark-1.3` is a reasoning model.** It spends completion tokens on hidden reasoning before
  emitting any text, so `max_tokens` is a budget for *reasoning + output*. A trivial prompt
  ("Reply with exactly: PONG") still burned ~150–210 `usage.completion_tokens_details.reasoning_tokens`.
  Too small a budget returns `finish_reason: "length"` with `message.content: null` and **no error** —
  so always check `finish_reason === "stop"` before trusting the content. Budget generously
  (512+ for short answers, more for structured output). `reasoning_effort` (`low`/`medium`/`high`) is
  accepted but did not meaningfully move reasoning-token count on a trivial prompt.
- **Server wiring.** `server/config.ts` owns `HOST` (`127.0.0.1`, never anything else), `DEFAULT_PORT`
  (8787) and `loadConfig()`, which throws `MissingApiKeyError` when `MODEL_API_KEY` is blank.
  `server/app.ts` exports `buildApp()` (routes only, no socket) so tests use `app.inject()`;
  `server/index.ts` is the only place that listens and exits.
- **Browser verification.** Playwright is a devDependency; `npm run verify:ui` drives the running UI.
  Drive it with the webapp-testing helper, which starts and stops the dev server:
  `python3 ~/.claude/skills/webapp-testing/scripts/with_server.py --server "npm run dev" --port 5173 -- node scripts/verify-ui.mjs /tmp/shot.png`.
  The helper runs the command from the repo root, so Playwright scripts must live in the repo.
- **Integration-test skip message.** Per-file `console.log` is swallowed when Vitest skips the file.
  The "MODEL_API_KEY is missing" notice is printed from a `globalSetup`
  (`server/test/integrationSetup.ts`), which runs outside that capture.
- **Generating fixture audio.** `~/Developer/Chatterbox/venv/bin/python fixtures/make_fixture.py
  fixtures/scripts/<name>.json --device mps`. Without `--device mps` it falls back per
  `pick_device`, which already prefers MPS, so the flag is just explicit. Throughput has ranged from
  **2.5x to 4.15x real time** (a 3-minute fixture took 809s wall clock), so budget ~4x, start the
  render early and do other checks while it works — and don't pipe it through `tail`, which buffers
  the whole run and hides progress. The script prints a `[n/total]` line per rendered line; read
  progress with `tr '\r' '\n' < log | grep -v '^Sampling' | tail`, since the Sampling progress bars
  use carriage returns. For script length, speech runs at **~3.4–3.8 words/second**:
  `words / 3.8 + sum(pauseAfterMs) / 1000` is a floor (it under-predicted a 3-minute fixture by 16s),
  so treat it as the low end of the range when aiming at a duration target.
- **Fixture invariants live in the schema, not the checker.** `FixtureScriptSchema` in
  `shared/fixtures.ts` carries the cross-field rules (`setupLines` < `triggerLine` <=
  `deadlineLine`, line indexes in range, unique moment ids) in a `superRefine`, so every reader
  gets them. `scripts/check-fixtures.ts` (`npm run fixtures:check`) adds only what needs the
  filesystem: WAV format and timing/script agreement. Add new script rules to the schema.
- **Audio contract.** `server/audio/AudioSource.ts` fixes the one shape audio takes on the server:
  PCM16 mono 24 kHz in 80 ms chunks of exactly `AUDIO_CHUNK_BYTES` (3,840). A source that runs out of
  audio mid-chunk zero-pads the last one, so `AudioSink.onChunk` never sees a short buffer;
  `onEnd(reason)` (`"complete" | "stopped"`) is the end signal. The RIFF reader is
  `server/audio/wav.ts` — one parser, shared with `scripts/check-fixtures.ts`.
- **Injected clock.** `server/clock.ts` is the `Clock` (`now()` on a monotonic timeline plus
  `setTimeout(fn, ms)` returning a cancel function) that the "never `Date.now()`" convention refers
  to; `systemClock` is the real one. Pass it in as a constructor argument, as `WavReplaySource` does,
  and a fake clock replays a two-minute fixture in a test instantly. **Drift correction** means
  computing each delay from the *start of the stream* (`(sent + 1) * CHUNK_MS - elapsed`), never from
  the previous tick, and catching up on several chunks when a timer overslept — measured 2001 ms for
  a 2.0 s WAV and an 80.02 ms average interval over 10 s.
- **Realtime transcription event shapes.** `fixtures/events/NOTES.md` is the record of what
  `wss://api.meta.ai/v1/asr/realtime` actually sends (198 turns, nine captures), and it beats the
  docs where they disagree. The load-bearing facts: a turn is always
  `speechStart` → cumulative `transcript` partials → exactly one `speaker` → `speechEnd` →
  `speechComplete`, in that order, with **no `turnId` on `transcript` or `speaker` frames** — they
  belong to the most recent `speechStart` that has no `speechEnd`. So a partial has no speaker label
  yet. Frames report `audioProcessedMs` (a position in the audio), not wall-clock, and arrive
  **601–762 ms** after it. The endpointer eats ~0.5 s of every pause, so a scripted 1,600 ms pause
  shows up as a ~1.1 s `speechEnd → speechStart` gap: **always size pause thresholds against the
  captures, not against `pauseAfterMs`.**
- **Capturing events.** `npm run capture -- <fixture>` / `-- --all` replays WAVs through the real API
  at real-time pace (~$0.18/hour of audio; the full set is ~15 min). Because it is real-time it is
  exactly the kind of job an iteration gets killed in the middle of, and a half-written `.jsonl`
  parses perfectly and just stops mid-conversation. `npm run fixtures:check` therefore requires each
  capture to reach the end of its WAV and to end with the empty `final: true` transcript the server
  only sends after `endStream`. Run it before trusting any capture.
- **The wake word is spelled `Sotto` but its punctuation is not.** `keywords: ["Sotto"]` biasing
  works on spelling, yet `ask-search`'s trigger line came back as
  `" Sotto what do the main competitors charge per month. "` — no comma, no question mark — while
  `ask-diagram`'s kept both. Matching on punctuation would miss half the fixtures. And "sotto voce"
  transcribes as `Sotto voce`, i.e. identical to the wake word, so position and the following word
  are the only things that separate them.
