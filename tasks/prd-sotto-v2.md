# PRD: Sotto v2 — A Voice in the Room

## Supersedes

This PRD changes parts of [`prd-sotto-core.md`](prd-sotto-core.md) (all 28 core stories are built). **Where the two disagree, this PRD wins.** Everything not listed here still stands, together with the core PRD's "Changes since this PRD" section.

| Core PRD section | Replaced by |
|---|---|
| FR-11 "never speak", Non-Goal "text-to-speech output" | Sotto speaks when addressed, through ElevenLabs (V2-003 to V2-008) |
| US-018 answer format (≤ 90-char headline, ≤ 150-word detail) | Spoken answers of whatever length suits the question; the card keeps a short headline (V2-005) |
| US-002 Chatterbox fixture generation | ElevenLabs renders test audio; Chatterbox is removed (V2-001) |
| Non-Goal "background prefetch of research" | Background research with research-ready cards and spoken briefings (V2-011 to V2-015) |
| US-012 candidate types | Adds `unanswered_question` and `research_hook` (V2-011) |
| US-014 single chattiness setting | Two controls: frequency and boldness (V2-017) |
| US-012/US-014 model-scored candidates | Muse Glimmer, running locally, scores and gates candidates (V2-016) |

## Introduction

The core build proved the hard part: Sotto listens to a group, keeps a board, and raises the right thing at a natural pause. Live trials caught a planted budget contradiction and a scope contradiction at the right moment.

But Sotto is meant to be a participant in a meeting, and participants talk. Reading answers off a screen breaks the flow of a conversation. v2 gives Sotto a voice and makes it do useful work in the background:

1. **Voice:** when someone says "Sotto, …", it answers out loud, quickly, at whatever length the question deserves, and **anyone can cut it off by saying "Sotto"**. It greets the room when a session starts.
2. **Background research:** it notices what's worth looking up (competitors, market size, a recipe's shopping list), researches it quietly with sources, and puts a small "research ready" card on screen. When someone asks, it gives a spoken briefing with visuals on screen. The work is already done.
3. **Local judgment:** Muse Glimmer, running on the laptop, scores every candidate interjection and research idea, so the judgment layer is private, cheap and fast. This also makes the project eligible for the "Best Build on Meta Open Weight Models" bonus.
4. **A digest at the end:** what Sotto said, what it almost said and why it held back, the research it produced, and what's still open.

**Unprompted contributions stay on screen.** Sotto speaks only when addressed (plus its opening hello). Spoken unprompted interjections come later; getting their timing and tone right in a room is a bigger job than this hackathon allows.

## Goals

- Sotto starts speaking quickly after being addressed: a short spoken acknowledgment within ~1.5 s, and the answer itself as soon as its first sentence exists
- Saying "Sotto" while it speaks silences it within ~1.5 s, and follow-ups ("Sotto, what about X?", "Sotto, go on") work
- Sotto never transcribes, reacts to or triggers on its own voice
- At least one research packet is ready *before* anyone asks for it in the research test conversation
- Glimmer gates candidates locally with eval results no worse than the current Spark scoring
- The interjection eval still passes its gates (recall ≥ 0.7, zero false interjects on calm conversations, 100% delivered during pauses)

## Prerequisites (done by a human before the loop)

