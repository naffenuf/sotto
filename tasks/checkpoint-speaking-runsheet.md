# V3-011 runsheet: live test of speaking up

Not the checkpoint file. `tasks/checkpoint-speaking.md` is written after this session from the
session folder plus your verdicts; this is what to do and say during it. ~10 minutes, two people
(Craig + EJ, or a phone voice reading EJ's lines). Adapt freely; react to whatever Sotto does.

## Before Start

1. `npm run dev` is running (it is). Open one Sotto tab in Chrome, click anywhere on the page
   once (audio needs a gesture).
2. Header selects: **frequency `often`, boldness `bold`**. Reason: read-backs are only *said* at
   `often`, verified corrections only at `bold`, and the "not now" / two-yields steps need
   somewhere to drop *from*. Expect the header to show `normal` after step 7 and `rare` after
   step 8.
3. Press Start. Let the hello finish (18 s), then say your names: "Hi, I'm Craig." / "And I'm EJ."
4. Keep an eye on the ✋ count in the header and the "almost said" tray under the cards.

Cooldown is 90 s at `often`, 180 s at `normal`: one unprompted line per cooldown. Don't rush the
beats; silence between them is where Sotto speaks.

## The conversation (a product launch workshop, same setting as the demo script)

Watch-fors are in brackets. Each beat is one acceptance item.

**1. Setup (no Sotto expected).**
C: "So, the launch workshop. The eighteenth, at the makerspace, on the grant money."
E: "The makerspace room caps at thirty. Fire code, so that's a hard thirty."
C: "Thirty kits is what the grant covers anyway."

**2. Wonder aloud, something lookable.** Then stop talking.
C: "I want the Bend crowd to come. How long is the drive from Portland to Bend, actually?"
E: "Three hours? Four? I did it once in the snow."
*[quiet 3–4 s. Expect "I'll check the drive time" at the first gap, then the answer at a later
gap, 15–30 s on. Note both timings and whether either landed on top of someone.]*

**3. Rhetorical questions (nothing expected).** Keep going while the search runs.
E: "Who even drives three hours for a workshop, right?"
C: "Yeah, what were we thinking." *[pause]* "Okay, start at eleven and feed them."
*[expect no claim, no card for these two]*

**4. Answer your own question before Sotto does.**
C: "What does the makerspace charge for a Saturday, do you know?"
E: "It's in the grant doc, I'm looking at it. Two hundred, flat." *(say this within ~5 s)*
*[expect: no answer said. A claim may already be out ("I'll check the rate"); if so it should
close out quietly, not read the answer. Note what happened.]*

**5. Decision with a risk raised then dropped → read-back with a probing question.**
E: "Tickets. I say we open fifty. The Bend people alone will take twenty."
C: "Fifty's a lot for a thirty-cap room… eh, no-shows. Fine."
E: "Five bucks a ticket, cuts no-shows in half."
C: "Okay: fifty tickets at five bucks, page goes up tonight, invite Friday."
*[quiet. Expect a read-back ("Got it: fifty tickets at five dollars…") with a question back about
the thirty cap, or a glow/interject card on the cap. Note which, and whether the question was
the right one.]*

**6. Talk over it, once.** The moment Sotto starts the read-back (or whatever it says next),
E starts a sentence over it:
E: "Oh wait, and the kit list has to go on the page."
*[expect Sotto to stop within ~1.5 s. First yield.]*

**7. Decision with no risk → plain read-back.**
C: "Dana's doing the mechanic slot, three hundred for the afternoon. Done."
E: "Done."
*[quiet. Expect a short read-back and nothing else — unless cooldown eats it (90 s since beat 5).
If it's quiet, that's the budget, not a bug; move on.]*

**8. "Not now."** Right after Sotto's next unprompted line (within 15 s of it):
C: "Sotto, not now."
*[expect: header frequency drops `often` → `normal`, a numbered notice card. If nothing
unprompted has happened recently, wonder something aloud first to provoke one.]*

**9. Side talk during Sotto's speech (deferred V2-008).** Ask it something so it talks:
E: "Sotto, what does Eventbrite charge per ticket on a five dollar event?"
While it answers, C and E chat to each other, not to Sotto:
C: "Did you ever hear back from the sign company?"  E: "Thursday, they said."
*[expect: it stops (second yield; at `normal` the two-yields rule → `rare`). Note whether the
side talk went into the transcript cleanly and whether Sotto's own line shows as `Sotto`.]*

**10. Two people at once (deferred V2-008).** Both say a different sentence simultaneously for
~3 s. *[just note what the transcript shows: one speaker, two, garbage.]*

**11. Call on it with its hand raised.** Check the ✋ count > 0 (by now a research card or the
cap contradiction should be waiting). Then:
C: "Sotto?"  *(or "Sotto, go ahead")*
*[expect it to say the held card: no gap wait, no budget. Note what it chose and whether the
count dropped.]*

**12. Wrap.**
E: "Last thing, who's at the door with the sign-in sheet?"  C: "I'll find a volunteer."
C: "Sotto, wrap us up."  Then Stop.

## After Stop

Tell me the session folder (`sessions/<stamp>-mic`) and, for each thing Sotto said unasked:
welcome / not / wrong, and whether it stepped on anyone. I'll pull the timings, yields and
classifier verdicts out of `timing.jsonl`, `candidates.jsonl` and `research.jsonl` and write
`tasks/checkpoint-speaking.md`. Also needed before the loop restarts: your welcome / not / wrong
on the two shadow reports (`tasks/shadow-2026-10-30_0919-mic.md`, `…_2141-mic.md`); I can draft
those for you to correct.
