"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Lightbulb } from "lucide-react";
import { sfx } from "@/lib/sounds";

/*
 * Type an answer straight into coloured blocks (one per word), the same way as Dictation:
 * there is no visible text field, keys typed anywhere go into the blocks, each finished word
 * turns green or red with a sound, and the Hint button reveals the next word.
 * Calls onSolved once the whole answer is spelled right.
 */

export type Solved = { errors: number; hints: number; accent: boolean };
type Status = "pending" | "typing" | "typing-bad" | "right" | "wrong";

const tidy = (s: string) => s.normalize("NFC").replace(/[‘’ʼ`]/g, "'").replace(/[“”]/g, '"');
const isCjk = (s: string) => !/\s/.test(s.trim()) && /[぀-ヿ㐀-鿿가-힯]/.test(s);
const splitWords = (s: string, cjk: boolean) => {
  const t = tidy(s).trim();
  return cjk ? Array.from(t).filter(c => /[\p{L}\p{N}]/u.test(c)) : t.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
};
const fold = (w: string, ignoreAccents: boolean) => {
  let x = tidy(w).toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (ignoreAccents) x = x.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return x;
};

/** Keeps room under the phone keyboard: sets --kb on the element to the height the keyboard covers. */
export function useKeyboardInset(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const fit = () => {
      const el = ref.current;
      if (!el) return;
      el.style.setProperty("--kb", Math.max(0, el.clientHeight - (vv.offsetTop + vv.height)) + "px");
    };
    fit();
    vv.addEventListener("resize", fit); vv.addEventListener("scroll", fit);
    return () => { vv.removeEventListener("resize", fit); vv.removeEventListener("scroll", fit); };
  }, [ref]);
}

export default function TypeBlocks({ answer, sound, onSolved }: { answer: string; sound: boolean; onSolved: (r: Solved) => void }) {
  const target = useMemo(() => answer.split(";")[0].trim(), [answer]);
  const cjk = isCjk(target);
  const words = useMemo(() => splitWords(target, cjk), [target, cjk]);
  const [input, setInput] = useState("");
  const [done, setDone] = useState(false);
  const [checked, setChecked] = useState(false);
  const [shake, setShake] = useState(-2);
  const [errors, setErrors] = useState(0);
  const [hints, setHints] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const before = useRef("");

  const typed = useMemo(() => splitWords(input, cjk), [input, cjk]);
  const trailing = !cjk && /\s$/.test(input);
  const typingIdx = cjk ? -1 : trailing ? typed.length : typed.length - 1;
  // Accents are forgiven while typing (the result then says "mind the accents").
  const same = (a: string, b: string) => fold(a, true) === fold(b, true);

  const statuses: Status[] = words.map((w, i) => {
    if (i >= typed.length) return "pending";
    const eq = same(typed[i], w);
    if (i === typingIdx) return eq ? "right" : fold(w, true).startsWith(fold(typed[i], true)) ? "typing" : "typing-bad";
    return eq ? "right" : "wrong";
  });
  const success = words.length > 0 && typed.length === words.length && words.every((w, i) => same(typed[i], w));

  useEffect(() => { const t = window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 150); return () => window.clearTimeout(t); }, []);

  function flash(w: number) { setShake(w); window.setTimeout(() => setShake(-2), 450); }

  function judge(prev: string, next: string) {
    if (done) return;
    if (cjk) {
      const a = splitWords(prev, true).length, b = splitWords(next, true);
      if (b.length > a && b.length <= words.length) {
        const i = b.length - 1;
        if (same(b[i], words[i])) { if (sound && b.length < words.length) sfx.word(); }
        else { if (sound) sfx.bad(); setErrors(e => e + 1); flash(i); }
      }
      return;
    }
    if (/\s$/.test(next) && !/\s$/.test(prev)) {
      const t = splitWords(next, false), i = t.length - 1;
      if (i < 0) return;
      if (i < words.length && same(t[i], words[i])) { if (sound && i + 1 < words.length) sfx.word(); }
      else { if (sound) sfx.bad(); setErrors(e => e + 1); flash(Math.min(i, words.length)); }
    }
  }
  function onChange(v: string) {
    if (done) return;
    if (!composing.current) judge(input, v);
    setInput(v);
  }
  function check() {
    if (done || success) return;
    setChecked(true); setErrors(e => e + 1); flash(-1);
    if (sound) sfx.bad();
    inputRef.current?.focus({ preventScroll: true });
  }
  function hint() {
    if (done) return;
    let j = 0;
    while (j < words.length && j < typed.length && same(typed[j], words[j])) j++;
    if (j >= words.length) return;
    const next = words.slice(0, j + 1);
    setInput(cjk ? next.join("") : next.join(" ") + (j + 1 < words.length ? " " : ""));
    setHints(h => h + 1);
    if (sound) sfx.word();
    inputRef.current?.focus({ preventScroll: true });
  }

  // Keys typed anywhere on the screen land in the blocks.
  const live = useRef({ change: (_v: string) => {}, enter: () => {}, input: "" });
  live.current = { change: onChange, enter: check, input };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = inputRef.current;
      if (!el || e.target === el || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      const onButton = t?.tagName === "BUTTON";
      if (e.key.length === 1 && !(onButton && e.key === " ")) {
        e.preventDefault(); e.stopPropagation(); el.focus({ preventScroll: true }); live.current.change(live.current.input + e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault(); e.stopPropagation(); el.focus({ preventScroll: true }); live.current.change(live.current.input.slice(0, -1));
      } else if (e.key === "Enter" && !onButton) {
        e.preventDefault(); e.stopPropagation(); el.focus({ preventScroll: true }); live.current.enter();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  // The whole answer is right.
  useEffect(() => {
    if (done || !success || composing.current) return;
    setDone(true);
    if (sound) sfx.ok();
    const accent = words.some((w, i) => fold(typed[i], false) !== fold(w, false));
    onSolved({ errors, hints, accent });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [success, done]);

  const cursorIdx = done ? -1 : typed.length === 0 ? 0 : trailing ? typed.length : cjk ? typed.length : typed.length - 1;
  const focusInput = () => inputRef.current?.focus({ preventScroll: true });

  return (
    <div className="tb">
      <div className="dict-audio">
        <button type="button" className="vp-speak small" onClick={() => { sfx.unlock(); hint(); }} disabled={done} aria-label="Hint: reveal the next word" title="Hint"><Lightbulb size={20} /></button>
      </div>
      <div className={`dict-slots ${shake === -1 ? "shake" : ""}`} aria-label="Your answer, word by word" onClick={focusInput}>
        {words.map((w, i) => {
          const st: Status = checked && statuses[i] === "pending" ? "wrong" : statuses[i];
          return (
            <span key={i} className={`dict-slot ${st} ${shake === i ? "shake" : ""} ${cursorIdx === i ? "cursor" : ""}`} style={{ minWidth: `${Math.max(2, Array.from(w).length) * 0.62}em` }}>
              {typed[i] ?? " "}
            </span>
          );
        })}
        {typed.slice(words.length).map((t, i) => <span key={"x" + i} className="dict-slot wrong extra">{t}</span>)}
      </div>
      <input ref={inputRef} className="dict-input" value={input} readOnly={done}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && !composing.current) { e.preventDefault(); e.stopPropagation(); check(); } }}
        onCompositionStart={() => { composing.current = true; before.current = input; }}
        onCompositionEnd={e => { composing.current = false; judge(before.current, e.currentTarget.value); setInput(e.currentTarget.value); }}
        aria-label="Type the word"
        autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} enterKeyHint="done" />
      <div className="dict-msg" aria-live="polite">
        {checked ? <span className="bad">Not quite: fix the red words.</span> : input === "" ? <span className="dict-tip">Just start typing: your keys go straight into the blocks.</span> : null}
      </div>
    </div>
  );
}
