"use client";
/*
 * Right-hand panel of the canvas: the inspector (properties of the selected block or connection)
 * and the lesson viewer (a lesson's Markdown, its questions and progress, with an inline editor).
 * Lessons are read and saved through the existing lesson endpoints; nothing is stored twice.
 */
import { useEffect, useState } from "react";
import { ExternalLink, HelpCircle, Maximize2, Minimize2, PanelRightClose, Pencil, Play, Trash2, X } from "lucide-react";
import { api, json } from "@/lib/api";
import Markdown from "./markdown";
import { EDGE_LABEL, QUICK_COLORS, isHex, STATUS_LABEL, TYPE_ICON, TYPE_LABEL } from "./canvas-blocks";
import { EDGE_TYPES, type CEdge, type CNode, type EdgeType } from "@/lib/canvas-sync";

type Lesson = { id: string; title: string; test_ids?: string[] };

/** Hue columns x lightness rows, like the colour grid in Paint, plus a grey column. */
const PALETTE: string[][] = (() => {
  const hex = (h: number, sat: number, l: number) => {
    const a = sat * Math.min(l, 1 - l), f = (n: number) => { const k = (n + h / 30) % 12; const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, "0"); };
    return `#${f(0)}${f(8)}${f(4)}`;
  };
  return [0.2, 0.32, 0.44, 0.56, 0.68, 0.8, 0.9].map(l => [...Array.from({ length: 12 }, (_, i) => hex(i * 30, 0.8, l)), hex(0, 0, l)]);
})();

function ColourPicker({ value, onPick }: { value: string; onPick: (v: string) => void }) {
  const [open, setOpen] = useState(isHex(value));
  return (
    <div className="cp-field"><span>Colour</span>
      <div className="cp-colors" role="radiogroup" aria-label="Colour">
        {QUICK_COLORS.map(c => (
          <button type="button" key={c} role="radio" aria-checked={value === c} aria-label={c} title={c === "default" ? "No colour" : c}
            className={`cp-swatch cb-color-${c}${value === c ? " on" : ""}`} onClick={() => onPick(c)} />
        ))}
        <button type="button" className={`cp-swatch cp-more${isHex(value) ? " on" : ""}`} style={isHex(value) ? { background: value } : undefined} aria-expanded={open} aria-label="More colours" title="More colours" onClick={() => setOpen(o => !o)}>{isHex(value) ? "" : "+"}</button>
      </div>
      {open && (
        <div className="cp-palette-wrap">
          <div className="cp-palette" role="radiogroup" aria-label="Palette">
            {PALETTE.flat().map(h => (
              <button type="button" key={h} role="radio" aria-checked={value.toLowerCase() === h} aria-label={h} title={h} className={`cp-pal${value.toLowerCase() === h ? " on" : ""}`} style={{ background: h }} onClick={() => onPick(h)} />
            ))}
          </div>
          <label className="cp-custom">Any colour
            <input type="color" value={isHex(value) ? value : "#3566d6"} onChange={e => onPick(e.target.value)} aria-label="Pick any colour" />
            <small>{isHex(value) ? value : ""}</small>
          </label>
        </div>
      )}
    </div>
  );
}

