# PRD: Sotto v3, speaking up when the room needs it

> Builds on [`prd-sotto-v2.md`](prd-sotto-v2.md), which is complete (all 24 stories pass, 1,175 tests,
> `npm run e2e` 55/55). Where v3 and v2 disagree, v3 wins. The core and v2 PRDs stay valid everywhere else.
>
> **Revised 2026-11-01** after a design review, before any v3 story was built. The review is summarized
> in [`decisions.md`](decisions.md) under that date. In short: open questions are noticed per turn rather
> than through the observer, unprompted speech yields to any human voice, Sotto claims a question out
> loud before it goes looking, decisions get a read-back, and the off switch is built before the live test.

## Introduction

A meeting summary is a commodity, and "ask the AI" is a chat box. What makes Sotto worth submitting is
that it **takes part in the conversation**, out loud, without being asked. That only works if it speaks
when the group actually wants an outsider to.

The v2 plan had unprompted contributions be **corrections**: contradictions, factual errors, untested
assumptions. Those are the hardest kind to make welcome. The group usually knows its own conflicts,
leaves some unresolved on purpose, and Sotto can't read politics or mood. A correct but tone-deaf
interjection gets Sotto muted.

What makes an interjection welcome is rarely whether it is correct. It is whether the speaker has a
**licensed role** in the room and whether they **yield** when they collide with someone. Three roles have
that license in any meeting: the person who says "I'll look that up", the scribe who reads back what
was just decided, and the person who stops talking the instant somebody else starts. The outsider who
gets muted is the expert with no role who holds the floor. v3 gives Sotto those three roles and
nothing else:

- **Wondering aloud:** "I wonder how long the drive is", "does anyone know what they charge?",
  "we'd need to check if the venue's free". Sotto says "I'll check the drive time" at the first gap,
  looks it up, and gives the answer at the next real pause, with sources on screen.
- **A decision closing:** "OK, let's go with six gardens." Sotto reads it back in one line, the way a
  note-taker does, and if the group itself raised a risk against it and never settled it, attaches
  that in the group's own words: "Got it: six gardens. EJ's question about only one signing up, did
  that get settled?"
- **Yielding:** anything Sotto says unprompted stops the moment a person starts talking, no wake
  word needed. Sotto was not asked, so it has the lowest floor rights in the room.
