"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, RotateCcw, Settings, Volume2, X } from "lucide-react";

/*
 * Full-screen vocabulary practice.
 *
 * - Only the card and its answers are on screen (no page chrome), laid out to fit
 *   the viewport so nothing needs scrolling.
 * - Words always come in random order.
 * - Gear menu: sound on/off, voice, and which practice modes are used (several
 *   enabled modes are mixed at random, one per card).
 * - Pronunciation uses the card's audio_url when it has one, otherwise the browser's
 *   built-in speech synthesis (no server involved). The voice language is guessed from
 *   the words and can be overridden per subject.
 */

export type VCard = {
  id: string; term: string; definition: string;
  part_of_speech?: string | null; example_sentence?: string | null;
  image_url?: string | null; audio_url?: string | null; is_due?: boolean;
};
type ModeId = "flashcard" | "choose-word" | "choose-meaning" | "type";
type Option = { text: string; correct: boolean };
type Prepared = { card: VCard; mode: ModeId; options: Option[] };
type Verdict = "right" | "wrong" | "accent" | null;
type Prefs = { sound: boolean; modes: ModeId[]; voices: Record<string, string>; dueOnly: boolean };

const STORE = "learnify.vocab.settings";
const MODES: { id: ModeId; label: string; hint: string }[] = [
  { id: "flashcard", label: "Flashcards", hint: "See the word, flip it, rate yourself" },
  { id: "choose-word", label: "Choose the word", hint: "See the meaning, pick the word" },
  { id: "choose-meaning", label: "Choose the meaning", hint: "See the word, pick the meaning" },
  { id: "type", label: "Type the word", hint: "See the meaning, type the word" },
];
const DEFAULTS: Prefs = { sound: true, modes: ["flashcard", "choose-word", "choose-meaning"], voices: {}, dueOnly: false };
const RATINGS = ["Again", "Hard", "Good", "Easy"];

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(STORE) || "null");
    if (!p) return DEFAULTS;
    const modes = Array.isArray(p.modes) ? (p.modes.filter((m: string) => MODES.some(x => x.id === m)) as ModeId[]) : [];
    return { sound: p.sound !== false, modes: modes.length ? modes : DEFAULTS.modes, voices: p.voices && typeof p.voices === "object" ? p.voices : {}, dueOnly: p.dueOnly === true };
  } catch { return DEFAULTS; }
}
const savePrefs = (p: Prefs) => { try { localStorage.setItem(STORE, JSON.stringify(p)); } catch { /* private mode */ } };

function shuffled<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
const plain = (s: string) => norm(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.!?,;:]+$/, "");

function judge(input: string, term: string): Verdict {
  const a = norm(input).replace(/[.!?,;:]+$/, "");
  if (!a) return null;
  const variants = term.split(/[/;]/).map(v => v.trim()).filter(Boolean);
  if (variants.some(v => norm(v).replace(/[.!?,;:]+$/, "") === a)) return "right";
  if (variants.some(v => plain(v) === plain(a))) return "accent";
  return "wrong";
}

