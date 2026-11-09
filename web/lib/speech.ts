/*
 * Browser speech helpers shared by vocabulary practice and the reading room.
 * Uses the built-in speech synthesis: no server, no API key.
 */

// Best-effort language of a text, so the right voice is used without asking.
export function guessLang(text: string): string | null {
  const t = text.toLowerCase();
  const scripts: [RegExp, string][] = [[/[Ѐ-ӿ]/g, "ru"], [/[؀-ۿ]/g, "ar"], [/[぀-ヿ]/g, "ja"], [/[가-힯]/g, "ko"],
    [/[一-鿿]/g, "zh"], [/[Ͱ-Ͽ]/g, "el"], [/[֐-׿]/g, "he"], [/[ऀ-ॿ]/g, "hi"], [/[฀-๿]/g, "th"]];
  let best: string | null = null, bestN = 0;
  for (const [re, code] of scripts) { const n = (t.match(re) || []).length; if (n > bestN) { best = code; bestN = n; } }
  if (bestN >= 3) return best;
  const count = (re: RegExp) => (t.match(re) || []).length;
  const score: Record<string, number> = {
    fr: count(/[éèêëàâçîïôœùû]/g), es: count(/[ñ¿¡]/g) * 4 + count(/[áíóú]/g), de: count(/[äöüß]/g) * 2, pt: count(/[ãõ]/g) * 4,
  };
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  return ranked[0][1] >= 2 && ranked[0][1] >= (ranked[1]?.[1] || 0) * 1.5 ? ranked[0][0] : null;
}

export function langName(code: string): string {
  try { return new Intl.DisplayNames([navigator.language || "en"], { type: "language" }).of(code) || code; } catch { return code; }
}

export function pickVoice(voices: SpeechSynthesisVoice[], lang: string | null, uri?: string): SpeechSynthesisVoice | undefined {
  if (uri) { const v = voices.find(x => x.voiceURI === uri); if (v) return v; }
  if (!lang) return undefined;
  const l = lang.toLowerCase();
  const m = voices.filter(v => v.lang.toLowerCase().replace("_", "-").startsWith(l));
  return m.find(v => v.localService) || m[0];
}

export const canSpeak = () => typeof window !== "undefined" && "speechSynthesis" in window;

export function stopSpeaking() { if (canSpeak()) window.speechSynthesis.cancel(); }

// Long texts are spoken in sentence-sized pieces: browsers cut a single long utterance off after ~15 seconds.
function chunks(text: string, max = 220): string[] {
  const parts = text.replace(/\s+/g, " ").trim().match(/[^.!?…。！？]+[.!?…。！？]*\s*/g) || [text];
  const out: string[] = [];
  for (const p of parts) {
    let s = p.trim();
    while (s.length > max) {
      const cut = s.lastIndexOf(" ", max);
      const at = cut > 40 ? cut : max;
      out.push(s.slice(0, at).trim());
      s = s.slice(at).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

/** Speak text in the given language code (e.g. "fr", "zh-CN"); null lets the browser choose. */
export function speak(text: string, lang: string | null, onEnd?: () => void) {
  if (!canSpeak() || !text.trim()) { onEnd?.(); return; }
  const synth = window.speechSynthesis;
  synth.cancel();
  const voice = pickVoice(synth.getVoices(), lang);
  const list = chunks(text);
  list.forEach((piece, i) => {
    const u = new SpeechSynthesisUtterance(piece);
    try { if (voice) u.voice = voice; } catch { /* ignore */ }
    const l = voice?.lang || lang;
    if (l) u.lang = l;
    u.rate = 0.95;
    if (i === list.length - 1) { u.onend = () => onEnd?.(); u.onerror = () => onEnd?.(); }
    synth.speak(u);
  });
}

/* The reading room's language choice, shared with the selection menu ("Read it"). */
const reader = { lang: "auto", guess: null as string | null };
export function setReader(next: { lang?: string; guess?: string | null }) { Object.assign(reader, next); }
export const readerLang = () => (reader.lang !== "auto" ? reader.lang : reader.guess);
// Works on any page: the reading room's language choice wins, otherwise guess from the selection,
// then from the text on the page (a single word is too short to guess from).
export function readSelected(text: string, onEnd?: () => void) {
  const page = typeof document !== "undefined" ? document.querySelector("[data-selectable]")?.textContent?.slice(0, 3000) || "" : "";
  speak(text, readerLang() ?? guessLang(text) ?? guessLang(page), onEnd);
}
