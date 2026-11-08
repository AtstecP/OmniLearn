"use client";
import { useEffect, useRef, useState } from "react";
import { BookmarkPlus, Volume2 } from "lucide-react";

/*
 * "Add to vocabulary" for selected text. Select a word or phrase inside any element
 * marked data-selectable (lessons, reading texts) and:
 *  - desktop: right-click shows a small menu at the pointer
 *  - touch:   a floating button appears under the selection (there is no right click)
 * The sentence around the selection is passed along as the example.
 */

type Menu = { x: number; y: number; term: string; sentence: string; touch: boolean };
const MAX = 120;
const BLOCKS = "p,li,td,th,blockquote,h1,h2,h3,h4,h5,h6,dd,dt";

const clean = (t: string) => t.replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").trim();
const elOf = (n: Node | null) => (n && n.nodeType === 1 ? (n as Element) : n?.parentElement) || null;

function read(): { term: string; sentence: string; rect: DOMRect } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const a = elOf(sel.anchorNode)?.closest("[data-selectable]");
  const b = elOf(sel.focusNode)?.closest("[data-selectable]");
  if (!a || a !== b) return null;
  const term = clean(sel.toString());
  if (!term || term.length > MAX) return null;
  const range = sel.getRangeAt(0);
  const block = elOf(range.startContainer)?.closest(BLOCKS);
  let sentence = "";
  const text = (block?.textContent || "").replace(/\s+/g, " ").trim();
  if (text) {
    const lower = text.toLowerCase();
    const at = lower.indexOf(term.toLowerCase());
    const parts = text.match(/[^.!?…]+[.!?…]*\s*/g) || [text];
    let pos = 0;
    for (const p of parts) {
      if (at >= pos && at < pos + p.length) { sentence = p.trim(); break; }
      pos += p.length;
    }
    if (!sentence) sentence = text.slice(0, 200);
    if (sentence.length > 300) sentence = sentence.slice(0, 300).trim() + "…";
    if (sentence.toLowerCase() === term.toLowerCase()) sentence = "";
  }
  return { term, sentence, rect: range.getBoundingClientRect() };
}

export default function SelectionMenu({ onAdd, onRead }: { onAdd: (term: string, sentence: string) => void; onRead?: (text: string) => void }) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number>(0);

  useEffect(() => {
    const coarse = () => window.matchMedia("(pointer: coarse)").matches;
    const clamp = (x: number, y: number) => ({ x: Math.max(8, Math.min(x, window.innerWidth - 240)), y: Math.max(8, Math.min(y, window.innerHeight - 64)) });

    function onContext(e: MouseEvent) {
      const r = read();
      if (!r) return;
      e.preventDefault();
      setMenu({ ...clamp(e.clientX, e.clientY), term: r.term, sentence: r.sentence, touch: false });
    }
    function onSelection() {
      if (!coarse()) return;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const r = read();
        if (!r) { setMenu(m => (m?.touch ? null : m)); return; }
        setMenu({ ...clamp(r.rect.left, r.rect.bottom + 10), term: r.term, sentence: r.sentence, touch: true });
      }, 350);
    }
    function onDown(e: Event) {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      setMenu(null);
    }
    const hide = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    document.addEventListener("contextmenu", onContext);
    document.addEventListener("selectionchange", onSelection);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener("contextmenu", onContext);
      document.removeEventListener("selectionchange", onSelection);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  if (!menu) return null;
  const shown = menu.term.length > 28 ? menu.term.slice(0, 27) + "…" : menu.term;
  return (
    <div ref={ref} className="sel-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
      <button type="button" role="menuitem" onMouseDown={e => e.preventDefault()}
        onClick={() => { const m = menu; setMenu(null); window.getSelection()?.removeAllRanges(); onAdd(m.term, m.sentence); }}>
        <BookmarkPlus size={16} />Add “{shown}” to vocabulary
      </button>
      {onRead && (
        <button type="button" role="menuitem" onMouseDown={e => e.preventDefault()}
          onClick={() => { const m = menu; setMenu(null); onRead(m.term); }}>
          <Volume2 size={16} />Read it
        </button>
      )}
    </div>
  );
}
