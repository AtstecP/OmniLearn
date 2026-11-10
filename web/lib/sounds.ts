/*
 * Tiny sound effects made with the Web Audio API (no audio files, no network).
 * Browsers only start audio after a tap or key press, so call sfx.unlock() from one.
 */

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const C = window.AudioContext || (window as any).webkitAudioContext;
      if (!C) return null;
      ctx = new C();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = "sine", vol = 0.12) {
  const c = audio();
  if (!c) return;
  try {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    const t = c.currentTime + start;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  } catch { /* audio is a nice-to-have */ }
}

export const sfx = {
  unlock: () => { audio(); },
  /** a word was typed correctly */
  word: () => tone(740, 0, 0.09, "sine", 0.07),
  /** the whole sentence is right */
  ok: () => { tone(523, 0, 0.13, "sine", 0.11); tone(659, 0.1, 0.13, "sine", 0.11); tone(784, 0.2, 0.26, "sine", 0.11); },
  /** a mistake */
  bad: () => { tone(190, 0, 0.16, "sawtooth", 0.08); tone(140, 0.09, 0.22, "sawtooth", 0.07); },
};
