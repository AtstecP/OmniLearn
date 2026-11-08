"use client";
import { ReactNode } from "react";
import { BookOpen, ClipboardCheck, Newspaper, Play, Star } from "lucide-react";

/* Star button used on lessons, reading texts and test questions, and the Favorites page. */

export function FavStar({ on, onToggle, label = "favorite", small = true }: { on: boolean; onToggle: () => void; label?: string; small?: boolean }) {
  return (
    <button type="button" className={`btn ${small ? "small" : ""} fav-star ${on ? "on" : ""}`} aria-pressed={on}
      title={on ? `Remove ${label} from favorites` : `Add ${label} to favorites`}
      onClick={e => { e.stopPropagation(); onToggle(); }}>
      <Star size={15} fill={on ? "currentColor" : "none"} />Favorite
    </button>
  );
}

type Item = { id: string; title: string; sub?: string };

export default function Favorites({ lessons, readings, questions, onOpenLesson, onOpenReading, onPractice, renderQuestion }: {
  lessons: Item[]; readings: Item[]; questions: { id: string }[];
  onOpenLesson: (id: string) => void; onOpenReading: (id: string) => void; onPractice: () => void;
  renderQuestion: (q: any) => ReactNode;
}) {
  if (!lessons.length && !readings.length && !questions.length) {
    return <div className="empty-state"><strong>No favorites yet</strong>Tap the star on a lesson, a reading text or a test question and it shows up here.</div>;
  }
  const row = (kind: "lesson" | "reading", it: Item, open: (id: string) => void) => (
    <button type="button" className="fav-row" key={kind + it.id} onClick={() => open(it.id)}>
      <span className="topic-icon">{kind === "lesson" ? <BookOpen size={18} /> : <Newspaper size={18} />}</span>
      <span><strong>{it.title}</strong>{it.sub && <small>{it.sub}</small>}</span>
      <Star size={16} fill="currentColor" className="fav-mark" />
    </button>
  );
  return (
    <>
      {lessons.length > 0 && <section className="fav-section"><h3><BookOpen size={17} /> Lessons <span className="tag">{lessons.length}</span></h3>{lessons.map(l => row("lesson", l, onOpenLesson))}</section>}
      {readings.length > 0 && <section className="fav-section"><h3><Newspaper size={17} /> Reading texts <span className="tag">{readings.length}</span></h3>{readings.map(r => row("reading", r, onOpenReading))}</section>}
      {questions.length > 0 && (
        <section className="fav-section">
          <div className="fav-q-head">
            <h3><ClipboardCheck size={17} /> Test questions <span className="tag">{questions.length}</span></h3>
            <button className="btn primary" onClick={onPractice}><Play size={16} />Practice these</button>
          </div>
          {questions.map(q => renderQuestion(q))}
        </section>
      )}
    </>
  );
}
