"use client";
import { Play } from "lucide-react";

/*
 * Mistake notebook: every question whose latest answer was wrong. "Start test" runs the
 * full-screen exam with up to BATCH questions at a time; answering a question correctly
 * takes it out of the notebook straight away, so the next test only holds what is left.
 */

type Q = { id: string; prompt: string; options: string[]; correct_index: number; explanation?: string };
export type MistakeItem = { question: Q; failures: number; streak: number };
export const BATCH = 5;

export default function Mistakes({ items, onStart }: { items: MistakeItem[]; onStart: () => void }) {
  if (!items.length) {
    return <div className="empty-state"><strong>No mistakes to revisit</strong>Wrong answers from lesson tests, the Test center and exams collect here. Answer one correctly and it leaves the notebook.</div>;
  }
  const next = Math.min(BATCH, items.length);
  return (
    <>
      <div className="panel mistakes-bar">
        <div><strong>{items.length} {items.length === 1 ? "question" : "questions"} to revisit</strong>
          <small>Tests are {BATCH} questions at a time. Answer correctly and the question leaves the notebook.</small></div>
        <button className="btn primary" onClick={onStart}><Play size={16} />Start test ({next} {next === 1 ? "question" : "questions"})</button>
      </div>
      <div className="mistake-list">
        {items.map(({ question: q, failures }) => (
          <div className="mistake-row" key={q.id}>
            <span>{q.prompt}</span>
            <span className="tag">Missed {failures}×</span>
          </div>
        ))}
      </div>
    </>
  );
}
