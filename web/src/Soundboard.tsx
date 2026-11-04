/**
 * `/dev/soundboard`: a scripted room that reacts on cue.
 *
 *     fixture WAV + timing -> one clip per line
 *       -> StereoPanner -> speakers      (A left, B right: the soundtrack)
 *       -> a mono GainNode -> MicCapture (same context) -> /ws/audio   (what Sotto hears)
 *
 * A `wav` session plays a recording that cannot go quiet for Sotto, so the
 * demo is driven from here instead: this page starts an ordinary `mic` session
 * and feeds it silence until a line is fired, so the operator can let Sotto
 * finish, leave a gap, or talk over it — exactly as a room would. The main page
 * (`/`) stays the one that plays Sotto's voice and the one that is recorded;
 * this page plays only the room, hard-panned, so a screen recording with
 * system audio carries both halves in sync and already in stereo.
 *
 * Keys: Space or Enter fires the next line, Escape cuts whatever is playing,
 * digits fire an ad-lib. Clicking any line fires it at once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FixtureScript, FixtureTiming } from "../../shared/fixtures.js";
import { MicCapture, startMicCaptureFrom } from "./audio/micCapture.js";

/** Comfort noise on the mic bus: white noise at about -60 dBFS (see `start`). */
const NOISE_FLOOR_GAIN = 0.001;

/** The main script, from `?fixture=`; the ad-libs are always the same set. */
const DEFAULT_FIXTURE = "launch-workshop";
const EXTRAS_FIXTURE = "soundboard-extras";

/** What to do after a line, by fixture and line index. Shown under the line. */
const CUES: Record<string, Record<number, string>> = {
  "launch-workshop": {
    0: "Fire this the moment the hello starts. Line 3 only once the hello has finished.",
    10: "Go quiet. Sotto says “I'll check the drive time…”. Let it finish, then carry on.",
    13: "If the card says Research ready, leave a gap here: Sotto speaks the answer in it.",
    14: "A decision. Sotto may read it back — let it finish before the next line.",
    17: "Go quiet. Sotto may raise the thirty-person cap. Let it finish.",
    22: "Sotto acknowledges and starts answering. Fire 23 while it is talking, to cut it off.",
    25: "Let the wrap-up finish, then Stop.",
  },
};

interface LoadedFixture {
  name: string;
  script: FixtureScript;
  timing: FixtureTiming;
  buffer: AudioBuffer;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return (await response.json()) as T;
}

async function loadFixture(name: string, context: AudioContext): Promise<LoadedFixture> {
  const base = `/api/dev/fixtures/${name}`;
  const [script, timing, wav] = await Promise.all([
    fetchJson<FixtureScript>(`${base}/script.json`),
    fetchJson<FixtureTiming>(`${base}/timing.json`),
    fetch(`${base}/audio.wav`).then((response) => {
      if (!response.ok) throw new Error(`${base}/audio.wav: ${response.status}`);
      return response.arrayBuffer();
    }),
  ]);
  const buffer = await context.decodeAudioData(wav);
  return { name, script, timing, buffer };
}

/** "Hi, I'm Craig." names the speaker letter that said it. */
function speakerNames(script: FixtureScript): Record<string, string> {
  const names: Record<string, string> = {};
  for (const line of script.lines) {
    const match = /\bI'?m ([A-Z][a-zA-Z]+)\b/.exec(line.text);
    if (match?.[1] !== undefined && names[line.speaker] === undefined) names[line.speaker] = match[1];
  }
  return names;
}

interface Playing {
  key: string;
  source: AudioBufferSourceNode;
}