// Best-effort language of the words, so the right voice is used without asking.
function guessLang(text: string): string | null {
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
function langName(code: string): string {
  try { return new Intl.DisplayNames([navigator.language || "en"], { type: "language" }).of(code) || code; } catch { return code; }
}
function pickVoice(voices: SpeechSynthesisVoice[], lang: string | null, uri?: string): SpeechSynthesisVoice | undefined {
  if (uri) { const v = voices.find(x => x.voiceURI === uri); if (v) return v; }
  if (!lang) return undefined;
  const m = voices.filter(v => v.lang.toLowerCase().replace("_", "-").startsWith(lang));
  return m.find(v => v.localService) || m[0];
}

type Props = {
  title: string; subjectId: string; topicCards: VCard[]; allCards: VCard[];
  onReview: (cardId: string, rating: number) => Promise<unknown>;
  onFinish: () => void; onClose: () => void;
};

export default function VocabPractice({ title, subjectId, topicCards, allCards, onReview, onFinish, onClose }: Props) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const prefsRef = useRef(prefs); prefsRef.current = prefs;
  const [showSettings, setShowSettings] = useState(false);

  // ---------- speech
  const synth = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    if (!synth) return;
    const load = () => setVoices(synth.getVoices());
    load();
    synth.addEventListener?.("voiceschanged", load);
    return () => synth.removeEventListener?.("voiceschanged", load);
  }, [synth]);
  const guessed = useMemo(() => guessLang(allCards.slice(0, 300).map(c => `${c.term} ${c.example_sentence || ""}`).join(" ")), [allCards]);
  const voice = pickVoice(voices, guessed, prefs.voices[subjectId]);
  const voiceRef = useRef(voice); voiceRef.current = voice;
  const guessedRef = useRef(guessed); guessedRef.current = guessed;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const unlocked = useRef(false);

  const tts = useCallback((text: string) => {
    if (!synth) return;
    const u = new SpeechSynthesisUtterance(text);
    const v = voiceRef.current;
    try { if (v) u.voice = v; } catch { /* ignore */ }
    const lang = v?.lang || guessedRef.current;
    if (lang) u.lang = lang;
    u.rate = 0.9;
    synth.speak(u);
  }, [synth]);
  const speak = useCallback((card: VCard) => {
    if (!prefsRef.current.sound) return;
    try { audioRef.current?.pause(); } catch { /* ignore */ }
    synth?.cancel();
    if (card.audio_url) {
      const a = new Audio(card.audio_url);
      audioRef.current = a;
      a.play().catch(() => tts(card.term));
      return;
    }
    tts(card.term);
  }, [synth, tts]);
  // iOS only allows speech after a tap inside the page; one silent utterance unlocks it.
  const unlock = () => {
    if (unlocked.current || !synth) return;
    unlocked.current = true;
    try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; synth.speak(u); } catch { /* ignore */ }
  };

  // ---------- session
  const topicIds = useMemo(() => new Set(topicCards.map(c => c.id)), [topicCards]);
  const buildPool = useCallback(() => {
    // Every word by default; "due only" limits it to words scheduled for review (all words if none are due).
    const due = topicCards.filter(c => c.is_due);
    return shuffled(prefsRef.current.dueOnly && due.length ? due : topicCards); // always random order
  }, [topicCards]);

  const prepare = useCallback((card: VCard): Prepared => {
    const enabled = prefsRef.current.modes;
    let mode = enabled[Math.floor(Math.random() * enabled.length)] || "flashcard";
    let options: Option[] = [];
    if (mode === "choose-word" || mode === "choose-meaning") {
      const text = (c: VCard) => (mode === "choose-word" ? c.term : c.definition);
      const seen = new Set([norm(text(card))]);
      const others = [...shuffled(topicCards.filter(c => c.id !== card.id)), ...shuffled(allCards.filter(c => c.id !== card.id && !topicIds.has(c.id)))];
      const wrong: Option[] = [];
      for (const c of others) {
        if (wrong.length >= 3) break;
        const t = text(c);
        if (!t || seen.has(norm(t))) continue;
        seen.add(norm(t)); wrong.push({ text: t, correct: false });
      }
      if (wrong.length < 1) mode = "flashcard"; // not enough other words for a multiple choice
      else options = shuffled([{ text: text(card), correct: true }, ...wrong]);
    }
    return { card, mode, options };
  }, [allCards, topicCards, topicIds]);

  const [queue, setQueue] = useState<VCard[]>(buildPool);
  const [i, setI] = useState(0);
  const [item, setItem] = useState<Prepared | null>(() => (queue[0] ? prepare(queue[0]) : null));
  const [answered, setAnswered] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [typed, setTyped] = useState("");
  const [verdict, setVerdict] = useState<Verdict>(null);
  const [stats, setStats] = useState({ right: 0, wrong: 0 });
  const [missed, setMissed] = useState<VCard[]>([]);
  const [done, setDone] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const repeats = useRef<Record<string, number>>({});
  const root = useRef<HTMLDivElement>(null);

  const resetCard = () => { setAnswered(false); setPicked(null); setTyped(""); setVerdict(null); };
  const commit = (rating: number, card: VCard): VCard[] => {
    onReview(card.id, rating).catch(() => setSaveError(true));
    const good = rating >= 2;
    setStats(s => ({ right: s.right + (good ? 1 : 0), wrong: s.wrong + (good ? 0 : 1) }));
    if (!good) setMissed(m => (m.some(x => x.id === card.id) ? m : [...m, card]));
    let q = queue;
    if (rating === 0 && (repeats.current[card.id] || 0) < 2) { // a missed word comes back later in the session
      repeats.current[card.id] = (repeats.current[card.id] || 0) + 1;
      q = [...queue, card]; setQueue(q);
    }
    return q;
  };
  const advance = (q: VCard[] = queue) => {
    const n = i + 1;
    if (n >= q.length) { setDone(true); onFinish(); return; }
    setI(n); setItem(prepare(q[n])); resetCard();
  };
  const restart = () => {
    const pool = buildPool();
    repeats.current = {};
    setQueue(pool); setI(0); setItem(pool[0] ? prepare(pool[0]) : null); resetCard();
    setStats({ right: 0, wrong: 0 }); setMissed([]); setDone(false);
  };

  const choose = (idx: number) => {
    if (!item || answered) return;
    const ok = item.options[idx]?.correct;
    if (item.options[idx] === undefined) return;
    setPicked(idx); setVerdict(ok ? "right" : "wrong"); setAnswered(true);
    commit(ok ? 2 : 0, item.card);
    if (item.mode === "choose-word") speak(item.card);
  };
  const check = () => {
    if (!item || answered) return;
    const v = judge(typed, item.card.term);
    if (!v) return;
    setVerdict(v); setAnswered(true);
    commit(v === "right" ? 2 : v === "accent" ? 1 : 0, item.card);
    speak(item.card);
  };
  const flip = () => { if (item?.mode === "flashcard" && !answered) setAnswered(true); };
  const rate = (r: number) => { if (item) advance(commit(r, item.card)); };

  // Say the word as soon as it is on screen (when it is the prompt).
  useEffect(() => {
    if (!item || done) return;
    if (item.mode === "flashcard" || item.mode === "choose-meaning") speak(item.card);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    root.current?.focus();
    return () => { document.body.style.overflow = prev; synth?.cancel(); try { audioRef.current?.pause(); } catch { /* ignore */ } };
  }, [synth]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === "Escape") { showSettings ? setShowSettings(false) : onClose(); return; }
      if (showSettings || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!item || done) return;
      if (item.mode === "flashcard") {
        if (!answered && (e.key === " " || e.key === "Enter")) { e.preventDefault(); flip(); }
        else if (answered && /^[1-4]$/.test(e.key)) rate(Number(e.key) - 1);
      } else if (item.mode === "choose-word" || item.mode === "choose-meaning") {
        if (!answered && /^[1-4]$/.test(e.key)) choose(Number(e.key) - 1);
        else if (answered && (e.key === " " || e.key === "Enter")) { e.preventDefault(); advance(); }
      } else if (answered && (e.key === " " || e.key === "Enter")) { e.preventDefault(); advance(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const update = (patch: Partial<Prefs>) => { const next = { ...prefs, ...patch }; setPrefs(next); savePrefs(next); };
  const toggleMode = (id: ModeId) => {
    const on = prefs.modes.includes(id);
    if (on && prefs.modes.length === 1) return; // keep at least one mode
    update({ modes: MODES.map(m => m.id).filter(m => (m === id ? !on : prefs.modes.includes(m))) });
  };
  const groupedVoices = useMemo(() => {
    const g = new Map<string, SpeechSynthesisVoice[]>();
    [...voices].sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name)).forEach(v => {
      const key = v.lang.split(/[-_]/)[0].toLowerCase();
      if (!g.has(key)) g.set(key, []);
      g.get(key)!.push(v);
    });
    return [...g.entries()].sort((a, b) => (a[0] === guessed ? -1 : b[0] === guessed ? 1 : langName(a[0]).localeCompare(langName(b[0]))));
  }, [voices, guessed]);

  if (typeof document === "undefined") return null;

  // ---------- render
  const card = item?.card;
  const total = queue.length;
  const mode = item?.mode;
  const termVisible = !!item && (mode === "flashcard" || mode === "choose-meaning" || answered);
  const canSpeak = prefs.sound && !!card && (!!synth || !!card.audio_url);
  const isChoice = mode === "choose-word" || mode === "choose-meaning";
  const longOptions = isChoice && (mode === "choose-meaning" || (item?.options || []).some(o => o.text.length > 26));
  const promptText = !card ? "" : mode === "choose-word" || mode === "type" ? card.definition : card.term;
  const label = mode === "choose-word" || mode === "type" ? "Meaning" : "Word";
  const isLast = i + 1 >= total;

  const speaker = (c: VCard, className = "vp-speak") => (
    <button type="button" className={className} aria-label={`Pronounce ${c.term}`} title="Pronounce" onClick={e => { e.stopPropagation(); unlock(); speak(c); }}>
      <Volume2 size={22} />
    </button>
  );

  const ui = (
    <div className="vp" ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Vocabulary practice: ${title}`} onPointerDown={unlock}>
      <header className="vp-top">
        <button type="button" className="vp-icon" aria-label="Close practice" onClick={onClose}><X size={22} /></button>
        <div className="vp-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done ? total : i}>
          <span style={{ width: `${total ? ((done ? total : i) / total) * 100 : 0}%` }} />
        </div>
        <span className="vp-count">{done ? total : Math.min(i + 1, total)} / {total}</span>
        <button type="button" className="vp-icon" aria-label="Practice settings" aria-haspopup="dialog" onClick={() => { unlock(); setShowSettings(true); }}><Settings size={22} /></button>
      </header>

      {!card ? (
        <main className="vp-main"><div className="vp-card"><div className="vp-term">No words in this topic yet</div><div className="vp-sub">Import vocabulary to practice it.</div></div></main>
      ) : done ? (
        <>
          <main className="vp-main vp-scroll">
            <section className="vp-card vp-summary" aria-live="polite">
              <div className="vp-label">Session complete</div>
              <div className="vp-term">{stats.right} of {stats.right + stats.wrong} right</div>
              {missed.length > 0 ? (
                <div className="vp-missed">
                  <div className="vp-sub">Words to review</div>
                  {missed.slice(0, 12).map(m => (
                    <div className="vp-missed-row" key={m.id}>
                      <span><strong>{m.term}</strong> <span className="vp-muted">{m.definition}</span></span>
                      {prefs.sound && (synth || m.audio_url) ? speaker(m, "vp-speak small") : null}
                    </div>
                  ))}
                </div>
              ) : <div className="vp-sub">Nothing missed. Nice work!</div>}
            </section>
          </main>
          <footer className="vp-actions vp-row">
            <button type="button" className="btn vp-big" onClick={onClose}>Done</button>
            <button type="button" className="btn primary vp-big" onClick={restart}><RotateCcw size={18} />Practice again</button>
          </footer>
        </>
      ) : (
        <>
          <main className="vp-main">
            <section className={`vp-card ${mode === "flashcard" && !answered ? "tappable" : ""}`} onClick={flip} aria-live="polite">
              {canSpeak && termVisible && speaker(card)}
              {card.image_url && <img className="vp-image" src={card.image_url} alt="" referrerPolicy="no-referrer" />}
              <div className="vp-label">{label}</div>
              <div className={`vp-term ${promptText.length > 70 ? "long" : ""}`}>{promptText}</div>
              {mode === "flashcard" && !answered && <div className="vp-sub">{card.part_of_speech ? `${card.part_of_speech} · ` : ""}Tap to flip</div>}
              {mode === "choose-meaning" && card.part_of_speech && !answered && <div className="vp-sub">{card.part_of_speech}</div>}
              {mode === "choose-word" && !answered && <div className="vp-sub">Which word matches?</div>}
              {mode === "type" && !answered && <div className="vp-sub">Type the word</div>}
              {verdict && (
                <div className={`vp-verdict ${verdict}`}>
                  {verdict === "right" ? <><Check size={18} />Correct</> : verdict === "accent" ? "Almost: mind the accents" : "Not quite"}
                </div>
              )}
              {answered && (mode === "flashcard" || mode === "choose-word" || mode === "type") && (
                <div className="vp-answer">
                  <div className="vp-label">{mode === "flashcard" ? "Meaning" : "Answer"}</div>
                  <div className="vp-term answer">{mode === "flashcard" ? card.definition : card.term}</div>
                </div>
              )}
              {answered && card.example_sentence && <div className="vp-example">{card.example_sentence}</div>}
            </section>
          </main>

          <footer className="vp-actions">
            {saveError && <div className="vp-warn" role="status">Couldn’t save your progress. Check your connection.</div>}
            {mode === "flashcard" && !answered && <button type="button" className="btn primary vp-big" onClick={flip}>Show answer</button>}
            {mode === "flashcard" && answered && (
              <div className="vp-rate" role="group" aria-label="How well did you know it?">
                {RATINGS.map((x, r) => <button type="button" key={x} className={`vp-rate-btn r${r}`} onClick={() => rate(r)}>{x}</button>)}
              </div>
            )}
            {isChoice && item && (
              <>
                <div className={`vp-options ${longOptions ? "one" : ""}`}>
                  {item.options.map((o, idx) => (
                    <button type="button" key={idx} disabled={answered && !o.correct && picked !== idx}
                      className={`vp-option ${answered ? (o.correct ? "correct" : picked === idx ? "wrong" : "dim") : ""}`}
                      onClick={() => choose(idx)}>
                      <span className="vp-key" aria-hidden="true">{idx + 1}</span><span>{o.text}</span>
                    </button>
                  ))}
                </div>
                {answered && <button type="button" className="btn primary vp-big" onClick={() => advance()} autoFocus>{isLast ? "Finish" : "Next"}</button>}
              </>
            )}
            {mode === "type" && !answered && (
              <form className="vp-type" onSubmit={e => { e.preventDefault(); check(); }}>
                <input className="input" value={typed} onChange={e => setTyped(e.target.value)} placeholder="Type the word" aria-label="Your answer"
                  autoFocus autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                <button type="submit" className="btn primary" disabled={!typed.trim()}>Check</button>
              </form>
            )}
            {mode === "type" && answered && <button type="button" className="btn primary vp-big" onClick={() => advance()} autoFocus>{isLast ? "Finish" : "Next"}</button>}
          </footer>
        </>
      )}

      {showSettings && (
        <div className="vp-sheet-backdrop" onClick={() => setShowSettings(false)}>
          <section className="vp-sheet" role="dialog" aria-modal="true" aria-label="Practice settings" onClick={e => e.stopPropagation()}>
            <div className="vp-sheet-head">
              <h2>Practice settings</h2>
              <button type="button" className="vp-icon" aria-label="Close settings" onClick={() => setShowSettings(false)}><X size={20} /></button>
            </div>

            <div className="vp-set-row">
              <div><strong>Sound</strong><small>Say each word aloud and show the speaker button</small></div>
              <button type="button" role="switch" aria-checked={prefs.sound} aria-label="Sound" className={`vp-switch ${prefs.sound ? "on" : ""}`}
                onClick={() => { unlock(); if (prefs.sound) synth?.cancel(); update({ sound: !prefs.sound }); }}><span /></button>
            </div>

            <div className={`vp-set-block ${prefs.sound ? "" : "off"}`}>
              <label htmlFor="vp-voice"><strong>Voice</strong>
                <small>{synth ? (guessed ? `Words look like ${langName(guessed)}. Pick another voice if that is wrong.` : "Pick the voice that matches your words.") : "This browser can't speak. Cards with an audio file still play."}</small>
              </label>
              <div className="vp-voice-row">
                <select id="vp-voice" className="select" disabled={!prefs.sound || !synth} value={prefs.voices[subjectId] || ""}
                  onChange={e => update({ voices: { ...prefs.voices, [subjectId]: e.target.value } })}>
                  <option value="">Automatic{guessed ? ` (${langName(guessed)})` : ""}</option>
                  {groupedVoices.map(([code, list]) => (
                    <optgroup key={code} label={langName(code)}>
                      {list.map(v => <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>)}
                    </optgroup>
                  ))}
                </select>
                <button type="button" className="btn small" disabled={!prefs.sound || !card} onClick={() => { unlock(); if (card) speak(card); }}><Volume2 size={16} />Test</button>
              </div>
            </div>

            <div className="vp-set-row">
              <div><strong>Only words due for review</strong><small>Off: practise every word in this topic. On: only words scheduled for today. Applies to the next session.</small></div>
              <button type="button" role="switch" aria-checked={prefs.dueOnly} aria-label="Only words due for review" className={`vp-switch ${prefs.dueOnly ? "on" : ""}`}
                onClick={() => update({ dueOnly: !prefs.dueOnly })}><span /></button>
            </div>

            <div className="vp-set-block">
              <strong>Practice modes</strong>
              <small>Words always come in random order. With several modes on, each card uses one at random.</small>
              <div className="vp-modes">
                {MODES.map(m => {
                  const on = prefs.modes.includes(m.id);
                  return (
                    <label className="vp-mode" key={m.id}>
                      <input type="checkbox" checked={on} disabled={on && prefs.modes.length === 1} onChange={() => toggleMode(m.id)} />
                      <span><strong>{m.label}</strong><small>{m.hint}</small></span>
                    </label>
                  );
                })}
              </div>
            </div>
            <button type="button" className="btn primary vp-big" onClick={() => setShowSettings(false)}>Done</button>
          </section>
        </div>
      )}
    </div>
  );
  return createPortal(ui, document.body);
}
