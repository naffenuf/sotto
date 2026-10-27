# PRD: Sotto Core — The AI That Knows When to Speak

## Introduction

Sotto (codename) is a local web app that listens to a brainstorm between two or more people and contributes to the **whole group** only when it really matters. Notetakers (Otter, Granola, Fireflies) stay silent and summarize. Live coaches (Cluely, Zoom's Live Meeting Agent) whisper privately to one person. Voice agents talk constantly. None of them decide, on their own, that *this* is the moment to tell the group something useful.

That decision is the product. Sotto listens continuously, keeps a living board of the discussion, and notices things worth raising:
- a contradiction with an earlier constraint
- a factual error
- an assumption nobody has tested
- a promising thread the group dropped

It scores each one and chooses to stay silent, show a quiet "glow" on screen, or interject visibly — only at a natural pause, and rarely. It also answers when addressed by name ("Sotto, what do competitors charge?").

This PRD covers the **core loop**:
- audio in → speaker-labeled live transcript → living board
- **interjection engine**, plus a measured evaluation against test conversations with planted moments
- wake-phrase Q&A with web search and HTML on a stage
- every session saved to a folder

Interjections come early in the build order, so the differentiator can be tested and tuned from the first days.

It runs as a **local web app**: a Node server on the user's Mac (holds the API key, talks to Meta's APIs, runs tools, writes session files) plus a browser UI at `http://127.0.0.1:<port>`.

## Goals

- Raise the right things at the right time: catch at least 70% of planted moments, with no visible interjections on conversations that don't need them
- Interject only at natural pauses, never mid-sentence, and within budget (default: at most 1 visible interjection per 3 minutes)
- Prove it with a repeatable evaluation report, not anecdotes
- Show a live transcript with speaker labels within ~2 s of speech
- Keep a structured discussion board that updates on its own
- Answer wake-phrase questions with a glanceable headline, using web search when needed, and render HTML artifacts safely
- Save every session to disk, and make every feature testable without live speakers

## Background: Meta APIs used

| Purpose | Model / endpoint | Notes |
|---|---|---|
| Live transcription with speaker labels | `muse-voice-transcribe-1.0` via `wss://api.meta.ai/v1/asr/realtime`, `mode: "DIARIZATION"` | Raw PCM16 mono, 24 kHz, ~80 ms chunks, sent at real-time pace (no more than 5 s ahead; sending too slowly also errors). Auth goes in the first JSON frame (`authorization.accessToken: "Bearer <key>"`), not in an HTTP header. Events: `speechStart`, `transcript` (cumulative partials, `final` flag), `speechEnd`, `speechComplete` (carries final text), `speaker` (`label`: `A`, `B`, …). Labels exist only within one session. Sessions last at most 60 min (close code 1011 "Max session duration reached"). `keywords` biasing is set at handshake. Docs: https://dev.meta.ai/docs/speech-to-text, https://dev.meta.ai/docs/api-reference/voice/realtime |
| Board updates, interjection candidates, answers, eval judging | `muse-spark-1.3` via `https://api.meta.ai/v1` (OpenAI-SDK compatible) | Structured output via JSON Schema. Tool calling supported. |
| Web search (answers, fact checks) | Built-in tool `{"type": "web_search"}` on the **Responses API only** | Citations arrive as `url_citation` annotations (`url`, `title`, `start_index`, `end_index`) on `output_text` blocks. Docs: https://dev.meta.ai/docs/cookbook/search-grounding |

Auth: `MODEL_API_KEY` in `.env`. The key must never reach the browser.

## Key Terms

- **Turn:** one continuous stretch of speech by one speaker, as reported by the transcription API.
- **Pause:** no speech in progress (no open `speechStart`) and at least 1.5 s since the last `speechEnd`.
- **Candidate:** something the observer thinks *might* be worth raising, with scores.
- **Delivery level:** what the policy does with a candidate: `silent` (logged only), `glow` (small ambient card), or `interject` (prominent card).
- **Planted moment:** a deliberate situation written into a test conversation that Sotto *should* catch, with the expected delivery level and the window in which it must be raised.

## User Stories

Stories are ordered by dependency. Each should fit in one focused session.

### US-001: Project scaffold
**Description:** As a developer, I need a working TypeScript project with a server and a browser UI so later stories have somewhere to land.

