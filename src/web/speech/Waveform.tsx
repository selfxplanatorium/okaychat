import { useEffect, useRef, type FC } from "react";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import { canRecord, displayLevel, levelDb, recordingLevel } from "./recorder";
import { sttEngineOf } from "./store";

const BAR = 3;
const GAP = 2;
/** A new bar enters from the right this often; the row glides one bar width per interval. */
const INTERVAL = 70;

type Source = () => number | null;

/**
 * Browser dictation holds the microphone itself, so the waveform opens a second capture to measure it. Touch devices
 * skip that: on Android a second capture can stop recognition. They get a gentle idle pulse instead.
 */
function openOwnSource(onReady: (source: Source) => void): () => void {
  let closed = false;
  let release = () => {};
  void navigator.mediaDevices
    .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    .then((stream) => {
      if (closed) return stream.getTracks().forEach((t) => t.stop());
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      onReady(() => displayLevel(levelDb(analyser, samples)));
      release = () => {
        stream.getTracks().forEach((t) => t.stop());
        void context.close().catch(() => {});
      };
    })
    .catch(() => {});
  return () => {
    closed = true;
    release();
  };
}

const idlePulse: Source = () => 0.12 + 0.1 * Math.abs(Math.sin(performance.now() / 260)) * Math.random();

/** Decorative scrolling waveform of the microphone level while dictating. */
export const DictationWaveform: FC<{ className?: string }> = ({ className }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const engine = useData((s) => sttEngineOf(s.settings?.speech));

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let source: Source = () => recordingLevel() ?? 0;
    let closeOwn = () => {};
    if (engine === "browser") {
      source = idlePulse;
      if (canRecord() && !matchMedia("(pointer: coarse)").matches) closeOwn = openOwnSource((own) => (source = own));
    }
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

    let width = 0;
    let height = 0;
    let levels: number[] = [];
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.ceil(width / (BAR + GAP)) + 2;
      levels = [...Array<number>(Math.max(0, count - levels.length)).fill(0), ...levels].slice(-count);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    let color = getComputedStyle(canvas).color;
    let last = performance.now();
    let frame = 0;
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      // After a hidden tab, start fresh instead of replaying every missed bar.
      if (now - last > 1000) last = now - INTERVAL;
      while (now - last >= INTERVAL) {
        last += INTERVAL;
        const previous = levels.at(-1) ?? 0;
        // Rises at once, falls over a few bars, so speech reads as shapes rather than flicker.
        const level = source() ?? 0;
        levels.push(level > previous ? level : previous * 0.45 + level * 0.55);
        levels.shift();
        color = getComputedStyle(canvas).color;
      }
      const shift = reduceMotion ? 0 : ((now - last) / INTERVAL) * (BAR + GAP);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let i = levels.length - 1, x = width - BAR - shift + (BAR + GAP); i >= 0 && x > -BAR; i--, x -= BAR + GAP) {
        const h = Math.max(BAR, (levels[i] ?? 0) * height);
        ctx.roundRect(x, (height - h) / 2, BAR, h, BAR / 2);
      }
      ctx.fill();
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      closeOwn();
    };
  }, [engine]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className={cn("text-primary [mask-image:linear-gradient(to_right,transparent,black_35%)]", className)}
    />
  );
};
