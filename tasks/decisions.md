# Decisions log

Changes to Sotto's behavior or scope after the core PRD ([`prd-sotto-core.md`](prd-sotto-core.md)). Newest at the bottom. Each entry: date, what changed, why, and where it lives.

The changes made before this log started are listed at the top of the PRD under "Changes since this PRD".

---

## 2026-11-01 — Muse Glimmer stays the default candidate gate

**What changed:** nothing in the code. `DEFAULT_GATE_MODE` in
`shared/candidates.ts` stays `"glimmer"`, and V2-020 records the measurement
behind it rather than changing it. Spark remains selectable with
`npm run eval -- --gate spark`, and `JudgmentRouter` still falls back to Spark
automatically whenever the local server is unreachable (FR-V7).

**Why:** V2-020 ran the whole nine-conversation eval set twice with identical
prompts, once each way.

| | `--gate glimmer` ([report](../eval/reports/2026-11-01_030103.md)) | `--gate spark` ([report](../eval/reports/2026-11-01_034450.md)) |
| --- | --- | --- |
| gates | **PASS** | FAIL (research recall 0.33 < 0.5) |
| moment recall | 7/9 (0.78) | 9/9 (1.00) |
| research recall | 2/3 (0.67) | 1/3 (0.33) |
| interject precision | 4/5 | 5/6 |
| false interjects on `brainstorm` + `no-wake` | 0 | 0 |
| deliveries in a pause | 9/9 | 13/13 |
| gate latency | 23.7 s median (20.5–28.5) | none |
| cost | $3.71 | $3.92 |

The local gate is not obviously the better judge on this set — it costs two
planted moments (it scored the verified Instagram launch-year error at
`importance` 0.18 and the nightly-photo assumption at 0.55) and gains no
precision. What decides it is that **the gateless run is the one that fails a
gate**, and a default whose own committed report fails is not defensible. The
local gate also matches what the v2 PRD asks for (FR-V6, FR-V7: judgment runs
on this Mac, Spark takes over when it cannot), costs nothing, and sends none
of the conversation to the cloud for the judgment step.

Two things are written down rather than fixed, because fixing either is a
behaviour change outside V2-020's scope:

- **23.7 s of judgment is free in the eval and not free in the room.**
  Simulated time does not move during a tracked model call, so a `max` replay
  charges the gate nothing. The planted windows in this run are 11.8–28.7 s
  wide (median ~21 s), so a candidate held 23.7 s for a verdict would miss
  seven of the twelve. `npm run e2e` (V2-021) is the only check that runs the
  gate against a real wall clock; if the live numbers are bad, the fix is
  Spark as the default, not a looser threshold.
- **The research-recall gate is decided by one conversation in steps of
  0.33.** Both runs missed `offsite-plan`'s hook, so the gate turns on
  `research-business-idea` alone. The difference there was not the gate at all
  (a `research_hook` never reaches it): the research budget is 3 searches per
  10 minutes and that conversation is under three minutes, so the observer
  splitting one out-loud request into two hooks — "market size" and "who's
  funded" — spent a slot and lost the moment. The sharpest lever left on
  research recall is `observer.md`: one hook per thing the group asked for.

---

## 2026-11-01 — The end-to-end check is budgeted per conversation, not per run

**What changed:** `npm run e2e`'s cost gate. The core PRD's flat $0.50 on a run
(US-021) became a table of per-conversation allowances in
`server/e2e/report.ts` (`FIXTURE_BUDGET_USD`), summed over whatever fixtures
were asked for. `MAX_RUN_COST_USD` is gone.

**Why:** the $0.50 was measured ($0.4826, 3.5% under) against a pipeline that
neither searched the web nor spoke. V2 gave Sotto both, and both are charged
per conversation rather than per run:

- **Every** fixture now runs the research planner, so a two-minute
  conversation can spend a grounded search — and a grounded call with a tool
  declared resends its whole request each round (V2-013), so one search is
  tens of thousands of input tokens. `ask-search`, a 48-second conversation,
  searched twice and cost $0.4700 on its own — three times what two minutes of
  `brainstorm` cost, because `brainstorm` searched not at all.