**Acceptance Criteria:**
- [ ] Single npm package with `server/` (Node 22, Fastify, `@fastify/websocket`), `web/` (React 18 + Vite), and `shared/` for types used by both
- [ ] TypeScript `strict: true` across all three directories
- [ ] Scripts: `npm run dev` (server and Vite together, Vite proxies `/api` and `/ws` to the server), `npm run build`, `npm run typecheck`, `npm test` (Vitest)
- [ ] Server loads `MODEL_API_KEY` from `.env` with `dotenv` and exits with a clear message if it is missing
- [ ] Server binds to `127.0.0.1` only
- [ ] `GET /api/health` returns `{ "ok": true }`
- [ ] Web page shows the app name and a "server: connected" indicator that reflects `/api/health`
- [ ] `.env.example` contains `MODEL_API_KEY=`; `.gitignore` covers `.env`, `node_modules/`, `dist/`, `sessions/`
- [ ] Typecheck passes
- [ ] Verify in browser (Playwright screenshot / webapp-testing skill)

### US-002: Test conversation fixtures with planted moments
**Description:** As a developer, I need recorded multi-speaker conversations — including ones with planted moments Sotto should catch — so every feature, especially interjections, can be tested and measured without people talking into a mic.

**Acceptance Criteria:**
- [ ] Script format `fixtures/scripts/<name>.json`:
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
  `type` is one of `contradiction`, `factual_error`, `untested_assumption`, `dropped_thread`. `expectedLevel` is `glow` or `interject`. A catch counts if it is delivered after `triggerLine` ends and before `deadlineLine` ends.
- [ ] `fixtures/make_fixture.py` turns a script into:
  - `fixtures/audio/<name>.wav` (mono, 16-bit PCM, 24 kHz), made with Chatterbox TTS from `~/Developer/Chatterbox/venv`. Speaker A uses `~/Developer/Chatterbox/voices/maddie.pt`; speaker B uses Chatterbox's default voice. Lines are joined with the given pauses.
  - `fixtures/audio/<name>.timing.json`: start and end ms of every line
- [ ] Usage documented in `fixtures/README.md`: `~/Developer/Chatterbox/venv/bin/python fixtures/make_fixture.py fixtures/scripts/<name>.json`
- [ ] Generated WAVs and timing files are committed so later stories don't need Chatterbox
- [ ] Fixtures created (each 1–3 minutes, two speakers planning a product):

  | Fixture | Contents |
  |---|---|
  | `brainstorm` | Healthy discussion: at least 5 points, 1 decision, 1 open question. **No moments, no wake phrase.** Sotto should stay quiet. |
  | `moment-contradiction` | A budget or deadline constraint stated early, contradicted later (`interject`) |
  | `moment-fact` | A confidently stated, checkably wrong fact, e.g. a wrong market size or a wrong product launch year (`interject`) |
  | `moment-assumption` | The plan rests on an assumption nobody questions, e.g. "users will obviously pay monthly" (`glow`) |
  | `moment-dropped` | A promising idea raised, interrupted, never returned to; later the discussion reaches a point where it applies (`glow`) |
  | `moment-mixed` | 3-minute conversation with two moments of different types and long stretches where nothing should be said |
  | `ask-search` | Includes "Sotto, what do the main competitors charge per month?" |
  | `ask-diagram` | Includes "Sotto, can you sketch the user flow we just described as a diagram?" |
  | `no-wake` | Look-alike phrases ("so to speak", "Soto's restaurant", "sotto voce"); no wake phrase, no moments |

### US-003: Audio sources (mic and replay)
**Description:** As a user, I want to stream my mic — and as a developer I want to stream a fixture file — through the same pipeline.

**Acceptance Criteria:**
- [ ] Shared `AudioSource` interface on the server emits PCM16 mono 24 kHz chunks of 80 ms (3,840 bytes)
- [ ] **Mic source:** the browser captures the mic with an AudioWorklet, downsamples to 24 kHz PCM16, and sends binary 80 ms chunks over `/ws/audio`. The server forwards them to the pipeline.
- [ ] **WAV replay source:** the server reads a WAV from `fixtures/audio/` and emits chunks paced at real time (an 80 ms chunk every 80 ms ± 10 ms on average over 10 s), using a drift-corrected timer
- [ ] WAV replay rejects files that aren't mono 16-bit 24 kHz, with a clear error
- [ ] UI header has a source selector (Microphone / each fixture file) and Start / Stop buttons
- [ ] Unit test: replaying a 2.0 s WAV emits 25 chunks over 1.9–2.2 s
- [ ] Typecheck passes
- [ ] Verify in browser (Playwright screenshot / webapp-testing skill)

### US-004: Capture raw transcription events
**Description:** As a developer, I need real recorded event streams from Meta's realtime transcription so the parser can be built and tested against what the API actually sends.

