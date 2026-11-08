/*
 * Free translation for auto-filling vocabulary cards.
 *
 * Uses the MyMemory public API (no key, CORS enabled, ~5000 characters per day per
 * visitor IP when anonymous). The request goes straight from the browser, so the
 * daily allowance is per user rather than shared by the whole app, and the only
 * thing sent is the selected word or phrase. Swap `translate` to change provider.
 */
export const LANGS: [code: string, name: string][] = [
  ["en", "English"], ["fr", "French"], ["es", "Spanish"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"],
  ["nl", "Dutch"], ["sv", "Swedish"], ["pl", "Polish"], ["cs", "Czech"], ["uk", "Ukrainian"], ["ru", "Russian"],
  ["tr", "Turkish"], ["ar", "Arabic"], ["he", "Hebrew"], ["hi", "Hindi"], ["zh-CN", "Chinese"], ["ja", "Japanese"], ["ko", "Korean"],
];

export type TranslateResult = { text: string; detected?: string };

export async function translate(text: string, from: string, to: string, signal?: AbortSignal): Promise<TranslateResult> {
  const q = text.trim().slice(0, 300);
  if (!q) throw new Error("Nothing to translate.");
  const pair = `${from === "auto" ? "Autodetect" : from}|${to}`;
  const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=${encodeURIComponent(pair)}`, { signal });
  if (!res.ok) throw new Error("The translation service is unavailable right now.");
  const data = await res.json();
  const status = Number(data?.responseStatus);
  if (status === 429) throw new Error("Daily free translation limit reached. Type the meaning yourself or try tomorrow.");
  let out = String(data?.responseData?.translatedText ?? "").trim();
  if (status !== 200 || !out) throw new Error(typeof data?.responseDetails === "string" && data.responseDetails ? data.responseDetails : "No translation found.");
  if (/^(PLEASE SELECT|INVALID|MYMEMORY WARNING)/i.test(out)) throw new Error("No translation found. Pick the source language manually.");
  // MyMemory sometimes answers in capitals or echoes the input; leave echoes empty so the user types it.
  if (out.toLowerCase() === q.toLowerCase()) throw new Error("The translation is the same as the word. Pick the source language manually.");
  return { text: out, detected: data?.responseData?.detectedLanguage || undefined };
}
