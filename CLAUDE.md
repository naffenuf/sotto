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
- **Chattiness is the server's setting, not the tab's.** It lives on the `EventBus` (which now
  snapshots **seven** events), is published as a `settings` event, and is deliberately *not*
  cleared by a session starting — turning Sotto down is meant for the next conversation too.
  `POST /api/session/settings` works with nothing running (the next session inherits it) and
  answers with the settings as they stand; the header's `<select>` shows what came back rather
  than what it clicked, so two tabs agree. `SessionSettings` is a typed `{ chattiness }` now, and
  `SessionManager.setChattiness` pushes it to the running policy *and* to `session.json`.
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
  call, nothing else — so `MuseClient.prose` is a loop (`PROSE_MAX_ROUNDS` 3): run the handler,
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