**Acceptance Criteria:**
- [ ] `server/asr/realtimeClient.ts` opens `wss://api.meta.ai/v1/asr/realtime`, sends the handshake within 10 s (`authorization`, `audioEncoding: "PCM_24KHZ"`, `model: "muse-voice-transcribe-1.0"`, `mode: "DIARIZATION"`, `keywords: ["Sotto"]`), streams chunks from an `AudioSource`, sends `{"type":"endStream"}` at the end of input, and reads until the server closes with code 1000
- [ ] Every server frame is appended with a receive timestamp (ms since stream start) to a JSONL file
- [ ] `npm run capture -- <fixture>` replays a fixture and writes `fixtures/events/<fixture>.jsonl`
- [ ] Captured event files for all fixtures are committed
- [ ] `fixtures/events/NOTES.md` records the actual event shapes seen, especially how `speaker` events relate to turns and partials (the docs are ambiguous), and how "Sotto" was spelled in transcripts
- [ ] Close codes handled: 1000 done; 1008 logged as a fatal config/pacing error; 1011 and 1013 retried with backoff (1 s, 2 s, 4 s, max 3 tries)
- [ ] Typecheck passes

### US-005: Turn assembler and pause detection
**Description:** As a developer, I need raw transcription events turned into clean speaker-labeled turns, plus a reliable signal for when nobody is talking.

**Acceptance Criteria:**
- [ ] Pure module `server/asr/turns.ts` consumes timestamped events and emits `TurnUpdate` messages (type in `shared/`): `{ turnId, speaker: string | null, text, final: boolean, startMs, endMs | null }`
- [ ] Partials replace (not append to) the current turn's text
- [ ] A turn becomes `final` on `speechComplete`, taking its text from that event
- [ ] Speaker labels are attached according to the behavior documented in US-004 `NOTES.md`
- [ ] Overlapping turns are tracked by `turnId`
- [ ] The module exposes `pauseState(nowMs)`: `{ speaking: boolean, silentForMs: number }`, where `speaking` is true while any turn has `speechStart` without `speechEnd`
- [ ] All time comes from an injected clock (`now()`), never directly from `Date.now()`, so tests and fast replay (US-006) can use simulated time
- [ ] Unit tests replay every `fixtures/events/*.jsonl` file through the assembler. For `brainstorm`: at least 2 distinct speakers, every final turn has non-empty text, final turns are in time order, and `pauseState` reports a pause of ≥ 1.5 s somewhere in the conversation.
- [ ] When a session hits the 60-minute limit (1011 "Max session duration reached"), the client reconnects and the assembler keeps going. New labels are mapped to existing speakers by order of first appearance, and a `speakerMappingUncertain` flag is set.
- [ ] Typecheck passes

### US-006: Fast event replay (simulated time)
**Description:** As a developer, I want to run captured conversations through the pipeline in seconds instead of minutes, without calling the transcription API, so interjection tuning is fast and cheap.

**Acceptance Criteria:**
- [ ] `EventReplaySource` feeds a `fixtures/events/<name>.jsonl` file into the turn assembler using a simulated clock, at a configurable speed (`1x` for UI demos, `max` for tests)
- [ ] Everything downstream (board, observer, policy, answers) reads time only from the shared injected clock
- [ ] At `max` speed, the pipeline still waits for each model call to finish before advancing the clock past it. Simulated time stays consistent; only idle time is skipped.
- [ ] The UI source selector also lists "Replay events: <fixture>" options, running at 1x
- [ ] Unit test: replaying `brainstorm` events at `max` produces the same final turns as at `1x`
- [ ] Typecheck passes

### US-007: Live transcript panel
**Description:** As a user, I want to see who said what as it happens.

**Acceptance Criteria:**
- [ ] Server pushes `TurnUpdate`s to the browser over `/ws/events`
- [ ] Transcript panel shows one row per turn: speaker chip, then text. Partial turns are gray and italic; final turns are normal.
- [ ] Each speaker label (A, B, …) gets a consistent color
- [ ] Clicking a speaker chip lets the user type a display name (e.g. "Craig"), which applies to every turn from that label and is saved in the session (US-008)
- [ ] Auto-scrolls to the newest turn unless the user has scrolled up; a "jump to live" button appears when they have
- [ ] With the `brainstorm` WAV replaying, the first text appears within 3 s of the first spoken word
- [ ] Typecheck passes
- [ ] Verify in browser (Playwright screenshot / webapp-testing skill)

### US-008: Session folder persistence
**Description:** As a user, I want every session saved so I can review it later — and so the build and the evaluation can be checked by reading files.

