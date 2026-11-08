"use client";
import { useEffect, useRef, useState } from "react";
import { Languages } from "lucide-react";
import { LANGS, translate } from "@/lib/translate";

/* Sits under the Term field of the vocabulary form. Translates the term and hands the
   text back; runs by itself once if the form opens with a term already filled in. */

const KEY = "learnify.translate";

function load(): { from: string; to: string } {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (s.from && s.to) return s;
  } catch { /* ignore */ }
  const nav = (typeof navigator !== "undefined" ? navigator.language : "en").split("-")[0];
  return { from: "auto", to: LANGS.some(l => l[0] === nav) ? nav : "en" };
}

export default function TranslateBar({ term, hasDefinition, onResult }: { term: string; hasDefinition: boolean; onResult: (text: string) => void }) {
  const [langs, setLangs] = useState({ from: "auto", to: "en" });
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [msg, setMsg] = useState("");
  const initial = useRef({ term, hasDefinition });
  const ready = useRef(false);
  const abort = useRef<AbortController | null>(null);

  async function run(from = langs.from, to = langs.to) {
    if (!term.trim()) { setState("error"); setMsg("Type or select a word first."); return; }
    abort.current?.abort();
    const ctl = (abort.current = new AbortController());
    setState("busy"); setMsg("");
    try {
      const r = await translate(term, from, to, ctl.signal);
      onResult(r.text);
      setState("idle");
      setMsg(from === "auto" && r.detected ? `Detected language: ${r.detected}` : "");
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setState("error");
      setMsg(e?.message || "Could not translate.");
    }
  }

  useEffect(() => {
    const l = load();
    setLangs(l);
    ready.current = true;
    if (initial.current.term.trim() && !initial.current.hasDefinition) run(l.from, l.to);
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function change(next: { from: string; to: string }) {
    setLangs(next);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }

  return (
    <div className="form-field full translate-bar">
      <div className="translate-row">
        <label>From
          <select className="select" value={langs.from} onChange={e => change({ ...langs, from: e.target.value })}>
            <option value="auto">Auto-detect</option>
            {LANGS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          </select>
        </label>
        <label>To
          <select className="select" value={langs.to} onChange={e => change({ ...langs, to: e.target.value })}>
            {LANGS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
          </select>
        </label>
        <button type="button" className="btn" disabled={state === "busy"} onClick={() => run()}><Languages size={16} />{state === "busy" ? "Translating…" : "Translate"}</button>
      </div>
      {msg && <small className={state === "error" ? "translate-msg err" : "translate-msg"}>{msg}</small>}
      <small className="translate-msg">Free translation by MyMemory. Only the word you translate is sent. Check it before saving.</small>
    </div>
  );
}
