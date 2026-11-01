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
- **Generating fixture audio.** `npm run fixture:render -- <name>` (`scripts/render-fixture.ts`)
  calls ElevenLabs once per line and runs **faster than real time**: 19.4 s of audio in 3.5 s on
  `eleven_flash_v2_5`, against Chatterbox's old 2.5–4x *slower* than real time. So render, capture
  and check in one iteration rather than starting a render and going off to do something else.
  For script length, speech runs at **~3.4–3.8 words/second**:
  `words / 3.8 + sum(pauseAfterMs) / 1000` is a floor (it under-predicted a 3-minute fixture by
  16s), so treat it as the low end of the range when aiming at a duration target. Two things bite:
  the key in `.env` is **scoped to synthesis** — it has neither `voices_read` nor `user_read`, so
  nothing may list voices or check credits at runtime, which is why voice ids are configuration in
  `fixtures/voices.json` (A = Rachel `21m00Tcm4TlvDq8ikWAM`, B = Adam `pNInz6obpgDQGcFmaJgB`,
  deliberately far apart for diarization) — and **every utterance comes back padded with
  near-silence** (measured 54–91 ms head, 268–371 ms tail), which `server/audio/renderScript.ts`
  trims before inserting `pauseAfterMs`, because the scripted pauses are what pause detection and
  the eval windows read off the WAV. Never re-render a fixture that already has a capture:
  `fixtures/events/<name>.jsonl` is checked against the exact bytes on disk.
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
- **Speaker names belong to the session, not the panel.** `/ws/events` carries a `speakers`
  event with the whole `{ label: name }` map; `EventBus` remembers it so a browser attaching
  mid-session is caught up, and **clears it on every `session` event**, because the API
  renumbers diarization labels per session. `POST /api/session/speaker` is the only way to set
  one — it goes through `SessionManager.renameSpeaker`, which publishes to the bus *and* writes
  to the session folder (which rewrites `transcript.md`), and answers 409 when nothing is
  running. A session whose folder failed to open still renames: the panel must not depend on
  the disk. The bus snapshot is therefore **five** events, not four.
- **A turn arrives many times; the row must not.** `useSessionEvents` keeps `turns:
  TurnUpdate[]` and replaces the entry with the same `turnId` in place, so a partial becoming
  final never doubles a row. The list is capped at `MAX_TURNS` (the whole transcript is on disk
  anyway), and only a session *starting* clears it — stopping leaves the transcript up to read.
- **"Jump to live" needs a list that overflows.** The brainstorm capture takes ~60 s of 1x
  replay to fill the panel at 1200x760, so a Playwright check must wait for
  `scrollHeight > clientHeight + 48` before scrolling up; scrolling a non-overflowing list
  fires no event and the button never appears. `npm run verify:ui` does this and now also
  measures US-007's three-second budget from the Start click (1,297 ms), the same number
  `server/session/transcriptLatency.test.ts` gets off the capture instantly (1.24 s).
- **The microphone is three files and one rule: convert in the page, frame on the wire.**
  `web/public/mic-worklet.js` only batches the raw Float32 blocks the audio thread hands it into
  80 ms frames and transfers them to the page; `web/src/audio/resample.ts` (pure, unit-tested in
  node — `npm test` now includes `web/src/**/*.test.ts`) does 48 kHz → 24 kHz and PCM16, and
  `micCapture.ts` sends whole `AUDIO_CHUNK_BYTES` messages over `/ws/audio`. The worklet lives in
  `web/public/` **on purpose**: `addModule` takes a URL, and a `?url` import of a small `.js`
  would be inlined as a `data:` URL by Vite's `assetsInlineLimit` in a production build, which
  worklets reject. It therefore has no imports of its own. The audio constants moved to
  `shared/audio.ts` (re-exported by `server/audio/AudioSource.ts`) because both ends need them.
  The resampler averages each output sample's slice of the input rather than decimating — exact
  sample counts, no drift across blocks, and ~10 dB on what would otherwise alias into the voice.
- **The mic session starts before the socket.** `POST /api/session/start {kind:"mic"}` builds the
  `MicSource` (`SessionManager.micInput()`), and only then does the page dial `/ws/audio`, so the
  source buffers up to a second of early audio and `attach()` keeps a second browser out. Closing
  that socket is `endInput()`: the tail is zero-padded, the source completes, `endStream` goes out.
  The page asks for the microphone **before** the session, so a refused prompt leaves nothing
  running — `describeMicError` turns the `DOMException` *name* (never its message) into the line
  the user reads.
- **A stopped live session is still receiving frames.** The API flushes for up to 20 s after
  `endStream`, and `startLive`'s `onFrame` used to push `transcription: active` on every one of
  them — so the dot came back up seconds after Stop and never went down. Anything in a per-frame
  callback that touches the bus has to check `this.current?.info.id === info.id` first.
- **Chromium's fake capture device runs at real time.** Measured through the real worklet:
  2,880 ms of audio in 3,000 ms of wall clock at a 48 kHz context, so `npm run verify:mic`
  (`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`) exercises the real pacing
  and the real API. It proves the audio arrived by reading the session folder's `events.jsonl`:
  `audioProgress.audioProcessedMs` is the API's own count of what it received. Its beep
  transcribes as `" Sotto "`, which is funny and worth remembering before a wake-word test
  believes it. Refused permission is tested in a separate context with an `addInitScript` that
  replaces `getUserMedia` with a `NotAllowedError`.
- **`locator.textContent()` on a missing element waits out the whole 30 s default timeout.**
  Harmless in a replay check, thirty seconds of billed microphone in a live one — `await
  locator.count()` first when the element is *expected* to be absent.
- **Zod cannot write a strict structured-output schema for you.** `z.toJSONSchema` emits `oneOf`
  for a discriminated union and keeps `minItems`/`maxItems`/`maxLength` — all keywords strict
  structured output rejects, which wants `anyOf`, every object `additionalProperties: false` with
  *every* property in `required`, and no length constraints at all. So `boardOpsJsonSchema` in
  `shared/board.ts` is written by hand next to `BoardOpSchema` (the zod union that validates the
  reply), and `shared/board.test.ts` keeps the two honest: same op kinds in the same order, same
  required fields per variant, closed objects, no unsupported keyword anywhere. Edit one and the
  test tells you to edit the other. Limits the model should respect (12 words an item, two
  sentences of summary) live in the schema's `description`s and in the prompt, never as keywords.
- **The board changes by operation, and ids are forever.** `server/board/applyOps.ts` is pure —
  it copies what it touches and returns `{ board, changedIds, summaryChanged, ignored }`. Each
  section numbers from 1 behind its own prefix (`c`/`p`/`q`/`d`) and `nextId` counts past the
  highest it ever handed out, so a dropped `p2` is never reborn as somebody else and a candidate
  (US-012) can hold an item id across the session. Nothing is deleted; `status: "dropped"` is the
  only way off the board, and `renderBoardMarkdown` leaves dropped items in `~~strikethrough~~`.
  A bad operation never discards the good ones beside it: an unknown id, a blank text or a change
  that changes nothing lands in `ignored` with a reason for the caller to log.
- **Every model call goes through one seam, and the prompt is a file.** `ModelClient.structured`
  in `server/model/client.ts` is the only way the server asks Muse Spark for anything: a system
  prompt, a rendered user message, and a strict JSON Schema. `MuseClient` is the real one and
  takes `{ completions }` so a unit test substitutes the endpoint and `npm test` stays offline.
  It checks `finish_reason === "stop"` and parses the JSON, then the **caller** validates with
  zod — a reply that doesn't fit has to be a handled failure, not a crash. Prompts are
  `server/prompts/*.md`, loaded by `loadPrompt(PROMPTS.<name>)` and cached; add a key to
  `PROMPTS` rather than a template literal. `tsconfig.server.json` sets `rootDir: "."`, so the
  compiled loader lands in `dist/server/server/prompts/` and `npm run build` copies the `.md`
  files *there* — the obvious `dist/server/prompts/` is a path tsc never creates.
- **The board update loop is two triggers, one call at a time.** `server/board/BoardUpdater.ts`
  fires on 4 new final turns **or** 45 s with at least one, and `kick()` sets `queued` instead
  of starting a second call when one is out, so triggers during flight merge into the next run.
  The whole cycle — not just the call — is wrapped in `clock.track`, so a `max`-speed replay
  stops at the apply and the write too. A failed call puts its turns back at the front of
  `pending` rather than losing them, and `flush()` on session end gets the last few turns onto
  the board even though they never reached four. `SessionManager` takes a `createModel` factory
  (unit tests pass `() => null`): a session with no model still transcribes and still saves,
  it just has no board.
- **Timing an integration test against a reasoning model: widen the hook, not the test.** Six
  or seven sequential board calls per fixture blow past `vitest.integration.config.ts`'s 60 s
  `testTimeout`, but if the replay runs in `beforeAll` then `beforeAll(fn, 10 * 60_000)` is the
  only timeout that matters and the `it()` blocks stay instant. Also load `.env` with `dotenv`
  in the test file itself: `globalSetup` runs in the main process, a test file runs in a worker.
- **Assert on `sourceTurnIds`, not just on item text.** `server/board/board.integration.test.ts`
  resolves a fixture's `moments[0].setupLines` through `<name>.timing.json` to a time window,
  collects the final turns overlapping it, and requires the planted constraint to *cite* one of
  them. Give the window **~1,500 ms of slack each side**: the API reports a turn's position in
  the audio but its endpointer trims about half a second off each end of a line, so a turn never
  sits inside its scripted line exactly.
- **React's StrictMode means a page has more than one `/ws/events` socket in dev.** The effect
  mounts, cleans up (closing socket A), and mounts again (socket B); A's `close` then fires
  *after* the second mount has reset `closed.current`, so it schedules a reconnect too. Harmless
  for the app — every event is idempotent — but a Playwright `page.routeWebSocket` mock that
  grabs the first routed socket is talking to a corpse. Collect the routed sockets, drop them on
  `onClose`, give the churn ~3 s to settle, and send to all that are left. That mock is how
  `npm run verify:ui` checks the UI states a model will not reliably produce (a dropped board
  item, a covered one) without faking the component.
- **The bus greets every socket with a board, and an empty one is not an update.** `snapshot()`
  always includes a `board` event; before the first real update it carries `emptyBoard()` and
  `updatedAtMs: 0`. Anything in the browser that reacts to "the board changed" — the panel's
  "updated 12s ago" line keys off `boardReceivedAtMs` — has to treat `updatedAtMs === 0` as
  "there has not been one" rather than as an arrival.