export function NodeInspector({ node, status, quizQuestions, lessons, onChange, onDelete, onOpen, onAttachQuiz, onStartQuiz, onSetStatus, onClose }: {
  node: CNode; status?: string; quizQuestions: number; lessons: Lesson[]; onAttachQuiz: () => void;
  onChange: (patch: Partial<CNode>, key: string) => void;
  onDelete: () => void; onOpen: () => void; onStartQuiz: () => void;
  onSetStatus: (s: "in_progress" | "mastered") => void; onClose: () => void;
}) {
  const Icon = TYPE_ICON[node.type];
  const meta = node.meta || {};
  const setMeta = (k: string, v: any) => onChange({ meta: { ...meta, [k]: v } }, "meta." + k + node.id);
  const picked: string[] = Array.isArray(meta.lesson_ids) ? meta.lesson_ids : [];
  return (
    <div className="cp-body">
      <div className="cp-head">
        <span className="cb-icon"><Icon size={15} /></span><strong>{node.type === "note" && meta.frame ? "Frame" : node.type === "note" && meta.plain ? "Text" : TYPE_LABEL[node.type]}</strong>
        <button type="button" className="vp-icon cp-x" aria-label="Close panel" onClick={onClose}><PanelRightClose size={18} /></button>
      </div>
      {node.type !== "note" && (
        <label className="cp-field"><span>Title</span>
          <input className="input" value={node.title} maxLength={255} onChange={e => onChange({ title: e.target.value }, "title" + node.id)} />
        </label>
      )}
      {node.type === "material" && (
        <>
          <label className="cp-field"><span>Level</span>
            <input className="input" value={node.level || ""} maxLength={32} placeholder="e.g. A1" onChange={e => onChange({ level: e.target.value || null }, "level" + node.id)} />
          </label>
          <div className="cp-field"><span>Progress</span>
            <div className="cp-row">
              <span className={`tag cp-status st-${status || "not_started"}`}>{STATUS_LABEL[status || "not_started"]}</span>
              {status === "mastered"
                ? <button type="button" className="btn small" onClick={() => onSetStatus("in_progress")}>Undo mastered</button>
                : <button type="button" className="btn small" onClick={() => onSetStatus("mastered")}>Mark mastered</button>}
            </div>
          </div>
          <div className="cp-row"><button type="button" className="btn primary small" onClick={onOpen}><Play size={14} />Open lesson</button><button type="button" className="btn small" onClick={onAttachQuiz}><HelpCircle size={14} />Attach quiz</button></div>
        </>
      )}
      {node.type === "topic" && (
        <label className="cp-field"><span>Description</span>
          <textarea className="input" rows={3} value={meta.description || ""} maxLength={2000} onChange={e => setMeta("description", e.target.value)} />
        </label>
      )}
      {node.type === "note" && (
        <label className="cp-field"><span>{meta.frame ? "Frame title" : "Text (Markdown)"}</span>
          <textarea className="input cp-note" rows={8} value={meta.text || ""} maxLength={20000} autoFocus onChange={e => setMeta("text", e.target.value)} />
        </label>
      )}
      {node.type === "resource" && (
        <>
          <label className="cp-field"><span>Link (web page or PDF)</span>
            <input className="input" type="url" inputMode="url" placeholder="https://" value={meta.url || ""} maxLength={2000}
              onChange={e => setMeta("url", e.target.value.trim())} />
          </label>
          <label className="cp-field"><span>Kind</span>
            <select className="input" value={meta.kind || "link"} onChange={e => setMeta("kind", e.target.value)}>
              <option value="link">Web link</option><option value="pdf">PDF</option>
            </select>
          </label>
          <label className="cp-field"><span>Notes</span>
            <textarea className="input" rows={3} value={meta.description || ""} maxLength={2000} onChange={e => setMeta("description", e.target.value)} />
          </label>
          {/^https?:\/\//i.test(meta.url || "") && <div className="cp-row"><a className="btn small" href={meta.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} />Open link</a></div>}
        </>
      )}
      {node.type === "quiz" && (
        <>
          <div className="cp-field"><span>Questions from these lessons</span>
            <small className="muted">Lessons connected to this quiz on the canvas count too.</small>
            <div className="cp-checks">
              {lessons.filter(l => (l.test_ids || []).length).map(l => (
                <label key={l.id} className="cp-check">
                  <input type="checkbox" checked={picked.includes(l.id)} onChange={() => setMeta("lesson_ids", picked.includes(l.id) ? picked.filter(x => x !== l.id) : [...picked, l.id])} />
                  <span>{l.title}</span><small>{(l.test_ids || []).length}</small>
                </label>
              ))}
              {!lessons.some(l => (l.test_ids || []).length) && <small className="muted">No lesson has questions yet. Import questions first.</small>}
            </div>
          </div>
          <div className="cp-row"><button type="button" className="btn primary small" disabled={!quizQuestions} onClick={onStartQuiz}><Play size={14} />Start quiz ({quizQuestions})</button></div>
        </>
      )}
      <ColourPicker key={node.id} value={String(meta.color || "default")} onPick={v => setMeta("color", v)} />
      <div className="cp-row cp-danger">
        <button type="button" className="btn danger small" onClick={onDelete}><Trash2 size={14} />{node.type === "material" ? "Delete lesson" : "Delete block"}</button>
      </div>
    </div>
  );
}

export function EdgeInspector({ edge, from, to, onChange, onDelete, onClose }: {
  edge: CEdge; from: string; to: string;
  onChange: (patch: Partial<CEdge>, key: string) => void; onDelete: () => void; onClose: () => void;
}) {
  return (
    <div className="cp-body">
      <div className="cp-head"><strong>Connection</strong>
        <button type="button" className="vp-icon cp-x" aria-label="Close panel" onClick={onClose}><PanelRightClose size={18} /></button>
      </div>
      <p className="muted cp-ends">{from} → {to}</p>
      <label className="cp-field"><span>Type</span>
        <select className="input" value={edge.type} onChange={e => onChange({ type: e.target.value as EdgeType }, "etype" + edge.id)}>
          {EDGE_TYPES.map(t => <option key={t} value={t}>{EDGE_LABEL[t]}</option>)}
        </select>
      </label>
      <label className="cp-field"><span>Label</span>
        <input className="input" value={edge.label || ""} maxLength={255} placeholder={EDGE_LABEL[edge.type]} onChange={e => onChange({ label: e.target.value || null }, "elabel" + edge.id)} />
      </label>
      <p className="muted cp-hint">Connections only describe how ideas relate. They never lock a lesson.</p>
      <div className="cp-row cp-danger"><button type="button" className="btn danger small" onClick={onDelete}><Trash2 size={14} />Delete connection</button></div>
    </div>
  );
}

const bodies = new Map<string, { title: string; level?: string | null; content_markdown: string }>();

export function LessonViewer({ subjectId, lessonId, status, questions, wide, onWide, onClose, onOpenPage, onOpenTest, onSetStatus, onSaved }: {
  subjectId: string; lessonId: string; status?: string; questions: number; wide: boolean;
  onWide: () => void; onClose: () => void; onOpenPage: () => void; onOpenTest: () => void;
  onSetStatus: (s: "in_progress" | "mastered") => void; onSaved: () => void;
}) {
  const [lesson, setLesson] = useState(bodies.get(lessonId) || null);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let gone = false;
    setEdit(null); setError(""); setLesson(bodies.get(lessonId) || null);
    api<any>(`/subjects/${subjectId}/nodes/${lessonId}`).then(l => { if (gone) return; bodies.set(lessonId, l); setLesson(l); }).catch(e => !gone && setError(e.message));
    return () => { gone = true; };
  }, [subjectId, lessonId]);
  async function save() {
    if (!lesson || edit === null) return;
    setSaving(true);
    try {
      const l = await api<any>(`/subjects/${subjectId}/nodes/${lessonId}`, json("PUT", { title: lesson.title, level: lesson.level || null, content_markdown: edit }));
      bodies.set(lessonId, l); setLesson(l); setEdit(null); onSaved();
    } catch (e: any) { setError(e.message); } finally { setSaving(false); }
  }
  return (
    <div className="cp-body cp-viewer">
      <div className="cp-head">
        <strong className="cp-title">{lesson?.title || "Lesson"}</strong>
        <button type="button" className="vp-icon" aria-label={wide ? "Narrow reading mode" : "Wide reading mode"} title={wide ? "Narrow" : "Reading mode"} onClick={onWide}>{wide ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
        <button type="button" className="vp-icon" aria-label="Close lesson" onClick={onClose}><X size={18} /></button>
      </div>
      <div className="cp-row">
        <span className={`tag cp-status st-${status || "not_started"}`}>{STATUS_LABEL[status || "not_started"]}</span>
        {status === "mastered"
          ? <button type="button" className="btn small" onClick={() => onSetStatus("in_progress")}>Undo mastered</button>
          : <button type="button" className="btn small" onClick={() => onSetStatus("mastered")}>Mark mastered</button>}
        <button type="button" className="btn small" disabled={!questions} onClick={onOpenTest}><Play size={14} />Test ({questions})</button>
        <button type="button" className="btn small" onClick={onOpenPage}><ExternalLink size={14} />Full page</button>
        {lesson && edit === null && <button type="button" className="btn small" onClick={() => setEdit(lesson.content_markdown || "")}><Pencil size={14} />Edit</button>}
      </div>
      {error && <p className="error-text">{error}</p>}
      {!lesson ? <p className="muted">Loading lesson…</p> : edit !== null ? (
        <div className="cp-edit">
          <textarea className="input" value={edit} onChange={e => setEdit(e.target.value)} rows={18} aria-label="Lesson text (Markdown)" />
          <div className="cp-row">
            <button type="button" className="btn primary small" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
            <button type="button" className="btn small" onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <article className="lesson-content cp-lesson" data-selectable>{lesson.content_markdown ? <Markdown text={lesson.content_markdown} /> : <p className="muted">This lesson has no text yet. Press Edit to write it.</p>}</article>
      )}
    </div>
  );
}
