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

Read by Adam, the ElevenLabs voice that plays Craig at the table, so the one voice the
audience meets in the intro is the one they then hear in the meeting. No introduction and
no "I built": the narrator is a voice, not a person.

> This is Sotto: a voice agent that sits in your meeting, answers when it is asked, and looks
> things up on its own when the room wonders something out loud. It speaks only in a pause,
> and only when it has something worth saying.
>
> Sotto is built on Meta's Muse Spark 1.3 for everything it writes, Muse Glimmer running
> locally for judgment calls, and Meta's realtime transcription. The rest of the stack is on
> screen.
>
> The code is open source on GitHub under the MIT licence. Let's watch Sotto in a meeting.

The repo is public at github.com/naffenuf/sotto with the MIT licence on `main`.

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

So the video is recorded from the **soundboard** (`/dev/soundboard`): the scripted lines, fired
by hand on cue, so the room goes quiet when Sotto speaks, leaves a gap when a card is ready, and
talks over it only when the script says so. Nobody is on camera and nobody has to read lines.

## Recording a take (soundboard)

Two browser windows, both on `npm run dev`:

1. **Window A, the one you record:** `http://localhost:5173`. Click on it once (Chrome needs a
   gesture before it will play audio). This page plays Sotto's voice.
2. **Window B, the controls:** `http://localhost:5173/dev/soundboard`. It plays the room —
   EJ hard left, Craig hard right — and sends the same audio to Sotto as the microphone.
3. Start the screen recording of window A with **system audio** (OBS "macOS Screen Capture"
   with audio, or Screen Studio). Both windows' audio lands in it, already mixed and in stereo.
4. In window B press **Start**, then in window A set frequency **often** and boldness **bold**
   (Start resets both to normal/normal, so set them after). Then fire line 0 straight away.
5. Fire lines with **Space** (next) or by clicking any line; **Esc** cuts whatever is playing;
   digits **1–9** fire the ad-libs ("Sotto, not now", "go ahead", "yes please", …). Follow the
   yellow cues: go quiet when Sotto starts, leave a gap where a card is ready, and fire line 23
   while Sotto is answering to cut it off.
6. "Sotto, wrap us up", let it finish, then **Stop** on the board. The session folder
   (`sessions/<stamp>-mic/`) has `transcript.md`, `timing.jsonl` and `audio.wav` for the record.
7. A take is about four minutes and under a dollar. Do three; keep the best.

The soundtrack needs no syncing: the recording already carries the panned room from window B
and Sotto from window A.

**Fallback, WAV take.** `fixtures/audio/launch-workshop.stereo.wav` (EJ left, Craig right, from
`node scripts/pan-fixture.mjs launch-workshop`) laid under a screen capture of a `wav` session
started from the devtools console:

```js
await fetch("/api/session/start", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ source: { kind: "wav", fixture: "launch-workshop" } }) }).then(r => r.json())
```

Expect Sotto to be talked over and stepped down; the dry run above is what that looks like.

## Take 4 (the keeper): `demo/takes/take4.mov`

OBS window capture of the Chrome Sotto window, 1920×1080 H.264, stereo AAC (EJ hard left,
Craig hard right, Sotto centre), 348 s. Session `sessions/2026-11-04_1106-mic`. The top 145 px
are Chrome's tab strip, address bar and a yellow extension banner: crop them off. Beats on the
recording's clock:

| Recording time | What happens |
|---|---|
| 0–32 | nothing (OBS was started before the session): cut |
| 32.0 | "Okay, it's running" then the hello, to 53.5 |
| 55–58 | "Hi, I'm Craig" / "And I'm EJ", names land |
| 108.9–111.7 | **claim**: "I'll check the drive time from Portland to Bend." |
| 135.8–147.9 | **spoken answer**: 160 miles, three to three and a half hours |
| 208.9 | "Sotto, go ahead" |
| 213.5–225.9 | **the correction read out**: 50 tickets against the cap of 30 |
| 226.6 | "Sotto, what does Eventbrite charge…" → "One sec." → "Let me pull the current ticketing fees" |
| 238.8 | "Sotto, hold on, we'll read it after" cuts it off; the answer stays raised on its card |
| 254–309 | **wrap-up** (55 s: fade out partway) |
| 312 | Stop; an offer line follows during the drain: cut |

Warts to cut or live with: a read-back the board talked over shows as "Sotto: G (interrupted)"
in the transcript from ~1:10 on; the spoken correction says "B proposes" (a diarization label
where the name should be); the wrap-up lists the drive-time question as open.

## The cut (target 2:55 total)

Hard cuts at line boundaries, each segment a beat. Times are on `take4.mov`'s clock.

| # | In → out | Length | What the audience gets |
|---|---|---|---|
| A | 32.0 → 38.3 | 6 s | "Hi, I'm Sotto. I'm listening and keeping notes, and I'll only speak up when it's worth it." |
| A' | 51.9 → 61.2 | 9 s | "…just say Sotto. Would you each say your name?" / "Hi, I'm Craig." / "And I'm EJ." |
| B | 74.5 → 83.4 | 9 s | EJ: "One thing, though: it caps at thirty people. Fire code, hard thirty." |
| C | 88.4 → 111.7 | 23 s | Bend crowd → "How long is the drive?" → "Three hours? Four?" → **"I'll check the drive time…"** |
| C' | 135.0 → 148.0 | 13 s | **the spoken answer**: 160 miles, three to three and a half hours |
| D | 166.0 → 177.8 | 12 s | "I say we open fifty… The Bend people alone will take twenty." / "Fifty. Okay. Free, or five bucks?" |
| E | 206.9 → 243.1 | 36 s | "Sotto, go ahead" → **the correction read out** → "Sotto, what does Eventbrite charge…" → "One sec." → "Let me pull…" → **"Sotto, hold on"** |
| F | 248.0 → 266.0 | 18 s | "Sotto, wrap us up." → the wrap-up's first twelve seconds, fading out |

Demo total ≈ 2:06. Intro slides ≈ 25 s, close ≈ 20 s → about 2:50.

Callouts (bottom third, two seconds each, white on a dark band): at 108.5 "Nobody asked. It
waited for a pause."; at 135.5 "A sourced answer, in the next gap."; at 208.6 "It raised a
hand. The room called on it."; at 238.4 "It stops the moment anyone talks."; at 253.5 "A
wrap-up from its own notes."

Frame: crop x 101–1820, y 145–1080 (Chrome's tab strip, address bar and the extension banner
go), scale to 1920 wide, letterbox to 1080. Audio: a 20 ms crossfade at every cut, loudness
normalised to −16 LUFS, Sotto centre and the room panned as recorded.

## Building the video

```
npm run demo:slides      # demo/slides/*.html -> demo/build/*.png (Playwright, 1920x1080)
npm run demo:narration   # Adam reads the three narration lines -> demo/narration/*.wav
npm run demo:video       # the cut above from demo/takes/take4.mov -> demo/sotto-demo.mp4
```

`scripts/build-demo-video.mjs` holds the segment list and the callouts; change the cut there.
The narration WAVs are committed (they cost credits); the slides' PNGs and the MP4 are rebuilt.
First build: 2:40, −16.7 LUFS, 12 MB.

## Narration

Craig's voice over the recording, recorded alone in QuickTime or Logic, no camera. Say little
over the session itself: the callouts carry it ("Nobody asked. It waited for a pause.").
If not narrating by voice, render the intro through ElevenLabs in a voice that is **not**
Matilda, so the narrator never sounds like Sotto.