**Acceptance Criteria:**
- [ ] Starting a session creates `sessions/<YYYY-MM-DD_HHMM>-<source>/`
- [ ] `session.json`: `{ id, startedAt, endedAt | null, source, speakers: { "A": { "name": string | null } }, asrSessions: string[], settings }`, updated on every change
- [ ] `events.jsonl`: every raw transcription event, as in US-004
- [ ] `transcript.md`: one line per **final** turn, appended as each turn finalizes, formatted `**[mm:ss] Name-or-label:** text`
- [ ] `board.md` and `board.json`: written by US-009 whenever the board changes
- [ ] `candidates.jsonl`: every candidate from the observer with its scores and the policy's decision (US-012–US-014)
- [ ] `feedback.jsonl`: user feedback on delivered cards (US-015)
- [ ] `answers.jsonl`: one record per answer (US-018)
- [ ] `artifacts/`: HTML files (US-020)
- [ ] Renaming a speaker rewrites `transcript.md` with the new name
- [ ] All writes are atomic (write a temp file, then rename) so a crash never leaves a half-written file
- [ ] Integration test: replaying `brainstorm` events (US-006) produces a folder where `transcript.md` has at least 10 lines and `session.json` has `endedAt` set
- [ ] Typecheck passes

### US-009: Living board — model and update loop
**Description:** As a user, I want the discussion organized automatically into points, questions and decisions without anyone asking. The board is also the memory the interjection engine reasons over.

**Acceptance Criteria:**
- [ ] Board type in `shared/`: `{ summary: string, constraints: Item[], points: Item[], questions: Item[], decisions: Item[] }`, where `Item = { id, text, status: "open" | "covered" | "dropped", sourceTurnIds: string[], createdAtMs, updatedAtMs }`
  - `constraints` holds stated limits (budget, deadline, audience, must-haves), which contradiction detection depends on
  - questions use "covered" to mean answered
- [ ] The update loop runs when at least 4 new final turns have arrived **or** 45 s have passed with at least 1 new final turn. Only one update can be in flight; triggers that arrive meanwhile are merged into the next run.
- [ ] Each update sends `muse-spark-1.3`: the current board as JSON, the final turns since the last update (with turn IDs), and the 10 turns before those for context. It asks for a JSON-Schema-constrained list of operations (`strict: true`), never a full board:
  - `add_constraint`, `add_point`, `add_question`, `add_decision` with `{ text, sourceTurnIds }`
  - `set_status` with `{ id, status }`
  - `edit_text` with `{ id, text }`
  - `set_summary` with `{ text }`
- [ ] Operations are applied by a pure, unit-tested function. Unknown IDs are ignored and logged. The function never deletes items; it marks them "dropped".
- [ ] The prompt tells the model to: keep items short (≤ 12 words); avoid duplicates (prefer `edit_text` on an existing item); record every stated constraint; mark points "covered" only when the conversation clearly addressed them; and keep `summary` ≤ 2 sentences
- [ ] After each update, `board.json` and `board.md` are written and the board is pushed to the browser
- [ ] Integration test (event replay): `brainstorm` gives at least 4 points, at least 1 decision, at least 1 question and a non-empty summary; `moment-contradiction` gives a constraint matching the planted setup line
- [ ] Typecheck passes

### US-010: Board panel
**Description:** As a user, I want to glance at the board and see what's been covered and what's still open.

**Acceptance Criteria:**
- [ ] Board panel shows the summary, then sections for Constraints, Points, Open Questions and Decisions
- [ ] Open items show an empty checkbox, covered items a checked box with strike-through, dropped items are hidden behind a "show dropped (n)" toggle
- [ ] Items added or changed in the latest update get a highlight that fades over 3 s
- [ ] A small "updated 12s ago" indicator, plus a spinner while an update is in flight
- [ ] Typecheck passes
- [ ] Verify in browser (Playwright screenshot / webapp-testing skill)

### US-011: Stage layout and card component
**Description:** As a user, I want one large, glanceable area where everything Sotto contributes appears.

**Acceptance Criteria:**
- [ ] Layout: left column (~25%) with transcript on top and board below; right (~75%) the stage; header with source selector, Start/Stop, and status dots for server, transcription and model
- [ ] One `Card` component with three variants:
  - `answer`: question in small text with asker's name; headline ≥ 28 px; "details ▾" expands markdown; numbered sources
  - `interject`: same size as `answer`, accent border, label "Sotto noticed…", plus a "why now" line and evidence quotes
  - `glow`: compact, one line, muted accent, click to expand into the full card
