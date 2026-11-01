# PRD: Sotto v3, speaking up when the room needs it

> Builds on [`prd-sotto-v2.md`](prd-sotto-v2.md), which is complete (all 24 stories pass, 1,175 tests,
> `npm run e2e` 55/55). Where v3 and v2 disagree, v3 wins. The core and v2 PRDs stay valid everywhere else.

## Introduction

A meeting summary is a commodity, and "ask the AI" is a chat box. What makes Sotto worth submitting is
that it **takes part in the conversation**, out loud, without being asked. That only works if it speaks
when the group actually wants an outsider to.

The v2 plan had unprompted contributions be **corrections**: contradictions, factual errors, untested
assumptions. Those are the hardest kind to make welcome. The group usually knows its own conflicts,
leaves some unresolved on purpose, and Sotto can't read politics or mood. A correct but tone-deaf
interjection gets Sotto muted.

v3 makes Sotto speak up when **the room has signalled a need, and Sotto can meet it**:

- **Wondering aloud:** "I wonder how long the drive is", "does anyone know what they charge?",
  "we'd need to check if the venue's free". Sotto looks it up and gives the answer at the next real
  pause, with sources on screen.
- **Something worth offering:** a research finding, a rundown. Sotto **asks first** ("I've got a quick
  rundown on competitors if you want it") and goes on only if someone says yes.
- **A stall:** the group is circling. Sotto offers ideas, also asked first.
- **A decision about to close with an unexamined risk:** Sotto asks one specific question ("Before you
  lock in six gardens: what if only one signs up?") rather than saying anyone is wrong.

And once someone is talking with Sotto, the conversation stays open: follow-ups need no wake word, and
Sotto notices when the humans have gone back to talking among themselves.

Answering what the room wondered is socially cheap: Sotto fills a gap they named instead of judging
anyone. It tolerates latency: an open question stays open for minutes, so an answer 20–40 s later is
like a colleague quietly looking it up. And it can be checked: answers are sourced, and no sources
means Sotto stays quiet.

**Corrections move to the screen**, where they cost nothing to ignore.

## What v3 supersedes in v2

| v2 | v3 |
|---|---|
| FR-V1: Sotto speaks only when addressed, for "wrap us up", and for its hello; all unprompted contributions are on screen | Sotto may also speak **unprompted** to answer what the room wondered aloud (V3-004), to make an offer it asked first about (V3-005, V3-007), and to ask one probing question at a decision point (V3-013). Corrections stay on screen, phrased as questions (V3-008, V3-013) |
| V2-008 / US-017: every question to Sotto needs the wake word | After an answer, follow-ups need no wake word until the humans resume (V3-014) |
| Non-Goal "Spoken unprompted interjections" | In scope, in the forms above |
| V2-014: research-ready cards are "never spoken" | A research answer to an open question is spoken (V3-004); longer findings are offered aloud (V3-005). The card stays |
| V2-012: research ideas come from hooks and a planner that runs every 2 minutes | Open questions also get a **fast path** that starts research at once (V3-003). The planner stays |
| V2-016/V2-020: `DEFAULT_GATE_MODE = glimmer` for all candidates | **Spark gates interjection candidates; Glimmer gates research ideas** (V3-001) |

## Why the gate splits (measured overnight, 2026-11-01)

- Glimmer's gate takes **24–34 s per candidate**, with a median of 23.7 s (V2-020). Planted interjection
  windows are 12–29 s wide. In the real-time e2e (V2-021), planted moments were delivered **31.9 s and
  50.1 s after their deadline**. The max-speed eval hides this, because simulated time stands still
  during a model call.
- With the same prompts, Spark beat Glimmer on moment recall (9/9 vs 7/9) and precision (5/6 vs 4/5),
  while Glimmer won research recall (2/3 vs 1/3). Glimmer also suppressed two verified moments.
- For research, wondering to answer currently takes about 37–46 s: the Glimmer gate 16–21 s, then
  research 16–21 s. Speed matters less there, and Glimmer keeps a real role for the open-weight bonus.

## Goals

- Sotto speaks up unprompted, and is **welcome**: the live checkpoint asks "would you leave it on?"
- The main form is answering what the room wondered aloud: sourced, one or two sentences, at a real
  pause, before anyone else answers, and never once the question is settled
- Longer contributions are offered and wait for a yes
- No unprompted speech on conversations that never asked for it: 0 on `brainstorm`, `no-wake` and a
  new rhetorical-questions fixture
- Corrections remain available on screen, ignorable at zero cost
- The group can turn Sotto down (or up) by talking to it, and it listens for the rest of the session
- A conversation with Sotto flows: follow-ups without the wake word, and no answer to a question meant
  for a person
- At a decision about to close, Sotto may ask one specific question, never generic coaching

## Prerequisites (human)

- **Glimmer served locally** (done; Ollama, `.env`). It's still needed for research gating.
- **A second person for the V3-011 live checkpoint**, plus the deferred two-person checks from V2-008
  (side talk and crosstalk). If no one is available, a phone playing a voice can stand in.

## User Stories

### V3-001: Gate per path (Spark for interjections, Glimmer for research)
**Description:** As the system, I want each judgment made by the model that can make it in time.

**Acceptance Criteria:**
- [ ] Interjection candidates (`CandidateGate`) are gated by Muse Spark by default; research ideas (`ResearchGate`) stay on Glimmer, falling back to Spark. `--gate` on the eval and e2e can still force either path, for A/B runs
- [ ] `tasks/decisions.md` records the split and the measured basis above
- [ ] `npm run e2e`: the planted moments in `moment-contradiction` and `research-business-idea` that were late overnight are delivered inside their windows (report the delivery time vs. the deadline for each)
- [ ] The eval report shows median gate latency per path
- [ ] Tests pass
- [ ] Typecheck passes

### V3-002: Noticing what the room is wondering
**Description:** As the system, I need to tell a real open question that Sotto can answer from a rhetorical one, from one that's been answered, and from one only the group can answer.

**Acceptance Criteria:**
- [ ] A new candidate type, `open_question`: asked or wondered aloud to the room (not to Sotto), not answered in the turns since, and **answerable by lookup** (the web, or later the knowledge folder in V3-009). Examples: drive time, prices, opening hours, market size, a definition, a date. Not: "who's handling food?" (only the group knows); "who even uses fax anymore?" (rhetorical); "should we do it?" (a decision)
- [ ] `unanswered_question` keeps the questions only the group can answer (on screen only). `research_hook` keeps "we should look into X" requests, which go to the research gate as today
- [ ] The candidate carries `question` (cleaned), `askedBy` and `sourceTurnId`
- [ ] The observer prompt defines `open_question` with positive and negative examples, including rhetorical and decision questions
- [ ] A new fixture, `rhetorical-questions` (2–3 min, Craig and EJ): at least four rhetorical or decision questions, one question asked and answered by a person within two turns, and one genuine open question (positive control). Rendered, captured and added to the eval set
- [ ] Integration test (events replay): `offsite-plan`'s drive-time question yields an `open_question`. `rhetorical-questions` yields exactly one, the positive control
- [ ] Tests pass
- [ ] Typecheck passes

### V3-003: Fast path from question to answer
**Description:** As the system, when the room wonders something Sotto can look up, I want the answer ready while it still matters.

**Acceptance Criteria:**
- [ ] An `open_question` skips the 2-minute planner and starts research immediately. It's gated by Spark ("answerable by search, useful now?", one quick call) and counts against the research budget (V2-012). Duplicates of earlier ideas and packets are dropped, as today
- [ ] The research runner produces a packet with a new field, `spokenAnswer`: one or two sentences that answer the question directly, written to be heard (numbers rounded sensibly, no URLs), grounded in the sources. Packets with zero sources produce no `spokenAnswer`
- [ ] Target: median ≤ 25 s from the question turn going final to the packet being ready, measured in `research.jsonl` (`questionToPacketMs`) on the e2e fixtures
- [ ] Unit tests: fast path vs planner path, budget shared, dedupe
- [ ] Tests pass
- [ ] Typecheck passes

### V3-004: Speaking the answer to the room
**Description:** As a user, when we wondered something aloud and Sotto found the answer, I want it to tell us briefly, at a natural moment, without talking over anyone.

**Acceptance Criteria:**
- [ ] When a `spokenAnswer` is ready, Sotto waits for a **real pause**: no open turn and at least `SPEAK_PAUSE_MS` (default 1,500) since the last `speechEnd`. It then speaks the answer, attributed to whoever asked: "EJ, on the drive time: about two hours fifteen from the city."
- [ ] **Still-open check**, right before speaking: one quick Spark call over the turns since the question ("has a person answered it, or has the group clearly moved on and closed it?"). If closed, the answer becomes a card only. Logged with its result
- [ ] **Never over anyone:** if a `speechStart` arrives after the decision to speak but before the first audio, the utterance is cancelled and retried at the next real pause. Barge-in (V2-007) handles anyone who starts once it's speaking
- [ ] **Expiry:** an answer not spoken within 90 s of being ready, or after 6 more final turns, becomes a card only
- [ ] The research card still appears, with sources. The spoken line appears in the transcript as Sotto's (V2-008a)
- [ ] Counts against the frequency budget and cooldown (V2-017). Muted voice means card only. Boldness `cautious` means card only
- [ ] `timing.jsonl` records `spoken_contribution` with `kind: "answer"`, `questionToSpeechMs`, `pauseWaitMs`, `stillOpen`, `cancelledForSpeech` and whether it was barged-in
- [ ] Offline tests on the simulated clock: waits for a real pause; cancels when speech starts before audio; still-open closed → card only; expiry; budget; muted; cautious
- [ ] Typecheck passes
- [ ] Verify in browser using webapp-testing skill (replay `offsite-plan` with the null audio sink: the spoken line appears in the transcript and the card shows sources)

### V3-005: Asking first for anything longer
**Description:** As a user, I want Sotto to offer longer contributions and let us decide.

**Acceptance Criteria:**
- [ ] A packet from the planner or a `research_hook` (not an open question with a short answer) is **offered** aloud at a real pause, in one sentence: "I've got a quick rundown on competitors if you want it." The card appears at the same time
- [ ] For 10 s after the offer, the next final turn from anyone is classified by Spark as `yes` ("sure", "go ahead", "yeah let's hear it"), `no` ("not now", "later") or `unrelated`, with **no wake word needed**. `yes` → the V2-015 spoken briefing from that packet. `no` or `unrelated` → nothing more; the card stays
- [ ] At most one open offer at a time; offers count against the frequency budget
- [ ] Logged as `spoken_contribution` with `kind: "offer"` and its outcome
- [ ] Offline tests: yes, no, unrelated, timeout, a second offer while one is open
- [ ] Typecheck passes

### V3-006: The room can turn Sotto down, or up
**Description:** As a user, I want to steer how forward Sotto is just by talking to it.

**Acceptance Criteria:**
- [ ] During, or within 15 s after, an unprompted contribution, an addressed "stop", "not now", "too much" or similar (V2-007 command classification gains `quieter`) stops speech and lowers **frequency** one step for the rest of the session. "Sotto, you can jump in more" (`louder`) raises it one step
- [ ] The header controls reflect the change, and it's saved in session settings. A short on-screen note says what changed ("Sotto will speak up less")
- [ ] A barge-in "stop" during an unprompted contribution counts as `quieter`; during an answer to a question it doesn't
- [ ] Logged in `timing.jsonl`
- [ ] Offline tests
- [ ] Typecheck passes

### V3-007: Offering ideas when the group is stuck
**Description:** As a user, when we're going around in circles, I want Sotto to offer a few ideas, only if we want them.

**Acceptance Criteria:**
- [ ] A new candidate type, `stall`: the same question or problem revisited across at least 3 turns without progress, or explicit "I don't know"/"we're stuck" with no new idea following. Defined in the observer prompt with negative examples (a normal pause, someone thinking aloud once)
- [ ] A stall is offered, never volunteered: "Want a few ideas on the name?" Same ask-first flow as V3-005. `yes` → up to three short ideas, spoken in about 20 s, plus a card
- [ ] At most one stall offer per 10 minutes
- [ ] Integration test (events replay) on a fixture with a planted stall (add one to `rhetorical-questions` or a new fixture): the stall is detected and offered. `brainstorm` produces no stall offer
- [ ] Tests pass
- [ ] Typecheck passes

### V3-008: Corrections go on screen
**Description:** As a user, I want Sotto's corrections available but never forced on the room.

**Acceptance Criteria:**
- [ ] `contradiction`, `factual_error`, `untested_assumption`, `dropped_thread` and `unanswered_question` are delivered as cards only, in every mode, with two exceptions: a probing question at a decision point (V3-013), and a **verified** `factual_error` at boldness `bold`, which may be spoken in one sentence under the V3-004 pause, still-open and expiry rules
- [ ] The interjection eval gates are unchanged (they measure deliveries, not speech)
- [ ] Tests pass
- [ ] Typecheck passes

### V3-009: The knowledge folder (stretch)
**Description:** As a user, I want Sotto to answer from our own files, not just the web.

**Acceptance Criteria:**
- [ ] A folder (`KNOWLEDGE_DIR`, default `knowledge/`, git-ignored) of `.md`, `.txt` and `.csv` files is indexed at session start (plain-text search is fine; no embeddings required)
- [ ] The research runner gets a `search_knowledge` tool next to `web_search`, and cites files as sources (`file: customers.csv`)
- [ ] `fixtures/knowledge-demo/` holds a small fictional company (a customer list with renewal dates, a price sheet, notes), clearly labelled fictional, for the demo and tests
- [ ] Integration test: an open question about a customer's renewal date is answered from the folder with a file citation
- [ ] Typecheck passes

### V3-010: Eval for unprompted speech
**Description:** As the developer, I need to measure unprompted speech the way the interjection eval measures cards.

**Acceptance Criteria:**
- [ ] Fixture moments gain `expectedLevel: "speak"` for open questions Sotto should answer aloud (`offsite-plan` drive time; others where natural; the positive control in `rhetorical-questions`)
- [ ] The eval scores spoken contributions: a moment is **caught** if Sotto speaks an answer the judge matches to it, at a real pause, before any human answered it, and within its window. **False speech** is any unprompted utterance on `brainstorm`, `no-wake` or `rhetorical-questions` that matches no moment
- [ ] Gates: speak recall ≥ 0.6; **zero** false speech on those three fixtures; 100% of spoken contributions at a real pause. Existing gates unchanged
- [ ] The report adds a spoken-contributions table: moment, text, `questionToSpeechMs`, pause wait, still-open result
- [ ] The e2e (real time) runs the same scoring on its fixtures, since only real time shows real latency
- [ ] Typecheck passes

### V3-011: HUMAN CHECKPOINT, live test of speaking up
**Description:** As the team, we need to hear whether Sotto speaking up unprompted is welcome before tuning it further.

**Acceptance Criteria:**
- [ ] The loop does not start this or any later story until `tasks/checkpoint-speaking.md` exists
- [ ] A human runs a live session of about 10 minutes, with two people if possible (a phone voice as a stand-in otherwise): wonder aloud about things that can be looked up, ask rhetorical questions, answer a question yourselves before Sotto does, settle a decision that has an obvious risk and one that doesn't, ask Sotto something and follow up twice without its name, then go back to talking to each other, and tell Sotto "not now" once. Also cover the deferred V2-008 checks (side talk during Sotto's speech, two people talking at once). Offers (V3-005) are built after this checkpoint and aren't tested here
- [ ] `tasks/checkpoint-speaking.md` records, for each unprompted contribution: what was said, whether it was welcome, its timing, and any false or late ones, then **"Would you leave it on?"** and `RESULT: PASS` or `RESULT: FAIL` with notes
- [ ] On FAIL: fix the listed problems in this iteration, commit, rename the file to `tasks/checkpoint-speaking-fail-<n>.md` (so the loop stops again for a retest), and leave `passes` false with notes. On PASS: set `passes` true and summarize

### V3-012: The hello sets expectations
**Description:** As a user, I want Sotto to tell us up front that it may chime in, and how to stop it.

**Acceptance Criteria:**
- [ ] `server/prompts/hello.md` adds, in one sentence, that Sotto may chime in when the group wonders something it can look up, and that "Sotto, not now" quiets it
- [ ] The hello stays under about 20 s spoken (measured from a real render)
- [ ] Typecheck passes

### V3-013: Probing questions at decision points
**Description:** As a user, when we're about to lock in a decision with an unexamined risk, I want Sotto to ask one specific question, the way a good colleague would, instead of telling us we're wrong.

**Acceptance Criteria:**
- [ ] **Corrections become questions everywhere.** Card text for `contradiction`, `untested_assumption` and `dropped_thread` is phrased as a specific question tied to what was said ("Before six gardens: what if only one signs up?"), not an assertion. The observer prompt gives good and bad examples; generic coach-speak ("Have you considered your audience?") is a named bad example
- [ ] A new signal, `decision_closing`: the group is settling something ("OK, let's go with six gardens", "so we're agreed on Saturday", "let's lock that in"). The observer flags it on the final turn
- [ ] **Spoken only at a decision point:** if a `decision_closing` turn relates to an open `contradiction` or `untested_assumption` candidate that passed the gate, Sotto speaks **one** probing question at the next real pause (V3-004 rules: real pause, never over anyone, still-open check, expiry 20 s). No relevant candidate means nothing is spoken
- [ ] At most one spoken probing question per 10 minutes. Counts against the frequency budget. Boldness `cautious` or muted means card only. `quieter` from the room (V3-006) applies
- [ ] Logged as `spoken_contribution` with `kind: "probe"`, the decision turn and the candidate
- [ ] Fixture work: add planted decision moments to existing or new fixtures, some with a real unexamined risk (a probing question expected, `expectedLevel: "speak"`) and some without (nothing expected). Integration test (events replay): the risky decision gets a question; the safe decision and `brainstorm` get none
- [ ] Tests pass
- [ ] Typecheck passes

### V3-014: Follow-ups without the wake word
**Description:** As a user, once I've asked Sotto something and it has answered, I want to keep talking to it ("why's that?", "and on Sunday?") without saying "Sotto" each time, and I want it to notice when we've gone back to talking among ourselves.

**Acceptance Criteria:**
- [ ] After Sotto finishes speaking an answer (addressed, unprompted, or an accepted offer), a **follow-up window** opens. While it's open, "Sotto is listening" stays visible, in a distinct "in conversation" style
- [ ] Every final turn in the window is classified by Spark, with Sotto's last answer and the recent turns as context: `to_sotto` (a follow-up: "why's that?", "how much would that cost?", "and on Sunday?", "where did you get that?"), `to_room` (the humans have resumed: "OK EJ, what do you think?", a new topic among themselves), or `closing` ("great, thanks", "got it"). This can share code with the V2-008 address classifier and the V2-007 command classifier
- [ ] `to_sotto` → answered like a wake question (acknowledgment, spoken answer, card), and the window stays open from the end of that answer. `to_room` or `closing` → the window closes; nothing is said
- [ ] **When unsure, close.** An ambiguous turn is treated as `to_room`. Answering a question meant for a person is worse than making the user say "Sotto" again
- [ ] The window also closes after 20 s with no final turn, or after 2 consecutive turns between humans. Any person may follow up, not only the original asker
- [ ] Barge-in during an answer works as today. A barge-in `new_question` counts as `to_sotto`
- [ ] Logged in `timing.jsonl`: `followup_window` opened/closed with the reason, and each classification with `kind` and `latencyMs`
- [ ] Offline tests on the simulated clock: a follow-up answered, humans resuming closes it, "thanks" closes it, timeout, two human turns, ambiguous → closed
- [ ] A new fixture, `followups` (2–3 min, Craig and EJ): a wake question, two natural follow-ups without the name, then the pair resume among themselves with a question addressed to each other by name (which must **not** be answered), then later a fresh wake question. Rendered, captured, and in the eval set. The eval counts answered-when-not-addressed as a false answer, gate 0
- [ ] Typecheck passes
- [ ] Verify in browser using webapp-testing skill (replay `followups`: the in-conversation indicator appears after the answer and clears when the humans resume)

## Build order

The loop builds in priority order, not story-number order, so Sotto speaking up reaches a live test as
early as possible:

1. V3-001 gate per path
2. V3-002 noticing open questions
3. V3-003 fast path to an answer
4. V3-004 speaking the answer
5. V3-014 follow-ups without the wake word
6. V3-013 probing questions at decision points
7. V3-008 corrections on screen
8. V3-010 eval for unprompted speech
9. **V3-011 live checkpoint** (the loop stops here)
10. V3-005 asking first, V3-006 steering by voice, V3-012 the hello, V3-007 stall ideas,
    V3-009 knowledge folder (stretch)

## Functional Requirements

- FR-V3-1: Unprompted speech happens only (a) to answer an `open_question` with a sourced `spokenAnswer`, (b) as a one-sentence offer (research, ideas) that continues only on `yes`, (c) as one probing question at a decision point, or (d) a verified factual error at boldness `bold`
- FR-V3-7: After Sotto answers, follow-ups need no wake word until the humans resume. When unsure whether it's being addressed, Sotto stays quiet
- FR-V3-2: Unprompted speech happens only in a real pause (`SPEAK_PAUSE_MS`), never starts over a person, and is cancelled by barge-in
- FR-V3-3: Before any unprompted speech, a still-open check confirms the moment hasn't passed
- FR-V3-4: Every unprompted contribution is also a card with sources, and Sotto's line in the transcript
- FR-V3-5: Frequency, boldness and mute govern unprompted speech. The room can lower or raise frequency by voice
- FR-V3-6: Spark makes time-critical judgments (interjections, still-open checks, offer replies); Glimmer judges research ideas

## Non-Goals

- Spoken corrections at default settings
- Reading mood, emotion or politics beyond the explicit signals above
- CRM, financial-system or email integrations; the knowledge folder is the stand-in
- Sotto initiating topics nobody raised

## Technical Considerations

- **Latency budget for an open-question answer:** question final → Spark gate (about 2–3 s) → research (about 16–21 s) → real pause (variable) → still-open check (about 2 s) → speech. The V3-003 target puts the answer ready around 25 s. Spoken around 30–40 s after the question is fine for this kind of contribution
- The max-speed eval can't see latency (simulated time stops during model calls); the e2e can. Every latency claim comes from the e2e or live logs
- Reuse what exists: `InterjectionPolicy` and delivery for pause logic, `VoiceHub` and `SpokenAnswer` for speech, `BargeIn` for interruptions, the V2-008 address/command classifier for offer replies, `ResearchManager` for queueing and budget
- Research quality: the overnight run produced a packet about *AGM* software for a question about meeting assistants. The `spokenAnswer` must answer the question asked; the V3-003 integration test checks relevance with the judge

## Success Metrics

- V3-011 live checkpoint: "would you leave it on?" yes
- Eval: speak recall ≥ 0.6, zero false speech, 100% at real pauses, zero answers to turns meant for a
  person (`followups`)
- e2e: median question → spoken answer ≤ 40 s on fixtures with open questions
- Demo: one clean moment where the room wonders aloud and Sotto quietly supplies a sourced answer

## Open Questions

- Should a stall offer (V3-007) also be allowed at boldness `normal`, or only at `bold`?
- Is attributing the answer by name ("EJ, on the drive time…") always welcome, or sometimes awkward?
- Is 20 s the right follow-up window, or should it track the conversation's pace?
