"use client";
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Play, Trash2 } from "lucide-react";

/*
 * Test center: questions grouped by lesson ("categories"), a custom-test builder
 * (tick lessons, choose how many, shuffle, timed) and per-question practice/remove.
 *
 * It only ever receives the subject's lesson/bank questions. Reading-passage
 * questions live in a different table and are never part of this list.
 */

type Q = { id: string; node_id?: string | null; prompt: string; options: string[]; tags?: string[] };
type N = { id: string; title: string; parent_node_id?: string | null };
type Cat<T extends Q> = { id: string; title: string; questions: T[] };
type Group<T extends Q> = { id: string; title: string; cats: Cat<T>[] };
export type TestOptions = { limit: number; shuffle: boolean; timed: boolean };

type Props<T extends Q> = {
  nodes: N[];
  questions: T[];
  busy: boolean;
  onStart: (list: T[], options: TestOptions) => void;
  onPractice: (id: string) => void;
  onRemove: (ids: string[], what: string) => void;
};

const BANK = "bank";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default function TestCenter<T extends Q>({ nodes, questions, busy, onStart, onPractice, onRemove }: Props<T>) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(0);
  const [shuffle, setShuffle] = useState(true);
  const [timed, setTimed] = useState(false);

  const groups = useMemo<Group<T>[]>(() => {
    const term = search.trim().toLowerCase();
    const visible = term ? questions.filter(q => q.prompt.toLowerCase().includes(term) || (q.tags || []).join(" ").toLowerCase().includes(term)) : questions;
    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const byNode = new Map<string, T[]>();
    const bank: T[] = [];
    for (const q of visible) {
      if (q.node_id && nodeById.has(q.node_id)) {
        if (!byNode.has(q.node_id)) byNode.set(q.node_id, []);
        byNode.get(q.node_id)!.push(q);
      } else bank.push(q);
    }
    const rootOf = (n: N): N => {
      let cur = n;
      const seen = new Set<string>();
      while (cur.parent_node_id && nodeById.has(cur.parent_node_id) && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = nodeById.get(cur.parent_node_id)!;
      }
      return cur;
    };
    const out = new Map<string, Group<T>>();
    for (const n of nodes) { // nodes arrive in curriculum order (main step, then its sub-topics)
      const qs = byNode.get(n.id);
      if (!qs?.length) continue;
      const root = rootOf(n);
      if (!out.has(root.id)) out.set(root.id, { id: root.id, title: root.title, cats: [] });
      out.get(root.id)!.cats.push({ id: n.id, title: n.title, questions: qs });
    }
    if (bank.length) out.set(BANK, { id: BANK, title: "General questions", cats: [{ id: BANK, title: "Not tied to a lesson", questions: bank }] });
    return [...out.values()];
  }, [nodes, questions, search]);

  const cats = useMemo(() => groups.flatMap(g => g.cats), [groups]);
  const total = cats.reduce((n, c) => n + c.questions.length, 0);
  const chosen = cats.filter(c => selected.has(c.id));
  const chosenCount = chosen.reduce((n, c) => n + c.questions.length, 0);
  const willAsk = limit > 0 ? Math.min(limit, chosenCount) : chosenCount;

  const toggle = (set: Set<string>, id: string) => { const next = new Set(set); next.has(id) ? next.delete(id) : next.add(id); return next; };
  const setMany = (ids: string[], on: boolean) => setSelected(prev => { const next = new Set(prev); ids.forEach(id => (on ? next.add(id) : next.delete(id))); return next; });
  const options: TestOptions = { limit, shuffle, timed };

  if (busy) return null;
  if (!questions.length) {
    return (
      <section className="empty-state">
        <strong>No test questions yet</strong>
        Import a course or add questions to a lesson, and they will appear here grouped by lesson.
      </section>
    );
  }

  return (
    <div className="test-center">
      <section className="panel tc-settings">
        <div className="panel-header">
          <div>
            <div className="panel-title">Custom test</div>
            <div className="panel-subtitle">Tick the lessons you want to be tested on, or use Practice on a single lesson.</div>
          </div>
        </div>
        <div className="tc-options">
          <label className="tc-field">How many questions
            <input className="input" type="number" inputMode="numeric" min={1} max={total || undefined} step={1} list="tc-limit-presets" placeholder="All of the chosen lessons"
              value={limit || ""} onChange={e => setLimit(Math.max(0, Math.floor(Number(e.target.value)) || 0))} />
            <datalist id="tc-limit-presets">{[5, 10, 20, 30, 50].map(n => <option key={n} value={n} />)}</datalist>
          </label>
          <label className="tc-check"><input type="checkbox" checked={shuffle} onChange={e => setShuffle(e.target.checked)} /> Shuffle</label>
          <label className="tc-check"><input type="checkbox" checked={timed} onChange={e => setTimed(e.target.checked)} /> Timed (1 min per question)</label>
        </div>
        <div className="filter-row">
          <input className="input" placeholder="Search questions or tags…" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search questions" />
          <button className="btn small" type="button" onClick={() => setMany(cats.map(c => c.id), true)}>Select all</button>
          <button className="btn small" type="button" onClick={() => setSelected(new Set())} disabled={!selected.size}>Clear</button>
        </div>
      </section>

      {!groups.length && <div className="empty-state"><strong>No matches</strong>Try a different search.</div>}

      {groups.map(g => {
        const single = g.cats.length === 1 && (g.id === BANK || g.cats[0].id === g.id);
        const ids = g.cats.map(c => c.id);
        const on = ids.filter(id => selected.has(id)).length;
        const count = g.cats.reduce((n, c) => n + c.questions.length, 0);
        return (
          <section className="panel tc-group" key={g.id}>
            {!single && (
              <header className="tc-group-head">
                <label className="tc-check tc-group-title">
                  <input type="checkbox" checked={on === ids.length} ref={el => { if (el) el.indeterminate = on > 0 && on < ids.length; }}
                    onChange={e => setMany(ids, e.target.checked)} aria-label={`Select every lesson in ${g.title}`} />
                  <span>{g.title}</span>
                </label>
                <span className="tag">{plural(count, "question")}</span>
              </header>
            )}
            {g.cats.map(c => {
              const isOpen = open.has(c.id);
              return (
                <div className="tc-cat" key={c.id}>
                  <div className="tc-cat-row">
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => setSelected(prev => toggle(prev, c.id))} aria-label={`Include ${c.title} in the custom test`} />
                    <button type="button" className="tc-cat-title" aria-expanded={isOpen} onClick={() => setOpen(prev => toggle(prev, c.id))}>
                      {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      <span className="tc-cat-name">{!single && c.id === g.id ? "Overview of this step" : c.title}</span>
                      <span className="tag">{plural(c.questions.length, "question")}</span>
                    </button>
                    <button type="button" className="btn small" onClick={() => onStart(c.questions, { ...options, limit: 0 })}><Play size={14} />Practice</button>
                  </div>
                  {isOpen && (
                    <div className="tc-qlist">
                      {c.questions.map(q => (
                        <div className="test-row" key={q.id}>
                          <div>
                            <div className="test-prompt">{q.prompt}</div>
                            {!!q.tags?.length && <div className="test-tags">{q.tags.map(x => <span className="tag" key={x}>{x}</span>)}</div>}
                          </div>
                          <div className="row-actions">
                            <button type="button" className="btn small" onClick={() => onPractice(q.id)}>Try</button>
                            <button type="button" className="btn small danger" onClick={() => onRemove([q.id], "this question")} aria-label="Remove this question" title="Remove this question"><Trash2 size={14} /></button>
                          </div>
                        </div>
                      ))}
                      <div className="tc-qfoot">
                        <button type="button" className="btn small danger" onClick={() => onRemove(c.questions.map(q => q.id), c.questions.length === 1 ? "the question in this lesson" : `all ${c.questions.length} questions in “${c.title}”`)}>
                          <Trash2 size={14} />Remove all {c.questions.length}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}

      <div className="tc-bar" role="region" aria-label="Start a custom test">
        <div className="tc-bar-text">
          <strong>{chosen.length ? `${plural(chosen.length, "lesson")} · ${plural(willAsk, "question")}` : "No lessons ticked"}</strong>
          <small>{chosen.length ? (limit > 0 && chosenCount > limit ? `a random ${limit} of ${chosenCount}` : timed ? `${Math.max(5, willAsk)} minutes` : "untimed") : `${plural(total, "question")} available`}</small>
        </div>
        <button type="button" className="btn primary" disabled={!chosen.length}
          onClick={() => onStart(chosen.flatMap(c => c.questions), options)}>
          <Play size={16} />Start test
        </button>
      </div>
    </div>
  );
}
