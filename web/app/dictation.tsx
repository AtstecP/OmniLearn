"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Check, Lightbulb, RotateCcw, Settings, Snail, Volume2, X } from "lucide-react";
import { canSpeak, guessLang, langName, speak, stopSpeaking } from "@/lib/speech";
import { sfx } from "@/lib/sounds";

/*
 * Dictation: listen, then type what you hear.
 *
 * The phrase (its "answer") is spoken with the browser's built-in speech
 * (or the card's audio_url) and its meaning is shown. The learner types the sentence; every word is
 * coloured as they go (green = right, red = wrong) with sound effects, and the next sentence only
 * unlocks once the current one is spelled completely right. "Hint" reveals the next word.
 * Nothing is sent to the server; the position in a set is remembered in this browser.
 */

export type DCard = { id: string; term: string; definition: string; part_of_speech?: string | null; audio_url?: string | null };
type Settings = { sound: boolean; autoplay: boolean; shuffle: boolean; accents: boolean; lang: string };
type Result = { errors: number; hints: number };
type Status = "pending" | "typing" | "typing-bad" | "right" | "wrong";

const STORE = "learnify.dictation.settings";
const DEFAULTS: Settings = { sound: true, autoplay: true, shuffle: false, accents: false, lang: "auto" };
const LANGS = ["en", "fr", "es", "de", "it", "pt", "nl", "sv", "pl", "tr", "ru", "uk", "ar", "he", "hi", "th", "zh", "ja", "ko", "el"];

function load(): Settings {
  try {
    const p = JSON.parse(localStorage.getItem(STORE) || "null");
    return p && typeof p === "object" ? { ...DEFAULTS, ...p } : DEFAULTS;
  } catch { return DEFAULTS; }
}
const save = (s: Settings) => { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* private mode */ } };

