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