- **The board panel's clock is the browser's, not the session's.** `TurnUpdate.startMs` and
  `BoardEvent.updatedAtMs` are offsets into the conversation, so they cannot say how long ago
  anything was; a `max`-speed replay runs them far ahead of the wall. `useSessionEvents` stamps
  `boardReceivedAtMs` with `Date.now()` instead. The "never `Date.now()`" convention is about
  the *server*'s injected `Clock`; the browser has no such clock and needs none.
- **The spinner already exists — it is the `model` dot.** `BoardUpdater.onModelState` pushes
  `connecting` for exactly the duration of a board call, so `statuses.model.state ===
  "connecting"` is the board panel's in-flight state. Later queues (observer, answers) should
  push the same channel rather than inventing a second one.
- **One card, three variants, and the glow is not a different card.** `web/src/Card.tsx`
  draws `answer`, `interject` and `glow` from one `StageCard` (`shared/cards.ts`): a glow is a
  one-line `<button>` that, clicked, renders as exactly the `<article>` an interject would have
  been. `variant` is the *level* the policy (US-014) chose, not different content, so a
  delivery story can hand the same payload to either. `thinking` puts the dot indicator
  *beside* whatever headline has already arrived, which is how a streaming answer (US-018)
  shows up: thinking → headline → detail. An `error` card with no headline renders no headline
  at all — the message is the whole card.
- **The stage's clock is the browser's, like the board panel's.** `StageCard.createdAtMs` is
  on the session clock, so a `StageCardView` adds `receivedAtMs` (`Date.now()` on arrival) and
  `arrangeCards` sorts and trays on that. `nextTrayDueAt(cards, now)` deliberately skips glows
  already past due: a due time in the past is a timer that fires immediately, finds nothing to
  do and re-renders — which is a loop, not a tray.
- **The card's markdown is parsed, never injected.** `web/src/markdown.ts` turns the little
  markdown a detail can hold (paragraphs, bullet and numbered lists, bold, italics, inline
  code, links) into a block tree the card renders as React elements. No HTML string, no
  `dangerouslySetInnerHTML`, no dependency — and only `http(s)` becomes an `href`, because a
  model can hallucinate `javascript:` as easily as any other URL. Anything it does not
  recognize stays literal text.
- **`location.pathname` is the whole router.** `main.tsx` renders `DevCards` for `/dev/cards`
  and `App` for everything else; Vite's SPA fallback serves `index.html` for the dev path in
  dev. `npm run verify:cards` drives that page — it is the only place an error card, a
  thinking card and a two-minute-old glow exist at once, which a replay will never reliably
  produce.
- **The `model` dot is `connecting` for the whole of every board call**, so any Playwright
  assertion that samples it at an uncontrolled moment mid-replay will flake. Wait for `active`
  to prove it came up, then accept `active` or `connecting` on later samples.
- **The observer hangs off the board, not off the turns.** `server/interject/Observer.ts` runs
  because `BoardUpdater.onUpdate` calls `observer.observe(update.board)` — one look per board
  update, which is where the PRD's "right after each board update" comes from and why the
  observer gets the board's memory (what was stated, what was decided) for free instead of
  re-reading the transcript. `observe()` returns immediately so the board loop never waits, but
  registers `clock.track("observer", …)` *before* returning, so a `max`-speed replay still stops
  for it. `SessionManager.modelLoops()` builds both loops from **one** `ModelClient` and both push
  the same `model` dot; `drainLoops()` flushes board-then-observer at session end, in that order,
  because the observer reads what the board update wrote.
- **Strict structured output has no `maxLength` and no `maximum`, so the limits are clipped after
  the fact.** The PRD's 90-char headline, 60-word detail, 20-word "why now" and 0–1 scores live in
  `observerCandidatesJsonSchema`'s `description`s and in `server/prompts/observer.md`, and are
  *enforced* by transforms inside `ObserverCandidateSchema` (`clipChars`/`clipWords` at a word
  boundary, `clamp01`). Rejecting an overlong headline would throw away a real contradiction over
  two characters; clipping means anything downstream can lay a candidate out without measuring it.
- **Validate a list reply one element at a time.** `ObserverReplySchema` deliberately types the
  array as `unknown[]` and the observer parses each candidate on its own, so one malformed
  candidate is dropped (and warned about) while the good ones beside it get through — the same
  rule `applyOps` follows for board operations. A whole-reply `z.array(CandidateSchema)` would
  lose all three.
- **"Zero candidates is normal" is a measurable property, and the prompt gets it.** Six observer
  runs over `moment-contradiction` produced exactly one candidate — the planted contradiction, at
  confidence 1.0, citing the trigger turn — and `brainstorm` produced none at all (no
  `candidates.jsonl` is written, since `SessionStore` only opens a log on first append). A test
  that expects the file to exist should say so with a message rather than failing on ENOENT.
- **The board prompt's constraints/points boundary is the flakiest thing in the suite.** One
  `board.integration.test.ts` run filed most of `brainstorm`'s product requirements as
  constraints and left a single point, failing the `>= 4 points` assertion; the next replay gave
  six. If it recurs, sharpen `server/prompts/board.md` — a stated limit versus a desired
  behaviour — rather than lowering the threshold.
