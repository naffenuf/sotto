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

> This is Sotto: a voice agent that sits in your meeting and speaks only when it has something
> worth saying.
>
> It's built on Meta's Muse Spark for everything it writes, Muse Glimmer running locally for
> judgment calls, and Meta's realtime transcription. Let's watch a meeting.

Cut from the first version (28 s, now 15 s) because Sotto's own hello says how it behaves a few
seconds later, and the end card says where the code is: the repeat was the first thing a viewer
noticed. The copy lives in `scripts/render-narration.ts`; `npm run demo:narration -- 01-title`
re-renders one line.

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
recording's clock, as first noted by eye (the measured ones are in `demo/take4.timeline.md`):

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

## Cutting by line, not by second

The first cut was a list of seconds read off the video, and every revision moved them by a second
or two because nobody could see where a word started (E2 ran to 243.1, which is EJ's "Last thing"
starting at 243.14). The take already says exactly when everything was said, two ways:

- **The session folder lines up with the take at one offset.** Cross-correlating the session's
  `audio.wav` (what the API heard) with the take's soundtrack puts the take's clock at the
  session's plus **31.98 s**, the same in every window that has room speech: no drift. So every ASR
  frame in `events.jsonl` (each line's text and speaker, and how far into the audio each partial
  had got) is on the take's clock.
- **The take's stereo separates the three voices.** EJ is hard left, Craig hard right, Sotto
  centre, mixed digitally with zero leakage, so per 10 ms the shared part of L and R is Sotto and
  what is left on each side is a person. That is where each voice's words begin and end, and the
  only record of where Sotto *stopped* (a Sotto transcript row has a start and nothing else).

Sotto's words inside a long line (the hello, the wrap-up) need one more measurement: its comma
pauses are as long as its sentence pauses, so the pauses alone cannot say which is which.
`npm run demo:transcribe-sotto` takes Sotto's channel out of the take and sends only those
stretches through the realtime transcription, the same instrument the room's partials come from,
and maps the frames back (2 min of real time, a few cents, written beside the take).

### The workflow

```
npm run demo:transcribe-sotto   # once per take: Sotto's word positions (real API)
npm run demo:timeline           # demo/take4.timeline.md: every line, exact in/out
npm run demo:check              # resolve the cut, write demo/build/review.md, encode nothing
npm run demo:video              # the same check, then the MP4
```

1. **Pick lines from `demo/take4.timeline.md`**, never from the video. It is committed, so it can
   be read without the take or the session (both are git-ignored).
2. **Name cut points by what is said** in `SEGMENTS` in `scripts/build-demo-video.mjs`:
   `start("Venue's easy")`, `end("not a soft one")`. A fragment that opens or closes its line is
   that line's measured edge; one inside a line goes between the two words around it, in a pause
   in that voice. `start(…, -1)` shifts by a second; `{ who: "Sotto" }` disambiguates. Callouts
   take the same refs. The resolver pads each edge (0.3 s in, 0.4 s out) into the surrounding
   silence, never past half of it.
3. **The build refuses a cut that lands on a voice** unless that edge has a fade, and names the
   segment, the time and who is talking. It also refuses a fragment that is in no line or in
   several, and a mid-line cut with no pause to cut in ("I'll grab a volunteer. Sotto, wrap us up"
   has none between its sentences).
4. **Check `demo/build/review.md`**, not the MP4: per segment, how each edge was found, who is
   talking there, every line it contains (✓ whole, ⚠ cut), callouts in programme time, and the
   first and last frame side by side. An edge marked **ESTIMATED** was placed by share of
   characters; run `demo:transcribe-sotto` and it goes away.

A new take needs only `scripts/demo/config.mjs` pointed at it and the session it recorded.

### The cut (take 4)

| # | From → to | What the audience gets |
|---|---|---|
| A | "Hi, I'm Sotto" → Sotto's "I'll check the drive time…" | one unbroken stretch: the hello, the names, Craig's opener, the cap of 30 and "30 kits", the drive-time question, EJ's guess, the claim |
| C2 | Sotto's "On the drive time…" → "…by lunch" | the spoken answer |
| D | "Good. And tickets" → "Free or five bucks?" | 50 tickets |
| E1 | "Sotto, go ahead" | the call-on |
| E2 | Sotto's "50 tickets — how does that fit…" → "…we'll read it after" | the correction, the Eventbrite question, the yield |
| F | "I'll grab a volunteer" → wrap-up's "…Charge 5 dollars for tickets." | the wrap-up, fading out |

Frame: crop x 101–1820, y 145–1080 (Chrome's tab strip, address bar and the extension banner
go), scale to 1920 wide, letterbox to 1080. Segments dissolve into each other, picture and sound,
over 0.4 s (`CROSSFADE_S`). The overlap must be silent on both sides, so the resolver pads those
edges by the crossfade plus `JOIN_BREATH_S` (0.25 s) and the check fails a join whose pause is too
short; measured, every join has 0.8–0.95 s of quiet between speakers. Loudness is normalised to
−16 LUFS in two passes (measured −16.1). Total 2:54.

The review sheet lists what each join leaves out. As of this cut: the start-at-11 exchange, the
mechanic, "Five bucks… Friday… which ticketing thing", and "who's at the door". Note the wrap-up
still names "start at 11" and "5 dollars" as decisions the audience never heard made.

## Building the video

`npm run demo:slides` (slides to 1080p PNGs) and `npm run demo:narration` (Adam reads the three
narration lines; the WAVs are committed because they cost credits), then the workflow above. The
slides' PNGs and the MP4 are rebuilt.

## Narration

Craig's voice over the recording, recorded alone in QuickTime or Logic, no camera. Say little
over the session itself: the callouts carry it ("Nobody asked. It waited for a pause.").
If not narrating by voice, render the intro through ElevenLabs in a voice that is **not**
Matilda, so the narrator never sounds like Sotto.
