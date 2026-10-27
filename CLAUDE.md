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
- **The clock has a simulated twin.** `SimulatedClock` in `server/clock.ts` is the `Clock` for
  tests: `advanceBy`/`advanceTo` fire due timers in order and leave `now()` exactly on each one's
  due time, `runAll()` drains the queue however far ahead it reaches, and nothing moves on its own.
  Use it instead of writing another fake clock — `WavReplaySource.test.ts` used to have one and
  no longer does. Replaying a capture is `clock.advanceTo(record.atMs)` before each
  `assembler.accept(record)`, which is also the shape US-008's `1x` replay wants.
- **Turn assembly.** `server/asr/turns.ts` is the only thing that reads raw ASR frames.
  `TurnAssembler.accept(record)` takes an `AsrFrameRecord` — the capture format *and* what
  `realtimeClient`'s `onFrame` hands over — so live and replay feed the same object. `turnId` on
  a `TurnUpdate` is a string, `"<session>:<apiTurnId>"`, because the API renumbers turns from 0
  in every session; `turnKey()` builds one. Untagged `transcript`/`speaker` frames go to the most
  recent `speechStart` without a `speechEnd`, so overlapping turns work without the API's help.
  `malformedFrames() > 0` is the signal that the API drifted from `fixtures/events/NOTES.md`:
  frames are narrowed with zod (`asAsrEvent` in `shared/asr.ts`) and a known type that fails its
  shape is counted and logged rather than guessed at.
- **Two kinds of 1011.** The realtime API's 60-minute session limit and a backend failure
  arrive as the *same* close code; only the reason text (`Max session duration reached`)
  separates them, so `isMaxSessionDuration()` in `server/asr/realtimeClient.ts` matches it
  case-insensitively and tolerates trailing detail. The limit is not a failure: it reconnects
  with **no backoff** (audio is queueing meanwhile) and spends none of the three-retry error
  budget, which a multi-hour session would otherwise burn through on reconnects that never
  failed. Retry count and session number are therefore separate counters in `run()`.
- **A reconnect restarts the diarization labels, not just the turn numbering.** Nothing in the
  API ties one session's `speaker` labels to the next one's, so `TurnAssembler` maps a later
  session's n-th new label to the n-th speaker met so far (order of first appearance) and sets
  `speakerMappingUncertain` on every turn from that session — at `speechStart`, so partials
  carry it too. That flag is a UI requirement: show the label with less confidence rather than
  silently merging two people. A voice beyond the ones already heard becomes a new speaker.
- **Holding a WebSocket upgrade open is how you test queueing.** `FakeAsr` in
  `server/asr/realtimeClient.test.ts` takes an optional `admit(index)` that defers the n-th
  upgrade through ws's async `verifyClient`, so a test can push audio while the client has no
  socket at all and then assert it all arrived on the next session. Far steadier than racing a
  real reconnect.
- **The endpointer's bite is a constant, not a ratio.** The same `brainstorm` line measured at
  `pauseAfterMs` 1,600 and 2,400 gave visible `speechEnd → speechStart` gaps of 1,084 and
  1,944 ms — 456 and 516 ms eaten. So a fixture needs `threshold + ~550 ms` of scripted pause to
  show a pause of `threshold`. Changing one `pauseAfterMs` costs a re-render (~4.5x real time)
  plus a re-capture, and `npm run fixtures:check` fails until both are done, since it compares the
  capture's `audioProcessedMs` against the WAV's length.
- **Replaying a capture is one timeline at two speeds.** `server/asr/EventReplaySource.ts`
  always *sets* the pipeline clock to each frame's recorded `atMs`, so the turns, pauses and
  timestamps a replay produces are identical at `1x` and at `max`; the speed only decides
  whether real wall-clock time is spent in between (`1x` paces against an injected
  `wallClock`, drift-corrected from the start of the run). That is why the source takes a
  `ControllableClock` — `Clock` plus `advanceTo`/`nextDueAt`/`settle`, implemented only by
  `SimulatedClock`.