- Every fixture says hello out loud, and ElevenLabs bills by the character:
  $0.4129 of the full run's $2.3409.

Keeping one flat number would have meant either a gate no run could pass or a
gate so loose that `--fixtures <one>` proved nothing. A table says what each
conversation is expected to cost, which is also the number a reader wants when
one of them gets expensive. The four core conversations share one $0.70
allowance — what separates them is whether the planner happened to spend a
search, not how long they are — and the research conversation gets $1.60
against a measured $1.1354. `npm run e2e` prints each conversation's bill
against its own allowance, and the first full run came to $2.3409 of $4.20.

**Where it lives:** `FIXTURE_BUDGET_USD` and `budgetFor` in
`server/e2e/report.ts`, with `DEFAULT_FIXTURE_BUDGET_USD` for a conversation
nobody has measured.

---

## 2026-11-01 — The v3 PRD is revised before any v3 story is built

**What changed:** [`prd-sotto-v3.md`](prd-sotto-v3.md) and `ralph/prd.json`, which
now carries 16 stories in a new build order. No code. The review that produced
it asked one question of every unprompted thing Sotto would say: what gives it
the right to the floor, and what makes it give the floor back?

**Why, and what moved:**

- **Open questions are noticed per turn, not by the observer (V3-002).** The
  observer only looks after a board update, a median 12.6 s after the turn that
  matters (US-009, four final turns). With a 2–3 s gate and a 16–21 s search
  behind that, the original 25 s question-to-packet target was unreachable by
  any prompt. A question-shaped final turn now goes through a lexical filter
  and one Spark call, the shape V2-008 settled on for addresses. The research
  gate is skipped for it too: the classifier already judged it answerable.
- **Nothing runs in the pause (V3-004).** The still-open check was a ~2 s
  Spark call at a 1.5 s pause, so Sotto would start speaking after the pause
  ended. It is now a cached verdict, refreshed on each final turn after the
  packet is ready, and renamed **still-current**: a group that changed topic
  has not closed the question, but re-raising it 40 s later into the new topic
  is the interruption the story exists to avoid.
- **Unprompted speech yields to any voice (V3-004, FR-V3-2).** The draft only
  cancelled before the first audio chunk; after that the wake word was needed.
  A reservation, answer, read-back or offer now stops on the first human
  partial the echo filter passes, at any point. Sotto was not asked, so it has
  the lowest floor rights in the room. Answers to direct questions keep the
  wake-word rule. Two yields in ten minutes lower the frequency (V3-006).
- **Sotto claims the question out loud (new V3-015).** "I'll check the drive
  time" at the first 700 ms gap, written locally from the classifier's topic,
  is V2-008c's holding line applied to unprompted speech. It turns a 30 s wait
  into an expected delivery, keeps phones in pockets, and the card that
  appears with it shows a demo audience that something is happening.
- **Decisions get a read-back, and the probe rides on it (V3-013).** The draft
  spoke "Before six gardens: what if only one signs up?" at the moment someone
  had just said "let's go with six", which is a challenge to that person. The
  scribe's read-back ("Got it: six gardens") is the one unprompted line every
  meeting already licenses, and the only thing attached to it out loud is the
  **group's own** dropped or unanswered question, quoted back. Sotto's own
  contradictions and untested assumptions go beside it on screen, and are
  spoken only at boldness `bold` (FR-V3-9).