export function Soundboard(): JSX.Element {
  const fixtureName = useMemo(
    () => new URLSearchParams(window.location.search).get("fixture") ?? DEFAULT_FIXTURE,
    [],
  );
  const [main, setMain] = useState<LoadedFixture | null>(null);
  const [extras, setExtras] = useState<LoadedFixture | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [next, setNext] = useState(0);
  const [playing, setPlaying] = useState<string[]>([]);
  const [chunks, setChunks] = useState(0);

  const context = useRef<AudioContext | null>(null);
  const toMic = useRef<GainNode | null>(null);
  const capture = useRef<MicCapture | null>(null);
  const active = useRef<Playing[]>([]);
  const nextRef = useRef(0);

  // The audio graph needs a gesture, so nothing is built until Start — but
  // the fixtures can be fetched and decoded with a throwaway context now.
  useEffect(() => {
    const decoder = new AudioContext();
    void (async () => {
      try {
        setMain(await loadFixture(fixtureName, decoder));
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error));
      }
      try {
        setExtras(await loadFixture(EXTRAS_FIXTURE, decoder));
      } catch {
        // Ad-libs are optional: an unrendered extras fixture leaves the panel out.
      }
    })();
    return () => void decoder.close().catch(() => undefined);
  }, [fixtureName]);

  useEffect(() => {
    const timer = setInterval(() => setChunks(capture.current?.chunksSent ?? 0), 500);
    return () => clearInterval(timer);
  }, []);

  const cutAll = useCallback(() => {
    for (const one of active.current) {
      try {
        one.source.stop();
      } catch {
        // Already ended.
      }
    }
    active.current = [];
    setPlaying([]);
  }, []);

  const fire = useCallback(
    (fixture: LoadedFixture, index: number) => {
      const ctx = context.current;
      const mic = toMic.current;
      if (ctx === null || mic === null) {
        setProblem("Press Start first: the session has to be running before a line can be heard.");
        return;
      }
      const line = fixture.timing.lines[index];
      const words = fixture.script.lines[index];
      if (line === undefined || words === undefined) return;
      const key = `${fixture.name}:${index}`;
      const source = ctx.createBufferSource();
      source.buffer = fixture.buffer;
      const panner = ctx.createStereoPanner();
      panner.pan.value = words.speaker === "A" ? -1 : 1;
      source.connect(panner).connect(ctx.destination);
      source.connect(mic);
      const entry = { key, source };
      active.current = [...active.current, entry];
      setPlaying((was) => [...was, key]);
      source.addEventListener("ended", () => {
        active.current = active.current.filter((one) => one !== entry);
        setPlaying((was) => was.filter((one) => one !== key));
      });
      source.start(0, line.startMs / 1000, (line.endMs - line.startMs) / 1000);
      if (fixture.name === fixtureName) {
        nextRef.current = index + 1;
        setNext(index + 1);
      }
    },
    [fixtureName],
  );

  const fireNext = useCallback(() => {
    if (main === null) return;
    if (nextRef.current >= main.script.lines.length) return;
    fire(main, nextRef.current);
  }, [fire, main]);

  const start = useCallback(async () => {
    if (main === null || session !== null || starting) return;
    setProblem(null);
    setStarting(true);
    try {
      const params = new URLSearchParams(window.location.search);
      const rate = Number(params.get("rate") ?? "0");
      const ctx = new AudioContext({ latencyHint: "interactive", ...(rate > 0 ? { sampleRate: rate } : {}) });
      if (ctx.state === "suspended") await ctx.resume();
      // Everything fired is also summed, mono, into this node, which is what
      // the capture reads — in this same context, so no `MediaStream` hop.
      const mic = ctx.createGain();
      mic.channelCount = 1;
      mic.channelCountMode = "explicit";
      // A real microphone never sends exact zeros, and the transcription
      // API's endpointer turns out to need the noise: fed digital silence
      // between clips it never closed a turn on its own — every speechEnd in
      // the first two board takes arrived only when the *next* clip began
      // (2.2 s median after the last word, against 0.7 s on a real mic), and
      // "Sotto, go ahead" stayed open for 20 s until the next line merged
      // into it. So the mic bus carries a faint noise floor, about -60 dBFS,
      // which also keeps the input bus active between clips. It never goes
      // to the speakers.
      const floor = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const samples = floor.getChannelData(0);
      for (let i = 0; i < samples.length; i += 1) samples[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = floor;
      noise.loop = true;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = Number(params.get("noise") ?? NOISE_FLOOR_GAIN);
      noise.connect(noiseGain).connect(mic);
      noise.start();
      const response = await fetch("/api/session/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { kind: "mic" } }),
      });
      const body = (await response.json()) as { session?: { id: string }; error?: string };
      if (!response.ok || body.session === undefined) {
        throw new Error(body.error ?? `start failed: ${response.status}`);
      }
      capture.current = await startMicCaptureFrom({ context: ctx, source: mic, onError: setProblem });
      // For poking at from the console on this dev page.
      (window as unknown as { __board?: unknown }).__board = { capture: capture.current, context: ctx };
      // Only now can a line be fired: the graph is published to `fire` after
      // the capture is listening to it, so nothing plays into a stream
      // nobody is reading yet.
      nextRef.current = 0;
      setNext(0);
      context.current = ctx;
      toMic.current = mic;
      setSession(body.session.id);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }, [main, session, starting]);

  const stop = useCallback(() => {
    cutAll();
    // A clean close of the audio socket is the mic's own end of input: the
    // server pads the tail, drains, and the session finishes itself.
    capture.current?.stop(); // also closes the context
    capture.current = null;
    context.current = null;
    toMic.current = null;
    setSession(null);
  }, [cutAll]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        fireNext();
      } else if (event.key === "Escape") {
        cutAll();
      } else if (/^[1-9]$/.test(event.key) && extras !== null) {
        const index = Number(event.key) - 1;
        if (index < extras.script.lines.length) fire(extras, index);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cutAll, extras, fire, fireNext]);

  const names = useMemo(() => (main === null ? {} : speakerNames(main.script)), [main]);
  const cues = CUES[fixtureName] ?? {};

  return (
    <main className="board">
      <header className="board__header">
        <h1 className="board__title">Soundboard · {fixtureName}</h1>
        <p className="board__note">
          Open <a href="/" target="_blank" rel="noreferrer">the main page</a> in another window: it plays
          Sotto's voice and is the one to record. This page plays the room — {names.A ?? "A"} left,{" "}
          {names.B ?? "B"} right — and sends it to Sotto as the microphone.
        </p>
        <div className="board__controls">
          <button type="button" onClick={() => void start()} disabled={main === null || session !== null || starting}>
            {starting ? "Starting…" : "Start"}
          </button>
          <button type="button" onClick={stop} disabled={session === null}>
            Stop
          </button>
          <button type="button" onClick={fireNext} disabled={session === null || main === null}>
            Next line (Space)
          </button>
          <button type="button" onClick={cutAll} disabled={playing.length === 0}>
            Cut (Esc)
          </button>
          <span className="board__status" data-testid="board-status">
            {session === null ? "no session" : `${session} · ${chunks} chunks sent`}
          </span>
        </div>
        {problem !== null && <p className="board__problem" role="alert">{problem}</p>}
      </header>

      {main === null ? (
        <p className="board__note">Loading {fixtureName}…</p>
      ) : (
        <ol className="board__lines" data-testid="board-lines">
          {main.script.lines.map((line, index) => {
            const key = `${main.name}:${index}`;
            const cue = cues[index];
            return (
              <li
                key={key}
                className={
                  "board__line" +
                  (index === next ? " board__line--next" : "") +
                  (index < next ? " board__line--done" : "") +
                  (playing.includes(key) ? " board__line--playing" : "")
                }
                data-index={index}
              >
                <button type="button" className="board__fire" onClick={() => fire(main, index)}>
                  <span className="board__index">{index}</span>
                  <span className={`board__speaker board__speaker--${line.speaker}`}>
                    {names[line.speaker] ?? line.speaker}
                  </span>
                  <span className="board__text">{line.text}</span>
                </button>
                {cue !== undefined && <p className="board__cue">{cue}</p>}
              </li>
            );
          })}
        </ol>
      )}

      {extras !== null && (
        <section className="board__extras">
          <h2 className="board__heading">Ad-libs (keys 1–{Math.min(9, extras.script.lines.length)})</h2>
          <div className="board__grid">
            {extras.script.lines.map((line, index) => (
              <button
                key={index}
                type="button"
                className={
                  "board__adlib" + (playing.includes(`${extras.name}:${index}`) ? " board__line--playing" : "")
                }
                onClick={() => fire(extras, index)}
              >
                <span className="board__index">{index + 1}</span>
                <span className={`board__speaker board__speaker--${line.speaker}`}>
                  {names[line.speaker] ?? line.speaker}
                </span>
                <span className="board__text">{line.text}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
