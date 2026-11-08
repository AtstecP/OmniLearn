"use client";
import { useEffect, useState } from "react";
import { CheckCircle2, Newspaper, Trash2 } from "lucide-react";

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

export default function ReadingTiles({ readings, done, onOpen, onDelete }: {
  readings: R[]; done: Set<string>; onOpen: (id: string) => void; onDelete: (r: R) => void;
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
            <button type="button" className="reading-delete" aria-label={`Delete ${r.title}`} title="Delete text" onClick={() => onDelete(r)}><Trash2 size={16} /></button>
          </div>
        );
      })}
    </div>
  );
}