- **No names, no obligating questions (FR-V3-8).** Diarization labels are
  remapped on every reconnect, so "EJ, on the drive time" risks naming the
  wrong person. Offers became statements ("There's a rundown on screen if you
  want it") because a question from the agent makes the room owe it a reply.
- **The off switch is built before the test that uses it.** The draft's
  checkpoint script said "tell Sotto 'not now' once" while V3-006 and V3-012
  were scheduled after the checkpoint. Both moved before it. V3-014
  (follow-ups without the wake word) moved after it: answering a question
  meant for a person is the worst failure in the plan, and the checkpoint
  should measure the unprompted forms first.
- **A shadow run before the live run (new V3-016).** `npm run shadow` replays
  a real past `mic` session through the v3 pipeline on the null voice sink and
  writes what Sotto would have said and when. The first look at its judgment
  on a real conversation should not also be the first time anyone hears it.
  The stage gains an "almost said" tray from the same records.
- **`SPEAK_PAUSE_MS` is measured, not 1,500.** Real quiet inside planted
  windows measured 930–1,610 ms (US-023), so 1,500 would exclude most of it.
  V3-004 picks it off `npm run eval:ceiling` and records the margins here.

**Where it lives:** the PRD's "Why open questions bypass the observer" section,
V3-002, V3-004, V3-006, V3-013, V3-015, V3-016, FR-V3-8/9 and the build order.

---

## 2026-11-01 — The judgment gate splits: Spark for interjections, Glimmer for research

**What changed:** `DEFAULT_GATE_MODE` in `shared/candidates.ts` is now
`"spark"` — the observer's own four scores stand and `CandidateGate` makes no
call at all — while `ResearchGate` is untouched and still goes to Muse Glimmer
on this Mac, falling back to Spark when the local server is unreachable
(FR-V7). This reverses [the entry above](#2026-11-01--muse-glimmer-stays-the-default-candidate-gate),
written the same day on the max-speed eval's numbers. `--gate glimmer|spark`
forces the interjection path either way for an A/B, on `npm run eval` and now
on `npm run e2e` too, and the eval report prints **median gate latency per
path** so the two are never again compared on one number.

**Why:** the local gate's judgment is good and its latency is wider than the
moment it is judging.

- A Glimmer verdict costs **24–34 s** (V2-020 median 23.7; re-measured here at
  24.7 s median over three candidates, [`2026-11-01_062711`](../eval/reports/2026-11-01_062711.md)).
  A planted interjection window is **12–29 s** wide. The candidate is held for
  the verdict, so the verdict arrives after the moment.
- `npm run eval` cannot see this. Simulated time does not move inside
  `clock.track`, so 25 s of local thinking is free in a replay and the report
  passed. The real-time e2e said otherwise: V2-021 delivered both planted
  contradictions **31.9 s and 50.1 s past their deadline** with every assertion
  still green, because the check does not gate on moment latency.
- On judgment itself, Spark was not worse. Over the nine-fixture set with
  identical prompts: recall 9/9 against Glimmer's 7/9, interject precision 5/6
  against 4/5, and Glimmer suppressed two verified moments
  ([glimmer](../eval/reports/2026-11-01_030103.md),
  [spark](../eval/reports/2026-11-01_034450.md)).
- Research is the opposite shape, so Glimmer keeps it. A gate verdict of
  27.8 s (median, max 34.9) sits in front of a 16–21 s search whose answer is
  for the rest of the conversation, not for the next ten seconds — nobody is
  waiting out loud — and it is the judgment that stops an unvetted search
  reaching the screen. It also keeps a real role for the open-weight model.

**Measured after the change**, `npm run e2e -- --fixtures
moment-contradiction,research-business-idea`, 22/22 checks, $1.31 of a $2.30
allowance:

| fixture | moment | window | trigger → delivery | overnight (Glimmer gate) |
|---|---|---|---|---|
| `moment-contradiction` | `budget-contradiction` | 18.2s | **4.6s**, before the deadline | 31.9s past it |
| `research-business-idea` | `audience-contradiction` | 23.2s | **8.4s**, before the deadline | 50.1s past it |

Research still ran on Glimmer in both conversations (2 and 5 local gate calls),
and `research-business-idea` still produced three sourced packets and a spoken
briefing.

**What this costs:** the interjection path loses its second opinion. That is a
judgment regression accepted on the measurement above — a verdict that arrives
after the moment is worth less than no verdict — and it is recoverable:
`--gate glimmer` is one flag, and a faster local model or a Spark-side gate
call (2–3 s) would make the gate affordable again. The thing that must not
happen is reading a replay's report as though it had charged the gate for its
seconds.

**Where it lives:** `shared/candidates.ts` (`DEFAULT_GATE_MODE`),
`server/interject/CandidateGate.ts`, `server/e2e/options.ts` (`--gate`),
`server/eval/score.ts` (`scoreResearchGate`), `server/eval/report.ts`
(the two headline rows), PRD V3-001.

---

## 2026-11-01 — Related work, and two ideas taken from it

**What changed:** [`prd-sotto-v3.md`](prd-sotto-v3.md) gains a "Related work"
section and V3-017 (a raised hand, and being called on); V3-009 and V3-012 are
extended; `ralph/prd.json` is regenerated with V3-001's result preserved.

**Why:** a survey of Meet Live Assist (Krystian Gwizdała's Chrome extension
that hands Meet captions to your own Claude Code session and advises one
person in a side panel), AWS Live Meeting Assistant, AgentCall, Hedy,
Fireflies Live Assist, Otter's Meeting Agent, CoAgentor, Relly and the Sun
voice API. None of them is in-room, and none publishes a theory of when to
speak or measures it, which is Sotto's claim. Two of their ideas were worth
having: CoAgentor's **hand-raise mode** is the safe route for every
correction Sotto decides not to say (visible, callable, never forced), and
Meet Live Assist's **corrections against your own records** ("that date is
inside the freeze") land where corrections against general knowledge do not,
so a file-backed `factual_error` is the one correction spoken at default
settings. Relly's "any participant can silence it" is now in the hello.

**Where it lives:** the PRD's "Related work", V3-017, V3-009, V3-012,
FR-V3-9/10 and the build order.

---

## 2026-11-01 — `SPEAK_PAUSE_MS` is 450 ms, and the measurement says why

**What changed:** V3-004's threshold for *speaking* an answer to the room is
450 ms of corrected silence, not the 700 ms everything Sotto shows unasked
waits for and not the ~1,000 ms the PRD expected. `inPause(pause, pauseMs)`
takes the threshold as an argument; `SPEAK_PAUSE_MS` lives beside `PAUSE_MS` in
`server/interject/policy.ts`.

**The measurement** (`npm run eval:ceiling -- --speak`, free, no API call).
The three planted open questions — a `research_hook` is exactly V3-002's
`open_question` — and the longest real quiet anywhere inside each one's window:

| fixture / moment | window | longest quiet | margin at 450 |
| --- | --- | --- | --- |
| `offsite-plan` / venue-logistics | 57.2–83.6 s (26.4 s) | 1,340 ms | 890 ms |
| `research-business-idea` / market-size | 67.3–89.8 s (22.6 s) | 1,725 ms | 1,275 ms |
| `research-business-idea` / competitor-gaps | 110.1–138.1 s (28.0 s) | 968 ms | 518 ms |

The PRD's rule is the largest threshold leaving every one of them ≥ 500 ms of
margin: 968 − 500 = **468 ms**, so 450 as a round number. `competitor-gaps` is
the binding window, and at 1,000 ms it would have had 0 ms of margin at all —
the PRD's expectation came from the 930–1,610 ms US-023 measured inside the
*interjection* windows, which are not these.

**Two things worth knowing about 450.** It is below the floor the endpointer
correction puts on corrected silence: `TurnAssembler.pauseState` counts silence
from `speechEnd − ENDPOINTER_HANGOVER_MS` (650 ms), so `silentForMs` reads 650
the instant a turn closes and any threshold under that means "the first moment
the transcription says nobody is talking". That is the intent — what keeps Sotto
off somebody's sentence is `pause.speaking`, not the threshold — and it is the
right trade for the one thing Sotto says that the room is actually waiting for.
And the window is narrower still than the table suggests: the fast path takes
13–28 s from the question to a sourced packet, and the quiet left *after* that
is 697–968 ms (`--speak` prints it per readiness offset), which is why 1,000
would have failed in practice as well as on the rule.

**Where it lives:** `server/interject/policy.ts` (`SPEAK_PAUSE_MS`, `inPause`),
`server/eval/ceiling.ts` (`speakReach`, `speakThresholdMs`, `SPEAK_MARGIN_MS`,
`SPEAK_MOMENT_TYPES`), `scripts/eval-ceiling.ts` (`--speak`), PRD V3-004.

## 2026-11-01 — A read-back's attachment costs nothing when the room can already see it

**What changed:** V3-013 reads a decision back at the next real pause and may
carry the room's own unsettled question on it. The PRD says a read-back
"counts against the frequency budget", and it does — with one exemption: when
the question on it belongs to a candidate the policy has **already delivered as
a card**, saying it beside the decision spends nothing. `ReadBackRequest
.alreadyDelivered` carries that fact and `Reservations.charges()` reads it.

**Why.** It is V3-008's rule, in the same words: the card spent the
contribution when it went out, and this is that contribution reaching the
room's ears rather than a second one. Without the exemption the feature is
unreachable rather than rationed. Measured on `decision-closings` with the
offline pipeline: the policy delivers the candidate as an `interject` the
moment it has a pause, which is **forty to fifty seconds before** the decision
it bears on, and an interject pushes `interjectedAtMs` — so at `normal`'s
180-second cooldown every read-back that had anything to say was skipped as
`cooldown`, and at `often`'s 90 seconds too. The thing being rationed would
have been exactly the contribution the PRD asks for.

What still pays: a **bare** read-back (nothing attached), and one whose
candidate the policy is still holding. And the read-back's own two limits are
untouched — one spoken read-back per five minutes, one attached question per
ten — so the ceiling is one attached read-back per ten minutes whatever the
budget says.

## 2026-11-01 — Which candidate goes with which decision is matched on words

**What changed:** `decisionRelevance` in `server/decision/readback.ts` scores
coverage of the *decision's* own content words by the candidate's headline,
detail, "why now" and cited quotes, against `DECISION_RELEVANCE` (0.4 — two of
a five-word decision, one of a two-word one). No model call.

**Why no call.** A read-back's whole value is arriving while the decision is
still in the air: V3-013 rides V3-002's existing classifier for exactly that
reason, and a second judgment call in front of it would cost the sentence the
only thing it has. The bar works because V3-008 made every correction a
question *tied to what was just said* — "Before the mechanic and the coffee
cart: where does the 450 come from?" shares the decision's own nouns, and a
candidate about something else shares none of them.

**The failure it accepts** is a miss, not a false attachment. A read-back with
nothing on it is a courtesy (and is only said at frequency `often`); a
read-back with the *wrong* question on it is Sotto not listening. Recency was
considered and rejected for this reason: "any open candidate from the last
minute" would have attached `brainstorm`'s dropped grocery-partnership thread
to its "decided then, photo to three suggestions" closing, which is the first
false speech the V3-010 gate would catch.

## 2026-11-01 — `decision-closings`, and `expectedLevel: "speak"`

**What changed:** a new fixture, `fixtures/scripts/decision-closings.json`
(27 lines, 133.8 s, rendered and captured), in the eval set. It settles three
things out loud and is the only conversation that exercises all three of
V3-013's cases: a decision only Sotto sees a problem with (the launch costs
against a stated 1,400 ceiling), a decision the group itself raised a question
against and dropped (six sheds, one per association), and a decision with
nothing open against it (paper sign-up sheets). `expectedLevels` gained
`"speak"` for the second, which V3-010 will score properly; until then
`levelRank` puts it above everything, so a card for a moment that expected
speech is `caught_low` rather than a catch.

**Measured** (`npm run eval:ceiling -- --fixtures decision-closings`, free):
`launch-costs-contradiction` has a 29.5 s window with 1,571 ms of real quiet
left after the observer could first look, and `association-signup-unanswered`
15.9 s with 743 ms — both reachable at `PAUSE_MS` 700, and the second with 293
ms of margin at the read-back's `SPEAK_PAUSE_MS` of 450. Note the ceiling tool
models an interjection: for a read-back the candidate already exists when the
decision lands, and the pause it waits for is the decision turn's own (a
scripted 2,400 ms).