- **Structured output and web search do work together, and the citations do not come from the
  annotations.** `MuseClient.grounded` (`server/model/client.ts`) is the Responses API seam —
  `tools: [{ type: "web_search" }]` beside a strict `json_schema` — which the docs never show
  (https://dev.meta.ai/docs/cookbook/search-grounding only demonstrates prose). Measured: 9–17 s
  and 1,350–1,800 reasoning tokens a check, 16–40 pages searched, and **zero `url_citation`
  annotations every time**, because an annotation is a character range into the model's prose and
  the reply is pure JSON. So the sources shown to a group come from the model's own `citations`
  array, each one *resolved* against `include: ["web_search_call.action.sources"]` — the API's
  record of what it actually put in front of the model. Exact URL, else the first page the search
  returned from that host, else dropped. (Ask for "the URL" and it answers `"en.wikipedia.org"`;
  ask for "the full URL exactly as the search gave it" and it gives one. The host fallback stays
  because a shortened name is a real source named badly, not an invention.) `readGrounded` also
  has to pick the structured reply out of the model's narration: one response holds several
  `message` items and `response.output_text` concatenates them all.
- **A candidate's headline is not the claim — it is the correction.** The observer's headline
  states what it believes ("Instagram launched in 2010, not 2014"), so anything that has to
  reason about what the *group* said needs the words. `Candidate.evidence` carries the cited
  turns verbatim (resolved in `Observer.quotes`, dropping an id the assembler never produced
  rather than inventing a quote), and `renderVerificationRequest` leads with those quotes and
  labels the headline as a listener's note that may itself be wrong. Sending the headline as
  the claim got a verdict of `right` on a conversation that was wrong — the first thing the
  US-013 integration test caught.
- **The verifier changed what the observer should say.** The observer has no web access, and
  `observer.md`'s "leave out anything you only half believe" meant it returned *zero*
  candidates for `moment-fact` across five looks, twice over, while reading
  "Instagram launched in 2014" in clean transcript. The prompt now carves out exactly one type:
  a `factual_error` is checked against the web before anybody hears it and a right one is
  dropped silently, so a middling `confidence` is still worth returning. `brainstorm` still
  returns zero candidates afterwards — check that whenever either prompt is loosened.
- **Checks run concurrently; the board and observer loops do not.** `Verifier.verify` returns
  as soon as a check is under way and keeps a set of in-flight promises, because a claim waiting
  on a search must not hold up the next one — each is registered with `clock.track` before
  `verify` returns, so a `max`-speed replay still waits for all of them, and `flush()` loops
  until the set is empty (a check can start while it waits). `right`, `unclear` **and a check
  that failed** all stop: an unchecked claim must not be told to a group as an error.
- **The policy is two files, and the second one owns a timer.** `server/interject/policy.ts` is
  pure — `decide(input)` takes the moment, the `PauseState`, the chattiness and a `PolicyHistory`
  and returns `silent | glow | interject | hold` with the reason, the score and the thresholds it
  used — while `server/interject/InterjectionPolicy.ts` holds the clock, the held candidates and
  the spent interjects. The timer is the load-bearing part: silence crossing the 1,500 ms
  threshold and the five-second courtesy window after a wake phrase both change a decision with
  *nothing arriving to say so*, and the next turn update after a `speechEnd` is the next person
  starting to talk — exactly the moment Sotto must not speak. So a held candidate schedules
  `nextCheckDelay()` (the soonest of: the rest of the pause, the end of the courtesy window, its
  own 90-second expiry) and re-decides there. Expiry counts from when the **policy** first saw a
  candidate, not from `createdAtMs`: a `factual_error` spends ten to fifteen seconds being
  checked, and that wait is the verifier's, not the group's.
- **A decision is logged when it changes, not when it is taken.** The policy re-decides on every
  turn snapshot, partials included (a `speechEnd` arrives as one), so writing every verdict would
  put forty identical `hold` lines in `candidates.jsonl` for one candidate. `DecisionLogRecord`
  (the third `kind` in the file, beside `candidate` and `verification`) is only appended when
  `decision`+`reason` differ from the last one written for that candidate: one `hold`, then
  whatever became of it. `flush()` at the end of a session gives everything one last look — a
  conversation ends in silence, so that last pause is real — and writes down whatever is still
  waiting as `silent`/`session_ended`, so no candidate is unaccounted for. A downgrade is a
  reason, not a loss: `cooldown` and `budget` both deliver a `glow` whose `level` is still
  `interject`.
- **How talkative Sotto is, is the server's setting, not the tab's.** It lives on the `EventBus`
  (which snapshots it as a `settings` event) and is deliberately *not* cleared by a session
  starting — turning Sotto down is meant for the next conversation too.
  `POST /api/session/settings` works with nothing running (the next session inherits it) and
  answers with the settings as they stand; the header's `<select>`s show what came back rather
  than what they clicked, so two tabs agree. Since V2-017 that is **two** settings
  (`SessionManager.setPolicySettings` takes either on its own) — see the V2-017 entry below.
- **`SessionManager.interjectionPolicy()` is where the courtesy hooks attach.** Wake-phrase
  detection (US-017) calls `wakePhraseDetected()` and the answer agent (US-018) brackets its work
  with `setAnswerThinking(true/false)`; both make held candidates wait rather than dropping them,
  and the one that finishes releases them on the spot.
- **A delivered card is a pure function of the decision, and its id is the candidate's.**
  `server/interject/delivery.ts` turns an `Interjection` into a `StageCard`: the level becomes
  the `variant` and *nothing else* changes with it, because a glow the reader opens has to be
  exactly the card an interjection would have been. The only thing not copied straight across is
  the evidence — the observer attaches diarization labels (`A`, `B`) and the group wants the
  names it gave them (US-007). `deliveredCardId(candidateId)` is `card-<id>`, derived rather
  than counted, so `POST /api/feedback` is handed only a card id and finds its way back to the
  candidate, its level and its type: a tab must not be able to file a verdict about a card the
  server never showed.
- **The stage outlives its session, so the feedback target does too.** `EventBus` remembers
  cards and clears them when a session *starts*, never when one ends — a replay's cards are read
  after it finishes, which is exactly when the 👍 gets clicked. `SessionManager.recordFeedback`
  therefore answers for the most recent session and writes to *that* folder's `feedback.jsonl`
  (`no-cards` → 409, `unknown-card` → 404). The bus snapshot is now seven events **plus one
  `card` event per card**, which is also how the browser folds a live arrival: same id replaces
  in place, so an answer landing in pieces (US-018) never doubles itself.
- **A replay has to be handed its last pause.** A capture ends within milliseconds of the last
  word (`moment-contradiction`'s final `speechEnd` is 17 ms before its last frame), but the
  conversation did not — a group that has stopped talking is in the longest pause of the
  session. `REPLAY_TRAILING_SILENCE_MS` (3 s) is advanced on the pipeline clock after the
  board/observer/verifier flush and before the policy's last look. It is what makes
  `moment-contradiction` deliver at all: that fixture has **no** reported silence ≥ 1,500 ms
  anywhere in its 26 lines, so its one real candidate (measured: score 0.855, found at 115.0 s)
  holds `waiting_for_pause` and goes out as `interject` at 123.5 s, in the quiet after the end.
  Without it the policy writes everything off as `session_ended`.
- **"No sound and no modal" is tested by instrumenting the page, not by listening.** A headless
  browser is silent either way, so `scripts/verify-delivery.mjs` (`npm run verify:delivery`)
  counts `new Audio`, `new AudioContext`, `HTMLMediaElement.play`, `showModal` and `alert` in an
  `addInitScript` that runs before any app code, and the criterion is a count of zero. The same
  check drives a real `moment-contradiction` replay to a real interject card (~145 s from the
  Start click), clicks an evidence quote and reads back which transcript row got `data-cited`
  and whether it is actually inside the list's box, then clicks ⏱ and reads the line out of
  `feedback.jsonl`. The glow/interject pair it cannot rely on a conversation producing comes
  from a second page with `/ws/events` mocked.
- **A replay that has finished leaves Stop disabled, not absent.** `locator.count()` is still 1,
  so a Playwright click on it waits out the full 30 s timeout and then throws. Ask
  `isEnabled()`. And a session folder is named `<when>-<source slug>`, so matching the newest
  one means `endsWith("events-moment-contradiction")`, not `endsWith("events")`.
- **The eval harness is not a second pipeline.** `server/eval/runner.ts` starts an ordinary
  `SessionManager` session (`replaySpeed: "max"`, the chattiness under test, a `SessionStore`
  under `eval/sessions/`) and watches the same `EventBus` a browser watches: a delivery is a
  `card` event, and the policy's reason and score come from that session folder's
  `candidates.jsonl` — the decision whose `decision` names a level, since a candidate is decided
  several times. Everything US-016 needs was already in the published contract. `npm run eval`
  measured ~1 minute of wall clock per fixture (seven fixtures, 700 s), because `max` only spends
  time on the calls the conversation would really have made.
- **"It happened in a pause" is measured, never taken from the policy.** `server/eval/pause.ts`
  rebuilds `PauseState` from the turn intervals a replay produced (`endMs === null || endMs >
  now` is speaking; silence counts from the last turn to close) and runs it through the policy's
  own `inPause()`. `pause.test.ts` holds the two against each other at ten moments of a synthetic
  conversation, so the reconstruction cannot drift from `TurnAssembler.pauseState`. Asking the
  policy whether it obeyed its own rule would prove nothing.
- **A planted moment lives on two timelines.** `<fixture>.timing.json` gives a line's position in
  the *audio*; a delivery time is on the session clock, which runs ~700 ms ahead (a frame arrives
  that long after the audio it describes) while the endpointer trims ~500 ms off each end of a
  line. So `MomentRecord` carries both: the scripted `triggerEndMs`/`deadlineEndMs` and the turns
  overlapping each line (±`TURN_SLACK_MS`, 1,500) with their session-clock ends. Never compare a
  scripted time to a delivery time without the slack.
- **The judge prompt is part of the judge cache key.** `eval/cache/<hash>.json` is hashed over the
  card's headline + detail, `<fixture>/<momentId>` (ids are unique only within one script) and a
  hash of `server/prompts/judge.md`, so editing the judge invalidates every verdict rather than
  mixing two standards in one report. A judge call that *fails* is recorded as a non-match with
  its error and deliberately not cached.
- **What loses a good candidate is never the score thresholds.** Across every eval run,
  `brainstorm` and `no-wake` produce **zero** candidates and precision has never been the problem —
  recall has. Each time, the log named the real cause: first `STALE_TURNS` (a candidate ran out of
  its 6 turns before a pause arrived), then the pause measurement itself
  (`ENDPOINTER_HANGOVER_MS`), and now the observer's coverage of one hard type. Read
  `candidates.jsonl`'s decision reasons before touching a weight.
- **Scoring reads the record, so re-scoring is free.** `server/eval/score.ts` is pure over an
  `EvalRunRecord`, and `npm run eval:report` rebuilds any past run's `eval/reports/<id>.md` from
  `eval/runs/<id>.json` with no API calls and the same exit code `npm run eval` would give. A
  moment's window is on the **session clock** — `MomentRecord.triggerTurnEndMs`/`deadlineTurnEndMs`,
  the turns the scripted trigger and deadline lines produced — never the audio times, which run
  ~700 ms behind the delivery times they would be compared to. The outcome rules that the PRD only
  implies: `late` beats level (a card after the deadline did not catch the moment), the *best*
  outcome of several matching cards wins, `late` does not count towards recall, and `--no-judge`
  marks the match-dependent gates `skipped` rather than scoring them zero.
- **A report is committed; the run it came from is not.** `eval/reports/` is deliberately outside
  `.gitignore` while `eval/runs/`, `eval/sessions/` and `eval/cache/` are inside it, so a report
  has to stand alone: it carries the git commit, a hash of every `server/prompts/*.md` and the
  estimated cost. That is also why `EvalRunRecord.promptHashes` and `.usage` are optional — the two
  runs written before US-022 have neither, and the report says so rather than printing zeros as
  fact.
- **Cost comes off the calls, through one seam.** `MuseClientOptions.onUsage` is told what every
  call spent *before* any error is thrown, because a truncated reply is billed too; the two
  endpoints name the same numbers differently (`prompt_tokens` vs `input_tokens`) and either may
  omit them, so a missing count is zero. Reasoning tokens are *part of* the output tokens, not an
  addition — pricing `input + output` is the whole bill. Measured: `moment-contradiction` alone is
  15 calls and $0.10, so the seven-fixture set is roughly $0.5–0.7.
- **A planted moment's window is narrow and most of it belongs to the board loop.** The window is
  the trigger turn's end to the deadline turn's end — 11.8–20.6 s on these fixtures — and the
  observer cannot see the trigger until the board update that carries it, which PRD US-009 fixes at
  4 new final turns: a median **12.6 s** later. So a delivery has only the last few seconds to land
  in, and anything that costs the policy a second costs it the moment. Compute the ceiling off the
  captures (`npm run eval:ceiling`) before tuning for recall — it needs no API call.
- **`speechEnd` is a decision, not an observation, and it is a median 647 ms late.** The endpointer
  waits out a hangover before it will call a turn over, so `speechEnd.audioProcessedMs` lands that
  far *after* the talking actually stopped — measured against `<fixture>.timing.json` over all 198
  captured turns: p25 506, median **647**, p75 841, p90 1,155 ms. Counting silence from `speechEnd`
  therefore understates the pause by about two-thirds of a second, and the understated part is the
  part that has *already elapsed* when the server hears about it. `ENDPOINTER_HANGOVER_MS` (650) in
  `server/asr/turns.ts` subtracts it, so `silentForMs` means how long the room has really been quiet
  and `PAUSE_MS` (700) is a threshold in those units; `server/eval/pause.ts` undoes the same
  constant, and the test holding it against `pauseState` keeps the two honest. The spread is wide
  and does not scale with the pause being eaten, and the last `transcript` frame of a turn is no
  help (its `audioProcessedMs` is exactly `speechEnd + 500` in all 198 turns), so a constant is the
  only correction available at runtime.
- **When a measurement looks impossible, measure the instrument.** US-023 spent two attempts
  concluding that PRD US-016's recall gate and PRD US-021's cost gate were in conflict, from a
  ceiling of 1/6 deliverable moments. The conflict was an artifact: inside those six windows the
  longest gap the API *reports* is 104–487 ms, while the longest run of real quiet in the same
  stretch of WAV (RMS over 10 ms frames) is **930–1,610 ms** — every one of them an obvious pause.
  Correcting the endpointer took recall 1/6 → 5/6 with no extra model calls, no prompt change and
  no threshold loosening. The audio and `<fixture>.timing.json` are ground truth and cost nothing;
  reach for them before accepting that a target cannot be hit.
- **Size the token budget for the worst thinking, not the typical.** `DEFAULT_MAX_TOKENS` at 4,096
  lost eight board updates and an observer look in one eval run to `finish_reason: "length"`, each
  having spent the whole budget on reasoning and emitted nothing — and a board update that fails
  costs more than itself, because the observer only looks after a successful one. Unused budget is
  not billed; a truncated reply is billed in full for nothing. 12,288 against a measured 1,300–3,200.
- **A report is regenerated, so hand-written notes live beside it.** `eval/reports/<id>-notes.md` is
  read back in by `writeReport` and rendered as the report's `## Notes` section, because
  `npm run eval:report` rewrites `<id>.md` from the run record and would otherwise erase anything
  typed into it. That is where a judge spot-check goes.
- **The wake phrase is matched on position, because the spelling is not enough.** `server/wake.ts`
  is pure (`detect(text, { spellings })`) and `server/wakeWatcher.ts` holds the stream state. The
  rules come from `fixtures/events/NOTES.md`, not from the scripts: `ask-search` was *written* as
  `Sotto, what do the main competitors charge per month?` and came back with **neither the comma nor
  the question mark**, so punctuation can never be required. What separates an address from
  `Sotto voce` (same spelling, same capitalisation, start of a sentence) is the following word, and
  from `Soto's Restaurant` is the position. Without a comma only **wh-words** make a question:
  auxiliaries would catch one more shape and would also fire on "Sotto is being too chatty", which
  is what a team building Sotto says all day. A wake word with nothing after it does not trigger —
  which is every partial on its way to a question, including `" Sotto"` itself.
- **The wake indicator is the partial's job and the question is the final's.** `WakeWatcher` raises
  "Sotto is listening" on the first partial that matches (and calls
  `InterjectionPolicy.wakePhraseDetected`, so the floor belongs to whoever is asking) and emits the
  question only when the turn goes final, at most once per `turnId`. A turn that stops matching as
  the speaker says more takes the indicator back down; another speaker's turn cannot, which is what
  `setListening`'s `about` argument is for. It is built in `SessionManager.assembler`, **not** in
  `modelLoops`: a session with no `MODEL_API_KEY` still shows that it heard its name.
- **The bus snapshot is eight events now, plus one per card.** `wake` joined it, remembered like the
  rest and cleared by a session event in both directions — and `useSessionEvents` clears `listening`
  on `session: null` too, because a session that ends mid-question would otherwise leave the
  indicator up forever.
- **An answer is prose, and prose is the only reply that carries citations.** `MuseClient.prose`
  (`server/model/client.ts`) is the Responses API with `web_search`, `stream: true` and **no**
  schema, because the PRD's shape for an answer — a headline then markdown — is text. Measured on
  the same question that returns *zero* `url_citation` annotations as JSON: a prose reply came back
  with **three to five**, on the final message item, arriving as `response.output_text.annotation.
  added`. So `Answer.citations` really is the annotations; the `Sources:` lines the prompt asks for
  are the fallback, resolved against `searchedUrls` exactly as US-013's are.
- **The model narrates in message items, and only the last one is the answer.** A searching reply is
  `reasoning`, `message` ("I'll look up current pricing"), four `web_search_call`s, `reasoning`,
  `message`, … and finally the answer. The narration items are **`message`s whose ids begin `rs_`**;
  the answer's begins `msg_` — the `type` is `message` for both, so the id prefix is the only thing
  that separates them while the stream is still running, and each narration item completes within a
  millisecond or two of starting. Hence `ANSWER_ITEM_PREFIX` in `server/answer/AnswerAgent.ts`:
  without it the stage shows "I'll look up current pricing" as the headline for the fifteen seconds
  it takes to write the real one. Measured end to end: first narration at 1.7–2.2 s, answer item
  starts at 18.4 s and streams for 0.7 s, 19.2 s total, ~$0.01 a question.
- **A replayed answer takes no time, and stalls the replay while it is written.**
  `EventReplaySource.run` awaits `clock.settle()` before *every* frame, at `1x` as well as at `max`,
  so a 20–30 s answer call freezes the replayed conversation and then the drift-corrected pacing
  catches up. The visible consequences: `Answer.latencyMs` is **0** in any replay (simulated time
  does not move during a tracked call) and real only in a live session, and a 1x replay's transcript
  pauses while Sotto is thinking. Don't assert `latencyMs > 0` off a replay.
- **The answer agent is the one loop with a queue of its own.** `server/answer/AnswerAgent.ts`
  answers one question at a time and waits for nothing else: a question asked while the board loop
  is mid-call goes out immediately. `ask()` returns as soon as the `thinking` card is on the stage,
  registering the call with `clock.track` first so a `max` replay still waits for it, and every push
  — thinking, headline, finished — carries the **same card id** (`card-ans-1`), which is what makes
  the stage replace the card instead of stacking three. It brackets its work with
  `InterjectionPolicy.setAnswerThinking`, so Sotto never interjects over its own answer.
- **Feedback buttons are for interjections, not answers.** `POST /api/feedback` can only file a
  verdict against a card the *policy* delivered (`SessionManager.recordFeedback` looks the card id
  up in that session's deliveries), and `useful`/`not useful`/`wrong moment` are verdicts on a
  decision to speak. So `Card.tsx` draws no feedback row on an `answer` card; a button there would
  have nothing to write.
- **A session outlives its Stop in two places, and they are the same place.** `SessionManager`'s
  `LastSession` is the most recent session — running or not — and both things a user does *after*
  Stop are addressed to it: a 👍 on a card still on the stage (US-015) and a question typed into
  "Ask Sotto…" (US-019). So the answer agent is retired when the **next** session supersedes it,
  not by `finish()`, and an answer card is published while `this.last?.sessionId === info.id`
  rather than while it is `this.current`. The session folder needed nothing — `SessionStore`'s
  `appendLine` reopens a descriptor closed by `end()`, so a post-Stop answer still lands in that
  conversation's `answers.jsonl`.
- **A typed question is the spoken path with a different front door.** `POST /api/ask` hands it to
  the same `AnswerAgent` with `askedBy: TYPED_ASKER` and `turnId: null`; the route answers only an
  acknowledgement, because the answer arrives on `/ws/events` as a card. It is also the cheapest
  way to drive the answer agent in a test or a browser check — no wake line to wait for. The only
  thing that branches on it is `renderAnswerRequest`, which must not tell the model somebody said
  it out loud.
- **`POST /api/session/stop` drains the answer queue.** A question typed into that window holds
  the Stop response until the answer lands, so the header's Start/Stop stay disabled for the
  length of a model call. Harmless, but a Playwright check that screenshots straight after a
  post-Stop answer will catch the controls mid-wait — wait for Start to be enabled first.
- **`web_search` and a function tool go in one request — the PRD's intent routing is dead code
  that was never written.** The real Responses API accepts
  `tools: [{type:"web_search"}, {type:"function", strict:true, …}]` together and completes
  normally, so there is no classification call. What *does* need handling is that a round ending
  in a `function_call` carries **no answer at all** — `reasoning`, a narration `message`, the
  call, nothing else — so `MuseClient.prose` is a loop (`TOOL_MAX_ROUNDS` 3): run the handler,
  push the `function_call` verbatim plus a `function_call_output`, ask again. Only the user
  message and the call/result pairs are resent; `store: false` means the model's own reasoning and
  narration are not kept anyway. The tools stay declared on the last round too — a request whose
  input holds a `function_call` for an undeclared tool is a shape never probed here, and a 400
  would lose the answer the withholding was meant to save.
- **A tool handler never throws; it tells the model in words.** An unknown tool name, arguments
  that are not JSON, a document that fails validation and a session with no folder all come back
  as "… Answer in words instead." Losing a whole answer because a diagram did not render is the
  worse outcome, and `SessionStore.writeArtifact` returns `string | null` for the same reason —
  the one write whose failure is reported back rather than only warned about once.
- **Nothing trusts an artifact's HTML, and nothing needs to.** `shared/artifacts.ts` never parses
  or rewrites it: it is written verbatim and served by
  `GET /api/sessions/:id/artifacts/:file` with `ARTIFACT_CSP` (`default-src 'none'` is the
  load-bearing clause) plus `nosniff`, into an `<iframe sandbox="allow-scripts">` with **no**
  `allow-same-origin` — an opaque origin with no network. "Self-contained" is a request in
  `answer.md` and a guarantee in the headers, not a claim about the bytes. The route reads a file
  name out of a URL, so it is gated on `ARTIFACT_FILE_PATTERN` (a name the server itself would
  have written) rather than sanitised, and it answers only for the most recent session — the same
  session feedback and typed questions are addressed to. "Open full screen" is the `<figure>`'s,
  not the document's: a cross-origin iframe cannot request fullscreen for itself.
- **A live session gets the pause a replay has to be handed.** `moment-contradiction` scores `late`
  in `npm run eval` — its only quiet is `REPLAY_TRAILING_SILENCE_MS` after the capture ends — but in
  `npm run e2e` the same fixture delivers **7.9 s after its trigger turn, before the deadline**,
  because the WAV runs out and the board/observer/verifier drain then takes ~20 s of *real* time
  while the policy's timers fire against growing real silence. The replay is the pessimistic case;
  don't read a recall ceiling off it as though it were the live one.
- **The end-to-end check stamps the wall clock because the pipeline has two timelines.** A turn's
  `startMs`/`endMs` are positions in the audio stream, while a card's `createdAtMs` is read off the
  live `Clock`, whose origin is the *process* — so in a live session those two cannot be subtracted.
  `server/e2e/live.ts` stamps every bus event with `Date.now() - startedAt`, and
  `server/e2e/latency.ts` maps a scripted instant onto that wall by the **median of
  `arrival − endMs`** over the run's final turns (measured 700 ms, the API's processing lag).
- **`npm run e2e` is 3.5% under its own budget.** Measured on the four fixtures: 333 s of audio in
  412 s of wall clock, 41 model calls, $0.4659 of model + $0.0167 of transcription = **$0.4826**
  against the PRD's $0.50, which `runPassed` gates on — so a run whose answers search harder can
  fail on price with every assertion holding. Half the bill is reasoning tokens and most of the
  input is the two searching answer calls (one searched 56 pages). The first waste to look at is
  the observer look the drain fires over *zero* new turns after a board flush that changed nothing;
  it happens in all four fixtures, and it is PRD US-012's "one look per board update".
- **An end-to-end assertion must come out the same every run, so it reads the contracts, not a
  judge.** `server/e2e/checks.ts` decides "the moment was caught" structurally — a delivered card
  whose decision `type` is the moment's own and whose `evidence` cites a setup or trigger turn —
  counts wake triggers off `answers.jsonl` (`turnId !== null`) rather than the indicator, which
  goes up on a partial and can come back down, and reads an artifact off disk because
  `GET /api/sessions/:id/artifacts/` only answers for the **most recent** session. All of it is
  pure over two records (`E2eObserved` from the bus, `E2eFiles` from the folder), so `npm test`
  covers the judgement and the API is only paid for the evidence.
- **The recall ceiling is measurable without an API call, and `npm run eval:ceiling` measures it.**
  A planted moment can only be delivered inside its window, only in a pause, and only once the
  observer has looked — and the observer looks after a board update, four final turns apart (PRD
  US-012 + US-009). `server/eval/ceiling.ts` replays a capture through the turn assembler *alone*
  and lays all three on one timeline, so "no prompt can catch this moment" is a number rather than
  a hunch. It reports 6/6 reachable at the shipped `PAUSE_MS` (700, on corrected silence), with
  margins of 754–1,137 ms; `--every N` reprices it at another observer cadence. Run it before
  paying for an eval run, and before blaming `observer.md`.
- **A new fixture's planted moments have to be *measured* reachable, and that is free.**
  `npm run eval:ceiling -- --fixtures <name>` replays a capture through the turn assembler
  alone and lays the window, the observer's four-turn look and the real quiet on one timeline,
  so authoring a fixture ends there rather than at `fixtures:check`. V2-002's first render put
  two windows at 701 and 708 ms against `PAUSE_MS` 700 — reachable by a millisecond — and
  widening the pauses took every margin to 780–1,453 ms. Two things decide that number: the
  usable pauses in a window are the ones after lines `triggerLine`…`deadlineLine - 1` (the
  pause after the deadline line is *outside* the window, so raising it buys nothing), and the
  observer cannot look until the board update four final turns after the trigger, a median
  12.6 s, which eats most of a short window.
- **ElevenLabs reads a new script more slowly than it read the old ones.** The core fixtures
  measure 3.4–3.8 words/second; V2-002's two came out at **3.06**, and the first render of
  `research-business-idea` was 193.8 s against a predicted 178 s — over the PRD's three
  minutes, so it had to be trimmed and re-rendered. Predict with `words / 3.1 + pauses` for a
  new script, then believe the renderer, which prints the real duration in ~10 s.
- **The eval's one remaining miss is the observer's, not the policy's.** Run
  `2026-10-29_053832` catches 5 of 6 planted moments, all in a pause and none late. The miss is
  `moment-mixed`/demo-deadline-contradiction, where nine looks produced no candidate for a
  three-week "hard wall" contradicted by a two-plus-four-week plan — cross-turn arithmetic is the
  hardest of the four types, and the board carries the deadline as a constraint but not the sum.
  938 ms of real quiet was available in its window, so a candidate would have been delivered in
  time. That is the next thing to sharpen in `observer.md` if 6/6 is wanted.
- **Sotto's voice is a socket, and two of its frames are nearly the same frame.**
  `server/voice/Speaker.ts` is one utterance (single-use): `await start()`, `append(sentence)` as
  the model writes it, `await finish()`, or `cancel()`. The REST seam beside it
  (`server/voice/elevenlabs.ts`) is for rendering fixtures, not for speaking. Three protocol facts
  carry the design: **`{text:""}` ends the stream while `{text:" "}` keeps it alive**, so `flush()`
  sends a space with `flush: true` and the handshake's text is a space; the credential rides the
  `xi-api-key` **HTTP upgrade header**, not the init JSON, so the key is in no message a log line
  could ever print (a unit test asserts that); and `chunk_length_schedule`'s first threshold (50
  chars, the API minimum) is what would otherwise hold a short opening sentence in the server's
  buffer — hence `append()` flushing on the **first** call only, which is what makes "speech starts
  before the full text exists" true rather than aspirational. Measured on the real API with
  `eleven_flash_v2_5` + `pcm_24000`: first audio chunk **299 ms** after `start()`, a 2.65 s
  utterance delivered whole in **398 ms** across 3 chunks.
- **"What had Sotto said when it was cut off?" is the alignment's answer, not the audio's.**
  `sync_alignment=true` attaches `chars`/`charStartTimesMs`/`charDurationsMs` to every audio frame
  (the durations array is spelled `charsDurationsMs` in some of ElevenLabs' docs, so `readAlignment`
  takes either), and `Speaker.spokenSoFar()` is the characters whose sound had *finished* by the
  last playback position the browser reported. With no report it is deliberately `""`: audio having
  been generated is not the same as anybody having heard it, and V2-007's `continue` resumes from
  what was heard. `/stream-input` numbers those times from the start of the whole stream, while its
  dialogue siblings restart at zero per frame, so `absorbAlignment` treats a frame as chunk-relative
  exactly when it would otherwise run backwards into text already spoken.
- **A default voice id is configuration, and it can be probed but not listed.** The `.env` key is
  scoped to synthesis, so nothing may enumerate voices — but a one-off `synthesizeSpeech` of three
  characters tells you whether an id works. Sotto speaks as the **River** library voice
  (`SAz9YHcvj6GT2YYXdXww`, via `loadSottoVoiceId`), chosen calm and deliberately apart from
  `fixtures/voices.json`'s Rachel and Adam so a replayed conversation never has Sotto sounding like
  one of the people in it. Also probed valid with this key: Sarah `EXAVITQu4vr4xnSDxMaL`, Charlotte
  `XB0fDUnXU5powFXDhCwa`, Lily `pFZP5JQG7iQjIQuC4Bku`.
- **One page plays Sotto's voice, and it must be the page with the microphone.** `VoiceHub`
  (`server/voice/VoiceHub.ts`) takes the first `/ws/voice` socket as the playback page and refuses
  others until it closes; `web/src/audio/useVoicePlayback.ts` schedules the PCM back-to-back on one
  AudioContext in the same page as `micCapture.ts`, which is what lets Chrome's echo cancellation
  subtract it — never move playback elsewhere or change the mic's processing constraints.
  `speaking` comes down on the page's `ended` report, not when ElevenLabs finishes (synthesis is
  faster than real time). `speak()` resolves `null` when muted or no page is attached — callers
  (V2-005) treat that as "screen only", not an error. On Stop the hub keeps the cancelled Speaker
  so the page's final flushed position still feeds `spokenSoFar()`. The hub is built in
  `server/app.ts`; V2-005 must share that instance with the answer pipeline, not build another.
  Mute is a session setting (`voiceMuted`). `SOTTO_DEV=1` (set by `npm run dev:server`) enables
  `POST /api/voice/test`; `npm run verify:voice` drives it through real ElevenLabs in a muted
  headless browser. Chrome needs a click or key press before audio can play.
