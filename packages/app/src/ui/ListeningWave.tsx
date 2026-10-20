/**
 * The call's "listening" line: columns of LED dots that rise and fall with the
 * user's voice, in place of a transcript of what they said (which arrived late
 * and read as clutter). After they stop, the columns settle into a slow
 * ripple while Pew is about to answer.
 *
 * Painted on the UI thread from a frame callback, like Pew, into a picture:
 * the mic level arrives as a shared value (polled from WebRTC's stats), so
 * the waves never wait on React. Without a level (no stats, the demo) the
 * columns are animated from `speaking` alone.
 */
import { useCallback } from "react";
import { StyleSheet } from "react-native";
import { Canvas, Picture, Skia, type SkPicture } from "@shopify/react-native-skia";
import { useFrameCallback, useSharedValue, type FrameInfo, type SharedValue } from "react-native-reanimated";
import { beginFrame, blankPicture, endFrame } from "./skiaFrame";

/** Columns across, dots per column, and their spacing, in points. */
const COLS = 17;
const ROWS = 5;
const STEP = 11;
const DOT = 2.1;
/** Columns at each side that fade out into the background. */
const EDGE_COLS = 4;

export const WAVE_WIDTH = (COLS - 1) * STEP + DOT * 4;
export const WAVE_HEIGHT = (ROWS - 1) * STEP + DOT * 4;

/** One paint and one colour buffer per UI runtime, reused every frame (see skiaFrame.ts on churn). */
function waveTools(): { paint: ReturnType<typeof Skia.Paint>; col: Float32Array } {
  "worklet";
  const g = globalThis as unknown as { __waveTools?: { paint: ReturnType<typeof Skia.Paint>; col: Float32Array } };
  if (!g.__waveTools) {
    const paint = Skia.Paint();
    paint.setAntiAlias(true);
    g.__waveTools = { paint, col: new Float32Array(4) };
  }
  return g.__waveTools;
}

function rgba(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

interface Props {
  /** The user is speaking (the server heard them start). */
  speaking: boolean;
  /** 0..1 mic loudness, -1 when unknown. */
  level?: SharedValue<number>;
  /** Lit colour, and the unlit dot colour. */
  color: string;
  off: string;
}

export function ListeningWave({ speaking, level, color, off }: Props) {
  const picture = useSharedValue<SkPicture>(blankPicture());
  const t = useSharedValue(0);
  const energy = useSharedValue(0);
  const sinceDraw = useSharedValue(1);
  const lit = rgba(color);
  const dim = rgba(off);
  const speakingNow = speaking ? 1 : 0;
  const tick = useCallback(
    (info: FrameInfo) => {
      "worklet";
      const dt = Math.min(1 / 30, Math.max(0.001, (info.timeSincePreviousFrame ?? 16) / 1000));
      t.value += dt;
      // Where the columns want to be: the real level while it is known
      // (lifted, so speech fills the columns), a lively stand-in while the
      // server says they are talking, and a low ripple once they stop.
      const raw = level ? level.value : -1;
      const want = raw >= 0 && speakingNow ? Math.min(1, 0.18 + raw * 3.2) : speakingNow ? 0.55 + 0.25 * Math.sin(t.value * 9) : 0.12;
      // Fast up, slower down: a voice's attack and decay.
      const k = want > energy.value ? Math.min(1, dt * 18) : Math.min(1, dt * 6);
      energy.value += (want - energy.value) * k;
      sinceDraw.value += dt;
      if (sinceDraw.value < 1 / 61) return;
      sinceDraw.value = 0;
      const canvas = beginFrame(WAVE_WIDTH, WAVE_HEIGHT);
      const { paint, col } = waveTools();
      const left = DOT * 2;
      const mid = (ROWS - 1) / 2;
      for (let c = 0; c < COLS; c++) {
        // Each column its own height: a travelling wave, tallest in the middle.
        const centre = 1 - Math.abs(c - (COLS - 1) / 2) / ((COLS - 1) / 2);
        const wave = 0.55 + 0.45 * Math.sin(t.value * 7.5 - c * 0.85 + Math.sin(c * 1.7) * 0.6);
        const h = energy.value * (0.35 + 0.65 * centre) * wave * (mid + 0.999);
        const x = left + c * STEP;
        // Soft edges: the outer columns fade into the background (a smooth
        // ramp over EDGE_COLS at each side), so the wave has no square ends.
        const edge = Math.min(c, COLS - 1 - c);
        const fade = edge >= EDGE_COLS ? 1 : Math.sin(((edge + 1) / (EDGE_COLS + 1)) * (Math.PI / 2)) ** 2;
        for (let r = 0; r < ROWS; r++) {
          const fromMid = Math.abs(r - mid);
          const on = Math.max(0, Math.min(1, h - fromMid));
          const y = DOT * 2 + r * STEP;
          col[0] = dim[0]; col[1] = dim[1]; col[2] = dim[2]; col[3] = 0.55 * (1 - on) * fade;
          paint.setColor(col);
          canvas.drawCircle(x, y, DOT, paint);
          if (on > 0.02) {
            col[0] = lit[0]; col[1] = lit[1]; col[2] = lit[2]; col[3] = on * fade;
            paint.setColor(col);
            canvas.drawCircle(x, y, DOT + 0.5 * on, paint);
          }
        }
      }
      picture.value = endFrame();
    },
    [t, energy, sinceDraw, picture, level, speakingNow, lit, dim],
  );
  useFrameCallback(tick, true);
  return (
    <Canvas style={styles.canvas} pointerEvents="none">
      <Picture picture={picture as SharedValue<SkPicture>} />
    </Canvas>
  );
}

const styles = StyleSheet.create({
  canvas: { width: WAVE_WIDTH, height: WAVE_HEIGHT },
});