function shuffled<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const tidy = (s: string) => s.normalize("NFC").replace(/[‘’ʼ`]/g, "'").replace(/[“”]/g, '"');
// Chinese, Japanese and Korean sentences have no spaces: every character is one "word".
const isCjk = (s: string) => !/\s/.test(s.trim()) && /[぀-ヿ㐀-鿿가-힯]/.test(s);
const splitWords = (s: string, cjk: boolean) => {
  const t = tidy(s).trim();
  // Stand-alone punctuation (a lone "?" or "-") is not a word and is never asked for.
  return cjk ? Array.from(t).filter(c => /[\p{L}\p{N}]/u.test(c)) : t.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
};
const fold = (w: string, ignoreAccents: boolean) => {
  let x = tidy(w).toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (ignoreAccents) x = x.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return x;
};

const posKey = (subjectId: string, title: string) => `learnify.dictation.pos.${subjectId}.${title}`;

export default function Dictation({ title, subjectId, cards, onClose }: { title: string; subjectId: string; cards: DCard[]; onClose: () => void }) {
  const usable = useMemo(() => cards.filter(c => c.term.trim()), [cards]);
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [phase, setPhase] = useState<"start" | "play" | "end">("start");
  const [order, setOrder] = useState<DCard[]>(usable);
  const [index, setIndex] = useState(0);
  const [saved, setSaved] = useState(0);
  const [input, setInput] = useState("");
  const [done, setDone] = useState(false);
  const [checked, setChecked] = useState(false);
  const [shake, setShake] = useState(-2); // -2 none, -1 whole row, >=0 one word
  const [errors, setErrors] = useState(0);
  const [hints, setHints] = useState(0);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [showSettings, setShowSettings] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const before = useRef("");

  useEffect(() => { setSettings(load()); }, []);
  useEffect(() => {
    try { const n = Number(localStorage.getItem(posKey(subjectId, title))); if (Number.isFinite(n) && n > 0 && n < usable.length) setSaved(n); } catch { /* ignore */ }
  }, [subjectId, title, usable.length]);
  useEffect(() => () => stopSpeaking(), []);
  const update = (patch: Partial<Settings>) => setSettings(s => { const n = { ...s, ...patch }; save(n); return n; });

  const card = phase === "play" ? order[index] : undefined;
  const cjk = card ? isCjk(card.term) : false;
  const words = useMemo(() => (card ? splitWords(card.term, cjk) : []), [card, cjk]);
  const typed = useMemo(() => splitWords(input, cjk), [input, cjk]);
  const trailing = !cjk && /\s$/.test(input);
  const typingIdx = cjk ? -1 : trailing ? typed.length : typed.length - 1;

  const lang = useMemo(() => (settings.lang !== "auto" ? settings.lang : guessLang(usable.slice(0, 60).map(c => c.term).join(" "))), [settings.lang, usable]);
  const same = useCallback((a: string, b: string) => fold(a, settings.accents) === fold(b, settings.accents), [settings.accents]);

  const statuses: Status[] = words.map((w, i) => {
    if (i >= typed.length) return "pending";
    const eq = same(typed[i], w);
    if (i === typingIdx) return eq ? "right" : fold(w, settings.accents).startsWith(fold(typed[i], settings.accents)) ? "typing" : "typing-bad";
    return eq ? "right" : "wrong";
  });
  const success = !!card && words.length > 0 && typed.length === words.length && words.every((w, i) => same(typed[i], w));

  const play = useCallback((slow = false) => {
    if (!card) return;
    if (!slow && card.audio_url) { try { void new Audio(card.audio_url).play(); return; } catch { /* fall back to speech */ } }
    if (canSpeak()) speak(card.term, lang, undefined, slow ? 0.55 : 0.95);
  }, [card, lang]);

  // A new sentence: clear the field, focus it and (optionally) speak it.
  useEffect(() => {
    if (phase !== "play") return;
    setInput(""); setDone(false); setChecked(false); setShake(-2); setErrors(0); setHints(0);
    const t = window.setTimeout(() => { inputRef.current?.focus(); if (settings.sound && settings.autoplay) play(); }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, index, order]);

  // A finished phrase moves on by itself after a moment (Enter skips the wait): there are no Next/Back buttons.
  useEffect(() => {
    if (phase !== "play" || !done) return;
    const t = window.setTimeout(() => next(), 1100);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, phase, index]);

  // Any typing key anywhere on the screen lands in the blocks, even when nothing is focused
  // (the field is invisible). The keys are applied directly so the first letter is never lost.
  const live = useRef({ change: (_v: string) => {}, enter: () => {}, input: "" });
  live.current = { change: onChange, enter: () => { if (done) next(); else check(); }, input };
  useEffect(() => {
    if (phase !== "play") return;
    const onKey = (e: KeyboardEvent) => {
      const el = inputRef.current;
      if (!el || e.target === el || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      const onButton = t?.tagName === "BUTTON";
      if (e.key.length === 1 && !(onButton && e.key === " ")) {
        e.preventDefault(); el.focus({ preventScroll: true }); live.current.change(live.current.input + e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault(); el.focus({ preventScroll: true }); live.current.change(live.current.input.slice(0, -1));
      } else if (e.key === "Enter" && !onButton) {
        e.preventDefault(); el.focus({ preventScroll: true }); live.current.enter();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [phase]);

  // The whole sentence became right.
  useEffect(() => {
    if (phase !== "play" || done || !success || composing.current) return;
    setDone(true);
    if (settings.sound) sfx.ok();
    setResults(r => ({ ...r, [card!.id]: { errors, hints } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [success, phase, done]);

  function start(from: number, shuffle = settings.shuffle, list = usable) {
    sfx.unlock();
    try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; window.speechSynthesis.speak(u); } catch { /* iOS needs a tap before speech */ }
    const o = shuffle ? shuffled(list) : list;
    setOrder(o); setIndex(from); setResults({}); setPhase("play");
  }

  function flash(w: number) { setShake(w); window.setTimeout(() => setShake(-2), 450); }

  // Sound and shake as soon as a word is finished (space typed) or a character typed (CJK).
  function judge(prev: string, next: string) {
    if (done || !card) return;
    if (cjk) {
      const a = splitWords(prev, true).length, b = splitWords(next, true);
      if (b.length > a && b.length <= words.length) {
        const i = b.length - 1;
        if (same(b[i], words[i])) { if (settings.sound && b.length < words.length) sfx.word(); }
        else { if (settings.sound) sfx.bad(); setErrors(e => e + 1); flash(i); }
      }
      return;
    }
    if (/\s$/.test(next) && !/\s$/.test(prev)) {
      const t = splitWords(next, false), i = t.length - 1;
      if (i < 0) return;
      if (i < words.length && same(t[i], words[i])) { if (settings.sound && i + 1 < words.length) sfx.word(); }
      else { if (settings.sound) sfx.bad(); setErrors(e => e + 1); flash(Math.min(i, words.length)); }
    }
  }

  function onChange(v: string) {
    if (done) return;
    if (!composing.current) judge(input, v);
    setInput(v);
  }

  function check() {
    if (done || !card) return;
    if (success) return;
    setChecked(true); setErrors(e => e + 1); flash(-1); inputRef.current?.focus({ preventScroll: true });
    if (settings.sound) sfx.bad();
  }

  function hint() {
    if (done || !card) return;
    let j = 0;
    while (j < words.length && j < typed.length && same(typed[j], words[j])) j++;
    if (j >= words.length) return;
    const next = words.slice(0, j + 1);
    setInput(cjk ? next.join("") : next.join(" ") + (j + 1 < words.length ? " " : ""));
    setHints(h => h + 1);
    if (settings.sound) sfx.word();
    inputRef.current?.focus();
  }

  function next() {
    if (!done) return;
    if (index + 1 >= order.length) {
      try { localStorage.removeItem(posKey(subjectId, title)); } catch { /* ignore */ }
      setSaved(0); setPhase("end"); stopSpeaking(); return;
    }
    if (!settings.shuffle) { try { localStorage.setItem(posKey(subjectId, title), String(index + 1)); } catch { /* ignore */ } setSaved(index + 1); }
    setIndex(index + 1);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !composing.current) { e.preventDefault(); if (done) next(); else check(); }
  }

  const pct = order.length ? Math.round(((phase === "end" ? order.length : done ? index + 1 : index) / order.length) * 100) : 0;
  const mistakes = order.filter(c => { const r = results[c.id]; return r && (r.errors > 0 || r.hints > 0); });

  const settingsPanel = (
    <div className="dict-settings" role="group" aria-label="Dictation settings">
      <label><input type="checkbox" checked={settings.sound} onChange={e => update({ sound: e.target.checked })} /> Sound effects</label>
      <label><input type="checkbox" checked={settings.autoplay} onChange={e => update({ autoplay: e.target.checked })} /> Read each sentence aloud automatically</label>
      <label><input type="checkbox" checked={settings.accents} onChange={e => update({ accents: e.target.checked })} /> Ignore accents (é = e)</label>
      <label><input type="checkbox" checked={settings.shuffle} onChange={e => update({ shuffle: e.target.checked })} /> Random order (next time you start)</label>
      <label className="dict-lang">Voice language
        <select className="select" value={settings.lang} onChange={e => update({ lang: e.target.value })}>
          <option value="auto">Automatic{lang ? ` (${langName(lang)})` : ""}</option>
          {LANGS.map(l => <option key={l} value={l}>{langName(l)}</option>)}
        </select>
      </label>
    </div>
  );

  // Where the next typed letter lands: the colored block with the blinking caret.
  const cursorIdx = done || phase !== "play" ? -1 : typed.length === 0 ? 0 : trailing ? typed.length : cjk ? typed.length : typed.length - 1;
  const focusInput = () => inputRef.current?.focus({ preventScroll: true });

  const slots = card ? (
    <div className={`dict-slots ${shake === -1 ? "shake" : ""}`} aria-label="Your answer, word by word" onClick={focusInput}>
      {words.map((w, i) => {
        const st: Status = done ? "right" : checked && statuses[i] === "pending" ? "wrong" : statuses[i];
        return (
          <span key={i} className={`dict-slot ${st} ${shake === i ? "shake" : ""} ${cursorIdx === i ? "cursor" : ""}`} style={{ minWidth: `${Math.max(2, Array.from(w).length) * 0.62}em` }}>
            {done ? w : typed[i] ?? " "}
          </span>
        );
      })}
      {!done && typed.slice(words.length).map((t, i) => <span key={"x" + i} className="dict-slot wrong extra">{t}</span>)}
    </div>
  ) : null;

  let ui: React.ReactNode;
  if (phase === "start") {
    ui = (
      <div className="dict-body">
        <h1 className="dict-title">Dictation: {title}</h1>
        <p className="muted-copy">{usable.length} {usable.length === 1 ? "sentence" : "sentences"}. Listen, then type exactly what you hear. You move on only when it is spelled right; use Hint if you are stuck.</p>
        {!canSpeak() && <div className="feedback wrong">This browser cannot speak aloud, so you will only see the meanings.</div>}
        {settingsPanel}
        <div className="dict-actions">
          {saved > 0 && !settings.shuffle ? (
            <>
              <button className="btn primary" onClick={() => start(saved)}><ArrowRight size={16} />Continue at {saved + 1} of {usable.length}</button>
              <button className="btn" onClick={() => start(0)}><RotateCcw size={16} />Start over</button>
            </>
          ) : (
            <button className="btn primary" disabled={!usable.length} onClick={() => start(0)}><ArrowRight size={16} />Start</button>
          )}
        </div>
      </div>
    );
  } else if (phase === "end") {
    ui = (
      <div className="dict-body">
        <h1 className="dict-title">Set complete</h1>
        <p className="muted-copy">This session: {Object.keys(results).length} {Object.keys(results).length === 1 ? "sentence" : "sentences"}, {Object.keys(results).length - mistakes.length} typed perfectly.</p>
        {mistakes.length > 0 && (
          <div className="dict-review">
            <strong>Worth another go ({mistakes.length})</strong>
            {mistakes.slice(0, 30).map(c => <div key={c.id}><span>{c.term}</span><small>{c.definition}</small></div>)}
          </div>
        )}
        <div className="dict-actions">
          {mistakes.length > 0 && <button className="btn primary" onClick={() => start(0, true, mistakes)}><RotateCcw size={16} />Practise these {mistakes.length}</button>}
          <button className="btn" onClick={() => start(0)}><RotateCcw size={16} />Start over</button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  } else if (card) {
    ui = (
      <div className="dict-body">
        <p className="dict-translation">{card.definition}</p>
        {card.part_of_speech && <small className="vp-muted">{card.part_of_speech}</small>}
        <div className="dict-audio">
          <button type="button" className="vp-speak small" onClick={() => { sfx.unlock(); play(); focusInput(); }} aria-label="Play the sentence" title="Play"><Volume2 size={20} /></button>
          <button type="button" className="vp-speak small" onClick={() => { sfx.unlock(); play(true); focusInput(); }} aria-label="Play slowly" title="Play slowly"><Snail size={20} /></button>
          <button type="button" className="vp-speak small" onClick={() => { sfx.unlock(); hint(); focusInput(); }} disabled={done} aria-label="Hint: reveal the next word" title="Hint"><Lightbulb size={20} /></button>
        </div>
        {slots}
        <input ref={inputRef} className="dict-input" value={input} readOnly={done}
          onChange={e => onChange(e.target.value)} onKeyDown={onKey}
          onCompositionStart={() => { composing.current = true; before.current = input; }}
          onCompositionEnd={e => { composing.current = false; judge(before.current, e.currentTarget.value); setInput(e.currentTarget.value); }}
          aria-label="Type the sentence you hear"
          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} enterKeyHint={done ? "next" : "done"} />
        <div className="dict-msg" aria-live="polite">
          {!done && !checked && input === "" ? <span className="dict-tip">Just start typing: your keys go straight into the blocks. Space moves to the next block.</span> : null}
          {done ? <span className="ok"><Check size={16} /> Correct{errors || hints ? ` (${errors} ${errors === 1 ? "mistake" : "mistakes"}, ${hints} ${hints === 1 ? "hint" : "hints"})` : "!"}</span>
            : checked ? <span className="bad">Not quite: fix the red words.</span> : null}
        </div>
      </div>
    );
  }

  const node = (
    <div className="vp dict" role="dialog" aria-modal="true" aria-label="Dictation practice">
      <div className="vp-top">
        <button type="button" className="vp-icon" onClick={onClose} aria-label="Close dictation"><X size={20} /></button>
        {phase === "play" ? (
          <>
            <div className="vp-progress" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
            <span className="dict-count">{index + 1} / {order.length} <b>{pct}%</b></span>
          </>
        ) : <div style={{ flex: 1 }} />}
        {phase === "play" && (
          <button type="button" className="vp-icon" onClick={() => setShowSettings(s => !s)} aria-label="Settings" aria-expanded={showSettings}><Settings size={20} /></button>
        )}
      </div>
      {showSettings && phase === "play" && <div className="dict-pop">{settingsPanel}</div>}
      <div className="dict-scroll">{ui}</div>
    </div>
  );
  return typeof document === "undefined" ? null : createPortal(node, document.body);
}
