"use client";
import { useEffect, useState } from "react";
import { CheckCircle2, Newspaper, Square, Star, Trash2, Volume2 } from "lucide-react";
import { LANGS } from "@/lib/translate";
import { canSpeak, guessLang, langName, readerLang, setReader, speak, stopSpeaking } from "@/lib/speech";

/* Reading room tiles: title, level and a "Finished" mark only. Finished marks are
   kept in this browser (localStorage, per subject); the text itself is opened on its own page. */

type R = { id: string; title: string; level?: string };
const key = (subjectId: string) => `learnify.readings.done.${subjectId}`;

export function useFinishedReadings(subjectId: string) {
  const [done, setDone] = useState<Set<string>>(new Set());
  useEffect(() => {
    try { setDone(new Set(JSON.parse(localStorage.getItem(key(subjectId)) || "[]"))); } catch { setDone(new Set()); }
  }, [subjectId]);
  const set = (id: string, value: boolean) => setDone(prev => {
    const next = new Set(prev);
    value ? next.add(id) : next.delete(id);
    try { localStorage.setItem(key(subjectId), JSON.stringify([...next])); } catch { /* private mode */ }
    return next;
  });
  return { done, set };
}

export default function ReadingTiles({ readings, done, favs, onFav, onOpen, onDelete }: {
  readings: R[]; done: Set<string>; favs: Set<string>; onFav: (id: string) => void; onOpen: (id: string) => void; onDelete: (r: R) => void;
}) {
  return (
    <div className="topic-grid reading-grid">
      {readings.map(r => {
        const finished = done.has(r.id);
        return (
          <div className={`reading-tile ${finished ? "finished" : ""}`} key={r.id}>
            <button type="button" className="reading-tile-main" onClick={() => onOpen(r.id)}>
              <span className="topic-icon"><Newspaper size={22} /></span>
              <strong>{r.title}</strong>
              <span className="reading-tile-foot">
                {r.level && <span className="tag">{r.level}</span>}
                {finished && <span className="tag ok"><CheckCircle2 size={13} /> Finished</span>}
              </span>
            </button>
            <button type="button" className={`reading-fav ${favs.has(r.id) ? "on" : ""}`} aria-pressed={favs.has(r.id)} aria-label={`Favorite ${r.title}`} title="Favorite" onClick={() => onFav(r.id)}><Star size={16} fill={favs.has(r.id) ? "currentColor" : "none"} /></button>
            <button type="button" className="reading-delete" aria-label={`Delete ${r.title}`} title="Delete text" onClick={() => onDelete(r)}><Trash2 size={16} /></button>
          </div>
        );
      })}
    </div>
  );
}

const langKey = (subjectId: string) => `learnify.reading.lang.${subjectId}`;
const plainText = (md: string) => md.replace(/```[\s\S]*?```/g, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^[#>\s-]*[-*+]\s+/gm, "").replace(/^#{1,6}\s+/gm, "").replace(/[*_`~|]/g, "");

/* Top of a reading text: the language the text is read in (remembered per subject) and Read aloud.
   Selecting text and choosing "Read it" in the selection menu uses the same language. */
export function ReadAloudBar({ subjectId, text }: { subjectId: string; text: string }) {
  const [lang, setLang] = useState("auto");
  const [speaking, setSpeaking] = useState(false);
  const guess = guessLang(text);
  const supported = canSpeak();

  useEffect(() => {
    let saved = "auto";
    try { saved = localStorage.getItem(langKey(subjectId)) || "auto"; } catch { /* ignore */ }
    setLang(saved);
    return () => { stopSpeaking(); };
  }, [subjectId]);
  useEffect(() => { setReader({ lang, guess }); return () => setReader({ lang: "auto", guess: null }); }, [lang, guess]);

  function change(next: string) {
    setLang(next);
    stopSpeaking(); setSpeaking(false);
    try { localStorage.setItem(langKey(subjectId), next); } catch { /* ignore */ }
  }
  function toggle() {
    if (speaking) { stopSpeaking(); setSpeaking(false); return; }
    setSpeaking(true);
    speak(plainText(text), readerLang(), () => setSpeaking(false));
  }

  return (
    <div className="read-bar">
      <label>Language
        <select className="select" value={lang} onChange={e => change(e.target.value)}>
          <option value="auto">Auto{guess ? ` (${langName(guess)})` : ""}</option>
          {LANGS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
        </select>
      </label>
      <button type="button" className="btn" disabled={!supported} onClick={toggle}>
        {speaking ? <><Square size={15} />Stop</> : <><Volume2 size={16} />Read aloud</>}
      </button>
      <small>{supported ? "Select any words and choose “Read it” to hear just those." : "This browser can't read text aloud."}</small>
    </div>
  );
}