- [ ] Cards stack newest on top; `glow` cards collapse into a "n quiet thoughts" tray after 2 minutes
- [ ] Each card supports a `thinking` state (animated indicator) and an `error` state (muted message)
- [ ] Dark theme by default; headline readable from ~2 m on a 13" laptop
- [ ] Storybook-style dev page at `/dev/cards` shows every variant and state with sample data
- [ ] Typecheck passes
- [ ] Verify in browser (Playwright screenshot / webapp-testing skill)

### US-012: Observer — interjection candidates
**Description:** As the system, I need to notice things worth raising — contradictions, factual errors, untested assumptions, dropped threads — and score them.

**Acceptance Criteria:**
- [ ] The observer runs right after each board update (US-009), with: the board, the turns since its last run, and the last 3 final turns marked as "current topic"
- [ ] It calls `muse-spark-1.3` with structured output and returns 0–3 candidates:
  `{ type, headline (≤ 90 chars), detail (≤ 60 words), whyNow (≤ 20 words), evidenceTurnIds: string[], relatedBoardItemIds: string[], scores: { relevance, novelty, importance, confidence } }` (each score 0–1)
  - `relevance`: how closely it relates to the current topic
  - `novelty`: it hasn't been said in the conversation and isn't already on the board as raised
  - `importance`: how much it would change the group's decision if ignored
  - `confidence`: how sure the model is the issue is real
- [ ] The prompt includes a short definition and one example of each type, and states that returning zero candidates is the normal, expected result
- [ ] Every candidate gets an ID and is written to `candidates.jsonl` before the policy (US-014) sees it
- [ ] Candidates that duplicate an earlier candidate (same type and an overlapping `relatedBoardItemIds`, or a headline judged equivalent) are marked `duplicate` and not passed on
- [ ] Integration test (event replay): `moment-contradiction` produces at least one `contradiction` candidate whose evidence includes the trigger line's turn
- [ ] Typecheck passes

### US-013: Fact verification
**Description:** As the system, before I tell a group they've got a fact wrong, I need to check it.

**Acceptance Criteria:**
- [ ] Every `factual_error` candidate is verified by a Responses API call with `tools: [{ "type": "web_search" }]`, which returns structured `{ verdict: "wrong" | "right" | "unclear", correction (≤ 30 words), citations: { url, title }[] }`
- [ ] `wrong`: the candidate continues to the policy, with the correction added to its detail and the citations attached
- [ ] `right` or `unclear`: the candidate is marked `unverified` and stops here
- [ ] Verification runs asynchronously; other candidates are not blocked
- [ ] Integration test (event replay): `moment-fact` yields a verified `factual_error` candidate with at least 1 citation
- [ ] Typecheck passes

### US-014: Interjection policy
**Description:** As a user, I want Sotto to speak up rarely, at good moments, and only about things that matter.

**Acceptance Criteria:**
- [ ] Pure, unit-tested module `server/interject/policy.ts`. Given a candidate, the clock, `pauseState`, and history, it decides `silent` | `glow` | `interject` | `hold` (wait for a pause)
- [ ] Score = `importance × confidence × (0.5 + 0.5 × relevance) × novelty`
- [ ] Thresholds from a "chattiness" setting:

  | Setting | glow ≥ | interject ≥ |
  |---|---|---|
  | quiet | 0.45 | 0.75 |
  | normal (default) | 0.35 | 0.6 |
  | active | 0.25 | 0.45 |

- [ ] **Timing:** `glow` and `interject` are delivered only during a pause (US-005). Otherwise the candidate is `hold` and re-checked whenever `pauseState` changes.
- [ ] **Expiry:** a held candidate expires (`silent`, reason `stale`) after 90 s or 6 new final turns, whichever comes first
- [ ] **Budget:** after a visible `interject`, further interjects are downgraded to `glow` for 3 minutes (cooldown). At most 3 `interject`s per 15 minutes.
- [ ] **Courtesy:** nothing is delivered while an answer (US-018) is in its `thinking` state, or within 5 s after a wake phrase is detected
- [ ] Every decision is logged to `candidates.jsonl` with the score, the thresholds and the reason (e.g. `below_threshold`, `cooldown`, `stale`, `delivered`)
- [ ] Unit tests cover each rule with a simulated clock: threshold boundaries, hold → deliver on pause, expiry by time and by turns, cooldown downgrade, budget cap, courtesy suppression
- [ ] Chattiness can be changed live from the UI header and is saved to `session.json` settings
- [ ] Typecheck passes

### US-015: Interjection delivery and feedback
**Description:** As a user, I want Sotto's contributions shown calmly and clearly, and I want to tell it when it got the call wrong.