- **Wrap every awaited model call in `clock.track`.** `Clock.track(label, work)` returns
  `work` unchanged, so `await clock.track("board", callModel())` reads like the bare call;
  `systemClock`'s is the identity, and `SimulatedClock.settle()` waits for what is in flight.
  `max`-speed replay settles before every advance, so time never skips past a call and the
  call reads back `now()` as the moment it was made. An untracked call gets raced past. The
  one rule: a tracked task must not await one of the same clock's timers — nothing moves time
  while `settle` waits, so that deadlocks.
- **One bus, and it remembers.** `server/events/bus.ts` is the only thing the pipeline
  publishes to; `/ws/events` sockets and (later) the session-folder writer subscribe. It folds
  `status` and `session` events into remembered state so `snapshot()` catches a socket that
  attached mid-session up, and deliberately does *not* remember turns. The status dots are a
  UI contract, not debug output: `server` = the events socket is attached, `transcription` =
  turns are arriving, `model` = a model client is **configured** for the running session
  ("ready"), not "a call is in flight" — push `connecting` around real calls instead of
  redefining `active`.
- **`SessionManager` is where a source becomes a session**, and it takes its collaborators as
  options (`replaySpeed`, `liveClock`, `wallClock`, `createAsrClient`) so unit tests never
  reach the network — `FakeAsrClient` in its test is the pattern. `start()` throws
  `SessionStartError` carrying the HTTP status the route should answer, so routes stay thin.
  An `events` source gets its own `SimulatedClock(0)` and needs no API key; `wav` and `mic`
  share the live path through `RealtimeTranscriptionClient`.
- **Testing `/ws/events`.** `app.injectWS()` delivers nothing unless `await app.ready()` ran
  first, and the handler's snapshot goes out *before* `injectWS` resolves — attach listeners
  through `injectWS(path, undefined, { onInit })`, never afterwards. An injected socket never
  completes the closing handshake either, so anything asserting on server-side `close` needs a
  real `ws` client against `listen({ port: 0 })`. And a `max`-speed replay finishes inside the
  very `inject()` that started it, so route tests about a *running* session must use `1x`.
- **Cancelling a timer is not resolving a promise.** `EventReplaySource.stop()` used to clear
  the 1x pacing timer and leave `run()` awaiting a promise nobody would ever resolve, so
  `POST /api/session/stop` hung. Any `await new Promise(... setTimeout ...)` that something can
  cancel must keep the `resolve` next to the cancel function and call both.
- **The session's timeline starts at 0, on both paths.** A frame's `atMs` is measured from the
  start of the stream — `realtimeClient` subtracts its own `streamStartedAt`, and a replay sets
  the clock to the capture's recorded `atMs` — so `TurnUpdate.startMs` is already an offset into
  the session and the assembler is always built with `startedAtMs: 0`. `SessionInfo.startedAtMs`
  is browser metadata, not that baseline; subtracting it from a turn is the bug this replaced.
- **The session folder has one writer and a published contract.** `server/session/SessionStore.ts`
  creates `sessions/<YYYY-MM-DD_HHMM>-<source>/` and its `SessionWriter` interface lists which
  later story owns which file (`writeBoard` US-009, `appendCandidate` US-012–US-014,
  `appendFeedback` US-015, `appendAnswer` US-018, `writeArtifact` US-020) — fill in your method
  rather than adding a second writer, and spell file names through `SESSION_FILES`. Whole files
  are temp-file-then-rename; the `.jsonl` logs keep an open fd. Every write is guarded and a
  failure warns **once per file**: losing the recording beats losing the conversation.
  `SessionManager` takes `createStore`, and unit tests pass `() => null` so `npm test` leaves no
  folders behind.
- **`now: () => Date` is the only calendar in the server.** The injected `Clock` is monotonic and
  cannot name a date, so `SessionStore` takes a separate wall-clock function for folder names and
  ISO stamps. Freeze it in tests with a Date built from **local** parts (`new Date(2026, 9, 27,
  13, 4)`) — folder names are local time, so a UTC literal fails outside UTC.