- **An answer is two pieces of writing, and the spoken one goes first.** `server/prompts/answer.md`
  asks for `Say this:` (sentences written to be heard — no markdown, no URLs, no word cap) then
  `Show this:` (the ≤90-char headline, the detail, the sources), and `splitSpokenAnswer` in
  `shared/answers.ts` separates them out of the one streamed prose reply. The order is
  load-bearing, not stylistic: the spoken half has to start being said while the screen half is
  still being written. It is as tolerant as `splitAnswer` — a reply with no screen half falls back
  to `screenFromSpoken`, which promotes the first spoken sentence to the headline, because an
  answer the room can hear but nobody can see is the worse failure. Two parsing traps: a heading
  on a line of its own must be **dropped**, not kept as the headline, and the spoken half is *not*
  a growing prefix while the heading is still arriving (`Say thi` → `""` → the real text), so the
  feeder guards on its own `startsWith` rather than trusting the parse.
- **Sotto says two things, and the second one interrupts the first.** `server/answer/ack.ts` picks
  "Mm-hm." or "Let me check." by one question — is this about the conversation or about the world?
  — and `SpokenAnswer` (`server/answer/SpokenAnswer.ts`) speaks it as its **own utterance**, so
  opening the answer's utterance is literally what cuts it off; the PRD's "unless the answer's
  first sentence is ready first" is the mechanism rather than a special case. Everything runs on
  one promise chain because `VoiceOut.begin()` is a socket and the model's text is synchronous.
  Measured end to end on `ask-search` (real model, real ElevenLabs): **ackMs 461**, firstAudioMs
  **11,012**, 732 characters spoken.