**Acceptance Criteria:**
- [ ] `interject` decisions appear as `interject` cards (US-011) with headline, "why now", detail, evidence quotes (clicking a quote scrolls the transcript to that turn and highlights it), and citations if any
- [ ] `glow` decisions appear as `glow` cards
- [ ] Every delivered card has three feedback buttons: 👍 "useful", 👎 "not useful", ⏱ "wrong moment". Clicks are written to `feedback.jsonl` with the candidate ID and card level.
- [ ] Delivery never plays sound or opens a modal
- [ ] Typecheck passes
- [ ] Verify in browser (Playwright screenshot / webapp-testing skill)

### US-016: Interjection evaluation harness
**Description:** As a developer, I want one command that measures how well Sotto chooses what to raise and when, so I can tune prompts and thresholds with numbers instead of gut feel.

**Acceptance Criteria:**
- [ ] `npm run eval` replays captured events (US-006, `max` speed) for `brainstorm`, `no-wake` and every `moment-*` fixture, through board → observer → verification → policy, at the current chattiness setting (or `--chattiness quiet|normal|active|all`)
- [ ] Matching delivered cards to planted moments: a judge call to `muse-spark-1.3` with structured output decides, for each delivered card and each moment in that fixture, whether the card raises that moment (`{ matches: boolean, reason }`). Judge results are cached by (card headline, moment ID) so reruns are cheap.
- [ ] Per moment, the outcome is one of:
  - **caught**: matched, delivered at the expected level or higher, within the window
  - **caught low**: matched, but as `glow` when `interject` was expected
  - **late**: matched, but delivered after `deadlineLine`
  - **missed**: no matching card
- [ ] Per fixture, the report counts **false interjections** (visible `interject` cards matching no moment) and **false glows**
- [ ] The report also records timing: every delivery happened during a pause (must be 100%), and the median delay from the end of `triggerLine` to delivery
- [ ] Output: a table in the terminal plus `eval/reports/<timestamp>.md` with the per-moment table, totals, the settings, the git commit, and estimated API cost
- [ ] Headline metrics printed at the end: **moment recall** (caught + caught low) / total, **interject precision** (true interjects / all interjects), **false interjects on `brainstorm` + `no-wake`**
- [ ] Exits non-zero if moment recall < 0.7, any false interject occurs on `brainstorm` or `no-wake`, or any delivery happened outside a pause
- [ ] Typecheck passes

### US-017: Wake-phrase detection
**Description:** As a user, I want to address Sotto by name mid-conversation and have it know I'm asking it something.

**Acceptance Criteria:**
- [ ] Pure module `server/wake.ts` takes turn text and returns `{ triggered: boolean, question: string | null }`
- [ ] Triggers when the wake word appears at the start of a sentence or right after "hey"/"okay"/"ok", followed by a comma or a question. Accepted spellings (case-insensitive) are configurable, defaulting to `["sotto", "soto", "sota"]`, tuned with the spellings recorded in US-004 `NOTES.md`.
- [ ] Does **not** trigger on: "so to speak", "so to", "sotto voce", or "Soto" used as a name inside a sentence (e.g. "Soto's restaurant")
- [ ] Unit tests: at least 8 positive and 8 negative sentences, including the look-alikes from the `no-wake` fixture
- [ ] When a **partial** turn triggers, the UI shows a "Sotto is listening…" indicator. The question is sent only when the turn becomes **final**, with `question` = the text after the wake word.
- [ ] At most one trigger per `turnId`
- [ ] Integration test (event replay): `ask-search` gives exactly 1 trigger; `no-wake`, `brainstorm` and all `moment-*` fixtures give 0
- [ ] Typecheck passes

### US-018: Answer agent with web search
**Description:** As a user, I want a short, sourced answer that uses the conversation as context.

**Acceptance Criteria:**
- [ ] On a trigger (US-017) or a typed question (US-019), the server calls the **Responses API** with `muse-spark-1.3`, `tools: [{ "type": "web_search" }]`, and input containing: the current board, the last 10 minutes of final turns (with speaker names), and the question
- [ ] The system prompt tells the model to answer for people glancing at a shared screen: line 1 is a headline of ≤ 90 characters, then optional detail in markdown of ≤ 150 words
- [ ] The response is parsed into `Answer = { id, question, askedBy, headline, detailMd, citations: { url, title }[], status: "thinking" | "done" | "error", createdAtMs, latencyMs }`. Citations come from `url_citation` annotations, deduplicated by URL.
- [ ] The answer streams as an `answer` card: "thinking" immediately, then the headline as soon as line 1 is complete, then the full answer when done
- [ ] Answers run in their own queue and never wait for board updates or the observer
- [ ] On an API error, status "error" is pushed with a short message, and the session keeps running
- [ ] Each answer is appended to `answers.jsonl`
- [ ] Integration test (event replay): `ask-search` gives 1 answer with status "done", a headline of ≤ 90 characters, and at least 1 citation
- [ ] Typecheck passes