- **Something worth offering:** a research finding, a rundown. Sotto says it exists ("There's a
  rundown on competitors on screen if you want it") and goes on only if someone says yes. Nobody
  owes it an answer.
- **A stall:** the group is circling. Sotto offers ideas, also ask-first.

And once someone is talking with Sotto, the conversation stays open: follow-ups need no wake word, and
Sotto notices when the humans have gone back to talking among themselves.

Answering what the room wondered is socially cheap: Sotto fills a gap they named instead of judging
anyone. Claiming the question out loud makes the wait expected ("a colleague is looking it up") rather
than an interruption 35 s later, and stops phones coming out. And it can be checked: answers are
sourced, and no sources means Sotto says so briefly and stays quiet.

**Corrections of Sotto's own stay on the screen**, where they cost nothing to ignore. The only
correction-shaped thing Sotto says aloud is the group's own unsettled question, quoted back to them.

## What v3 supersedes in v2

| v2 | v3 |
|---|---|
| FR-V1: Sotto speaks only when addressed, for "wrap us up", and for its hello; all unprompted contributions are on screen | Sotto may also speak **unprompted** to claim and answer what the room wondered aloud (V3-015, V3-004), to read back a closing decision and attach the group's own open question to it (V3-013), to make an offer (V3-005, V3-007), and, at boldness `bold` only, one verified factual error. Sotto's own corrections stay on screen (V3-008) |
| V2-007: speech is cut off by the wake word | Unprompted speech is cut off by **any** human voice (V3-004). Answers to direct questions keep the wake-word rule |
| V2-008 / US-017: every question to Sotto needs the wake word | After an answer, follow-ups need no wake word until the humans resume (V3-014) |
| Non-Goal "Spoken unprompted interjections" | In scope, in the forms above |
| V2-014: research-ready cards are "never spoken" | A research answer to an open question is spoken (V3-004); longer findings are offered aloud (V3-005). The card stays |
| V2-012: research ideas come from hooks and a planner that runs every 2 minutes; the observer is the only thing that notices | Open questions are noticed **per final turn** by a classifier (V3-002), never through the observer, and start research at once (V3-003). The planner and the observer's `research_hook` stay |
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

## Why open questions bypass the observer (2026-11-01 review)

The observer only looks after a board update, which PRD US-009 fires every 4 final turns: a median
**12.6 s** after the turn that matters. Put that in front of a 2–3 s gate and a 16–21 s search and the
answer is ready 31–37 s after the question, before any pause is waited for, and V3-003's 25 s target
cannot be hit by any prompt. So an open question is noticed the way an address is (V2-008): a cheap
lexical filter on the final turn, then one Spark call. The observer never sees `open_question`.

## Goals

- Sotto speaks up unprompted, and is **welcome**: the live checkpoint asks "would you leave it on?"
- The main form is claiming and answering what the room wondered aloud: "I'll check" within seconds,
  then a sourced one- or two-sentence answer at a real pause, before the room moves on
- Nothing Sotto says unprompted is ever said over a person: it yields to any voice
- Longer contributions are offered as a statement, and continue only on a yes
- No unprompted speech on conversations that never asked for it: 0 on `brainstorm`, `no-wake` and a
  new rhetorical-questions fixture
- Sotto's own corrections remain available on screen, ignorable at zero cost
- The group can turn Sotto down (or up) by talking to it, and it listens for the rest of the session;
  the hello says so before anything else happens
- A conversation with Sotto flows: follow-ups without the wake word, and no answer to a question meant
  for a person
- At a decision closing, Sotto reads it back, and attaches the group's own unsettled risk if there is
  one, never generic coaching and never a judgment of its own

## Prerequisites (human)

- **Glimmer served locally** (done; Ollama, `.env`). It's still needed for research gating.
- **A second person for the V3-011 live checkpoint**, plus the deferred two-person checks from V2-008
  (side talk and crosstalk). If no one is available, a phone playing a voice can stand in.
- **One or two real past `mic` sessions** under `sessions/` for the V3-016 shadow run. Any real
  conversation will do; the longer the better.

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
**Description:** As the system, I need to tell a real open question that Sotto can answer from a rhetorical one, from one that's been answered, and from one only the group can answer, within seconds of it being said.

**Acceptance Criteria:**
- [ ] A **question classifier** on final turns, built like the V2-008 address classifier and **not** through the observer: a lexical pre-filter (wh-words, "wonder", "does anyone know", "we'd need to check", "how long/much/far/many", "what does/do … charge/cost", a trailing "?") decides whether a turn is question-shaped, and only those go to one Spark call (`reasoning_effort: "low"`, about 2 s) with the previous four final turns and speaker names. The pre-filter must pass every open question in the fixtures and must not send more than about a quarter of `brainstorm`'s turns to the model
- [ ] The classifier returns `kind`: `open_question` (asked or wondered aloud to the room, not to Sotto, and **answerable by lookup**: the web, or later the knowledge folder in V3-009. Examples: drive time, prices, opening hours, market size, a definition, a date), `to_group` (only the group knows: "who's handling food?"), `rhetorical` ("who even uses fax anymore?"), `decision` ("should we do it?"), `answered` (a person answered it in the same or the previous turn) or `none`; plus `question` (cleaned, the thing to look up), `topic` (three to five words, for "I'll check the drive time") and `askedBy`
- [ ] `open_question` is **not** a candidate type and never reaches the observer, the candidate gate or the policy. It is a record of its own (`origin: "open_question"` on the research idea, V3-003). `unanswered_question` keeps the questions only the group can answer (on screen only). `research_hook` keeps "we should look into X" requests, which go to the research gate as today; the observer prompt is told that a question somebody just wondered aloud is already handled and is not a hook
- [ ] A question with the wake word, or inside the V3-014 follow-up window, is the address path's, never this one. A turn that is a `decision` is handed to V3-013's `decision_closing` detection so the pair share one call
- [ ] The prompt is `server/prompts/question.md`, with positive and negative examples, including rhetorical and decision questions. Every classification is logged in `timing.jsonl` as `stage: "question"` with `turnId`, `kind`, `latencyMs`; a Spark failure or timeout (6 s, wall clock) is `none` and logged `fallback: true`
- [ ] A new fixture, `rhetorical-questions` (2–3 min, Craig and EJ): at least four rhetorical or decision questions, one question asked and answered by a person within two turns, and one genuine open question (positive control). Rendered, captured and added to the eval set
- [ ] Integration test (events replay, real Spark): `offsite-plan`'s drive-time question yields an `open_question` within 4 s of its final turn (session clock plus the call's wall time); `rhetorical-questions` yields exactly one, the positive control; `brainstorm` and `no-wake` yield none
- [ ] Tests pass
- [ ] Typecheck passes