**The pre-filter had to grow a second half.** A closing decision is not
question-shaped at all — no question word, no question mark — so
`isClosingShaped` joins `isQuestionShaped` in `worthClassifying`, which is what
the watcher now asks. Measured across all twelve older captures: **three** extra
calls in total (`brainstorm`'s "decided then, photo to three suggestions",
`moment-assumption`'s "let's do pricing today", `moment-contradiction`'s "let's
just say that out loud"), every one of them a group really settling something.
`brainstorm` goes from 2 of 24 turns to 3 — still well inside V3-002's quarter.

## 2026-11-01 — the shadow run, and what two real conversations produced

**What changed:** `npm run shadow -- <session folder>` (V3-016) replays a past
`mic` session's `events.jsonl` through the whole v3 pipeline at `max` speed,
with Sotto's voice on V2-021's null sink and the hello suppressed (an `events`
session never builds a `Greeting`), and writes `tasks/shadow-<session>.md` for a
human to mark up before the V3-011 live checkpoint. The replay itself is
`replayFixture` — the eval's — with one new seam,
`SessionManager.createReplaySource`, so the only difference from an eval run is
which file the frames come off. Every run is also saved to
`shadow/runs/<session>.json`, so `--report` rebuilds the markdown for nothing.

**Measured, `2026-10-30_0919-mic`** (a real two-person product conversation, 24
turns, 3:58; 42 model calls, $0.62) at `normal/normal`: **nothing would have
been said out loud**, which is the designed answer rather than a gap — at the
default settings Sotto speaks unasked only for an `open_question` it can look
up (V3-002/V3-004), a read-back at frequency `often` (V3-013) or a verified
factual error at boldness `bold` (V3-008). Four classifications (2 `decision`,
1 `rhetorical`, 1 `none`; no `open_question`), two turns addressed Sotto by
name, and four cards — two research packets, one answer and one interject
("We said one garden first — where does launching in all six fit?").

**Measured, `2026-10-30_2141-mic`** (11 turns, 4:20; 34 calls, $0.39) at
`often/bold`: one read-back said ("Got it: human bingo, two-hour event, book
$900 caterer") and a glow holding the thing that matters — "The $900 caterer —
how does that fit within the $500 budget?" — against a budget stated four
minutes earlier. Three `decision` verdicts, two of them `closing`.

**What a `max` shadow run cannot tell you**, and the report says so: simulated
time does not move inside a tracked call, so "from the trigger turn" reads 0.0 s
and the pause reconstruction says the room was not quiet. Judge the judgement in
a shadow report and leave the timing to V3-011, which is the only clock that
charges for it.

**The stage's "almost said" tray** is the same list, live: `SessionDigest.
almostSaid()` is published on `/ws/events` as a `suppressed` event from the one
place every candidate line is already written down, so the bus snapshot is
**eleven** events plus one per card. Neither of the two real runs held anything
back at the end — every candidate was either delivered or a duplicate — so the
tray's own look is checked on `/dev/cards`.

## V3-014: one call per turn in the follow-up window (2026-11-01)

The PRD asks for the follow-up verdict to "share the V3-002 question
classifier's call where a turn is question-shaped, and the V2-008 address
classifier's otherwise". Read literally that means teaching two prompts and two
schemas a third job; read as "do not pay twice", it is already satisfied by the
routing that was in place, and that is how it is built:

- a turn in the window that **says the name** is the address path's (V2-008),
  which owes it an answer whatever kind of question it is, and the window makes
  no call about it at all;
- a turn in the window that **does not** is skipped by `QuestionWatcher`
  (`inFollowUpWindow`, the option V3-002 left for this) and classified once by
  `server/answer/followUp.ts` instead.

So every turn in the window costs exactly one `reasoning_effort: "low"` Spark
call, which is what the criterion is protecting, and the follow-up prompt can be
written about one question — who is this turn for? — rather than bolted onto two
prompts about other ones.

**The two closing rules overlap, and the strict one wins.** "`to_room` or
`closing` → the window closes" and "the window closes after 2 consecutive turns
between humans" cannot both bite: the first turn between two humans already
closes it. `FOLLOWUP_MAX_HUMAN_TURNS` is therefore the backstop for turns that
have **no verdict yet** — verdicts are serialized, so two people talking faster
than the classifier can answer would otherwise leave Sotto listening across
them. Keeping the stricter rule is the "when unsure, close" principle the same
story states.

**A turn that names somebody else closes it with no model call.** The names are
the ones the group gave its own voices (US-007); a bare diarization label is not
a name anybody says out loud, and the speaker's own name does not count — "is
that per head or Craig's whole budget?" said *by* Craig is still a follow-up.

**The window opens on an answer that reached the room, spoken or on screen.**
`AnswerAgent.onFinished` fires after `SpokenAnswer.done()`, which is where
"after Sotto finishes speaking" lands; an answer whose `status` is `error` opens
nothing, because leaving Sotto listening after a failure would answer the room's
next sentence with the same error.

**The eval gate is structural, never judged.** `followups` (26 lines, 125.9 s)
marks the lines Sotto may answer — `wakeQuestions` 3 and 18, plus the new
`followUpLines` 4 and 5 — and `answersFrom` resolves each answer's turn against
them with `turnsForLine`'s slack. An answer to any other turn is a false answer
and the gate is zero. The capture also shows why no lexical rule could do this
job: "glass hire" came back as **"glass higher"**, and "And how much of that
would just be the glass higher?" is a follow-up only in context.

## V3-009: the knowledge folder

**The folder is read, not indexed.** `KNOWLEDGE_DIR` (default `knowledge/`,
git-ignored at the root so `server/knowledge/` is not hidden too) is a handful
of `.md`, `.txt` and `.csv` files, read whole at session start by
`KnowledgeIndex.load` and searched by matching the query's content words
against each line. No embeddings, which is what the PRD allows, and for a few
kilobytes also the right answer: a group asking "when does Harborview renew"
wants the line with those words on it. Two rules do the work that a bare
`includes` would not — **a CSV row carries its header** (`Harborview
Clinic,Pro,2027-03-01` means nothing without `customer,plan,renews_on`), and
the query is reduced to content words first, so "when does the Harborview
contract renew?" does not match every line that contains "the".
`load` returns **`null`** for a folder that is missing *or* empty, because that
is the one value every caller already branches on.

**A file is a source with no URL, and it is resolved the same way a page is.**
`knowledgeCitation("customers.csv")` is `{ url: "file:customers.csv", title:
"file: customers.csv" }`, and only a file **this search actually read** may be
cited — `resolveKnowledgeCitation` tolerates every spelling the model uses
(`customers.csv`, `knowledge/customers.csv`, `file: Customers.CSV`) and rejects
anything with a scheme, because it runs *before* US-013's URL resolution and
`https://x.com/prices.csv` is a page. The card renders a file source as text
rather than as a link: there is nothing for a reader to open.

**The group's own records are checked before the web, and that is what makes
one correction speakable at `normal`.** `Verifier` searches the folder with the
room's own words (never the headline — US-013's lesson), and only when lines
come back does it make one *ungrounded* Spark call against
`prompts/verify-knowledge.md`. Anything but `wrong` — and a `wrong` naming no
file we showed it, and a call that failed — falls straight through to the web
check, so losing the knowledge half never costs the web half. A `wrong` sets
`CandidateVerification.file`, which is the only thing that tells the two kinds
of correction apart downstream, and `spokenCorrectionAllowed` adds exactly one
cell to V3-008's table: `normal/factual_error/interject`. `cautious` is still
silent and a web-verified error still needs `bold`. The reasoning is the
read-back's: a group's own sheet quoted back is their sentence, they can check
it in ten seconds, and nothing on the web could have settled it.

**Measured on the real model** (`server/knowledge/knowledge.integration.test.ts`,
two calls, ~17 s): the renewal question came back in **7.8 s** citing
`file:customers.csv` with "Harborview Clinic renews March 1, 2027" and a spoken
line of "Harborview Clinic renews March first, twenty twenty-seven" — a year
spelled out because the line is written to be *heard*, which is worth knowing
before asserting on digits. The `$49` claim was settled by `notes.md` with no
web search at all, and said at boldness `normal` as "From notes.md: the notes
have Pro at $40 a seat a month on the list price sheet."

**The lead-in is dropped when the correction already names the file.** Asked
for the file's own phrasing the model sometimes writes the file name into the
sentence ("notes.md has Pro at $40"), and `From notes.md: notes.md has…` says
it twice; `fileCorrectionLine` uses such a sentence as the whole line. The
prompt now asks for the record's human name ("the price sheet", "the customer
list") instead, since the file name is attached separately.

**The eval, the e2e and the shadow run get no folder.** `createKnowledge`
defaults to none, exactly as `createVoice` and `createGlimmer` do, so `npm
test` reads nothing off the disk and a replay's result never depends on what
happens to be in `knowledge/` on this Mac. `server/app.ts` is the one place
that loads it.
