"use client";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, RotateCcw } from "lucide-react";

/*
 * Mistake notebook: every question you got wrong and have not yet re-answered
 * correctly twice in a row. Answer straight on the card (feedback is instant,
 * and counts as a retest); "Retest all" runs them as a one-question-at-a-time test.
 * Cleared questions stay visible until you leave so the page does not jump.
 */

type Q = { id: string; prompt: string; options: string[]; correct_index: number; explanation?: string };
export type MistakeItem = { question: Q; failures: number; streak: number };
type Result = { is_correct: boolean; correct_index: number; explanation: string; is_flagged_mistake: boolean; consecutive_correct_in_retest: number };

type Props = {
  items: MistakeItem[];
  onAnswer: (id: string, selected: number) => Promise<Result>;
  onRetest: (list: Q[]) => void;
  onLeave: () => void;
};

const letter = (i: number) => String.fromCharCode(65 + i);

export default function Mistakes({ items, onAnswer, onRetest, onLeave }: Props) {
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [results, setResults] = useState<Record<string, Result>>({});
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const leave = useRef(onLeave);
  leave.current = onLeave;
  const touched = useRef(false);
  useEffect(() => () => { if (touched.current) leave.current(); }, []);

  async function choose(q: Q, i: number) {
    if (busyId || results[q.id]) return;
    setBusyId(q.id);
    setError("");
    setPicked(p => ({ ...p, [q.id]: i }));
    try {
      const r = await onAnswer(q.id, i);
      touched.current = true;
      setResults(x => ({ ...x, [q.id]: r }));
    } catch (e: any) {
      setPicked(p => { const n = { ...p }; delete n[q.id]; return n; });
      setError(e?.message || "Could not save your answer.");
    } finally {
      setBusyId("");
    }
  }
  const again = (id: string) => {
    setResults(x => { const n = { ...x }; delete n[id]; return n; });
    setPicked(p => { const n = { ...p }; delete n[id]; return n; });
  };

  if (!items.length) {
    return <div className="empty-state"><strong>No mistakes to revisit</strong>Wrong answers from lesson tests, the Test center and exams collect here. Answer a question correctly twice in a row and it leaves the notebook.</div>;
  }

  const cleared = Object.values(results).filter(r => !r.is_flagged_mistake).length;
  return (
    <>
      <div className="panel mistakes-bar">
        <div><strong>{items.length} {items.length === 1 ? "question" : "questions"} to revisit</strong>
          <small>Answer correctly twice in a row to clear a question.{cleared ? ` Cleared this visit: ${cleared}.` : ""}</small></div>
        <button className="btn primary" onClick={() => onRetest(items.map(i => i.question))}><RotateCcw size={16} />Retest all</button>
      </div>
      {error && <div className="feedback wrong" style={{ marginBottom: 12 }}>{error}</div>}
      {items.map(({ question: q, failures, streak }) => {
        const r = results[q.id];
        const mine = picked[q.id];
        const now = r ? r.consecutive_correct_in_retest : streak;
        return (
          <article className="question-card" key={q.id}>
            <div className="mistake-meta">
              <span className="tag">Missed {failures}×</span>
              <span className={`tag ${r && !r.is_flagged_mistake ? "ok" : ""}`}>{r && !r.is_flagged_mistake ? "Cleared" : `Correct in a row: ${Math.min(now, 2)}/2`}</span>
            </div>
            <h3>{q.prompt}</h3>
            {q.options.map((o, i) => (
              <button key={i} type="button" disabled={!!r || busyId === q.id}
                className={`quiz-btn ${r ? (i === q.correct_index ? "correct" : i === mine ? "wrong" : "dim") : mine === i ? "chosen" : ""}`}
                onClick={() => choose(q, i)}>
                <span className="ex-letter">{letter(i)}</span><span>{o}</span>
              </button>
            ))}
            {r && (
              <div className={`feedback ${r.is_correct ? "correct" : "wrong"}`}>
                <strong>{r.is_correct ? (r.is_flagged_mistake ? "Correct! One more to clear it." : "Correct! This one is cleared.") : "Not quite."}</strong> {q.explanation || r.explanation}
                <div><button className="btn small" style={{ marginTop: 8 }} onClick={() => again(q.id)}>{r.is_correct ? <CheckCircle2 size={14} /> : <RotateCcw size={14} />}Try again</button></div>
              </div>
            )}
          </article>
        );
      })}
    </>
  );
}
