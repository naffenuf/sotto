# V3-011 checkpoint: live test of speaking up

- Session: `sessions/2026-11-01_1928-mic` (6:10 of audio, 27 room turns, two people: Craig and EJ)
- Script: `fixtures/scripts/launch-workshop.json` read live, settings `normal/normal`, voice on
- Shadow reports marked up before the session: `tasks/shadow-2026-10-30_0919-mic.md` (nothing was
  said out loud; nothing to judge) and `tasks/shadow-2026-10-30_2141-mic.md` (one read-back, **welcome**)
- Every number below is read off `timing.jsonl`, `candidates.jsonl`, `research.jsonl` and
  `answers.jsonl` in that folder; the verdicts are Craig's.

## Unprompted contributions

| # | At | What Sotto said | Trigger | Timing | Yielded | Welcome? |
|---|---|---|---|---|---|---|
| 1 | 01:02 | "I'll check Portland to Bend drive time." | EJ: "How long is the drive from Portland to Bend actually?" (00:43) | claim 6.6 s after the question's last word; the room had not answered | no, not needed | **welcome** |
| 2 | 01:05 | "On Portland to Bend drive time: about three and a quarter hours, roughly a hundred and sixty miles non-stop." | same question | answer 9.5 s after the question (search 7.7 s), into a real pause, still-current: no call needed | no | **welcome** |
| 3 | 04:12 | "On the food truck hire cost: about eight hundred to twenty-eight hundred dollars for two hours…" | EJ: "I wonder what a food truck charges for two hours." (03:25) | the claim was skipped (`no_gap`: Craig asked the Eventbrite question straight after); the answer waited behind that answer and its barge-in, 45 s after the question | **yes** — Craig's "Thursday they said" cut it off; the retry was not said (frequency cooldown) | **welcome** |

- **False ones:** none. Nothing was said that was not about a question the room had asked itself.
- **Late ones:** #3, by design of the queue — one utterance at a time, and a wake answer was in
  flight — and the room had moved on by then. Craig still calls it welcome.
- **Cooldown bit the planted contradiction.** cand-1 ("50 tickets — how does that work with the hard
  30-person cap?") scored 0.75, above the interject threshold, and was downgraded to a **glow** at
  01:52 because contribution #2 had started the 180 s cooldown 48 s earlier. Correct per V2-017, and
  worth knowing when reading the demo: one spoken answer silences the next interjection for three
  minutes at `normal`.

## The scripted beats

| Beat | Happened? | Record |
|---|---|---|
| Wonder aloud, Sotto looks it up and says it | yes, twice | #1–#3 above; both open questions classified in 1.8 s and 2.7 s |
| Rhetorical question ignored | yes | "Who even drives three hours for a workshop right?" → `rhetorical`, nothing said |
| Room answers its own question first | yes | "What does the Makerspace charge for a Saturday?" → Craig answered; classified `none` (one 6 s classifier timeout, fallback) |
| Talk over Sotto mid-sentence, it stops | yes | "Soto not now" at 03:04 stopped the status answer (barge-in confirmed in 7 ms); "Soto, not now" at 04:08 stopped the Eventbrite answer (8 ms) |
| "Not now" turns the frequency down | yes | second "not now" → `quieter`, `normal` → `rare`; the first was read as "stop this answer" because it landed during one, which is the designed split |
| Two yields in 10 min step the frequency down | **not reached** | one yield (#3); the rule is tested against real `Reservations` records in `Steering.test.ts` |
| Decision with a dropped risk, read back | **not exercised** | no turn was classified `decision_closing`; "Okay, 50 tickets at five bucks, page goes up tonight" had no closing shape in the transcript |
| Decision with no risk | not exercised | same |
| Call on the raised hand | **not exercised** | cand-6 ("Does the kit list have to go on the page?") went up as a glow at 04:16, raised; nobody said "Sotto?" to it |
| Side talk during Sotto's speech (V2-008) | yes, and it found a bug | see problem 1 |
| Two people at once (V2-008) | yes | one garbled B turn at 04:17 mixing both lines; the API transcribes one stream and labels one voice per turn, so this is its limit, not Sotto's |
| Wrap-up | **missed** | "Sado, wrap us up" — spelling; see problem 2 |

## Addressed questions, for the record

| Asked | Classified | First words | Full answer |
|---|---|---|---|
| "Soto? Where are we at at this point?" (02:14) | 3.8 s | 13.4 s (no holding line) | interrupted at 02:55 |
| "Soto, what is Eventbrite charge per ticket on a $5 event?" (03:28) | 0.0 s (reused the early check) | 4.7 s | 19.4 s |
| "Soto? Last thing, who's at the door with the sign-in sheet?" (04:59) | 2.4 s | 5.7 s | 13.7 s |

## Problems found, and what was done about each

1. **A person's line was swallowed as Sotto's own echo.** Craig's "Oh wait, and the kit list has to
   go on the page?" at 02:47, said over the status answer, matched the answer on function words
   (8 of 12 tokens: "and the has to on the page", plus "kits") and never reached the transcript.
   Fixed in `d0e5f75`: the echo matcher scores content words only and needs three of them.
2. **Two addresses were never heard.** "Sotto, where are we at" came back as "So to where where are
   we at" and "Sotto, wrap us up" as "Sado"; neither is a spelling the matcher knew. Fixed in
   `d0e5f75`: "sado" and "sana" added, a sentence-initial "so to" folded into the name, and every
   address rewritten to "Sotto" in the transcript. The classifier prompt lists the same.
3. **Thirteen seconds of silence after "Mm-hm".** Notes questions got no holding line on the theory
   they answer in a second or two; the status question took 9.8 s to its first sentence. Fixed in
   `1fa618a`: every spoken question gets a holding line, and a notes question's says it is checking
   the notes.
4. **EJ stayed "B".** "I'm Craig. I'm EJ. Okay, so…" arrived as one 22-second turn under one label,
   because the service ends a turn on silence, not on a change of voice. Fixed in `1fa618a` for the
   introduction beat: a second name introduced in one turn is given to the next voice the session
   meets. The underlying limit stands — two people running straight on share a turn.

Not changed, and noted for the next run: a plain interruption (no name) does not stop an answer,
by V2-007's design; both "not now"s did. And one `question` classification in nine timed out at
6 s and fell back, V3-002's known one-in-forty.

## Would you leave it on?

Craig: "We have to — it's the core feature of the app. It will take lots of tweaking. So yes."

**RESULT: PASS** — three unprompted contributions, all three welcome, none false; the four
problems above are fixed and committed. The beats not reached (two yields, the read-backs, calling
on the raised hand) are covered by offline tests against real records and stay on the list for the
next live run, which is also the first exercise of problems 2–4 against the real model.