### V3-003: Fast path from question to answer
**Description:** As the system, when the room wonders something Sotto can look up, I want the answer ready while it still matters.

**Acceptance Criteria:**
- [ ] An `open_question` becomes a research idea at once: it skips the 2-minute planner **and** the research gate (the classifier already judged it answerable and asked by the room, so a second call on the same question is only latency) and starts the search immediately. It counts against the research budget (V2-012). Duplicates of earlier ideas and packets are dropped, as today; a duplicate of an idea whose packet already exists re-uses that packet and is answered from it
- [ ] The research runner produces a packet with a new field, `spokenAnswer`: one or two sentences that answer the question directly, written to be heard (numbers rounded sensibly, no URLs), grounded in the sources. Packets with zero sources produce no `spokenAnswer`
- [ ] A research card appears on the stage **as soon as the question is accepted**, carrying the question and a thinking indicator (the `thinking` state answers already use), and fills in when the packet is ready. The room, and a demo audience, can see Sotto working during the wait
- [ ] Target: median ≤ 25 s from the question turn going final to the packet being ready, measured in `research.jsonl` (`questionToPacketMs`) on the e2e fixtures
- [ ] Unit tests: fast path vs planner path, budget shared, dedupe, re-use of an existing packet
- [ ] Tests pass
- [ ] Typecheck passes

### V3-015: Claiming the question out loud
**Description:** As a user, when I wonder something aloud and Sotto is going to look it up, I want it to say so right away, the way a colleague says "I'll check", so I know not to reach for my phone.

