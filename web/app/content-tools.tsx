"use client";
import { useEffect, useState } from "react";
import { Copy, Search, Trash2 } from "lucide-react";
import { api, json } from "@/lib/api";
import { extractJson } from "@/lib/extractJson";

/*
 * Edit-as-JSON and word management.
 *  - JsonEditor: loads the current learning path / vocabulary / readings as the ID-free bundle JSON,
 *    lets the user edit or copy it, and saves it back with PUT /subjects/{sid}/content/{part}.
 *    The API replaces that part in one transaction, so removed lessons take their questions,
 *    attempts and mistakes with them.
 *  - VocabManager: searchable word list with a delete button per card.
 */

export type Part = "path" | "vocabulary" | "readings";

const LABEL: Record<Part, string> = { path: "learning path", vocabulary: "vocabulary", readings: "reading texts" };
const WARN: Record<Part, string> = {
  path: "Saving replaces every lesson and every question of this subject with this JSON. Lessons or questions you removed are deleted for good, together with their answers, mistakes and lesson progress.",
  vocabulary: "Saving replaces all vocabulary cards with this JSON. Removed words are deleted for good, together with their review history.",
  readings: "Saving replaces all reading texts with this JSON. Removed texts and their questions are deleted for good.",
};

function slice(part: Part, bundle: any) {
  if (part === "path") return { lessons: bundle.lessons || [], questions: bundle.questions || [] };
  if (part === "vocabulary") return { vocabulary: bundle.vocabulary || [] };
  return { readings: bundle.readings || [] };
}

export function JsonEditor({ subjectId, part, onClose, onSaved }: { subjectId: string; part: Part; onClose: () => void; onSaved: (msg: string) => void }) {
  const [text, setText] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    api(`/subjects/${encodeURIComponent(subjectId)}/export`)
      .then(b => { if (!alive) return; const t = JSON.stringify(slice(part, b), null, 2); setText(t); setOriginal(t); })
      .catch(e => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [subjectId, part]);

  async function copy() {
    try { await navigator.clipboard.writeText(text); }
    catch { const el = document.getElementById("json-editor-area") as HTMLTextAreaElement | null; el?.select(); document.execCommand("copy"); }
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  }

  async function save() {
    setError("");
    const parsed = extractJson(text);
    if ("error" in parsed) { setError(parsed.error); return; }
    if (!window.confirm(`${WARN[part]}\n\nSave changes?`)) return;
    setSaving(true);
    try {
      const r = await api<any>(`/subjects/${encodeURIComponent(subjectId)}/content/${part}`, json("PUT", parsed.value));
      const c = r.saved || {};
      onSaved(part === "path" ? `Saved: ${c.lessons ?? 0} lessons, ${c.questions ?? 0} questions.` : part === "vocabulary" ? `Saved ${c.vocabulary ?? 0} words.` : `Saved ${c.readings ?? 0} texts.`);
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  const changed = text !== original;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal json-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div><h2>Edit {LABEL[part]} as JSON</h2><p>Change the text, add or delete entries, then save. No IDs needed.</p></div>
          <button className="close-button" onClick={onClose}>×</button>
        </div>
        <textarea id="json-editor-area" className="textarea json-area" spellCheck={false} value={loading ? "Loading…" : text} disabled={loading}
          onChange={e => setText(e.target.value)} />
        {error && <div className="feedback wrong import-error" role="alert">{error}</div>}
        <small className="muted-copy" style={{ display: "block", marginTop: 8 }}>{WARN[part]}</small>
        <div className="filter-row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={copy} disabled={loading}><Copy size={16} />{copied ? "Copied" : "Copy JSON"}</button>
          <button className="btn primary" onClick={save} disabled={loading || saving || !changed}>{saving ? "Saving…" : "Save changes"}</button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </section>
    </div>
  );
}

type Card = { id: string; term: string; definition: string; tags?: string[] };

export function VocabManager({ cards, onDelete, onClose }: { cards: Card[]; onDelete: (c: Card) => Promise<void>; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState("");
  const list = cards.filter(c => !q.trim() || `${c.term} ${c.definition}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal json-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div><h2>Manage words</h2><p>{cards.length} {cards.length === 1 ? "word" : "words"}. Delete the ones you no longer need.</p></div>
          <button className="close-button" onClick={onClose}>×</button>
        </div>
        <label className="vocab-search"><Search size={16} /><input className="input" placeholder="Search words" value={q} onChange={e => setQ(e.target.value)} /></label>
        <div className="vocab-manage-list">
          {list.map(c => (
            <div className="vocab-manage-row" key={c.id}>
              <div><strong>{c.term}</strong><small>{c.definition}</small></div>
              <button className="btn danger" disabled={busy === c.id} aria-label={`Delete ${c.term}`}
                onClick={async () => { if (!window.confirm(`Delete "${c.term}"? This can't be undone.`)) return; setBusy(c.id); try { await onDelete(c); } finally { setBusy(""); } }}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          {!list.length && <div className="empty-state"><strong>{cards.length ? "No matches" : "No words"}</strong></div>}
        </div>
      </section>
    </div>
  );
}
