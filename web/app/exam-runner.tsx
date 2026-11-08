"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bookmark, ChevronLeft, ChevronRight, Grid3x3, Search, X } from "lucide-react";

/*
 * Full-screen exam: one question at a time, flag for review, go back, and a
 * question navigator. Nothing is revealed while answering; results (with
 * explanations) appear after Finish. Answers are posted only at the end, so
 * they feed the mistake notebook exactly like any other attempt.
 */

export type ExamQ = { id: string; prompt: string; options: string[]; correct_index: number; explanation?: string };
type Props = {
  title: string;
  questions: ExamQ[];
  timedSeconds: number; // 0 = untimed
  sectionOf?: (q: ExamQ) => string;
  onSubmit: (answers: { id: string; selected: number }[]) => Promise<void>;
  onClose: () => void;
};
type Filter = "all" | "unanswered" | "flagged";

const letter = (i: number) => String.fromCharCode(65 + i);
const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

export default function ExamRunner({ title, questions, timedSeconds, sectionOf, onSubmit, onClose }: Props) {
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [flags, setFlags] = useState<Set<string>>(new Set());
  const [struck, setStruck] = useState<Record<string, number[]>>({});
  const [drawer, setDrawer] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [left, setLeft] = useState(timedSeconds);
  const [phase, setPhase] = useState<"run" | "done">("run");
  const [saving, setSaving] = useState(false);
  const [resultFilter, setResultFilter] = useState<"wrong" | "all">("wrong");
  const [confirmFinish, setConfirmFinish] = useState(false);
  const latest = useRef({ answers, phase });
  latest.current = { answers, phase };
  const total = questions.length;
  const q = questions[idx];

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  async function finish() {
    if (latest.current.phase !== "run") return;
    setSaving(true);
    setConfirmFinish(false);
    try {
      await onSubmit(Object.entries(latest.current.answers).map(([id, selected]) => ({ id, selected })));
    } catch { /* results still show; the attempt just was not saved */ }
    setSaving(false);
    setPhase("done");
    setDrawer(false);
  }
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    if (phase !== "run" || !timedSeconds) return;
    if (left <= 0) { finishRef.current(); return; }
    const t = window.setTimeout(() => setLeft(x => x - 1), 1000);
    return () => window.clearTimeout(t);
  }, [left, phase, timedSeconds]);

  const answered = Object.keys(answers).length;
  const go = (i: number) => { setIdx(Math.max(0, Math.min(total - 1, i))); setDrawer(false); };
  const pick = (i: number) => { if (phase === "run" && q) setAnswers(a => ({ ...a, [q.id]: i })); };
  const toggleFlag = () => q && setFlags(f => { const n = new Set(f); n.has(q.id) ? n.delete(q.id) : n.add(q.id); return n; });
  const strike = (i: number) => q && setStruck(s => {
    const cur = s[q.id] || [];
    return { ...s, [q.id]: cur.includes(i) ? cur.filter(x => x !== i) : [...cur, i] };
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (phase !== "run" || drawer || confirmFinish) { if (e.key === "Escape") { setDrawer(false); setConfirmFinish(false); } return; }
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "ArrowRight") go(idx + 1);
      else if (e.key === "ArrowLeft") go(idx - 1);
      else if (e.key.toLowerCase() === "f") toggleFlag();
      else if (/^[a-z]$/i.test(e.key) && !e.metaKey && !e.ctrlKey) {
        const n = e.key.toLowerCase().charCodeAt(0) - 97;
        if (q && n < q.options.length) pick(n);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const navItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    return questions.map((x, i) => ({ q: x, i })).filter(({ q: x, i }) => {
      if (filter === "unanswered" && answers[x.id] !== undefined) return false;
      if (filter === "flagged" && !flags.has(x.id)) return false;
      if (!term) return true;
      return String(i + 1) === term || x.prompt.toLowerCase().includes(term) || (sectionOf?.(x) || "").toLowerCase().includes(term);
    });
  }, [questions, answers, flags, filter, search, sectionOf]);

  if (typeof document === "undefined" || !q) return null;

  // ---------------------------------------------------------------- results
  if (phase === "done") {
    const rows = questions.map((x, i) => ({ x, i, mine: answers[x.id] }));
    const right = rows.filter(r => r.mine === r.x.correct_index).length;
    const wrong = rows.filter(r => r.mine !== undefined && r.mine !== r.x.correct_index).length;
    const skipped = total - right - wrong;
    const shown = rows.filter(r => resultFilter === "all" || r.mine !== r.x.correct_index);
    const pct = Math.round((right / total) * 100);
    return createPortal(
      <div className="ex" role="dialog" aria-modal="true" aria-label="Exam results">
        <header className="ex-top"><strong className="ex-title">{title}</strong><button className="btn" onClick={onClose}>Done</button></header>
        <div className="ex-scroll"><div className="ex-result">
          <section className="ex-score">
            <div className="ex-score-num">{pct}%</div>
            <div><strong>{right} of {total} correct</strong>
              <small>{wrong} wrong · {skipped} not answered{timedSeconds ? ` · ${clock(timedSeconds - Math.max(left, 0))} used` : ""}</small></div>
          </section>
          <div className="roadmap-view-toggle" role="tablist">
            {(["wrong", "all"] as const).map(f => <button key={f} role="tab" aria-selected={resultFilter === f} className={resultFilter === f ? "active" : ""} onClick={() => setResultFilter(f)}>{f === "wrong" ? `To review (${wrong + skipped})` : `All (${total})`}</button>)}
          </div>
          {shown.length === 0 && <div className="empty-state"><strong>Perfect score</strong>Nothing to review.</div>}
          {shown.map(({ x, i, mine }) => (
            <article className="question-card" key={x.id}>
              <h3>{i + 1}. {x.prompt}</h3>
              {x.options.map((o, j) => (
                <div key={j} className={`ex-opt static ${j === x.correct_index ? "correct" : j === mine ? "wrong" : ""}`}>
                  <span className="ex-letter">{letter(j)}</span><span>{o}</span>
                  {j === x.correct_index && <small className="ex-tag">Correct answer</small>}
                  {j === mine && j !== x.correct_index && <small className="ex-tag">Your answer</small>}
                </div>
              ))}
              {mine === undefined && <div className="feedback wrong">Not answered.</div>}
              {x.explanation && <div className="feedback correct">{x.explanation}</div>}
            </article>
          ))}
        </div></div>
      </div>, document.body);
  }

  // ---------------------------------------------------------------- question
  const mine = answers[q.id];
  const gone = struck[q.id] || [];
  const isFlagged = flags.has(q.id);
  const section = sectionOf?.(q) || "";
  const last = idx === total - 1;

  return createPortal(
    <div className="ex" role="dialog" aria-modal="true" aria-label={title}>
      <header className="ex-top">
        <strong className="ex-title">{title}</strong>
        <span className="ex-progress" aria-label={`${answered} of ${total} answered`}><span style={{ width: `${(answered / total) * 100}%` }} /></span>
        <span className="ex-count">{answered}/{total}</span>
        {timedSeconds > 0 && <span className={`ex-timer ${left < 60 ? "low" : ""}`}>{clock(Math.max(left, 0))}</span>}
        <button className="btn small" onClick={() => setConfirmFinish(true)}>Finish</button>
        <button className="vp-icon ex-x" aria-label="Quit" onClick={() => { if (window.confirm("Quit this test? Your answers will not be saved.")) onClose(); }}><X size={20} /></button>
      </header>

      <div className="ex-scroll">
        <article className="ex-card">
          <div className="ex-card-head">
            <div>
              <strong>Question {idx + 1}</strong> <span className="ex-of">of {total}</span>
              {section && <div className="ex-section">{section}</div>}
            </div>
            <button className={`btn small ex-flag ${isFlagged ? "on" : ""}`} aria-pressed={isFlagged} onClick={toggleFlag}>
              <Bookmark size={15} fill={isFlagged ? "currentColor" : "none"} />{isFlagged ? "Flagged" : "Flag for review"}
            </button>
          </div>
          <h2 className="ex-prompt">{q.prompt}</h2>
          <div className="ex-hint"><span>Select one answer</span><span className="ex-hint-tip">Tip: ✕ crosses out a choice</span></div>
          <div className="ex-options" role="radiogroup" aria-label="Answers">
            {q.options.map((o, i) => (
              <div key={i} className={`ex-opt ${mine === i ? "chosen" : ""} ${gone.includes(i) ? "struck" : ""}`}>
                <button type="button" role="radio" aria-checked={mine === i} className="ex-opt-main" onClick={() => pick(i)}>
                  <span className="ex-letter">{letter(i)}</span><span className="ex-opt-text">{o}</span>
                </button>
                <button type="button" className="ex-strike" aria-label={gone.includes(i) ? "Restore choice" : "Cross out choice"} onClick={() => strike(i)}><X size={15} /></button>
              </div>
            ))}
          </div>
        </article>
      </div>

      <footer className="ex-bottom">
        <button className="btn ex-nav" disabled={idx === 0} onClick={() => go(idx - 1)}><ChevronLeft size={18} /><span>Prev</span></button>
        <button className="btn ex-grid-btn" onClick={() => setDrawer(true)} aria-label="Open question navigator"><Grid3x3 size={16} />{idx + 1} / {total}</button>
        {last
          ? <button className="btn primary ex-nav" onClick={() => setConfirmFinish(true)}>Finish</button>
          : <button className="btn primary ex-nav" onClick={() => go(idx + 1)}><span>Next</span><ChevronRight size={18} /></button>}
      </footer>

      {drawer && (
        <div className="ex-drawer-backdrop" onClick={() => setDrawer(false)}>
          <aside className="ex-drawer" role="dialog" aria-label="Question navigator" onClick={e => e.stopPropagation()}>
            <div className="ex-drawer-head">
              <div><strong>Question navigator</strong><small>{answered} of {total} answered · {flags.size} flagged</small></div>
              <button className="vp-icon" aria-label="Close navigator" onClick={() => setDrawer(false)}><X size={20} /></button>
            </div>
            <label className="ex-search"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search question, keyword, or lesson…" /></label>
            <div className="roadmap-view-toggle" role="tablist">
              {([["all", `All (${total})`], ["unanswered", `Unanswered (${total - answered})`], ["flagged", `Flagged (${flags.size})`]] as [Filter, string][]).map(([f, label]) =>
                <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>{label}</button>)}
            </div>
            <div className="ex-legend"><span><i className="cur" />Current</span><span><i className="ans" />Answered</span><span><i />Unanswered</span><span><i className="flag" />Flagged</span></div>
            <div className="ex-grid">
              {navItems.map(({ q: x, i }) => (
                <button key={x.id} className={`ex-num ${i === idx ? "cur" : ""} ${answers[x.id] !== undefined ? "ans" : ""} ${flags.has(x.id) ? "flag" : ""}`} onClick={() => go(i)} title={x.prompt}>{i + 1}</button>
              ))}
              {navItems.length === 0 && <p className="muted-copy">No questions match.</p>}
            </div>
          </aside>
        </div>
      )}

      {confirmFinish && (
        <div className="ex-drawer-backdrop center" onClick={() => setConfirmFinish(false)}>
          <div className="ex-dialog" role="alertdialog" aria-label="Finish test" onClick={e => e.stopPropagation()}>
            <h2>Finish the test?</h2>
            <p>{answered} of {total} answered{total - answered > 0 ? `, ${total - answered} left blank` : ""}{flags.size ? `, ${flags.size} flagged for review` : ""}.</p>
            <div className="form-actions">
              {total - answered > 0 && <button className="btn" onClick={() => { setFilter("unanswered"); setConfirmFinish(false); setDrawer(true); }}>Review unanswered</button>}
              <button className="btn" onClick={() => setConfirmFinish(false)}>Keep going</button>
              <button className="btn primary" disabled={saving} onClick={finish}>{saving ? "Saving…" : "Finish and score"}</button>
            </div>
          </div>
        </div>
      )}
    </div>, document.body);
}