**Acceptance Criteria:**
- [ ] When an `open_question` starts research, Sotto speaks a **reservation line** at the first gap of `PAUSE_MS` (the policy's 700 ms, on corrected silence) that arrives within `RESERVE_WINDOW_MS` (default 5,000) of the classifier's verdict. The text is written locally from the classifier's `topic`, no model call: "I'll check the drive time." If no gap arrives in the window, nothing is said; the card from V3-003 is the only sign, and the answer still follows under V3-004
- [ ] A reservation yields to any human voice (V3-004's rule) and is never retried
- [ ] A reservation is the contribution for budget purposes (V2-017 frequency cooldown and budget); the answer that follows is its completion, not a second contribution. Muted voice or boldness `cautious` means no reservation
- [ ] If the search then fails or comes back unsourced after a reservation was spoken, Sotto closes the loop at the next real pause with one short line ("Nothing solid on the drive time, sorry."), only if the question is still current (V3-004); otherwise the card says so
- [ ] `timing.jsonl` records `spoken_contribution` with `kind: "reserve"`, `questionToReserveMs`, whether it yielded, and (for the closing line) `kind: "no_answer"`
- [ ] Offline tests on the simulated clock: spoken at the first gap; not spoken when no gap arrives in the window; yields; budget; muted; cautious; the no-answer line
- [ ] Typecheck passes

### V3-004: Speaking the answer to the room
**Description:** As a user, when we wondered something aloud and Sotto found the answer, I want it to tell us briefly, at a natural moment, and to stop the instant one of us starts talking.

**Acceptance Criteria:**
- [ ] When a `spokenAnswer` is ready, Sotto waits for a **real pause**: no open turn and at least `SPEAK_PAUSE_MS` of corrected silence (`silentForMs`, V2's endpointer correction). The default is **measured, not guessed**: run `npm run eval:ceiling` with the speak threshold over the open-question fixtures and choose the largest value that leaves every planted open question a pause inside its window with ≥ 500 ms of margin; record the number and the margins in `decisions.md`. Expect it near 1,000 ms: the real quiet measured inside planted windows is 930–1,610 ms, so 1,500 would exclude most of it
- [ ] **Still-current check, never in the critical path.** Right when the packet is ready and again after every later final turn, one quick Spark call over the turns since the question returns `current` (the group is still on, or adjacent to, the topic), `answered` (a person answered it, and whether the sourced answer agrees) or `moved_on`. The verdict is cached, so between "pause detected" and first audio there is **no model call**. No final turn since the question means `current` with no call. `moved_on` means card only: a pause 40 s later is a pause in the new topic, and re-raising the old one is the interruption this story exists to avoid. `answered` and the answer agrees means a card marked **confirmed** and nothing spoken; disagrees means a card only, with the correction on screen
- [ ] The spoken line is addressed to the room, **never by name**: "On the drive time: about two hours fifteen from the city." Diarization labels are remapped on every reconnect (`speakerMappingUncertain`), and naming the wrong person is a worse failure than naming nobody
- [ ] **Yield to any voice.** Unprompted speech (a reservation, an answer, a read-back, a probe, an offer) is cancelled by the first human partial the self-echo filter lets through, at any point in the utterance, no wake word and no classification. (Not on a bare `speechStart`: the echo filter decides on text, and Sotto must not cancel itself on its own echo. The cost is one partial's lag, about 300 ms.) Barge-in (V2-007) still applies on top. A yielded answer is retried once at the next real pause if still current; yielded twice, it becomes a card only. Answers to direct questions keep the wake-word rule: the room asked for those
- [ ] **Expiry:** an answer not spoken within 90 s of being ready, or after 6 more final turns, becomes a card only
- [ ] The research card still appears, with sources. The spoken line appears in the transcript as Sotto's (V2-008a)
- [ ] Counts against the frequency budget and cooldown (V2-017), unless a reservation already did. Muted voice means card only. Boldness `cautious` means card only
- [ ] `timing.jsonl` records `spoken_contribution` with `kind: "answer"`, `questionToSpeechMs`, `pauseWaitMs`, `stillCurrent` (verdict and the latency of the call that produced it), `yielded` (count) and whether it was barged-in
- [ ] Offline tests on the simulated clock: waits for a real pause; no model call between pause and speech; yields to a human partial mid-utterance and retries once; still-current `moved_on` → card only; `answered` agreeing → confirmed card; expiry; budget; muted; cautious
- [ ] Typecheck passes
- [ ] Verify in browser using webapp-testing skill (replay `offsite-plan` with the null audio sink: the reservation and the answer appear in the transcript as Sotto's lines, and the card shows sources)

### V3-006: The room can turn Sotto down, or up
**Description:** As a user, I want to steer how forward Sotto is just by talking to it, and I want it to take the hint when we keep talking over it.

**Acceptance Criteria:**
- [ ] During, or within 15 s after, an unprompted contribution, an addressed "stop", "not now", "too much" or similar (V2-007 command classification gains `quieter`) stops speech and lowers **frequency** one step for the rest of the session. "Sotto, you can jump in more" (`louder`) raises it one step
- [ ] **Being talked over is a hint.** Two yields (V3-004) inside 10 minutes lower frequency one step, silently, with the on-screen note below. Yields during an answer to a direct question don't count
- [ ] The header controls reflect the change, and it's saved in session settings. A short on-screen note says what changed ("Sotto will speak up less")
- [ ] A barge-in "stop" during an unprompted contribution counts as `quieter`; during an answer to a question it doesn't
- [ ] Logged in `timing.jsonl`
- [ ] Offline tests, including the two-yields rule
- [ ] Typecheck passes

### V3-012: The hello sets expectations
**Description:** As a user, I want Sotto to tell us up front that it may chime in, and how to stop it.

**Acceptance Criteria:**
- [ ] `server/prompts/hello.md` adds, in one sentence, that Sotto may chime in when the group wonders something it can look up, that it will stop if anyone starts talking, and that "Sotto, not now" quiets it for the rest of the meeting
- [ ] The hello stays under about 20 s spoken (measured from a real render)
- [ ] Typecheck passes

### V3-008: Sotto's own corrections go on screen
**Description:** As a user, I want Sotto's corrections available but never forced on the room.

**Acceptance Criteria:**
- [ ] `contradiction`, `factual_error`, `untested_assumption`, `dropped_thread` and `unanswered_question` are delivered as cards only, in every mode, with two exceptions: the group's own unsettled question attached to a read-back (V3-013), and a **verified** `factual_error` at boldness `bold`, which may be spoken in one sentence under the V3-004 pause, still-current, yield and expiry rules
- [ ] **Corrections become questions everywhere.** Card text for `contradiction`, `untested_assumption` and `dropped_thread` is phrased as a specific question tied to what was said ("Before six gardens: what if only one signs up?"), not an assertion. The observer prompt gives good and bad examples; generic coach-speak ("Have you considered your audience?") is a named bad example
- [ ] The interjection eval gates are unchanged (they measure deliveries, not speech)
- [ ] Tests pass
- [ ] Typecheck passes

### V3-013: Read-backs and probing questions at decision points
**Description:** As a user, when we're about to lock in a decision, I want Sotto to read it back the way a good note-taker does, and if one of us raised a risk against it that never got settled, to remind us in our own words, not to tell us we're wrong.

**Acceptance Criteria:**
- [ ] A new signal, `decision_closing`: the group is settling something ("OK, let's go with six gardens", "so we're agreed on Saturday", "let's lock that in"). Detected on the final turn by the V3-002 question classifier's call (its `decision` kind grows a `closing: true` with the decision in a few words), so it costs no extra call and is not late by a board update. The board's `add_decision` is the backstop
- [ ] **The read-back.** At the next real pause after a `decision_closing`, Sotto speaks one line in the scribe's voice: "Got it: six gardens, Saturday." Yield, still-current and expiry (20 s) rules from V3-004 apply. A read-back with nothing attached is spoken only at frequency `often`; otherwise the decision just lands on the board as today
- [ ] **The attached question.** If an open `dropped_thread` or `unanswered_question` candidate that passed the gate relates to the decision, the read-back carries it, **quoted from the group**: "Got it: six gardens. EJ's question about only one signing up, did that get settled?" This is spoken at every frequency except where the budget says no. A `contradiction` or `untested_assumption` of Sotto's own that relates to the decision is attached **on screen** as a prominent card beside the read-back, and spoken only at boldness `bold`; the PRD's earlier "Before you lock in six gardens: what if only one signs up?" is that card's text, never Sotto's unprompted voice at default settings
- [ ] At most one spoken read-back per 5 minutes and one attached question per 10 minutes. Counts against the frequency budget. Boldness `cautious` or muted means card only. `quieter` from the room (V3-006) applies
- [ ] Logged as `spoken_contribution` with `kind: "readback"` (and `attached: "group" | "own" | null`), the decision turn and the candidate
- [ ] Fixture work: add planted decision moments to existing or new fixtures, some where the group itself raised and dropped a risk (a read-back with the group's question expected, `expectedLevel: "speak"`), some where only Sotto would see a risk (a card expected, nothing spoken at default settings) and some with no risk (nothing or a bare read-back). Integration test (events replay): the first gets the question, the second gets the card and no speech, the third and `brainstorm` get nothing attached
- [ ] Tests pass
- [ ] Typecheck passes

### V3-010: Eval for unprompted speech
**Description:** As the developer, I need to measure unprompted speech the way the interjection eval measures cards.

**Acceptance Criteria:**
- [ ] Fixture moments gain `expectedLevel: "speak"` for open questions Sotto should answer aloud (`offsite-plan` drive time; others where natural; the positive control in `rhetorical-questions`) and for the V3-013 read-backs with a group question attached
- [ ] The eval scores spoken contributions: a moment is **caught** if Sotto speaks an answer the judge matches to it, at a real pause, before any human answered it, and within its window. A reservation (V3-015) is scored separately as `reserved` with its `questionToReserveMs`. **False speech** is any unprompted utterance on `brainstorm`, `no-wake` or `rhetorical-questions` that matches no moment, reservations included
- [ ] Gates: speak recall ≥ 0.6; **zero** false speech on those three fixtures; 100% of spoken contributions at a real pause; **zero** unprompted utterances that continued over a human turn (read off the transcript: a Sotto line overlapping a human line that started after it, with no yield logged). Existing gates unchanged
- [ ] The report adds a spoken-contributions table: moment, kind, text, `questionToReserveMs`, `questionToSpeechMs`, pause wait, still-current result, yields
- [ ] The e2e (real time) runs the same scoring on its fixtures, since only real time shows real latency
- [ ] Typecheck passes

### V3-016: Shadow run on a real conversation
**Description:** As the team, before anyone hears Sotto speak up unprompted, I want to read what it would have said during a real meeting we already had, so the first live test isn't also the first look at its judgment.

**Acceptance Criteria:**
- [ ] `npm run shadow -- <session folder>` replays a past **`mic`** session's `events.jsonl` through the full v3 pipeline at `max` speed with the voice on the null sink (V2-021's `nullSinkVoice`) and the hello suppressed, and writes `tasks/shadow-<session>.md`: every unprompted contribution it would have made (reservation, answer, read-back, attached question, offer) with the trigger turn quoted, the text, its timing from the trigger, the still-current verdict and whether a pause was found; and every open question the classifier saw, with its kind, so false negatives are visible too. The policy's `silent` decisions go in a final "almost said" section
- [ ] The stage gets an **"almost said" tray**: a collapsed list, below the cards, of what the policy held back this session (candidate headline, reason), built from the same records the digest's "What Sotto almost said" uses. Restraint made visible, and the cheapest demo of judgment there is
- [ ] Run it on at least one real session from `sessions/` and commit the report. A human reads it before V3-011 and writes verdicts (welcome / not / wrong) beside each line; the checkpoint script refers to it
- [ ] Typecheck passes

### V3-011: HUMAN CHECKPOINT, live test of speaking up
**Description:** As the team, we need to hear whether Sotto speaking up unprompted is welcome before tuning it further.

**Acceptance Criteria:**
- [ ] The loop does not start this or any later story until `tasks/checkpoint-speaking.md` exists
- [ ] Before the session, a human has read the V3-016 shadow report and written verdicts in it
- [ ] A human runs a live session of about 10 minutes, with two people if possible (a phone voice as a stand-in otherwise): wonder aloud about things that can be looked up, ask rhetorical questions, answer a question yourselves before Sotto does, start talking while Sotto is mid-sentence and confirm it stops, settle a decision after one of you raised a risk and dropped it, settle one with no risk, tell Sotto "not now" once, and talk over it twice to see the frequency drop. Also cover the deferred V2-008 checks (side talk during Sotto's speech, two people talking at once). Follow-ups without the wake word (V3-014) and offers (V3-005) are built after this checkpoint and aren't tested here
- [ ] `tasks/checkpoint-speaking.md` records, for each unprompted contribution: what was said, whether it was welcome, its timing, whether it yielded cleanly, and any false or late ones, then **"Would you leave it on?"** and `RESULT: PASS` or `RESULT: FAIL` with notes
- [ ] On FAIL: fix the listed problems in this iteration, commit, rename the file to `tasks/checkpoint-speaking-fail-<n>.md` (so the loop stops again for a retest), and leave `passes` false with notes. On PASS: set `passes` true and summarize

### V3-014: Follow-ups without the wake word
**Description:** As a user, once I've asked Sotto something and it has answered, I want to keep talking to it ("why's that?", "and on Sunday?") without saying "Sotto" each time, and I want it to notice when we've gone back to talking among ourselves.

**Acceptance Criteria:**
- [ ] After Sotto finishes speaking an answer (addressed, unprompted, or an accepted offer), a **follow-up window** opens. While it's open, "Sotto is listening" stays visible, in a distinct "in conversation" style
- [ ] Every final turn in the window is classified by Spark, with Sotto's last answer and the recent turns as context: `to_sotto` (a follow-up: "why's that?", "how much would that cost?", "and on Sunday?", "where did you get that?"), `to_room` (the humans have resumed: "OK EJ, what do you think?", a new topic among themselves), or `closing` ("great, thanks", "got it"). This shares the V3-002 question classifier's call where a turn is question-shaped, and the V2-008 address classifier's otherwise
- [ ] `to_sotto` → answered like a wake question (acknowledgment, spoken answer, card), and the window stays open from the end of that answer. `to_room` or `closing` → the window closes; nothing is said
- [ ] **When unsure, close.** An ambiguous turn is treated as `to_room`. A turn that names another person is `to_room` without a call. Answering a question meant for a person is worse than making the user say "Sotto" again
- [ ] The window also closes after 20 s with no final turn, or after 2 consecutive turns between humans. Any person may follow up, not only the original asker
- [ ] Barge-in during an answer works as today. A barge-in `new_question` counts as `to_sotto`
- [ ] Logged in `timing.jsonl`: `followup_window` opened/closed with the reason, and each classification with `kind` and `latencyMs`
- [ ] Offline tests on the simulated clock: a follow-up answered, humans resuming closes it, "thanks" closes it, timeout, two human turns, ambiguous → closed, a named person → closed with no call
- [ ] A new fixture, `followups` (2–3 min, Craig and EJ): a wake question, two natural follow-ups without the name, then the pair resume among themselves with a question addressed to each other by name (which must **not** be answered), then later a fresh wake question. Rendered, captured, and in the eval set. The eval counts answered-when-not-addressed as a false answer, gate 0
- [ ] Typecheck passes
- [ ] Verify in browser using webapp-testing skill (replay `followups`: the in-conversation indicator appears after the answer and clears when the humans resume)

### V3-005: Offering anything longer
**Description:** As a user, I want Sotto to tell us when it has something longer and let us decide, without putting us on the spot.

**Acceptance Criteria:**
- [ ] A packet from the planner or a `research_hook` (not an open question with a short answer) is **offered** aloud at a real pause, as a **statement, not a question**: "There's a quick rundown on competitors on screen if you want it." Nobody owes it a reply. The card appears at the same time. Yield and still-current rules from V3-004 apply; an offer about a topic the room has moved on from is the card alone
- [ ] For 10 s after the offer, the next final turn from anyone is classified by Spark as `yes` ("sure", "go ahead", "yeah let's hear it"), `no` ("not now", "later") or `unrelated`, with **no wake word needed**. `yes` → the V2-015 spoken briefing from that packet. `no` or `unrelated` → nothing more; the card stays
- [ ] At most one open offer at a time; offers count against the frequency budget
- [ ] Logged as `spoken_contribution` with `kind: "offer"` and its outcome
- [ ] Offline tests: yes, no, unrelated, timeout, a second offer while one is open, moved-on → card only
- [ ] Typecheck passes

### V3-007: Offering ideas when the group is stuck
**Description:** As a user, when we're going around in circles, I want Sotto to offer a few ideas, only if we want them.

**Acceptance Criteria:**
- [ ] A new candidate type, `stall`: the same question or problem revisited across at least 3 turns without progress, or explicit "I don't know"/"we're stuck" with no new idea following. Defined in the observer prompt with negative examples (a normal pause, someone thinking aloud once, a disagreement being worked through: a group circling because two people disagree is not stuck, and an outsider's ideas there land as taking a side)
- [ ] A stall is offered, never volunteered, as a statement in the V3-005 shape: "I've got a few ideas on the name if they'd help." `yes` → up to three short ideas, spoken in about 20 s, plus a card
- [ ] At most one stall offer per 10 minutes
- [ ] Integration test (events replay) on a fixture with a planted stall (add one to `rhetorical-questions` or a new fixture): the stall is detected and offered. `brainstorm` produces no stall offer
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

## Build order

The loop builds in priority order, not story-number order. Everything that decides "would you leave it
on?" is built before the live test, and the off switch is built before the first thing it switches off
is tested:

1. V3-001 gate per path
2. V3-002 noticing open questions (per-turn classifier)
3. V3-003 fast path to a packet
4. V3-015 claiming the question out loud
5. V3-004 speaking the answer (yield, still-current)
6. V3-006 steering by voice
7. V3-012 the hello
8. V3-008 corrections on screen, phrased as questions
9. V3-013 read-backs and attached questions
10. V3-010 eval for unprompted speech
11. V3-016 shadow run on a real conversation
12. **V3-011 live checkpoint** (the loop stops here)
13. V3-014 follow-ups without the wake word, V3-005 offers, V3-007 stall ideas,
    V3-009 knowledge folder (stretch)

V3-014 moved from before the checkpoint to after it: it is the highest false-positive risk in the plan
(answering a question meant for a person) and the checkpoint should measure the unprompted forms first.

## Functional Requirements

- FR-V3-1: Unprompted speech happens only (a) to claim an `open_question` ("I'll check…") and then answer it with a sourced `spokenAnswer`, (b) to read back a closing decision, with the group's own unsettled question attached when there is one, (c) as a one-sentence offer (research, ideas) that continues only on `yes`, or (d) a verified factual error at boldness `bold`
- FR-V3-2: Unprompted speech happens only in a real pause (`SPEAK_PAUSE_MS`), never starts over a person, and **stops for any human voice** without a wake word. Answers to direct questions keep the wake-word barge-in
- FR-V3-3: Before any unprompted speech, a cached still-current check confirms the room is still on the topic; nothing between the pause and the first audio makes a model call
- FR-V3-4: Every unprompted contribution is also a card with sources, and Sotto's line in the transcript
- FR-V3-5: Frequency, boldness and mute govern unprompted speech. The room can lower or raise frequency by voice, and being talked over twice lowers it
- FR-V3-6: Spark makes time-critical judgments (question classification, interjections, still-current checks, offer replies); Glimmer judges research ideas
- FR-V3-7: After Sotto answers, follow-ups need no wake word until the humans resume. When unsure whether it's being addressed, Sotto stays quiet
- FR-V3-8: Unprompted speech never addresses a person by name, and never asks the room a question it has to answer, except the group's own question quoted back at a decision
- FR-V3-9: Sotto's own judgments (contradictions, untested assumptions) are never spoken unprompted at default settings

## Non-Goals

- Spoken corrections of Sotto's own at default settings
- Reading mood, emotion or politics beyond the explicit signals above
- CRM, financial-system or email integrations; the knowledge folder is the stand-in
- Sotto initiating topics nobody raised

## Technical Considerations

- **Latency budget for an open-question answer:** question final → question classifier (about 2 s, Spark) → reservation at the first 700 ms gap (target ≤ 5 s from the question) → research (about 16–21 s, no gate) → real pause (variable) → speech, with the still-current verdict already cached. The V3-003 target puts the packet ready around 20–25 s; spoken around 25–35 s after the question is fine once the room has heard "I'll check"
- The max-speed eval can't see latency (simulated time stops during model calls); the e2e can. Every latency claim comes from the e2e or live logs
- Reuse what exists: `InterjectionPolicy` and delivery for pause logic, `VoiceHub` and `SpokenAnswer` for speech, `BargeIn` for interruptions (yield is a second trigger on the same cancel path), the V2-008 address classifier as the pattern and the partial-turn hook for the question classifier, `ResearchManager` for queueing and budget, V2-008c's holding-line plumbing for the reservation
- **Yield and self-echo:** the yield trigger is the first human partial the V2-006 echo filter passes, not a `speechStart`. The live checkpoint measures how often Sotto cancels itself; if it does, the fix is in the echo window, not in the yield rule
- **Cost:** every open question is a grounded search, $0.08–0.17. The research budget (3 per 10 min) caps a talkative hour at about $2–3; keep it, and say so in the demo notes
- Research quality: the overnight run produced a packet about *AGM* software for a question about meeting assistants. The `spokenAnswer` must answer the question asked; the V3-003 integration test checks relevance with the judge

## Success Metrics

- V3-011 live checkpoint: "would you leave it on?" yes
- Eval: speak recall ≥ 0.6, zero false speech, 100% at real pauses, zero unprompted utterances continued over a person, zero answers to turns meant for a person (`followups`)
- e2e: median question → reservation ≤ 5 s and question → spoken answer ≤ 35 s on fixtures with open questions
- Demo: one clean moment where the room wonders aloud, Sotto says "I'll check", the card fills while they keep talking, and Sotto supplies a sourced answer at the next pause

## Open Questions

- Should a stall offer (V3-007) also be allowed at boldness `normal`, or only at `bold`?
- Is a bare read-back (no question attached) welcome often enough to allow at frequency `normal`, or does it become a tic?
- Is 20 s the right follow-up window, or should it track the conversation's pace?
- Resolved 2026-11-01: answers are not attributed by name (V3-004); offers are statements, not questions (V3-005)
