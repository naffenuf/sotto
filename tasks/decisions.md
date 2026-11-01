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
