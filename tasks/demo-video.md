# Demo video: plan and run sheet

Three minutes, nobody on camera. The product is the actor: the `launch-workshop` fixture
plays through a real `wav` session in the real UI with Sotto's voice on, and the screen is
recorded. Craig narrates over the top (voice only). No generated video anywhere.

## Shape (3:00)

| Time | What is on screen | Audio |
|---|---|---|
| 0:00–0:20 | Slide 1 (title), slide 2 (stack) | Craig's intro, below |
| 0:20–2:35 | The session, lightly cut | Room (stereo, EJ left / Craig right) + Sotto (centre) + short callouts as text |
| 2:35–2:55 | Slide 3: how it decides | Craig, one or two sentences |
| 2:55–3:00 | End card: repo, licence | — |

The rendered conversation is 148 s, so the middle section needs about 15–20 s of cuts
(the two long waits for a search are the obvious places; keep the first one, trim the second).

## Intro copy (slides 1–2)

> I'm Craig, and I built Sotto: a voice agent that sits in your meeting, answers when it is
> asked, and looks things up on its own when the room wonders something out loud. It speaks only
> in a pause, and only when it has something worth saying.
>
> Sotto is built on Meta's Muse Spark 1.3 for everything it writes, Muse Glimmer running
> locally for judgment calls, and Meta's realtime transcription. The rest of the stack is on
> screen.
>
> The code is open source on GitHub under the MIT licence. Let's watch Sotto in a meeting.

Two corrections to the draft: the model is **Muse Spark 1.3** (not "Meta Spark"), and the
repo currently has **no LICENSE file, no `license` field and no GitHub remote**, so the last
line is a promise to keep before recording: add a LICENSE, set `"license"` in `package.json`,
push.

**Slide 2, stack:** Meta Realtime ASR (`api.meta.ai`, diarized) · Muse Spark 1.3 (answers,
notes, observer, research) · Muse Glimmer 30B via Ollama (local judgment) · Jev (TypeSafe
System One, sub-second gating) · ElevenLabs (Sotto's voice, streamed) · MCP (tools) ·
Node 22 / TypeScript / Fastify / React.

**Slide 3, how it decides:** one diagram — transcript → notes → judgment → *speak only in
silence* — and the "almost said" tray as the one-line caption: Sotto shows you what it chose
not to say.

## Beats to catch, on the rendered audio's clock

| Audio time | Line | What Sotto should do |
|---|---|---|
| 0.0–21.5 | (hello) | Says hello; names appear at 24.8 / 26.3 |
| 36.3 | EJ: hard cap of thirty, fire code | goes on the notes |
| 57.6–68.4 | Craig: how long is the drive? EJ: three or four hours | **claim** "I'll check the drive time", card fills, **spoken answer** at a later gap |
| 92.4–100.7 | EJ: open fifty tickets. Craig: fifty, okay | **contradiction** against the thirty-cap, a card (at often/bold, said aloud) |
| 121.2 | EJ: Sotto, what does Eventbrite charge… | acknowledgment, holding line, searched answer |
| 130.8 | Craig: Sotto, hold on, we'll read it after | Sotto **yields**; the card stays raised |
| 139.0 | Craig: Sotto, wrap us up | the digest, spoken |

If the drive-time beat lands, the video has its moment. If the contradiction is only a card,
that is still the restraint story: cut to the card and the ✋ count.

## What the dry run showed (2026-11-04, `sessions/2026-11-04_0903-wav-launch-workshop`)

A `wav` take runs the real pipeline end to end, but **a recording cannot go quiet for Sotto**,
and that decides the shape of the video:

- The claim ("I'll check the drive time from Portland to Bend", 6.5 s after the question) and the
  read-back ("Got it: start at 11") were both talked over by the next scripted line. Two yields
  in ten minutes is the "speak up less" rule, so frequency stepped itself from often to normal at
  88 s and the contradiction (scored 0.95, `interject`) went out as a quiet card under cooldown.
- The drive-time research was ready 12 s after the question, but the answer was never said:
  each still-current check took 3.5–8 s and this script lands a line every ~4 s, so no verdict
  covered the latest turn before a gap, and by 101 s the verdict was `moved_on` — correctly, the
  room had settled on eleven and lunch.
- Two identical "Portland to Bend" research cards went up (`idea-1` and `idea-2`, same clean
  question): a dedupe miss on the speculative path, worth fixing before any recording.
- What did land: the hello, both names, the notes, the cap-vs-fifty question card raised and
  pinned to the "$5 tickets" decision, "Let me pul—" cut off by "Sotto, hold on" with the
  Eventbrite answer raised on its card, and a full spoken wrap-up.

**Fixed after the dry run (same day):** `ResearchCards.bringForward`/`reuse` now re-use the
card a packet was already delivered on (`cardIdFor`), so a repeated question brings the
filled-in card forward instead of adding a twin (`ResearchCards.test.ts` holds it). And the
still-current check runs at `reasoning_effort: "minimal"` (`server/question/stillCurrent.ts`),
which on the other gated classifiers halved the latency with identical verdicts — re-read
`timing.jsonl`'s `still_current` lines on the next take to confirm it covers in time.

So the video is recorded **live, voices only**: Craig and EJ read
`tasks/checkpoint-speaking-lines.md` (it already has the "go quiet" cues) into the microphone
with the screen recorded. The product's thesis is reacting to a room; a room that cannot react
makes it look worse than it is. The WAV take stays as the safety copy and as B-roll.

## Recording a take (live)

1. `npm run dev`, open `http://localhost:5173`, mute off.
2. Start recording the browser window with system audio (OBS: "macOS Screen Capture" with
   audio; or Screen Studio). Record at the final frame size.
3. Press **Start** (the microphone). **Then** set frequency **often** and boldness **bold** in
   the header — Start resets both to normal/normal, so setting them first is lost.
4. Read the sheet. Go quiet whenever Sotto starts; let it finish unless the cue says to talk
   over it. "Sotto, wrap us up", let it finish, Stop.
5. A take is about four minutes and under a dollar. Do three; keep the best.

**Room audio.** A mic session writes what Sotto heard to the session folder's `audio.wav`
(24 kHz mono, on the same clock as every Sotto line in `transcript.md`), so the room track is
already recorded and already aligned: lay it under the screen capture with its start at the
hello's first audio. For hard-panned voices, record each of you on your own mic in Logic at
the same time and sync by a clap, or sit either side of one mic and leave it mono.

**Fallback, WAV take.** Same as above but start with, from the devtools console:

```js
await fetch("/api/session/start", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ source: { kind: "wav", fixture: "launch-workshop" } }) }).then(r => r.json())
```

and set often/bold *after* it returns. Lay `fixtures/audio/launch-workshop.stereo.wav` (EJ left,
Craig right, `node scripts/pan-fixture.mjs launch-workshop`) under the capture with its start at
the hello's first audio minus about 0.3 s. Expect Sotto to be talked over and stepped down.

## Narration

Craig's voice over the recording, recorded alone in QuickTime or Logic, no camera. Say little
over the session itself: the callouts carry it ("Nobody asked. It waited for a pause.").
If not narrating by voice, render the intro through ElevenLabs in a voice that is **not**
Matilda, so the narrator never sounds like Sotto.