- **`VoiceOut` is the seam, and `null` means "screen only".** `server/voice/voiceOut.ts` has the
  three moves — `begin()`, `append()`, `finish()` — that `VoiceHub` and `nullSinkVoice` both
  implement, so nothing upstream knows whether a browser, a discarded buffer or a mute is on the
  other end. `begin()` resolving `null` is not an error. `nullSinkVoice` is the *real* ElevenLabs
  socket with the audio thrown away, which is how an integration test measures `firstAudioMs`
  without a page; `SessionManager` takes `createVoice` (default none, so `npm test` never
  synthesizes) and `server/app.ts` builds the hub **before** the session manager so answers and
  the dev route share one.
- **The voice's latencies are read off real time, never the session clock.** `ackMs` and
  `firstAudioMs` are what a person in the room felt, and a `max` replay's session clock does not
  move while a model call is in flight — which is also why `latencyMs` is 0 in a replay and these
  two are not. `AnswerAgent` therefore takes a `wallClock` (defaulting to `systemClock`) beside
  its session `clock`.
- **A cancelled utterance has to wait for the page before it knows what was heard.** `cancel` and
  the browser's final `ended` report cross on the wire, and that report carries the flushed
  playback position that `Speaker.spokenSoFar()` reads. So `VoiceHub`'s utterance `finish()`
  waits up to `VOICE_FLUSH_WAIT_MS` (500) for it — and only on a cancel, and only when a page is
  attached, so a page that has gone away costs nothing.
- **Echo filtering belongs before every transcript consumer, including raw capture and answers.**
  V2-006's `SessionTranscription` wraps `TurnAssembler` for both live and replay input. Its
  `finalTurns()` is the human-only answer context; calling the raw assembler's would put echo
  back in the model's memory. During the echo window it holds partials until final text decides,
  because an echoed-looking prefix can grow into unrelated side talk. Raw frames wait in original
  order too, so `events.jsonl` cannot leak what `transcript.md` excluded. Echo text is marked
  `selfEcho` and goes only to `timing.jsonl`. `VoiceOut.playback()` is optional for silent/null
  sinks; `VoiceHub` supplies it from actual alignment-backed playback, retaining each utterance
  until 1,500 ms after playback ends on its real clock. Queued text is not heard text. A human
  turn overlapping playback carries `suppressTriggers` even if its final arrives later. V2-007
  needs a private partial-turn hook at this boundary for barge-in; keep public partials buffered.
  Later research gates must consult `playback().playing`, as the policy's pause getter does.
- **A dummy API key does not make a unit test offline.** Session and route plumbing tests now
  inject `server/test/emptyModel.ts` instead of constructing `MuseClient` with `test-key`.
  Those old tests attempted SDK calls and waited through network retries; the offline stub
  exercises the same configured-model wiring with empty board operations and candidates.