1. **Glimmer running locally.** Download a Muse Glimmer 4-bit build (~20 GB) and serve it behind an OpenAI-compatible endpoint (llama.cpp's `llama-server`, or Ollama if a Glimmer build exists). Set `GLIMMER_BASE_URL` (e.g. `http://127.0.0.1:8080/v1`) and `GLIMMER_MODEL` in `.env`. Docs: https://dev.meta.ai/docs/muse-glimmer/deploy. The loop never downloads models.
2. **ElevenLabs key.** `ELEVENLABS_API_KEY` in `.env` (done). Optionally `ELEVENLABS_VOICE_ID` for Sotto's voice; otherwise a calm default library voice is chosen in V2-003.

## Key Terms

- **Playback:** the time during which Sotto's speech is playing in the browser.
- **Barge-in:** someone saying "Sotto" while Sotto is speaking, which stops it.
- **Side talk:** people talking to each other while Sotto speaks. It stays in the transcript but triggers nothing.
- **Self-echo:** Sotto's own voice picked up by the mic and transcribed.
- **Research packet:** the result of one background research job: title, teaser, key points, sources, and an optional visual.
- **Gate:** the step that scores a candidate and decides whether it goes on to the policy (interjections) or the research runner (research ideas).

## User Stories

Ordered by dependency. Each should fit in one loop iteration.

### V2-001: Replace Chatterbox with ElevenLabs for test audio
**Description:** As a developer, I want test conversations rendered by ElevenLabs so fixture generation is fast, uses distinct voices, and has no Python dependency.

**Acceptance Criteria:**
- [ ] `npm run fixture:render -- <name>` (TypeScript, `scripts/render-fixture.ts`) renders `fixtures/scripts/<name>.json` into `fixtures/audio/<name>.wav` (mono, 16-bit PCM, 24 kHz) and `<name>.timing.json`, using ElevenLabs text-to-speech with output format `pcm_24000`
- [ ] Each script speaker letter maps to a distinct ElevenLabs voice (configurable map in `fixtures/voices.json`; defaults are two clearly different library voices)
- [ ] Pauses between lines are inserted as silence; timing files match the existing format, so `npm run fixtures:check` passes
- [ ] `fixtures/make_fixture.py` is deleted; Chatterbox is removed from `fixtures/README.md`, `CLAUDE.md`, `ralph/preflight.sh` and `ralph/ITERATION.md`
- [ ] Existing fixture WAVs, timing files and captured events are **kept unchanged** (not re-rendered)
- [ ] Rendering a 10-line test script works end to end (integration test, real API)
- [ ] `ELEVENLABS_API_KEY` is read only by server-side and script code, never logged or sent to the browser
- [ ] Typecheck passes

### V2-002: New test conversations from the research and offsite scripts
**Description:** As a developer, I need test conversations that exercise research hooks, unanswered questions and dependency-style contradictions.

**Acceptance Criteria:**
- [ ] The fixture schema's moment types add `unanswered_question` and `research_hook`; `expectedLevel` adds `research` (meaning a research-ready card must appear within the window)
- [ ] Two scripts, expanded from the Grok scripts to 2–3 minutes each with natural back-and-forth, speakers Craig and EJ:
  - `research-business-idea`: two people brainstorm a meeting tool. Moments: `research_hook` (market size / who's funded), `research_hook` (top competitors and their gaps), `contradiction` ("smaller teams" vs. "enterprise clinics"). No wake phrase until near the end, where one person asks "Sotto, what did you find on competitors?"
  - `offsite-plan`: planning a short offsite. Moments: `contradiction` (Alex said free Thursday afternoon, then "can't do Thursday at all"), `unanswered_question` ("who's handling food?" never answered), `research_hook` (drive time / venue availability), plus a dependency list request near the end
- [ ] Both rendered with V2-001, captured with `npm run capture`, and committed; `npm run fixtures:check` passes
- [ ] The same two conversations are added as human-readable live scripts in `fixtures/live-scripts/05-…` and `06-…`
- [ ] Typecheck passes

### V2-003: ElevenLabs speech service
**Description:** As the system, I need to turn text into streaming speech quickly, stop it instantly, and know exactly what was spoken.

**Acceptance Criteria:**
- [ ] `server/voice/Speaker.ts` streams text to ElevenLabs over its input-streaming WebSocket (`/v1/text-to-speech/{voice_id}/stream-input`), model `eleven_flash_v2_5`, output `pcm_24000`, and emits audio chunks as they arrive
- [ ] Accepts text incrementally (sentence by sentence) so speech can start before the full text exists
- [ ] Requests alignment data and tracks **which characters have been played**, so after a stop the system knows the exact text spoken so far
- [ ] `cancel()` stops the stream immediately and discards pending audio
- [ ] Voice from `ELEVENLABS_VOICE_ID`, or a documented calm default
- [ ] Unit tests with a mocked ElevenLabs socket: incremental text, cancel mid-stream, spoken-so-far tracking
- [ ] Integration test (real API): one sentence produces non-empty PCM; time to first audio chunk is logged
- [ ] Tests pass
- [ ] Typecheck passes

### V2-004: Browser playback, speaking state and Stop
**Description:** As a user, I want to hear Sotto through the laptop speakers, see when it's speaking, and stop or mute it.

**Acceptance Criteria:**
- [ ] The server forwards speech audio to the browser over `/ws/voice`; the browser plays it gaplessly with Web Audio in the **same page** that captures the mic, so Chrome's echo cancellation can use it as a reference
- [ ] Mic capture keeps `echoCancellation: true` (already set) and does not change other processing settings
- [ ] The browser reports playback started / position / ended to the server; the server exposes a `speaking` state on the event bus
- [ ] UI: a speaking indicator on the stage, a **Stop** button visible while speaking, and a **Mute voice** toggle (muted = answers appear on screen only), saved in session settings
- [ ] Typecheck passes
- [ ] Verify in browser using webapp-testing skill (Playwright: trigger a test utterance from a dev route, see the speaking indicator and Stop button, click Stop, indicator clears)

### V2-005: Spoken answers
**Description:** As a user, when I ask Sotto something, I want a spoken answer that starts fast and is as long as it needs to be.

**Acceptance Criteria:**
- [ ] When a wake question arrives, a short pre-synthesized acknowledgment ("Mm-hm.", "Let me check.", chosen by whether web search is likely) plays within 1.5 s, unless the real answer's first sentence is ready first
- [ ] The answer prompt (`server/prompts/answer.md`) asks for a **spoken** reply of whatever length suits the question in a meeting (no word cap), written to be heard (no markdown, no URLs read aloud), plus on-screen material: a headline of ≤ 90 characters, optional detail, and sources
- [ ] Spoken text streams from Muse Spark into the Speaker sentence by sentence; speech starts before the full answer is generated
- [ ] The answer card appears on screen as before, with headline, detail and sources; the spoken text is available under "transcript of answer"
- [ ] When voice is muted, behavior matches the core build (screen only)
- [ ] `answers.jsonl` records `firstAudioMs` (wake → first answer audio), `ackMs`, the full spoken text, and `spokenSoFar` if interrupted
- [ ] Integration test (events replay): `ask-search` produces an answer whose speech starts, with `firstAudioMs` logged
- [ ] Tests pass
- [ ] Typecheck passes

### V2-006: Self-echo suppression
**Description:** As a user, I don't want Sotto's own voice in the transcript, on the board, or triggering anything.

**Acceptance Criteria:**
- [ ] During playback and for 1.5 s after, any transcribed turn whose text fuzzy-matches (token overlap ≥ 0.6) the text Sotto spoke in that window is marked `selfEcho` and excluded from the transcript, board, observer, wake detection and session files (logged to `timing.jsonl` only)
- [ ] Wake detections whose text matches Sotto's own recent speech (e.g. its hello saying "I'm Sotto") are ignored
- [ ] Turns that don't match Sotto's speech (side talk) stay in the transcript normally but trigger no wake question, observer candidate delivery or research during playback (wake barge-in is handled by V2-007)
- [ ] Pure, unit-tested matcher with cases: exact echo, partial echo, echo with ASR errors, unrelated side talk, side talk that quotes a few words of Sotto
- [ ] Tests pass
- [ ] Typecheck passes

### V2-007: Barge-in and follow-ups
**Description:** As a participant, I want to cut Sotto off by saying its name, and redirect or resume it.

**Acceptance Criteria:**
- [ ] While Sotto is speaking, wake detection runs on **partial** turns; a valid detection immediately cancels speech (Speaker `cancel()` plus a browser flush). Target: under 1.5 s from the wake word's end to silence, measured from the audio position in transcription events and logged to `timing.jsonl`
- [ ] Optional ducking: when a non-echo human speech partial starts during playback, volume drops to 30% until the turn resolves; restored if it isn't a barge-in
- [ ] After the turn becomes final, the command is classified (structured output, Muse Spark or Glimmer): `stop` ("Sotto, stop" / "thanks Sotto") → silence; `new_question` → answer it; `continue` ("Sotto, go on") → resume from `spokenSoFar`
- [ ] The interrupted answer is recorded with `spokenSoFar`, and follow-up context tells the model it was cut off
- [ ] Unit tests on a simulated clock with scripted turns: barge-in on a partial stops playback, each command type, barge-in during the acknowledgment, and a stop followed by a new question
- [ ] Tests pass
- [ ] Typecheck passes

### V2-008: Human checkpoint — live voice test
**Description:** As the team, we need to confirm in a real room that echo cancellation and barge-in work before building on them.

**Acceptance Criteria:**
- [ ] The loop does not start this or any later story until `tasks/checkpoint-voice.md` exists
- [ ] A human runs a 10-minute live session with laptop speakers and at least two people, and records in `tasks/checkpoint-voice.md`: whether Sotto's voice leaked into the transcript, barge-in latency observations, false barge-ins, and PASS or FAIL with notes
- [ ] On FAIL, the notes become the next iteration's fix list before V2-009 starts

**Setup:** keep exactly one Sotto tab open, and start the mic in it. The first tab to connect owns playback, so with two tabs the voice can play from a page that is not capturing the mic, and echo cancellation will not remove it. Click the page once before the first answer: Chrome blocks audio until it has had a click or key press.

### V2-008a: Sotto's speech in the transcript
**Description:** As a user, I want what Sotto said aloud to appear in the transcript as Sotto's own lines, so the record shows both sides of the conversation.

**Acceptance Criteria:**
- [ ] Every utterance Sotto speaks aloud appears as a final transcript entry labeled **Sotto**: answers, briefings, and later the hello. Short acknowledgments ("Mm-hm.", "Let me check.") don't.
- [ ] The text is Sotto's own source text, not the microphone's transcription. If the utterance was interrupted, the entry holds only `spokenSoFar` (what was actually played), marked as interrupted. Muted (screen-only) answers add no entry.
- [ ] The entry is placed when playback started, **on the turn timeline** (the transcription stream's clock, the same one human turns use), not the server clock. Add a test with a live clock offset from the stream timeline (see the V2-008 answer-context bug).
- [ ] Shown in the live transcript with a distinct Sotto style, written to `transcript.md`, and shown in the discussion-history view
- [ ] Never fed back into listening: wake/address classification, barge-in, the self-echo matcher's human side, speaker introductions and the eval's turn matching all ignore Sotto entries
- [ ] The board update sees Sotto entries, labeled as Sotto, so facts it established can land in the notes. The observer does **not** see them, so it never proposes interjections that argue with Sotto's own answers. Answer context may include them.
- [ ] Typecheck passes
- [ ] Verify in browser using webapp-testing skill (dev voice route or a replayed answer: the Sotto line appears with its style; a stopped utterance shows only the heard part)

### V2-008b: Faster response to being addressed
**Description:** As a user, when I say "Sotto, …", I want the acknowledgment to come right after I stop talking, not 4 seconds later.

Measured at the V2-008 retest: name to "Mm-hm" was about 4 s. End-of-speech detection is about 0.5 s, transcription lag about 0.65 s, the Spark address check 2.6–3.3 s (the biggest piece), and the acknowledgment 0.25–0.5 s.

**Acceptance Criteria:**
- [ ] When a partial turn contains the name (the existing word check) and its text has settled (for example, unchanged for about 300 ms, or a few words after the name), the Spark address check starts **on the partial** rather than waiting for the final turn. At most one early check is in flight per turn.
- [ ] When the turn goes final: if the final text only extends the partial that was checked, the early result is reused; otherwise the final is checked again. Mentions never acknowledge. `name_only` arming works as before.
- [ ] The acknowledgment plays as soon as the turn is final and the result is `request`. It **never** plays while the person is still talking.
- [ ] Target: the turn's end-of-speech arrival to the first acknowledgment audio ≤ 1.5 s when the early check has finished. `timing.jsonl` records `address_early` (started, reused or rechecked) and `speechEndToAckMs`.
- [ ] Barge-in during playback is unchanged
- [ ] Offline tests with a fake classifier on the simulated clock: early start, reuse, recheck on a changed final, no acknowledgment while speaking, mention, `name_only`
- [ ] Typecheck passes

### V2-008c: First line while researching
**Description:** As a user, when Sotto has to search before answering, I want it to start talking sensibly right away instead of leaving a long silence after "Let me check."

Measured: acknowledgment to first real sentence was 8–13 s on searched answers, of which only about 2.5 s was the search itself.

**Acceptance Criteria:**
- [ ] For a question likely to need search, the answer pipeline starts a fast **conversation-only first line** in parallel with the searched answer: Muse Spark, no tools, low reasoning. It's grounded only in the conversation and Sotto's general knowledge, and makes **no specific factual claims that need the search** (no figures, dates or quotes). For example: "The 2019 Outback is mostly solid, but there are a couple of known weak spots worth checking. Let me pull the specifics."
- [ ] Spoken after the acknowledgment. The searched answer continues from it without repeating it: it gets the first line as context.
- [ ] If the searched answer's first sentence is ready before the first line, the first line is skipped
- [ ] Both are one utterance for barge-in and `spokenSoFar`: an interruption cancels both and records what was heard across the two
- [ ] The card is unchanged (headline, detail, sources from the searched answer). The spoken transcript of the answer includes both parts.
- [ ] Target: acknowledgment to first real sentence ≤ 4 s on search questions. `answers.jsonl` records `firstLineMs` and the continuation's first audio.
- [ ] Offline tests on the simulated clock (ordering, skip when the answer is first, cancellation across both). An integration probe measures the real timing on a search question.
- [ ] Typecheck passes

### V2-009: Opening hello and introductions
**Description:** As a group, we want Sotto to introduce itself and learn who's here, so it feels like a participant and not a hidden recorder.

**Acceptance Criteria:**
- [ ] On session start (mic or WAV source), Sotto speaks a short hello: who it is, that it's listening, how to address it ("just say 'Sotto'"), and an invitation for everyone to introduce themselves. Text in `server/prompts/hello.md`; not spoken when voice is muted (shown as a card instead)
- [ ] If any active speaker label still has no name 2 minutes after start, one on-screen nudge ("I'd love to know who's here") appears at the next pause; never repeated
- [ ] The hello is excluded from the transcript and board by V2-006
- [ ] Typecheck passes
- [ ] Verify in browser using webapp-testing skill (Playwright: start a session, see the hello card and speaking indicator)

### V2-010: Glimmer client
**Description:** As the system, I need a local model client for fast, private judgment calls.

**Acceptance Criteria:**
- [ ] `server/model/GlimmerClient.ts` calls the OpenAI-compatible endpoint at `GLIMMER_BASE_URL` with `GLIMMER_MODEL`, supports JSON-Schema structured output (or grammar-constrained JSON, whichever the server supports), and validates with zod
- [ ] Health check at session start; if Glimmer is unreachable, the session logs a warning and every Glimmer role falls back to Muse Spark (shown as a status dot "judgment: local / cloud")
- [ ] `ralph/preflight.sh` checks the Glimmer endpoint answers a trivial structured request
- [ ] Integration test (real local server): a structured request returns valid JSON; latency logged
- [ ] Tests pass
- [ ] Typecheck passes

### V2-011: New candidate types
**Description:** As the system, I need to notice unanswered questions and research-worthy moments, not just contradictions and errors.

**Acceptance Criteria:**
- [ ] `candidateTypes` adds `unanswered_question` (asked directly, nobody answered, conversation moved on) and `research_hook` (outside information would clearly help: explicit, like "we should look up competitors", or implicit, like a market-size claim nobody can back up)
- [ ] `dropped_thread` is redefined as an idea or risk raised and abandoned, so it doesn't overlap `unanswered_question`
- [ ] The observer prompt defines both new types with one example each
- [ ] `unanswered_question` candidates go through the interjection policy (on screen only); `research_hook` candidates go to the research gate (V2-012), not the interjection policy
- [ ] Integration test (events replay): `offsite-plan` yields an `unanswered_question` candidate about food; `research-business-idea` yields at least one `research_hook`
- [ ] Tests pass
- [ ] Typecheck passes

### V2-012: Research planner and gate
**Description:** As the system, I want to decide what's worth researching, from explicit hooks and from the conversation itself, without researching everything.

**Acceptance Criteria:**
- [ ] Research ideas come from two places: `research_hook` candidates (V2-011), and a planner that runs every 2 minutes (injected Clock) if at least 3 new final turns arrived. The planner asks Muse Spark for at most 2 concrete, checkable research items given the board and recent turns. Prompt in `server/prompts/research-planner.md`, with examples spanning business, scheduling, cooking and technical topics (no per-topic playbooks)
- [ ] Each idea is `{ id, topic, question, why, sourceTurnIds }`
- [ ] Ideas are deduplicated against earlier ideas and packets (same topic, or a question judged equivalent)
- [ ] The gate (Glimmer, falling back to Spark) scores each idea: useful to this group now, not already known in the conversation, answerable by web search. Ideas above threshold are queued
- [ ] Budget: at most 3 research jobs started per 10 minutes; at most 2 running at once
- [ ] Every idea and gate decision is logged to `research.jsonl`
- [ ] Unit tests: dedupe, budget, gate threshold
- [ ] Tests pass
- [ ] Typecheck passes

### V2-013: Research runner and packets
**Description:** As the system, I want each approved research idea turned into a short, sourced packet ready to present.

**Acceptance Criteria:**
- [ ] The runner calls the Responses API (Muse Spark, `web_search`, and the existing `show_html` tool when a visual helps) and produces `ResearchPacket = { id, ideaId, title, teaser (1–2 sentences), keyPoints: string[], sources: { url, title }[], visual?: { title, path }, createdAtMs, latencyMs }`
- [ ] Packets with zero sources are discarded and logged as `unsourced`
- [ ] Saved to `research/<id>.json` and `research/<id>.md` in the session folder; visuals go to `artifacts/`
- [ ] Runs in its own queue; never blocks answers, board updates or the observer
- [ ] Integration test (events replay): `research-business-idea` produces at least one packet with at least one source before the wake question at the end of the conversation
- [ ] Tests pass
- [ ] Typecheck passes

### V2-014: Research-ready cards
**Description:** As a user, I want to see quietly that research is ready, without being interrupted.

**Acceptance Criteria:**
- [ ] Each packet appears as a compact on-screen card, "Research ready: <title>", with the teaser. Delivered only during a pause (same pause rule as interjections), never spoken
- [ ] Clicking it expands key points, sources and the visual on the stage
- [ ] Research cards respect the frequency control (V2-017) but have their own budget, separate from interjections
- [ ] Typecheck passes
- [ ] Verify in browser using webapp-testing skill (Playwright: replay `research-business-idea` events, see a research card, expand it)

### V2-015: Spoken research briefings
**Description:** As a user, when I ask "Sotto, what did you find?", I want a spoken briefing from the prepared research, with visuals on screen.

**Acceptance Criteria:**
- [ ] The answer agent receives the session's research packets (titles, teasers, key points, sources) as context with every wake question
- [ ] If the question refers to available research ("what did you find on competitors?", "tell us about that research", "show us"), Sotto gives a spoken briefing built from the packet. It may still search to fill gaps, and the packet's card and visual come forward on the stage while it speaks
- [ ] Briefings are interruptible like any answer (V2-007)
- [ ] `answers.jsonl` records which packets were used
- [ ] Integration test (events replay): the wake question in `research-business-idea` produces an answer that uses at least one packet and cites its sources; `firstAudioMs` is lower than the same question without packets (both logged)
- [ ] Tests pass
- [ ] Typecheck passes

### V2-016: Glimmer as the judgment gate
**Description:** As the system, I want candidate interjections scored locally by Glimmer instead of trusting the proposing model's own scores.

**Acceptance Criteria:**
- [ ] The observer (Muse Spark) still proposes candidates. Glimmer then scores each one on four questions: **true** (supported by the transcript), **new** (not already said or on the board), **worth saying** (would a thoughtful participant raise it), **still relevant** (the conversation hasn't moved on). Each gets a 0–1 probability via structured output
- [ ] The policy's score uses the Glimmer scores when present. The mapping is documented in `server/interject/policy.ts` and replaces `relevance/novelty/importance/confidence` from the observer
- [ ] Gate prompt in `server/prompts/gate.md`
- [ ] `candidates.jsonl` records both the observer's own scores and Glimmer's, plus `gate: "glimmer" | "spark-fallback"`
- [ ] `npm run eval -- --gate spark|glimmer` runs either. The report shows recall, precision, false interjects and median gate latency for the chosen gate
- [ ] Tests pass
- [ ] Typecheck passes

### V2-017: Frequency and boldness controls
**Description:** As a user, I want to control how often Sotto contributes and how sure it must be, separately.

**Acceptance Criteria:**
- [ ] `chattiness` is replaced by two settings:
  - **frequency**: `rare | normal | often` → cooldown 5 / 3 / 1.5 min and budget 2 / 3 / 5 per 15 min
  - **boldness**: `cautious | normal | bold` → glow and interject thresholds equal to today's quiet / normal / active, and allowed types: cautious = contradiction and verified factual_error only; normal and bold = all
- [ ] `normal/normal` reproduces today's `normal` chattiness exactly (unit test)
- [ ] Two compact controls replace the chattiness control in the UI, saved in session settings
- [ ] The eval accepts `--frequency` and `--boldness`; `--chattiness` is removed and old reports still render
- [ ] Unit tests for the mapping
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Verify in browser using webapp-testing skill (Playwright screenshot of both controls)

### V2-018: End-of-session digest
**Description:** As a group, we want a record of what Sotto did and almost did, plus the research and open items.

**Acceptance Criteria:**
- [ ] On Stop, `digest.md` is written to the session folder with these sections:
  1. Summary (from the board)
  2. Decisions
  3. Open questions
  4. What Sotto said (answers and briefings, with whether each was interrupted)
  5. On-screen interjections
  6. What Sotto almost said: the top 5 suppressed candidates by score, each with its reason (below threshold, cooldown, stale, …)
  7. Research produced (titles, teasers, sources)
- [ ] The Backstage view for a past discussion shows the digest
- [ ] "Sotto, wrap us up" during a session speaks a short summary built from the same sections (decisions, open questions, research), interruptible as usual
- [ ] Integration test (events replay of `offsite-plan`): `digest.md` exists with all seven section headings and at least one suppressed candidate with a reason
- [ ] Tests pass
- [ ] Typecheck passes
- [ ] Verify in browser using webapp-testing skill (Playwright: Backstage shows the digest for a replayed session)

### V2-019: Eval update
**Description:** As a developer, I want the eval to cover the new conversations, research, and the Glimmer gate.

**Acceptance Criteria:**
- [ ] `npm run eval` includes `research-business-idea` and `offsite-plan`
- [ ] Research moments (`expectedLevel: research`) count as caught if a research card matching the moment (judge call) is delivered within the window
- [ ] The report adds research recall, research packets per conversation, unsourced packet count, and gate type
- [ ] Gates stay as before (recall ≥ 0.7 over non-research moments, zero false interjects on `brainstorm` and `no-wake`, 100% deliveries during pauses), plus research recall ≥ 0.5
- [ ] Cost estimate includes research calls; Glimmer calls are counted at $0
- [ ] Scoring changes are unit-tested
- [ ] Tests pass
- [ ] Typecheck passes

### V2-020: Tune with the Glimmer gate
**Description:** As the team, we want the Glimmer-gated system to meet targets before the demo.

**Acceptance Criteria:**
- [ ] Run `npm run eval -- --gate glimmer`; iterate only on `server/prompts/gate.md`, `server/prompts/observer.md`, `server/prompts/research-planner.md` and gate thresholds until all V2-019 gates pass
- [ ] Never edit fixtures, moment annotations, the judge prompt, or scoring code to reach targets
- [ ] Also run `--gate spark` once with the final prompts and commit both reports; the decision log (`tasks/decisions.md`) records which gate is the default and why
- [ ] If Glimmer can't reach the gates after 5 eval rounds, Spark stays the default gate, Glimmer remains selectable, and the gap is written in notes (the story still passes if the Spark report passes)
- [ ] Tests pass
- [ ] Typecheck passes

### V2-021: End-to-end update
**Description:** As a developer, I want the end-to-end check to cover voice and research.

**Acceptance Criteria:**
- [ ] `npm run e2e` adds `research-business-idea` (WAV, real transcription): at least one research card before the wake question, a spoken briefing that uses a packet, and `firstAudioMs` and `ackMs` reported
- [ ] Speech runs in a headless mode where audio goes to a null sink, but timing and spoken-so-far tracking still work
- [ ] Prints per-fixture: ack latency, first-audio latency, research packets, and estimated cost (ElevenLabs characters included)
- [ ] Exits non-zero on failure
- [ ] Typecheck passes

## Functional Requirements

- FR-V1: Sotto speaks only when addressed by the wake word, for "wrap us up", and for its opening hello. All unprompted contributions (interjections, research-ready cards, the introduction nudge) are on screen only.
- FR-V2: Spoken answers have no length cap. The prompt asks for the length that suits the question, and interruption is the control.
- FR-V3: Saying "Sotto" while it speaks stops it; after a stop, Sotto handles stop / new question / continue.
- FR-V4: Sotto's own voice never reaches the transcript, board, observer, research planner, or wake detection. Side talk during playback is kept in the transcript but triggers nothing.
- FR-V5: Speech uses ElevenLabs streaming (Flash model) and starts before the full answer is generated. A short acknowledgment plays if the answer isn't ready within 1.5 s.
- FR-V6: Background research is gated (Glimmer, falling back to Spark), budgeted (3 per 10 min, 2 at once), and must be sourced; research packets are saved per session.
- FR-V7: Glimmer runs locally behind an OpenAI-compatible endpoint. If it's unavailable, Spark takes over every Glimmer role and the UI shows it.
- FR-V8: `ELEVENLABS_API_KEY` and `MODEL_API_KEY` stay server-side.
- FR-V9: Each session writes `digest.md` on Stop and `research.jsonl` plus `research/` during the session, in addition to the core session files.

## Non-Goals (Out of Scope)

- Spoken unprompted interjections (on-screen only for now)
- Spoken "not useful" feedback
- Nightly self-review of thresholds
- Rolling narrative summary (the board serves as memory for sessions of this length)
- Per-topic research playbooks
- Avatar or animated face (the speaking indicator is enough)
- Jev or any non-Meta judgment model
- Native app, system/meeting audio capture (see `private/PRODUCTIZE.md`)
- Re-rendering existing test conversations

## Technical Considerations

- **Echo cancellation:** Chrome cancels audio the page itself plays from the mic signal, so speech must play through Web Audio in the same page that captures the mic, not a separate tab or app. V2-006's text matcher catches whatever leaks through. The real-room behavior is verified at the V2-008 checkpoint.
- **Latency budget for a spoken answer:** transcription (~0.6–0.8 s to a final turn) → Muse Spark (a reasoning model, so it thinks before writing; acknowledgment covers this) → first sentence → ElevenLabs Flash (first audio in a few hundred ms) → playback. Log each stage to `timing.jsonl`.
- **Barge-in latency:** wake detection on partials arrives ~0.6–0.8 s after the word is spoken (captured timings), plus cancel and flush. ~1–1.5 s is realistic.
- **Glimmer on this Mac:** M1 Max, 32 GB. The 4-bit model needs ~20 GB of RAM, so close heavy apps during sessions. Glimmer's gate calls are short structured outputs; measure latency in V2-010 and keep the gate off the critical path of spoken answers.
- **ElevenLabs output** is `pcm_24000`, the same format as the transcription input, so fixtures and playback share one audio format.
- **Cost:** ElevenLabs bills by characters; long answers cost more. Log characters per session.
- **Hackathon:** submissions due Nov 4, 9:00 PM ET. The README must state what was built during the hackathon, and the demo video is 3 minutes.

## Success Metrics

- Acknowledgment ≤ 1.5 s after a wake question in ≥ 90% of cases; first answer audio median ≤ 4 s without search
- Barge-in to silence median ≤ 1.5 s in the live checkpoint
- Zero self-echo turns in the transcript during the live checkpoint
- `research-business-idea`: research card on screen before the wake question; the briefing uses the packet
- Eval gates pass with the default gate; Glimmer-gate results within 0.1 recall of Spark
- In the live demo, the group interrupts and redirects Sotto at least once, and it handles it cleanly

## Open Questions

1. Does Chrome's echo cancellation work well enough with laptop speakers in a real room? (V2-008 decides; fallback ideas: a speakerphone with hardware echo cancellation, or stricter text filtering.)
2. Which Glimmer serving path works on this Mac (llama.cpp vs. Ollama), and how fast is a gate call?
3. Which ElevenLabs voice fits Sotto? (Pick by ear after V2-004.)
4. Should research cards ever be spoken ("I found something on competitors when you're ready")? Not in v2; revisit after the demo.