### US-019: Typed questions
**Description:** As a user, I want to type a question when speaking isn't practical or the wake word was misheard.

**Acceptance Criteria:**
- [ ] Input box at the bottom of the stage: "Ask Sotto…". Enter submits.
- [ ] A typed question goes through the same path as a spoken one (US-018), with `askedBy: "typed"`
- [ ] Works while a session is running and while it is stopped (using the last session's context)
- [ ] Typecheck passes
- [ ] Verify in browser (Playwright screenshot / webapp-testing skill)

### US-020: HTML artifacts on the stage
**Description:** As a user, I want to ask for a diagram, table or mockup and see it rendered.

**Acceptance Criteria:**
- [ ] The answer agent can call a function tool `show_html({ title: string, html: string })`, where `html` is a complete self-contained HTML document (inline CSS/JS/SVG, no external requests)
- [ ] The server saves it to `artifacts/<nn>-<slug>.html` and attaches `{ title, path }` to the answer
- [ ] The card renders the artifact in an `<iframe sandbox="allow-scripts">` (no `allow-same-origin`), served from `/api/sessions/<id>/artifacts/<file>` with header `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:`
- [ ] The artifact card has an "open full screen" button
- [ ] **If the API rejects mixing `web_search` with function tools in one request:** route by intent. A cheap first call classifies the question as `search` or `visual`, then the matching tool set is used. Record which approach was used in `NOTES.md`.
- [ ] Integration test (event replay): `ask-diagram` gives an answer with exactly 1 artifact, whose file exists and contains `<svg` or `<div`
- [ ] Typecheck passes
- [ ] Verify in browser (Playwright screenshot / webapp-testing skill)

### US-021: End-to-end live-audio check
**Description:** As a developer, I want one command that proves the whole loop works against the real APIs from audio, not just from captured events.

**Acceptance Criteria:**
- [ ] `npm run e2e` replays the WAVs (real-time pace, real transcription) for `brainstorm`, `moment-contradiction`, `ask-search` and `ask-diagram` headlessly through the full pipeline
- [ ] It asserts: the integration criteria from US-008, US-009, US-017, US-018 and US-020; `moment-contradiction` is caught; `brainstorm` has no `interject` cards
- [ ] It prints per-fixture latency: wake → headline, wake → done, and moment trigger → delivery
- [ ] It exits non-zero on any failure
- [ ] Total API cost per run is under $0.50 (estimate printed from token and audio usage)

## Functional Requirements

- FR-1: The system must run as a Node server bound to `127.0.0.1` plus a browser UI served from it. `MODEL_API_KEY` stays on the server.
- FR-2: The system must accept audio from the browser mic or from a fixture WAV (normalized to PCM16 mono 24 kHz, 80 ms chunks, real-time pace), and captured transcription events at simulated speed.
- FR-3: The system must stream audio to Meta's realtime transcription in `DIARIZATION` mode, with "Sotto" as a biasing keyword, and reconnect automatically on retryable errors and the 60-minute session limit.
- FR-4: The system must turn transcription events into speaker-labeled turns, show partial and final turns live, and track whether anyone is speaking.
- FR-5: Users must be able to give speaker labels display names, which are used in the UI, in saved files and in model prompts.
- FR-6: The system must keep a board of constraints, points, questions, decisions and a summary, updated by model-proposed operations, never by full rewrites.
- FR-7: The system must generate scored interjection candidates of four types (contradiction, factual error, untested assumption, dropped thread), and verify factual errors with web search before acting on them.
- FR-8: The system must decide `silent` / `glow` / `interject` for each candidate using scores, a chattiness setting, pause timing, expiry, cooldown, budget and courtesy rules, and log every decision with its reason.
- FR-9: The system must deliver contributions only as on-screen cards during pauses, never as sound, and collect 👍 / 👎 / ⏱ feedback on each.
- FR-10: The system must provide a repeatable evaluation (`npm run eval`) that scores moment recall, interject precision, false interjections and timing against fixtures with planted moments.
- FR-11: The system must detect the wake phrase, avoid known look-alikes, fire at most once per turn, and answer with a headline, optional detail and citations, using web search when the model decides to.
- FR-12: The system must render model-generated HTML artifacts in a sandboxed iframe with a restrictive CSP.
- FR-13: The system must save each session to `sessions/<id>/` (`session.json`, `events.jsonl`, `transcript.md`, `board.md`, `board.json`, `candidates.jsonl`, `feedback.jsonl`, `answers.jsonl`, `artifacts/`) using atomic writes.

## Non-Goals (Out of Scope)

- Spoken output (text-to-speech) of any kind
- Background prefetch of research mentioned in conversation (next PRD)
- Learning from feedback automatically; feedback is collected now and used for manual tuning
- Image generation (Muse Image), local file read/write tools
- Capturing audio from Zoom/Meet or other apps; native or desktop wrappers
- Recognizing the same speaker across sessions, or voice enrollment
- Accounts, auth, multiple users, cloud deployment
- Browsing past sessions in the UI (folders on disk are enough for now)
- Mobile layout

## Design Considerations

- One screen, dark theme, readable from across a table (see US-011 for layout).
- Glanceable first: the headline carries the message, and detail is opt-in.
- Calm: no sounds, no modal popups, no flashing. Highlights fade. Glows collapse into a tray.
- An interjection should feel like a thoughtful colleague's raised hand. It always explains "why now" and shows its evidence (quotes from the transcript), so the group can judge it quickly.

## Technical Considerations

- **Stack:** Node 22, TypeScript (strict), Fastify + `@fastify/websocket`, `ws` for the outbound transcription socket, the `openai` SDK with `baseURL: "https://api.meta.ai/v1"`, `zod` for runtime validation of model output, Vitest, React 18 + Vite.
- **Clock:** a single injected clock drives everything time-based (pauses, update triggers, expiry, cooldown), so event replay can run at simulated speed and policy tests are deterministic.
- **Pacing:** the transcription API errors (1008) if audio arrives more than 5 s ahead *or* slower than real time. WAV replay must use a drift-corrected timer, not `setInterval` alone.
- **Browser audio:** use an AudioWorklet, not the deprecated ScriptProcessor. Most mics capture at 48 kHz, so resample to 24 kHz. Start with default browser audio processing settings.
- **Queues:** board updates (followed by the observer), fact verification and answers run in independent queues. An answer must never wait for the board or the observer.
- **Prompts** live in `server/prompts/*.md` so they can be tuned without code changes. The eval report records which prompt versions (by file hash) were used.
- **Fixtures:** Chatterbox (local, at `~/Developer/Chatterbox`) is used only to generate test audio. It is not part of the product. Generated WAVs, timing files and captured events are committed.
- **Hackathon rules:** public repo; only work built during the event; the README must state what was built during the hackathon.
- **Cost:** transcription is ~$0.18/hour; Muse Spark 1.3 is $1.25 per million input tokens and $4.25 per million output tokens. A full `npm run eval` at one chattiness setting should cost under $1.

## Success Metrics

- Moment recall ≥ 70% on the `moment-*` fixtures at the `normal` setting
- Zero false `interject` cards on `brainstorm` and `no-wake`
- 100% of deliveries happen during a pause
- Median delay from moment trigger to delivery < 15 s
- Wake → headline on screen: median < 6 s without search, < 12 s with search
- A new discussion point appears on the board within 60 s of being raised
- A 30-minute live session runs with no crash and no lost transcript
- In live testing, at least half of delivered cards get 👍

## Open Questions

1. Can `web_search` and function tools (`show_html`) be combined in one Responses request? US-020 includes a fallback.
2. How well does diarization separate two people on one laptop mic in a real room? The TTS fixtures are an optimistic proxy. Test live early.
3. How does the transcription model spell "Sotto"? `keywords` biasing should help; US-004 records the spellings.
4. What exactly does a `speaker` event label? The docs and their example disagree; US-004 resolves this.
5. Is the default Chatterbox voice distinct enough from "maddie" for diarization to separate them? If not, clone a second voice.
6. Are scripted TTS conversations realistic enough to tune interjections? Real conversations are messier (interruptions, filler, half-sentences). Record at least one real two-person brainstorm, annotate its moments by hand, and add it to the eval set.
7. Is the score formula right? It's a starting point; tune it with eval results and feedback.
8. How reliable is the LLM judge? Spot-check a sample of judge decisions by hand in the first eval reports.
9. **Revisit Muse Glimmer (local open-weight model) once the core works.** Candidate jobs: the frequent board updates and the observer pass, kept local for privacy and cost, with Muse Spark handling verification and answers. It would also make the project eligible for the $10K "Best Build on Meta Open Weight Models" bonus prize. Constraints on this Mac (M1 Max, 32 GB): the 4-bit build (~20 GB) fits in memory but tightly, and the disk had only ~16 GB free as of Oct 26, so space must be freed first. The injected-clock, prompt-file and eval-harness design lets us compare Glimmer against Spark on the same fixtures before switching.