- **An answer is not finished until its playback is finished.** V2-007 makes `VoiceHub`'s
  utterance `finish()` wait for the browser's `ended` report, or a bounded playback timeout,
  before returning heard text. Synthesis can already be complete when a barge-in arrives;
  cancellation therefore has its own state rather than trusting the synthesis result's reason.
  `AnswerAgent.interrupt()` cancels both the hub and the `SpokenAnswer` feeder, including an
  acknowledgment whose answer has not opened yet. Stopping only the hub would let a later
  model sentence open another utterance. The private `SessionTranscription.onHuman` hook feeds
  `BargeIn` without publishing tentative partials; final commands are classified through
  `PROMPTS.command`, and the ordinary wake watcher skips owned turns. Follow-up prompts carry
  the interrupted answer and its flushed `spokenSoFar`; continue omits an acknowledgment.
  `barge_in` timing uses the first matching partial's `audioProcessedMs` as an explicitly
  labelled wake-end estimate (ASR has no word timestamps), plus arrival lag and the browser's
  flush-confirmation delay. A missing confirmation leaves latency null. The live checkpoint,
  not a simulated-clock result, must establish the room's actual under-1.5-second behavior.
- **Glimmer runs locally through Ollama, and its reasoning level decides everything.** Served as
  `muse-glimmer:30b-q4_K_M` by the Ollama server (0.40.11; the Homebrew `ollama` client is 0.15.2,
  so talk to the HTTP API, not the CLI). `.env` has `GLIMMER_BASE_URL=http://127.0.0.1:11434/v1`
  and `GLIMMER_MODEL`. It takes 16 GB of memory on the GPU, with a default context of 32768, and
  generates about 13 tokens/s on the M1 Max. The first call after a load took 44 s, and Ollama
  unloads the model after 5 idle minutes, so send `keep_alive` (e.g. `"30m"`) or warm it at
  session start. Measured on a four-probability gate prompt with json_schema output:
  default (high) reasoning about 35 s, correct; `reasoning_effort: "low"` (/v1) or `think: "low"`
  (/api/chat) 14–19 s, correct, and it rejects an already-raised point (new 0.05, worth 0.12);
  thinking off (`think: false` / `reasoning_effort: "none"`) 2–3.5 s but **unusable for scores**:
  noisy or all-zero results, and `<|eot|>` leaks into `content`, which breaks `JSON.parse`. Strip
  it if thinking is ever off. Never send temperature 0 (Meta's docs: Glimmer must not run greedy).
  On a 15-turn classification of whether Sotto was addressed, Glimmer with thinking off scored
  13/15 and wobbled between runs, while Muse Spark at low reasoning scored 15/15 in about 2 s. So
  use Glimmer where 15 s doesn't matter (research ideas, background judgment), and Spark where
  someone is waiting. Untested speed-up: the `muse-glimmer:30b-q4_K_M-dflash` tag (20 GB,
  speculative decoding).

- **Live ASR time and server uptime have different origins.** V2-008 fixes answer context by
  anchoring `recentTurns` to the latest final turn, never `clock.now()`. The same error affected
  silence: `SessionTranscription.pauseState` now projects elapsed clock time from the most recent
  `record.atMs` before asking `TurnAssembler` about the pause. Keep stream timestamps on turns and
  compare them only to stream time; cards and model durations use the session clock. Regression
  tests must offset live uptime by more than the ten-minute answer window, since replay starts at 0.
- **A lexical name hint is not a request.** V2-008's `detectsAddress` accepts whole-word wake
  spellings anywhere (except possessives/voce), so partial listening and barge-in stay instant.
  `AddressWatcher` classifies final intent through Spark with four named previous turns; `detect`
  remains the unchanged fallback. A name-only final arms only that speaker for eight seconds.
  Finals are serialized, so a fast follow-up can arrive while the name is still being classified;
  eligibility uses arrival time even if processing finishes after expiry. The six-second timeout
  uses the wall clock and an AbortSignal, never an awaited replay timer. Track the whole address
  queue for replay, drain it before answers, and stop it with the session. Playback commands are
  owned by BargeIn and never get a second address classification.

- **Sotto's own line is a turn, and the timeline it sits on is not the clock.** V2-008a writes every
  utterance Sotto speaks aloud into the transcript as a final `TurnUpdate` with `speaker: "Sotto"`
  and `sotto: true` (`sottoTurn()` in `shared/turns.ts`), placed at **playback start on the
  transcription stream's timeline** — `SessionTranscription.streamNow()`, the last frame's `atMs`
  plus elapsed clock time. A live session's `Clock` counts from the start of the *process*, so
  using `clock.now()` here is the same bug V2-008 fixed in the answer context. The text is Sotto's
  own (`spokenText`), or only `spokenSoFar` with `interrupted: true` when the room was cut off;
  a muted answer, an utterance nothing reported playing, and an acknowledgment write nothing —
  only `SpokenAnswer.say()` is stamped, never `acknowledge()`. Both the success and the failure
  path record, so a stream that broke mid-answer still says what was heard.
- **Routing is the whole story: what hears Sotto's line and what must not.** It goes to the bus,
  to `transcript.md` and to the **board** (labeled `Sotto`, so a fact Sotto established reaches
  the notes). It must not go to the **observer** (filtered at the `board.uncoveredTurns()` call
  site — an interjection arguing with Sotto's own answer helps nobody), nor to the wake watcher,
  `AddressWatcher`, `BargeIn`, the policy or speaker introductions, which each also early-return
  on `isSottoTurn`. `server/eval/runner.ts` and `server/e2e/live.ts` drop it at collection, which
  is the only route by which it could reach moment scoring or the `arrival − endMs` latency map.
  The self-echo matcher never sees it at all: it is injected downstream of
  `SessionTranscription.accept`. **Answer context deliberately excludes it** — the PRD says "may",
  and a measured 663-word spoken answer would crowd the ten-minute window, while an interrupted
  answer already reaches the follow-up through `AnswerAgent.interrupted`.
- **A transcript is in conversation order, not arrival order.** Sotto's line is written when its
  utterance ends but belongs where playback began, so it can land *after* the barge-in that cut it
  off. `SessionStore.appendTurn` inserts by `offsetMs` and rewrites the whole file when the insert
  is not at the end (the same move `renameSpeaker` makes), and `withTurn` in
  `useSessionEvents.ts` inserts by `startMs` — a no-op for the room's turns, which arrive in order.
  Sotto is never added to `record.speakers`, so nothing offers to rename it.

- **The complete question is known while the speaker is still talking, and that is where the address
  check belongs.** V2-008b starts the Spark classification on a *partial*: four words after the name
  (`ADDRESS_EARLY_WORDS`), or 600 ms of unchanged text (`ADDRESS_SETTLE_MS`) for turns that never
  reach four. Both numbers are measured off the captures rather than guessed: mid-speech partials
  arrive a median 310 ms apart (p75 482, p90 641), so the obvious 300 ms settle fires mid-sentence,
  and the *last* partial of a turn — which carries the complete text in 270 of 273 turns — lands only
  a median 882 ms before `speechEnd` arrives, so no settle rule can cover a 2.5 s check. Four words
  after the name is reached 1.8–4.9 s ahead. Real Spark on the four wake captures: the final turn
  waits **0.07–0.69 ms** for a verdict that took 1.9–3.0 s. A reuse keeps the **verdict**, never the
  wording — an extended request re-derives its question from the final text through
  `questionAfterName` (the loose reading `detect` refuses: any whole-word spelling anywhere, minus
  possessives and `voce`) — and a `name_only` is rechecked on *any* extension, because the request is
  the rest of the sentence and reusing it would arm the speaker and answer nothing.
- **A fake clock where every wait is instant does not test what it looks like it tests.**
  `instantWallClock` in `SessionManager.test.ts` fires a timer's callback in a microtask after adding
  its delay to `now()`, so the address check's six-second deadline expired before the model could
  answer and the `ask-search` answer test had been exercising the lexical fallback
  (`latencyMs: 6000, fallback: true`) rather than the classifier. A `max` replay spends no wall time
  pacing, so such a test can simply take `systemClock` and still run in 400 ms; only a `1x` replay
  needs the instant one.

- **Sotto says something before it knows anything, and that is three facts about the API.** V2-008c's
  holding line — one orienting sentence said while a searched answer is still being written — is a
  second Spark call (`server/answer/firstLine.ts`, `prompts/firstline.md`: no tools,
  `reasoning_effort: "low"`, 2k tokens) and it lands in the **answer's** utterance, not a third one,
  so a barge-in is one cancellation and `spokenSoFar` reads across both halves. Measured on
  `ask-search` through real Spark and real ElevenLabs, four runs: the acknowledgment at 257–275 ms,
  the first *real* sentence 1,979–2,741 ms after it (target 4,000), the searched half following at
  15.7–31.5 s. Three things the design turns on. **The prose request is built once**, so a call
  already in flight can never be told what the room has since heard — hence
  `FIRST_LINE_CONTEXT_WAIT_MS` (4,000 ms, on the **wall** clock): the searched call waits for the
  line and is given it, and the wait is hidden behind the ~5 s of speech the line itself is. 1.5 s
  and 3 s both expired just short of real runs and threw the context away for nothing. **`opened` is
  not synchronous** — it is set inside the promise chain — so "the answer got there first" is a
  separate flag set inside `say()` itself; two calls in one tick would otherwise both win. And
  **`firstAudioMs` keeps its meaning** (the answer utterance's first audio, which *is* the line's,
  since the line opens it), so nothing downstream changed; the continuation needed one optional seam,
  `VoiceUtterance.audioMs()`, because inside one utterance the second half is heard where the first
  half's audio ends. The line covers the first ~5 s of the wait, not all of it.

- **Sotto says hello to a room, not to a recording.** V2-009's `server/session/Greeting.ts` is
  built in `SessionManager.startLive` only — `mic` and `wav`, as the PRD words it — so an `events`
  replay is never greeted. That is not a detail: `npm run eval` replays captures and scores every
  `interject`/`glow` card as a delivery, and one card at t=0 would fail the "every delivery in a
  pause" gate on its own. The card it shows is a fourth `CardVariant`, **`notice`** (ids in
  `NOTICE_CARD_IDS`): Sotto talking about itself rather than about the conversation, so no
  "Sotto noticed…" label and no feedback row — `POST /api/feedback` only knows cards the *policy*
  delivered. `server/eval/runner.ts`'s `deliveredLevel` and `server/e2e/checks.ts`'s
  `interjections()` both already filtered on `interject|glow`, so neither needed changing; keep it
  that way when adding a variant. The words are `server/prompts/hello.md`, read verbatim through
  `loadPrompt` — the one "prompt" no model ever sees — so a session with no `MODEL_API_KEY` still
  introduces itself.
- **Three stories disagree about the hello, and the resolution is transcript yes, board no, echo
  never.** V2-009 says it is "excluded from the transcript and board by V2-006"; V2-008a, written
  later, lists "and later the hello" among the lines that appear labeled `Sotto`. V2-006 only ever
  excluded what the *microphone* heard, which is what V2-009 can have meant — so the hello is a
  Sotto turn (`sottoTurn({ utteranceId: "hello" })`, placed at `streamNow()` when the utterance
  opened) and its echo is suppressed, and `recordSottoSpeech` is called with a `null` board because
  the hello establishes no fact the notes want. A muted hello writes nothing at all: nothing was
  heard.
- **The nudge is armed by a deadline and fired by a pause.** `NAME_NUDGE_AFTER_MS` (120 s) only
  decides *whether* to ask; the card goes up at the next `inPause(pauseState())` — the policy's own
  rule on the same corrected silence — and the re-check is armed the way `InterjectionPolicy` arms
  its own: a timer for `PAUSE_MS - silentForMs` when the room is quiet, and **nothing at all** while
  somebody is talking, because the turn closing is what arrives next. A test that advances a fake
  clock without also delivering that turn will watch the nudge never fire; drive it with a
  `pauseState` derived from the clock, as `Greeting.test.ts` does.
- **The header's Start button is the microphone now.** The old source `<select>` is gone from
  `SessionControls`, so a Playwright check that wants a `wav` or `events` session has to
  `fetch("/api/session/start", …)` from the page (as `scripts/verify-hello.mjs` does) rather than
  pick an option. `scripts/verify-cards.mjs` and `scripts/verify-ui.mjs` still assert on that
  selector and on the old dark theme, and fail on both; their card and layout checks are still good.

- **Glimmer's schema constrains the tokens; it does not brief the model.** Ollama compiles a
  `response_format` JSON Schema into a grammar, so the keys and types always come back right and
  the model never reads a word of it — a probe whose properties were described as `"0-1"` returned
  `{"useful": 8, "unknown": 2, "answerable": 9}` while its own reasoning said "No schema given".
  Ranges, limits and units belong in the **prompt** for Glimmer; Muse Spark's strict structured
  output does show descriptions, so they can live in both. `server/model/GlimmerClient.ts` is the
  seam (same shape as `MuseClient.structured`, validated by the caller with zod) and it carries
  three more measured facts: `keep_alive: "30m"` in the `/v1` body **is** honoured (checked against
  `/api/ps`'s `expires_at`) and is on every call, because Ollama unloads after five idle minutes
  and the reload is ~44 s; `reasoning_effort` defaults to `"low"` here, since the model's own
  default spends ~35 s on a short prompt and thinking off is unusable for scores and leaks
  `<|eot|>` into `content` (stripped anyway); and nothing sends `temperature`, because Glimmer must
  not run greedy. Measured: a four-field gate call 17.0 s, in-range scores once the prompt said the
  range.
- **The judgment dot is the one that reads out its detail.** `server/model/judgment.ts`'s
  `JudgmentRouter` is built per session and decides once — `check()` starts the health check and
  returns, a role `await`s `client()` — so nothing waits at session start and a verdict landing
  after the session has gone changes no dot (`stop()`). That health check is a **models listing**
  (38 ms), not a trivial generation: a cold structured request is ~44 s, and `GlimmerClient.warm()`
  pays that in the background instead; `ralph/preflight.sh` is where the real structured request is
  sent. Glimmer unreachable is a **warning, not an error** — every judgment call goes to Muse Spark
  — so the dot is `active` either way and its `detail` (`local`/`cloud`) is what the header prints,
  which is why `statusChannels` is four long now and the bus snapshot is **nine** events plus one
  per card. `SessionManager.createGlimmer` defaults to `() => null` and `server/app.ts` supplies
  `glimmerFromEnv()`, exactly as it does for the voice: that is what keeps `npm test` off the local
  server as surely as it is off the network.

- **Adding a candidate type is three edits, and two of the six never reach the policy's door.**
  Nothing in the interjection pipeline branches on `CandidateType` — the policy, `delivery.ts`, the
  card and `feedback.jsonl` are all type-agnostic — so V2-011's `unanswered_question` and
  `research_hook` cost exactly `candidateTypes`, the `type` description inside
  `observerCandidatesJsonSchema` (strict structured output *does* show descriptions to the model,
  unlike Glimmer's compiled grammar) and a section in `server/prompts/observer.md`;
  `shared/candidates.test.ts` derives its enum assertion from `candidateTypes` and needed no
  change. The routing is one branch in `SessionManager.modelLoops`'s `onCandidate`: a
  `factual_error` detours through the verifier, a **`research_hook` leaves the interjection path
  for good** — it is an idea for the research gate (V2-012), so it is queued in
  `ModelLoops.researchHooks`, logged as `stage: "research_hook"` in `timing.jsonl`, and the policy
  never hears of it — and everything else goes straight to the policy. The no-overlap rule between
  `dropped_thread` (an idea or a risk raised and abandoned) and `unanswered_question` (a direct
  question nobody answered) lives only in the prompt, because the type is just an enum: moving
  `dropped_thread`'s old "who owns the data?" example to the new type *is* the enforcement.
  `MAX_CANDIDATES_PER_RUN` is still 3, so hooks now compete with interjection candidates for those
  three slots — look there first if recall on the core fixtures drops.

- **Research is three stages, and two of them exist to say no.** V2-012's `server/research/` is
  `ResearchManager` (dedupe → gate → budget) over `ResearchPlanner` (Muse Spark, every 2 min with
  ≥ 3 new final turns, ≤ 2 items) and `ResearchGate` (one judgment call per idea through
  `JudgmentRouter.client()`, so Glimmer when it is there and Spark when it is not). `shared/
  research.ts` carries the shape the PRD names — `{ id, topic, question, why, sourceTurnIds }`, with
  origin, the candidate it came from and the verdict on the *log records* rather than on the idea —
  plus `researchScore`, the **geometric mean** of `useful`/`unknown`/`answerable` against a 0.6
  threshold: one low answer sinks an idea (a question no search can answer is worthless however
  interesting) while a merely good one keeps its own level, which a plain product would not
  (0.7³ = 0.34). Measured on real local Glimmer: 19–39 s a call, scores always in range, 0.71–0.86
  for a checkable question and 0.19–0.46 for "would our team rather…" (`answerable` 0.05–0.15). The
  gate **never throws** — `failed` is a decision and it stops the idea, because an unscored idea must
  not spend a search slot. `run` is V2-013's seam: absent, an approved idea sits in `queued()`.
- **A hook's headline is already the question, so a hook costs no model call.** `hookIdea` reads
  `question` off `Candidate.headline` (`observer.md` demands the question there in as many words),
  `why` off `whyNow` with `detail` as the fallback, and a short topic off the question's first three
  content words — which is what makes two hooks asking the same thing collide in `topicKey`, while a
  planner idea on the same subject is caught by the question's Jaccard overlap instead.
- **The planner is quiet where the observer is loud, and that is the design.** It proposed two sharp
  items (HIPAA recording rules, clinic procurement certifications) on `research-business-idea` lines
  28–33, where a nine-month sales cycle is being leaned on and nobody asks for anything, and
  **zero** on `offsite-plan` lines 10–14, where they say "somebody should check the drive" — four
  runs out of four. That stretch is the observer's `research_hook`, and `research-planner.md`'s first
  paragraph says so. Never read a planner regression off a stretch that contains an out-loud request.
- **Three ways to make a prompt silent without noticing.** Measuring V2-012's planner cost three
  attempts, all of them the prompt rather than the code: a **synthetic snippet** tells you about the
  snippet, so both halves of `research.integration.test.ts` are built from the fixtures' own words;
  "**it is not on the board**" reads as excluding an *unanswered* board question, which is the
  clearest sign the group needs the answer (now spelled out in `research-planner.md` and
  `research-gate.md`); and the **JSON Schema's `description` is part of the prompt** on Muse Spark —
  an `ideas` array described as "an empty array is a perfectly good answer" was a stronger nudge than
  the prompt's own framing, and outvoted it. (On Glimmer the opposite trap: the description is never
  read at all, so ranges live in the prompt.)
- **`research.jsonl` is the record, and the budget's two caps fail differently.** `SESSION_FILES.
  research` / `SessionWriter.appendResearch` take `idea`, `gate` and `start` lines (V2-013 adds the
  packet), mirrored into `timing.jsonl` as `research_*`. The concurrency cap (2) frees when a job
  finishes, which calls back into the pump; the ten-minute cap (3) frees **with the clock, and
  nothing arrives to say so**, so `ResearchManager` arms a timer for the moment the oldest start ages
  out — the same shape as the policy's pause re-check. Dedupe is against every idea the session ever
  had, which is also the dedupe against earlier packets the PRD asks for, since a packet's idea is
  still in that list.

- **`grounded` is the same tool loop `prose` is, and all three tools go in one request.** Probed
  before V2-013 was written: a strict `json_schema` reply, `web_search` and a `function` tool are
  accepted together by the Responses API, and a round that ends in a `function_call` carries **no
  JSON at all** — narration, the searches, the call, nothing else — exactly the shape US-020
  measured for prose. So `MuseClient.grounded` loops (`TOOL_MAX_ROUNDS`, renamed from
  `PROSE_MAX_ROUNDS` now that two callers share it) and `GroundedReply` carries `functionCalls`.
  Two consequences worth knowing before offering a tool on a searching call: `store: false` means
  round two is resent only the user message and the call/result pair, so it **searches again from
  scratch** — 56k input tokens a round, which is why a packet with a visual costs about twice one
  without (~$0.17 against ~$0.08) and why `research-packet.md` tells the model a visual costs it a
  round. And the citations still do not come from the annotations: a JSON reply has no prose for an
  annotation to point into, so the model's own `sources` are the supply and every one is resolved
  against `include: ["web_search_call.action.sources"]`, as US-013 does.
- **A research packet is sources or nothing.** `server/research/ResearchRunner.ts` is one grounded
  call per approved idea (V2-012's gate decided *whether*; this is the search), and the only thing
  that can stop a finished reply reaching the screen is its sources: every URL goes through
  `resolveCitation`/`searchedIndex`, and a packet left with none is **discarded** and written to
  `research.jsonl` as `unsourced` — a research card is a claim about the world, and a group that
  cannot follow it back is worse off than one that never saw it. `failed` is the same kind of
  decision for a call that did not come back. The request is deliberately **just the question and
  why it came up**: a model handed six turns of brainstorm starts answering the brainstorm.
  Measured on a real `research-business-idea` replay: three packets at 67/90/110 s of a 175 s
  conversation, 12.9–20.7 s each, 2–4 sources, 5 key points, no visual drawn in any of them.
- **A research job has to be tracked on the clock, and that is what makes a replay honest.**
  `ResearchManager.start` registers each job with `clock.track`, like the gate queue and the
  verifier's checks; without it a `max` replay races past a 15-second search and every packet's
  `createdAtMs` lands after the conversation ended — which is also how V2-019's "a research card
  inside the window" would silently fail. The price: `SimulatedClock.settle()` now waits for a
  running job, so a test that *holds* one must drain microtasks (`tick()`) instead of settling, and
  `drainLoops` awaiting `research.flush()` means **Stop waits for a search in flight** (up to ~20 s)
  — deliberate, because V2-018's digest lists the research produced.

- **A research card is not a delivery, and that is what makes it cheap to add.** V2-014's fifth
  `CardVariant` (`research`) reaches the stage through `server/research/ResearchCards.ts`, which
  holds every ready packet until `inPause(pauseState())` — the policy's own rule, read off the
  policy's own getter, so Sotto's playback counts as somebody talking (V2-006) — and spends a
  budget of its own (`RESEARCH_CARD_COOLDOWN_MS` 60 s, `MAX_RESEARCH_CARDS_PER_WINDOW` 4 per 15
  min) beside the interjection one. Its id is `research-<packetId>`, deliberately **outside**
  `CARD_ID_PREFIX`, so `POST /api/feedback` can never find a candidate behind it and the two
  delivery filters that already existed — `deliveredLevel` in `server/eval/runner.ts` and
  `interjections()` in `server/e2e/checks.ts`, both `interject|glow` — needed no change at all.
  Adding a variant is three edits when those filters are honoured and a day's work when they are
  not. Unlike a held candidate, a packet is **never dropped**: `flush()` in `drainLoops` shows
  whatever is still waiting, pause and cooldown ignored, because a candidate is about a moment
  that has passed while a sourced packet is about the world — and it publishes against
  `this.last`, like an answer, since the stage is read after Stop.
- **One click has to be the whole interaction.** A research card is `card--collapsed` like a glow,
  but opening it renders the key points *inline* (`Details` grew an `inline` prop) rather than
  behind the "details ▾" toggle an answer uses: "clicking expands key points, sources and the
  visual" is one click, not two. The teaser is a new `StageCard.teaser` because it is shown
  **closed as well as open** — it is what somebody reads before deciding to open anything — which
  is exactly what `detailMd` is not. Measured in the browser: 90 px closed at 1440 px wide.
- **The replay that proves a research card costs four minutes and one search.** `npm run
  verify:research` starts a real `research-business-idea` events replay through
  `POST /api/session/start` (the header's Start button is the microphone), waits for the first
  `[data-variant="research"]` card — 67.3 s into the conversation, having waited 50 ms for a pause
  — and stops the session there rather than paying for all three packets. A 1x replay stalls on
  every tracked model call, so its wall clock is the conversation plus every gate and search in
  series. The one thing a replay will not reliably produce is a packet whose search drew a
  **visual** (none of V2-013's three did, and none here), so the opened-card-with-a-frame case is
  checked on `/dev/cards`, which now carries closed and open research samples and frames
  `web/public/dev/sample-artifact.html`.

- **A briefing is the fastest answer Sotto gives, because it is the one with nothing to
  wait for.** V2-015 hands `AnswerAgent` every `ResearchPacket` the session has made —
  context for *every* question, like the board — and a question that *asks* what Sotto
  found (`asksForResearch`, word patterns rather than a classification call) becomes a
  briefing: the packets it is about come forward and the spoken half opens with
  `briefingOpener`, a line written **locally**. That is the load-bearing choice.
  Measured on a real `research-business-idea` replay: the briefing skipped the
  acknowledgment *and* V2-008c's holding-line call and reached real speech in
  **392 ms**, while the same question with the packets taken away acknowledged at 241 ms
  and reached a real sentence at **4,342 ms** — and searched for 22 s to do it, where the
  briefing searched not at all. The opener rides the existing `sayFirstLine` plumbing, so
  the prose call is still told what the room has already heard. One consequence worth
  knowing: **`ackMs` is null on a briefing**, so anything reading it as "did Sotto
  respond" has to read `firstAudioMs` too.
- **A packet's pages are citable even when the answer searched for nothing.** The
  briefing's source URLs are added to `searchedIndex` beside this call's own, because
  they were already resolved against a real search when the packet was made, and the
  packet's sources go onto the card whether the model listed them or not — a finding the
  group cannot follow back is exactly what V2-013 throws packets away over. Without this
  every citation of a no-search briefing is dropped as "a page it never opened".
- **Matching a question to a packet is stems minus the asking words.** "what did you find
  on competitors?" is a question about *competitors*; leave "find" in and every packet
  matches every question. `packetsForBriefing` strips an `ASKING_WORDS` set, stems the
  rest, and scores **coverage of the question** (not Jaccard — a packet is paragraphs and
  a question is three words). Nothing matching is not a failure: it falls back to the most
  recent packets, which is what "what did you find?" means anyway, and the model sees all
  of them regardless.
- **`forward` is how a card comes back to the top.** `StageCard.forward` is set on the one
  push that happens because somebody asked (`ResearchCards.bringForward`), and it is the
  only thing that re-stamps `receivedAtMs` in `foldCard` — every other repeat push keeps
  its place and its collapsed state, which is what stops a streaming answer jumping the
  stack. `foldCard` moved from `useSessionEvents` into `stageView.ts` to be unit-tested.
  A brought-forward card spends none of the research-card budget and never starts its
  cooldown: the budget is about *unsolicited* cards.

- **The second opinion is cheap to add and expensive to wait for.** V2-016's
  `server/interject/CandidateGate.ts` sits at the one place every candidate but a
  `research_hook` passes through on its way to the policy, so turning it on cost three edits:
  the gate, `scoresFromGate` in `server/interject/policy.ts` (`true`→`confidence`,
  `new`→`novelty`, `worthSaying`→`importance`, `stillRelevant`→`relevance`, chosen so the
  formula and the chattiness thresholds mean exactly what they meant), and routing
  `onVerified`/`onCandidate` at it instead of at `policy.accept`. Nothing else branches on it
  — a gated candidate is a `Candidate` with different numbers in `scores`, the observer's kept
  in `observerScores`. The load-bearing difference from the research gate: a call that does
  not come back **keeps the observer's scores** rather than dropping the candidate, because
  losing the gate should cost judgment, not speech. Measured on local Glimmer: **26.4 s** a
  call at `low` effort, which scored a planted contradiction 0.75 where the observer had said
  0.95 and still interjected.
- **A `max` replay cannot measure what a gate costs a moment.** Simulated time does not move
  during a `clock.track`ed call, so the gate's 26 s — like the verifier's 10–15 — is *free* in
  the eval's timing and only the judgment is being measured. That is why
  `npm run eval -- --gate glimmer|spark` prints **median gate latency** beside recall and
  precision (`scoreGate` in `server/eval/score.ts`, off `FixtureRunRecord.gateCalls`, read
  back out of `candidates.jsonl`'s new `kind: "gate"` lines): against a planted window of
  11.8–20.6 s, 26 s of local judgment is the whole window, and only a live run or the report's
  latency will say so. `--gate spark` makes no call at all and is the baseline the local gate
  is compared to — the observer *is* Spark.
- **An eval replay has no Glimmer unless the script hands it one.** `server/eval/runner.ts`
  defaults `createGlimmer` to none, exactly as `SessionManager` does, so `npm test` never
  dials the local server — which means `scripts/eval.ts` has to pass `glimmerFromEnv()` or
  `--gate glimmer` quietly measures Muse Spark instead (the first V2-016 run did: "0 on
  Glimmer, 1 on Spark"). The same was true of V2-012's research gate in every eval run before
  this one.

- **One control became two, and only one of them is about *what* Sotto would say.** V2-017's
  `frequency` (`rare|normal|often`) owns the rationing — `FREQUENCY_LIMITS` in `shared/policy.ts`
  carries the cooldown and the budget for interjections *and* for research cards, because a group
  that asked for rare contributions meant everything Sotto does unasked — while `boldness`
  (`cautious|normal|bold`) owns the two thresholds, which are the three pairs the old
  `quiet`/`normal`/`active` chattiness carried, in that order. `normal/normal` is therefore the
  old `normal` exactly, and `server/interject/policy.test.ts` has a describe block that says so
  in four assertions. Boldness is also the first thing in the policy that reads a candidate's
  **type**: `cautious` raises a contradiction or a *verified* `factual_error` and nothing else
  (`CAUTIOUS_TYPES`, applied by `boldnessAllows`), with `boldness` as a new `DecisionReason`
  — checked *after* the score, so the log still says `below_threshold` for something that was
  never worth saying anyway. `ResearchCards` took the pair as `limits` and grew `setLimits`, the
  same shape `InterjectionPolicy.setSettings` has: changing a setting re-decides what is waiting
  rather than waiting for the next turn.
- **A record outlives the names of the things it recorded.** `eval/runs/<id>.json` from before
  V2-017 carries `chattiness`, so `FixtureRunRecord.settings` and `EvalRunRecord.settings` are
  **optional** beside a deprecated `chattiness`, and `settingsOf`/`settingsAsked` in
  `server/eval/score.ts` map the old name onto the new (`quiet`→`cautious`, `active`→`bold`,
  frequency `normal`, since the cooldown and budget were constants then). That is what keeps
  `npm run eval:report <old id>` working, and it is the same move `promptHashes`, `usage` and
  `gate` already made. Group by `policySettingsLabel(settings)` (`rare/bold`), never by object
  identity. The eval's flags are `--frequency` and `--boldness`, each taking `all`, and the
  settings run are their **cross product** — `--frequency all --boldness all` is nine groups.
- **`npm run verify:controls` replaced `verify:chattiness`**, which had been dead since V2-009
  took the source `<select>` out of the header: it starts its session with
  `fetch("/api/session/start")` like `verify-hello.mjs` does. What it proves beyond the obvious
  is that the two settings are *separate* — changing the frequency and reloading leaves the
  boldness where it was — and that both reach `session.json`.
