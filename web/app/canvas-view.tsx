"use client";
/*
 * Freeform learning canvas (React Flow). Lessons, topics, quizzes, notes and resources are blocks
 * placed anywhere; connections are stored on their own (roadmap_edges) and never imply a hierarchy
 * or lock anything. Positions, blocks and connections autosave in batches (lib/canvas-sync.ts),
 * survive refreshes and offline periods, and undo/redo works on whole canvas snapshots.
 *
 * Mouse: drag a block to move it, drag the background to pan, scroll to zoom, Shift+drag to select
 * with a rectangle, drag from a dot on a block's edge to connect. Double-click opens a block.
 * Keys: Space quick-create, Delete, Ctrl+D duplicate, Ctrl+C / Ctrl+V, Ctrl+Z / Ctrl+Shift+Z.
 */
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background, BackgroundVariant, ConnectionMode, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider, SelectionMode, applyEdgeChanges, applyNodeChanges,
  useReactFlow, type Connection, type Edge as RFEdge, type EdgeChange, type Node as RFNode, type NodeChange, type Viewport,
} from "@xyflow/react";
import { AlignStartHorizontal, AlignStartVertical, BoxSelect, CloudOff, Copy, Frame, Grid3x3, Hand, LayoutGrid, Type as TypeIcon, List, Loader2, Maximize, Minimize, Plus, Redo2, Search, Trash2, Undo2, X, Check, AlertTriangle } from "lucide-react";
import { api } from "@/lib/api";
import { autoLayout } from "@/lib/canvas-layout";
import { CanvasSync, loadStored, NODE_TYPES, snapFrom, tempId, type CEdge, type CNode, type NodeType, type SaveState, type Snap } from "@/lib/canvas-sync";
import { BlockNode, FloatingEdge, TYPE_ICON, TYPE_LABEL, type BlockData } from "./canvas-blocks";
import { EdgeInspector, LessonViewer, NodeInspector } from "./canvas-panel";
import type { Node as Lesson, Test } from "./types";

type Extras = { subject_id?: string; version: number; nodes: any[]; edges: any[] } | null;
type Props = {
  userId: string; subjectId: string;
  lessons: Lesson[]; extras: Extras; statuses: Record<string, string>; questions: Test[];
  onOpenLesson: (id: string) => void; onOpenTest: (id: string) => void;
  onStartQuiz: (testIds: string[], title: string) => void;
  onSetStatus: (id: string, status: "in_progress" | "mastered") => Promise<void>;
  onLessonsChanged: () => void; message: (s: string) => void;
};
type Menu = { x: number; y: number; flow: { x: number; y: number }; kind: "pane" | "node" | "edge"; id?: string } | null;

const nodeTypes = { block: BlockNode };
const edgeTypes = { floating: FloatingEdge };
const GRID = 20;
const DEFAULT_META: Record<NodeType, Record<string, any>> = { topic: { color: "blue" }, material: {}, quiz: { lesson_ids: [] }, note: { text: "", color: "yellow" }, resource: { url: "", kind: "link" } };
const DEFAULT_TITLE: Record<NodeType, string> = { topic: "New topic", material: "New lesson", quiz: "Quiz", note: "Note", resource: "Resource" };
const empty: Snap = { nodes: {}, edges: {} };
let clipboard: { nodes: CNode[]; edges: CEdge[] } | null = null;

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

export default function CanvasView(props: Props) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}

function Canvas({ userId, subjectId, lessons, extras, statuses, questions, onOpenLesson, onOpenTest, onStartQuiz, onSetStatus, onLessonsChanged, message }: Props) {
  const rf = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);
  const [snap, setSnap] = useState<Snap>(empty);
  const snapRef = useRef(snap); snapRef.current = snap;
  const [ready, setReady] = useState(false);
  const [save, setSave] = useState<{ s: SaveState; msg?: string }>({ s: "saved" });
  const [rfNodes, setRfNodes] = useState<RFNode[]>([]);
  const [rfEdges, setRfEdges] = useState<RFEdge[]>([]);
  const [menu, setMenu] = useState<Menu>(null);
  const [panel, setPanel] = useState(true);
  const [viewer, setViewer] = useState<string | null>(null);
  const [wide, setWide] = useState(false);
  const [full, setFull] = useState(false);
  const [blocks, setBlocks] = useState(false);
  const [query, setQuery] = useState("");
  const [snapGrid, setSnapGrid] = useState(false);
  const [tool, setTool] = useState<"pan" | "select" | "frame" | "text">("pan");
  const [drawing, setDrawing] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [, force] = useState(0);
  const history = useRef<{ past: Snap[]; future: Snap[]; lastKey: string; lastAt: number }>({ past: [], future: [], lastKey: "", lastAt: 0 });
  const mouse = useRef<{ x: number; y: number } | null>(null);
  const sync = useRef<CanvasSync | null>(null);
  const pendingSel = useRef<string[] | null>(null);       // select these blocks once they are on screen
  const idMap = useRef<Record<string, string>>({});       // temp id -> server id (keeps the selection across a save)
  const lessonsChanged = useRef(onLessonsChanged); lessonsChanged.current = onLessonsChanged;

  useEffect(() => { try { setSnapGrid(localStorage.getItem("learnify.canvas.grid") === "1"); } catch { /* ignore */ } }, []);

  // ---------------------------------------------------------------- sync lifecycle
  // The lessons/extras props belong to whichever subject was loaded last; use them only when they are this subject's.
  const serverSnap = useMemo(() => extras && extras.subject_id === subjectId && lessons.every(l => l.subject_id === subjectId) ? { version: extras.version, snap: snapFrom([...lessons, ...extras.nodes], extras.edges) } : null, [lessons, extras, subjectId]);
  useEffect(() => {
    const s = new CanvasSync({
      userId, sid: subjectId,
      onLocal: l => setSnap(l),
      onState: (st, msg) => setSave({ s: st, msg }),
      onLessonsChanged: () => lessonsChanged.current(),
      onRemap: map => {
        const h = history.current;
        const fix = (x: Snap) => { const out: Snap = { nodes: {}, edges: {} }; const m = (id: string) => map[id] || id;
          for (const n of Object.values(x.nodes)) out.nodes[m(n.id)] = { ...n, id: m(n.id) };
          for (const e of Object.values(x.edges)) out.edges[m(e.id)] = { ...e, id: m(e.id), source: m(e.source), target: m(e.target) };
          return out; };
        h.past = h.past.map(fix); h.future = h.future.map(fix);
        idMap.current = { ...idMap.current, ...map };
        setViewer(v => (v && map[v]) || v);
      },
    });
    sync.current = s;
    let gone = false;
    (async () => {
      const stored = await loadStored(userId, subjectId);
      let server = serverSnapRef.current;
      if (!server) {
        try { const cv = await api<any>(`/subjects/${subjectId}/canvas`); server = { version: cv.version, snap: snapFrom(cv.nodes, cv.edges) }; } catch { /* offline: stored only */ }
      }
      if (gone) return;
      s.init(server, stored);
      setReady(true);
      requestAnimationFrame(() => { if (s.viewport) rf.setViewport(s.viewport); else rf.fitView({ padding: 0.2, maxZoom: 1 }); });
    })();
    return () => { gone = true; s.stop(); sync.current = null; history.current = { past: [], future: [], lastKey: "", lastAt: 0 }; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, subjectId]);
  const serverSnapRef = useRef(serverSnap); serverSnapRef.current = serverSnap;
  useEffect(() => { if (ready && serverSnap) sync.current?.server(serverSnap.version, serverSnap.snap); }, [ready, serverSnap]);
  // Flush on tab hide so a closed tab keeps as little pending as possible (it is stored anyway).
  useEffect(() => { const f = () => { if (document.visibilityState === "hidden") sync.current?.flushSoon(); }; document.addEventListener("visibilitychange", f); return () => document.removeEventListener("visibilitychange", f); }, []);

  /** Change the canvas: recorded for undo (keystrokes on the same field within 1.5 s count as one step). */
  const commit = useCallback((next: Snap, key = "") => {
    const h = history.current, now = Date.now();
    if (!(key && key === h.lastKey && now - h.lastAt < 1500)) { h.past.push(snapRef.current); if (h.past.length > 100) h.past.shift(); }
    h.future = []; h.lastKey = key; h.lastAt = now;
    snapRef.current = next;
    setSnap(next);
    sync.current?.setLocal(next);
    force(x => x + 1);
  }, []);
  const undo = useCallback(() => {
    const h = history.current; const prev = h.past.pop(); if (!prev) return;
    h.future.push(snapRef.current); h.lastKey = "";
    snapRef.current = prev; setSnap(prev); sync.current?.setLocal(prev); force(x => x + 1);
  }, []);
  const redo = useCallback(() => {
    const h = history.current; const next = h.future.pop(); if (!next) return;
    h.past.push(snapRef.current); h.lastKey = "";
    snapRef.current = next; setSnap(next); sync.current?.setLocal(next); force(x => x + 1);
  }, []);

  // ---------------------------------------------------------------- derived data
  const testsByLesson = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const q of questions) if (q.node_id) (m[q.node_id] ||= []).push(q.id);
    return m;
  }, [questions]);
  const neighbours = useMemo(() => {
    const m: Record<string, Set<string>> = {};
    for (const e of Object.values(snap.edges)) { (m[e.source] ||= new Set()).add(e.target); (m[e.target] ||= new Set()).add(e.source); }
    return m;
  }, [snap.edges]);
  const quizTests = useCallback((n: CNode) => {
    const ids = new Set<string>([...(Array.isArray(n.meta?.lesson_ids) ? n.meta.lesson_ids : []), ...[...(neighbours[n.id] || [])].filter(id => snap.nodes[id]?.type === "material")]);
    return [...ids].flatMap(id => testsByLesson[id] || []);
  }, [neighbours, snap.nodes, testsByLesson]);
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => !q ? [] : Object.values(snap.nodes).filter(n => [n.title, n.meta?.text, n.meta?.description, n.meta?.url, n.level].some(v => typeof v === "string" && v.toLowerCase().includes(q))), [q, snap.nodes]);
  const matchSet = useMemo(() => new Set(matches.map(n => n.id)), [matches]);

  const onResizeEnd = useCallback((id: string, p: { x: number; y: number; width: number; height: number }) => {
    const s = snapRef.current, n = s.nodes[id]; if (!n) return;
    commit({ ...s, nodes: { ...s.nodes, [id]: { ...n, x: p.x, y: p.y, w: Math.round(p.width), h: Math.round(p.height) } } });
  }, [commit]);

  useEffect(() => {
    setRfNodes(prev => {
      const sel = new Set(pendingSel.current || prev.filter(n => n.selected).map(n => idMap.current[n.id] || n.id));
      pendingSel.current = null;
      return Object.values(snap.nodes).map(n => {
        const data: BlockData = { node: n, onResizeEnd, match: matchSet.has(n.id) };
        if (n.type === "material") { data.status = statuses[n.id] || "not_started"; data.questions = (testsByLesson[n.id] || n.testIds || []).length; }
        if (n.type === "quiz") data.questions = quizTests(n).length;
        if (n.type === "topic") {
          const ls = [...(neighbours[n.id] || [])].filter(id => snap.nodes[id]?.type === "material");
          data.progress = { done: ls.filter(id => statuses[id] === "mastered").length, total: ls.length };
        }
        return { id: n.id, type: "block", position: { x: n.x, y: n.y }, ...(n.type === "note" && n.meta?.frame ? { zIndex: -1 } : {}), data: data as any, selected: sel.has(n.id),
          ...(n.w ? { width: n.w, height: n.h || undefined, style: { width: n.w, height: n.h || undefined } } : {}) } as RFNode;
      });
    });
  }, [snap.nodes, statuses, testsByLesson, neighbours, quizTests, matchSet, onResizeEnd]);
  useEffect(() => {
    setRfEdges(prev => {
      const sel = new Set(prev.filter(e => e.selected).map(e => idMap.current[e.id] || e.id));
      return Object.values(snap.edges).map(e => ({ id: e.id, source: e.source, target: e.target, type: "floating", selected: sel.has(e.id),
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }, data: { type: e.type, label: e.label } }));
    });
  }, [snap.edges]);

  const selectedNodes = rfNodes.filter(n => n.selected).map(n => n.id);
  const selectedEdges = rfEdges.filter(e => e.selected).map(e => e.id);
  const one = selectedNodes.length === 1 && !selectedEdges.length ? snap.nodes[selectedNodes[0]] : null;
  const oneEdge = selectedEdges.length === 1 && !selectedNodes.length ? snap.edges[selectedEdges[0]] : null;

  // ---------------------------------------------------------------- editing
  const onNodesChange = useCallback((changes: NodeChange[]) => setRfNodes(n => applyNodeChanges(changes.filter(c => c.type !== "remove"), n)), []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => setRfEdges(e => applyEdgeChanges(changes.filter(c => c.type !== "remove"), e)), []);
  const onDragStop = useCallback((_: any, __: any, moved: RFNode[]) => {
    const s = snapRef.current; let changed = false; const nodes = { ...s.nodes };
    for (const m of moved) { const n = nodes[m.id]; if (n && (n.x !== m.position.x || n.y !== m.position.y)) { nodes[m.id] = { ...n, x: Math.round(m.position.x), y: Math.round(m.position.y) }; changed = true; } }
    if (changed) commit({ ...s, nodes });
  }, [commit]);
  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    const s = snapRef.current, id = tempId();
    commit({ ...s, edges: { ...s.edges, [id]: { id, source: c.source, target: c.target, type: "default", label: null } } });
  }, [commit]);
  // Dropping a connection anywhere on a block (not only on its dots) connects to that block.
  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: any) => {
    if (state?.isValid || !state?.fromNode) return;
    const p = "changedTouches" in event ? event.changedTouches[0] : event;
    const el = document.elementFromPoint(p.clientX, p.clientY)?.closest(".react-flow__node");
    const target = el?.getAttribute("data-id");
    if (target && target !== state.fromNode.id) onConnect({ source: state.fromNode.id, target, sourceHandle: null, targetHandle: null });
  }, [onConnect]);
  const select = useCallback((ids: string[], edgeIds: string[] = []) => {
    setRfNodes(n => n.map(x => ({ ...x, selected: ids.includes(x.id) })));
    setRfEdges(e => e.map(x => ({ ...x, selected: edgeIds.includes(x.id) })));
  }, []);

  const createAt = useCallback((type: NodeType, pos: { x: number; y: number }) => {
    const s = snapRef.current, id = tempId();
    const at = snapGrid ? { x: Math.round(pos.x / GRID) * GRID, y: Math.round(pos.y / GRID) * GRID } : { x: Math.round(pos.x), y: Math.round(pos.y) };
    const n: CNode = { id, type, title: DEFAULT_TITLE[type], x: at.x - 100, y: at.y - 30, meta: { ...DEFAULT_META[type] }, testIds: [],
      ...(type === "note" ? { w: 220, h: 140 } : {}) };
    commit({ ...s, nodes: { ...s.nodes, [id]: n } });
    setMenu(null); setPanel(true); setViewer(null);
    pendingSel.current = [id];
  }, [commit, select, snapGrid]);
  /** A quiz block right of the lesson, connected to it (type "tests"); it runs the lesson's questions. */
  const attachQuiz = useCallback((lessonId: string) => {
    const s = snapRef.current, l = s.nodes[lessonId]; if (!l) return;
    const old = Object.values(s.edges).some(e => (e.source === lessonId || e.target === lessonId) && (s.nodes[e.source]?.type === "quiz" || s.nodes[e.target]?.type === "quiz"));
    if (old && !window.confirm("This lesson already has a quiz block. Add another?")) return;
    const id = tempId(), eid = tempId();
    const n: CNode = { id, type: "quiz", title: `${l.title} quiz`.slice(0, 255), x: l.x + 300, y: l.y + 10, meta: { lesson_ids: [lessonId] }, testIds: [] };
    commit({ nodes: { ...s.nodes, [id]: n }, edges: { ...s.edges, [eid]: { id: eid, source: lessonId, target: id, type: "tests", label: null } } });
    pendingSel.current = [id];
    setMenu(null);
  }, [commit]);
  /** One button: a quiz block for every lesson that has questions and no quiz block yet (a single undo step). */
  const attachAllQuizzes = useCallback(() => {
    const s = snapRef.current;
    const hasQuiz = (id: string) => Object.values(s.edges).some(e => (e.source === id || e.target === id) && (s.nodes[e.source]?.type === "quiz" || s.nodes[e.target]?.type === "quiz"));
    const todo = Object.values(s.nodes).filter(n => n.type === "material" && !n.id.startsWith("tmp-") && (testsByLesson[n.id] || []).length && !hasQuiz(n.id));
    if (!todo.length) { message("Every lesson with questions already has a quiz block."); return; }
    if (!window.confirm(`Add a quiz block next to ${todo.length} lesson${todo.length === 1 ? "" : "s"}? You can undo it with Ctrl+Z.`)) return;
    const nodes = { ...s.nodes }, edges = { ...s.edges };
    for (const l of todo) {
      const id = tempId(), eid = tempId();
      nodes[id] = { id, type: "quiz", title: `${l.title} quiz`.slice(0, 255), x: l.x + 300, y: l.y + 10, meta: { lesson_ids: [l.id] }, testIds: [] };
      edges[eid] = { id: eid, source: l.id, target: id, type: "tests", label: null };
    }
    commit({ nodes, edges });
  }, [commit, message, testsByLesson]);
  /** Tidy everything (or just the selected blocks when 2+ are selected) into tree-like columns. One undo step. */
  const arrange = useCallback(() => {
    const s = snapRef.current;
    const sel = rf.getNodes().filter(n => n.selected).map(n => n.id);
    const scope = sel.length > 1 ? new Set(sel) : null;
    const nodes = Object.values(s.nodes).filter(n => !scope || scope.has(n.id));
    const pos = autoLayout(nodes, Object.values(s.edges));
    if (!Object.keys(pos).length) return;
    if (!scope && !window.confirm("Arrange all blocks automatically? Frames and text labels stay where they are. You can undo it with Ctrl+Z.")) return;
    const next = { ...s.nodes };
    for (const [id, p] of Object.entries(pos)) next[id] = { ...next[id], x: Math.round(p.x), y: Math.round(p.y) };
    commit({ ...s, nodes: next });
    setTimeout(() => rf.fitView({ padding: 0.2, maxZoom: 1, duration: 400 }), 60);
  }, [commit, rf]);
  const align = useCallback((axis: "x" | "y") => {
    const s = snapRef.current, sel = rf.getNodes().filter(n => n.selected).map(n => n.id).filter(id => s.nodes[id]);
    if (sel.length < 2) return;
    // Line the blocks up on one edge, then spread them along that line so none sit on top of another.
    const to = Math.min(...sel.map(id => s.nodes[id][axis]));
    const other = axis === "x" ? "y" : "x";
    const order = [...sel].sort((a, b) => s.nodes[a][other] - s.nodes[b][other] || a.localeCompare(b));
    const next = { ...s.nodes };
    let prev: CNode | null = null;
    for (const id of order) {
      let at = s.nodes[id][other];
      if (prev) {
        const gap = axis === "x" ? Math.max(120, (prev.h || 0) + 30) : Math.max(300, (prev.w || 0) + 40);
        at = Math.max(at, prev[other] + gap);
      }
      prev = { ...s.nodes[id], [axis]: to, [other]: at } as CNode;
      next[id] = prev;
    }
    commit({ ...s, nodes: next });
  }, [commit, rf]);
  const finishDraw = useCallback((kind: "frame" | "text", a: { x: number; y: number }, b?: { x: number; y: number }) => {
    const s = snapRef.current, id = tempId();
    const x = Math.round(b ? Math.min(a.x, b.x) : a.x), y = Math.round(b ? Math.min(a.y, b.y) : a.y);
    const n: CNode = kind === "frame"
      ? { id, type: "note", title: "Frame", x, y, w: Math.max(120, Math.round(Math.abs(b!.x - a.x))), h: Math.max(80, Math.round(Math.abs(b!.y - a.y))), meta: { frame: true, text: "", color: "blue" }, testIds: [] }
      : { id, type: "note", title: "Text", x, y, w: 220, h: 60, meta: { plain: true, text: "" }, testIds: [] };
    pendingSel.current = [id];
    commit({ ...s, nodes: { ...s.nodes, [id]: n } });
    setTool("pan"); setPanel(true); setViewer(null);
  }, [commit]);
  const centre = useCallback(() => {
    const r = wrap.current?.getBoundingClientRect();
    return r ? rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 0, y: 0 };
  }, [rf]);

  const removeIds = useCallback((ids: string[], edgeIds: string[]) => {
    const s = snapRef.current;
    const lessonsHit = ids.filter(id => s.nodes[id]?.type === "material" && !id.startsWith("tmp-"));
    if (lessonsHit.length && !window.confirm(`Delete ${lessonsHit.length === 1 ? `the lesson “${s.nodes[lessonsHit[0]].title}”` : `${lessonsHit.length} lessons`}? Its text and your progress on it are deleted; its questions stay in the Test center. This cannot be undone.`)) return;
    if (!ids.length && !edgeIds.length) return;
    const nodes = { ...s.nodes }, edges = { ...s.edges };
    for (const id of ids) delete nodes[id];
    for (const id of edgeIds) delete edges[id];
    for (const e of Object.values(edges)) if (!nodes[e.source] || !nodes[e.target]) delete edges[e.id];
    commit({ nodes, edges });
    if (lessonsHit.length) { history.current.past = []; history.current.future = []; } // a deleted lesson cannot come back with its text
    if (viewer && ids.includes(viewer)) setViewer(null);
    setMenu(null);
  }, [commit, viewer]);

  const copy = useCallback((ids: string[]) => {
    const s = snapRef.current, set = new Set(ids);
    clipboard = { nodes: ids.map(id => s.nodes[id]).filter(Boolean), edges: Object.values(s.edges).filter(e => set.has(e.source) && set.has(e.target)) };
  }, []);
  const paste = useCallback((at?: { x: number; y: number }) => {
    if (!clipboard?.nodes.length) return;
    const s = snapRef.current, map: Record<string, string> = {};
    const minX = Math.min(...clipboard.nodes.map(n => n.x)), minY = Math.min(...clipboard.nodes.map(n => n.y));
    const dx = at ? at.x - minX : 40, dy = at ? at.y - minY : 40;
    const nodes = { ...s.nodes }, edges = { ...s.edges };
    for (const n of clipboard.nodes) {
      const id = tempId(); map[n.id] = id;
      nodes[id] = { ...n, id, x: n.x + dx, y: n.y + dy, testIds: [], meta: { ...n.meta },
        ...(n.type === "material" ? { title: n.title + " (copy)", copyOf: n.copyOf || (n.id.startsWith("tmp-") ? undefined : n.id) } : {}) };
    }
    for (const e of clipboard.edges) { const id = tempId(); edges[id] = { ...e, id, source: map[e.source], target: map[e.target] }; }
    pendingSel.current = Object.values(map);
    commit({ nodes, edges });
  }, [commit, select]);

  const openBlock = useCallback((id: string) => {
    const n = snapRef.current.nodes[id]; if (!n) return;
    if (n.type === "material") { if (id.startsWith("tmp-")) { message("Saving the new lesson first…"); return; } setViewer(id); setPanel(true); }
    else if (n.type === "quiz") { const t = quizTests(n); if (t.length) onStartQuiz(t, n.title); else { select([id]); setPanel(true); message("Pick lessons for this quiz first."); } }
    else if (n.type === "resource" && /^https?:\/\//i.test(n.meta?.url || "")) window.open(n.meta.url, "_blank", "noopener,noreferrer");
    else { select([id]); setPanel(true); }
  }, [message, onStartQuiz, quizTests, select]);

  const focusNode = useCallback((id: string) => {
    const n = rf.getNode(id); if (!n) return;
    const w = n.measured?.width || 200, h = n.measured?.height || 60;
    rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: Math.max(rf.getZoom(), 0.9), duration: 400 });
    select([id]);
  }, [rf, select]);

  const setStatus = useCallback(async (id: string, st: "in_progress" | "mastered") => {
    try { await onSetStatus(id, st); } catch (e: any) { message(e.message); }
  }, [message, onSetStatus]);

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!wrap.current || typing(e.target) || document.querySelector('.modal-backdrop, [aria-modal="true"]')) return;
      if (!full && !wrap.current.matches(":hover") && !wrap.current.contains(document.activeElement)) return;
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      const sel = rf.getNodes().filter(n => n.selected).map(n => n.id), selE = rf.getEdges().filter(x => x.selected).map(x => x.id);
      if (mod && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (mod && k === "y") { e.preventDefault(); redo(); }
      else if (mod && k === "d") { e.preventDefault(); if (sel.length) { copy(sel); paste(); } }
      else if (mod && k === "c") { if (sel.length) { copy(sel); } }
      else if (mod && k === "v") { e.preventDefault(); paste(mouse.current ? rf.screenToFlowPosition(mouse.current) : undefined); }
      else if (mod && k === "a") { e.preventDefault(); select(Object.keys(snapRef.current.nodes)); }
      else if (e.key === "Delete" || e.key === "Backspace") { if (sel.length || selE.length) { e.preventDefault(); removeIds(sel, selE); } }
      else if (e.key === " " && !mod) {
        e.preventDefault();
        const r = wrap.current.getBoundingClientRect();
        const p = mouse.current && mouse.current.x >= r.left && mouse.current.x <= r.right && mouse.current.y >= r.top && mouse.current.y <= r.bottom ? mouse.current : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        setMenu({ x: p.x - r.left, y: p.y - r.top, flow: rf.screenToFlowPosition(p), kind: "pane" });
      } else if (!mod && !e.altKey && (k === "v" || k === "h" || k === "f" || k === "t")) {
        setTool(k === "v" ? "select" : k === "h" ? "pan" : k === "f" ? "frame" : "text");
      } else if (e.key === "Escape") { if (menu) setMenu(null); else if (tool !== "pan") { setTool("pan"); setDrawing(null); } else if (full) setFull(false); else select([]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [copy, paste, redo, undo, removeIds, rf, select, menu, full, tool]);

  const openMenu = (kind: "pane" | "node" | "edge", e: React.MouseEvent | MouseEvent, id?: string) => {
    e.preventDefault();
    const r = wrap.current!.getBoundingClientRect();
    if (kind === "node" && id && !rf.getNode(id)?.selected) select([id]);
    if (kind === "edge" && id) select([], [id]);
    setMenu({ x: e.clientX - r.left, y: e.clientY - r.top, flow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }), kind, id });
  };

  // ---------------------------------------------------------------- render
  const lessonList = useMemo(() => lessons.map(l => ({ id: l.id, title: l.title, test_ids: testsByLesson[l.id] || l.test_ids })), [lessons, testsByLesson]);
  const statusChip = save.s === "saving" ? <><Loader2 size={14} className="spin" />Saving…</>
    : save.s === "pending" ? <>Unsaved changes</>
    : save.s === "offline" ? <><CloudOff size={14} />{save.msg || "Offline: changes kept"}</>
    : save.s === "error" ? <><AlertTriangle size={14} />{save.msg || "Not saved"}</>
    : <><Check size={14} />Saved</>;
  const showPanel = panel && (viewer || one || oneEdge);
  const nodeCount = Object.keys(snap.nodes).length;

  return (
    <div className={`canvas-shell${full ? " full" : ""}${showPanel ? " with-panel" : ""}${wide && viewer ? " wide" : ""}`}>
      <div className="canvas-toolbar" role="toolbar" aria-label="Canvas tools">
        <div className="ct-group" role="radiogroup" aria-label="Tool">
          <button type="button" role="radio" aria-checked={tool === "pan"} className={`ct-btn icon${tool === "pan" ? " on" : ""}`} title="Move the canvas (H). Shift+drag still selects" aria-label="Hand tool" onClick={() => setTool("pan")}><Hand size={16} /></button>
          <button type="button" role="radio" aria-checked={tool === "select"} className={`ct-btn icon${tool === "select" ? " on" : ""}`} title="Select tool (V): drag on the empty canvas to draw a selection box" aria-label="Select tool" onClick={() => setTool("select")}><BoxSelect size={16} /></button>
          <button type="button" role="radio" aria-checked={tool === "frame"} className={`ct-btn icon${tool === "frame" ? " on" : ""}`} title="Frame tool (F): draw a box around blocks and type its title" aria-label="Frame tool" onClick={() => setTool("frame")}><Frame size={16} /></button>
          <button type="button" role="radio" aria-checked={tool === "text"} className={`ct-btn icon${tool === "text" ? " on" : ""}`} title="Text tool (T): click anywhere and type" aria-label="Text tool" onClick={() => setTool("text")}><TypeIcon size={16} /></button>
        </div>
        <div className="ct-group">
          {NODE_TYPES.map(t => { const I = TYPE_ICON[t]; return (
            <button key={t} type="button" className="ct-btn" title={`Add ${TYPE_LABEL[t].toLowerCase()}`} onClick={() => createAt(t, centre())}><I size={16} /><span>{TYPE_LABEL[t]}</span></button>
          ); })}
        </div>
        <div className="ct-group">
          <button type="button" className="ct-btn" title="Tidy the blocks into columns (just the selected ones when several are selected)" onClick={arrange}><LayoutGrid size={16} /><span>Auto arrange</span></button>
          <button type="button" className="ct-btn" title="Add a quiz block next to every lesson that has questions" onClick={attachAllQuizzes}><TYPE_ICON.quiz size={16} /><span>Quiz for all</span></button>
          <button type="button" className="ct-btn icon" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!history.current.past.length} onClick={undo}><Undo2 size={16} /></button>
          <button type="button" className="ct-btn icon" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!history.current.future.length} onClick={redo}><Redo2 size={16} /></button>
          <button type="button" className={`ct-btn icon${snapGrid ? " on" : ""}`} title="Snap to grid" aria-label="Snap to grid" aria-pressed={snapGrid}
            onClick={() => setSnapGrid(g => { try { localStorage.setItem("learnify.canvas.grid", g ? "0" : "1"); } catch { /* ignore */ } return !g; })}><Grid3x3 size={16} /></button>
          <button type="button" className={`ct-btn icon${blocks ? " on" : ""}`} title="Find blocks" aria-label="Find blocks" aria-pressed={blocks} onClick={() => setBlocks(b => !b)}><List size={16} /></button>
          <button type="button" className="ct-btn icon" title={full ? "Exit full screen (Esc)" : "Full screen"} aria-label={full ? "Exit full screen" : "Full screen"} onClick={() => setFull(f => !f)}>{full ? <Minimize size={16} /> : <Maximize size={16} />}</button>
        </div>
        <span className={`ct-status s-${save.s}`} role="status" aria-live="polite">{statusChip}</span>
      </div>

      <div className="canvas-area">
        {blocks && (
          <aside className="canvas-blocks" aria-label="Blocks">
            <label className="cbx-search"><Search size={14} /><input className="input" type="search" placeholder="Search blocks" value={query} onChange={e => setQuery(e.target.value)} autoFocus /></label>
            <div className="cbx-list">
              {(q ? matches : Object.values(snap.nodes).sort((a, b) => a.title.localeCompare(b.title))).slice(0, 300).map(n => { const I = TYPE_ICON[n.type]; return (
                <button key={n.id} type="button" className="cbx-item" onClick={() => focusNode(n.id)} onDoubleClick={() => openBlock(n.id)}>
                  <I size={14} /><span>{n.type === "note" ? (String(n.meta?.text || "").split("\n")[0] || "Note") : n.title}</span>
                </button>
              ); })}
              {q && !matches.length && <small className="muted">Nothing matches.</small>}
            </div>
          </aside>
        )}
        <div className="canvas-flow" ref={wrap} onMouseMove={e => { mouse.current = { x: e.clientX, y: e.clientY }; }} onClick={() => menu && setMenu(null)}>
          {ready && (
            <ReactFlow nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
              onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeDragStop={onDragStop} onConnect={onConnect} onConnectEnd={onConnectEnd} connectionRadius={30}
              onNodeDoubleClick={(_, n) => openBlock(n.id)} onNodeClick={() => setPanel(true)} onEdgeClick={() => setPanel(true)}
              onPaneContextMenu={e => openMenu("pane", e)} onNodeContextMenu={(e, n) => openMenu("node", e, n.id)} onEdgeContextMenu={(e, ed) => openMenu("edge", e, ed.id)}
              onMoveEnd={(_, v: Viewport) => sync.current?.setViewport(v)}
              connectionMode={ConnectionMode.Loose} deleteKeyCode={null} panActivationKeyCode={null} selectionKeyCode="Shift" selectionOnDrag={tool === "select"} panOnDrag={tool === "select" ? [1] : tool === "pan"} multiSelectionKeyCode={["Meta", "Control"]}
              selectionMode={SelectionMode.Partial} snapToGrid={snapGrid} snapGrid={[GRID, GRID]} minZoom={0.1} maxZoom={2.5} zoomOnDoubleClick={false}
              onlyRenderVisibleElements={nodeCount > 300} proOptions={{ hideAttribution: true }} fitView={false}>
              <Background variant={snapGrid ? BackgroundVariant.Lines : BackgroundVariant.Dots} gap={GRID} />
              <MiniMap pannable zoomable className="canvas-minimap" nodeClassName={n => "mm-" + ((n.data as any)?.node?.type || "material")} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
          {(tool === "frame" || tool === "text") && (
            <div className={`canvas-draw ${tool}`} onWheel={e => rf.zoomTo(rf.getZoom() * (e.deltaY < 0 ? 1.1 : 0.9))}
              onPointerDown={e => {
                try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic or finished pointer */ }
                const r = wrap.current!.getBoundingClientRect();
                setDrawing({ x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top });
              }}
              onPointerMove={e => { if (drawing) { const r = wrap.current!.getBoundingClientRect(); setDrawing({ ...drawing, x1: e.clientX - r.left, y1: e.clientY - r.top }); } }}
              onPointerUp={e => {
                if (!drawing) return;
                const r = wrap.current!.getBoundingClientRect(), d = drawing; setDrawing(null);
                const a = rf.screenToFlowPosition({ x: d.x0 + r.left, y: d.y0 + r.top }), b = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
                if (tool === "text") finishDraw("text", a);
                else if (Math.abs(d.x1 - d.x0) > 20 && Math.abs(d.y1 - d.y0) > 20) finishDraw("frame", a, b);
              }}>
              {drawing && tool === "frame" && <div className="canvas-draw-box" style={{ left: Math.min(drawing.x0, drawing.x1), top: Math.min(drawing.y0, drawing.y1), width: Math.abs(drawing.x1 - drawing.x0), height: Math.abs(drawing.y1 - drawing.y0) }} />}
              <div className="canvas-draw-hint">{tool === "frame" ? "Drag to draw a frame around blocks" : "Click where the text should go"} · Esc to cancel</div>
            </div>
          )}
          {selectedNodes.length > 1 && tool !== "frame" && tool !== "text" && (
            <div className="canvas-selbar" role="toolbar" aria-label="Selection">
              <strong>{selectedNodes.length} selected</strong>
              <button type="button" className="ct-btn" title="Line the blocks up in a column on the left edge (Ctrl+Z undoes)" aria-label="Align left" onClick={() => align("x")}><AlignStartVertical size={16} />Column</button>
              <button type="button" className="ct-btn" title="Line the blocks up in a row on the top edge (Ctrl+Z undoes)" aria-label="Align top" onClick={() => align("y")}><AlignStartHorizontal size={16} />Row</button>
              <button type="button" className="ct-btn" title="Tidy the selected blocks" onClick={arrange}><LayoutGrid size={15} />Arrange</button>
              <button type="button" className="ct-btn" title="Duplicate (Ctrl+D)" onClick={() => { copy(selectedNodes); paste(); }}><Copy size={15} />Duplicate</button>
              <button type="button" className="ct-btn danger" title="Delete (Del)" onClick={() => removeIds(selectedNodes, [])}><Trash2 size={15} />Delete</button>
              <button type="button" className="ct-btn icon" title="Clear selection" aria-label="Clear selection" onClick={() => select([])}><X size={15} /></button>
            </div>
          )}
          {ready && nodeCount === 0 && (
            <div className="canvas-empty"><strong>An empty canvas</strong><span>Add a block with the toolbar, press Space, or right-click anywhere.</span></div>
          )}
          {menu && (
            <div className="canvas-menu" style={{ left: menu.x, top: menu.y }} role="menu" onClick={e => e.stopPropagation()}>
              {menu.kind === "pane" && NODE_TYPES.map(t => { const I = TYPE_ICON[t]; return (
                <button key={t} type="button" role="menuitem" onClick={() => createAt(t, menu.flow)}><Plus size={14} /><I size={14} />{TYPE_LABEL[t]}</button>
              ); })}
              {menu.kind === "pane" && <button type="button" role="menuitem" onClick={() => { select(Object.keys(snapRef.current.nodes)); setMenu(null); }}><BoxSelect size={14} />Select all</button>}
              {menu.kind === "pane" && clipboard?.nodes.length ? <button type="button" role="menuitem" onClick={() => { paste(menu.flow); setMenu(null); }}><Copy size={14} />Paste</button> : null}
              {menu.kind === "node" && menu.id && <>
                <button type="button" role="menuitem" onClick={() => { openBlock(menu.id!); setMenu(null); }}>Open</button>
                {snap.nodes[menu.id]?.type === "material" && <button type="button" role="menuitem" onClick={() => attachQuiz(menu.id!)}><Plus size={14} />Attach quiz</button>}
                <button type="button" role="menuitem" onClick={() => { const s = rf.getNodes().filter(n => n.selected).map(n => n.id); copy(s.length ? s : [menu.id!]); paste(); setMenu(null); }}><Copy size={14} />Duplicate</button>
                <button type="button" role="menuitem" onClick={() => { const s = rf.getNodes().filter(n => n.selected).map(n => n.id); copy(s.length ? s : [menu.id!]); setMenu(null); }}>Copy</button>
                <button type="button" role="menuitem" className="danger" onClick={() => { const s = rf.getNodes().filter(n => n.selected).map(n => n.id); removeIds(s.length ? s : [menu.id!], []); }}><Trash2 size={14} />Delete</button>
              </>}
              {menu.kind === "edge" && menu.id && <>
                <button type="button" role="menuitem" onClick={() => { setPanel(true); setMenu(null); }}>Edit connection</button>
                <button type="button" role="menuitem" className="danger" onClick={() => removeIds([], [menu.id!])}><Trash2 size={14} />Delete connection</button>
              </>}
            </div>
          )}
        </div>
        {showPanel && (
          <aside className="canvas-panel" aria-label="Details">
            {viewer && snap.nodes[viewer] ? (
              <LessonViewer subjectId={subjectId} lessonId={viewer} status={statuses[viewer]} questions={(testsByLesson[viewer] || []).length} wide={wide}
                onWide={() => setWide(w => !w)} onClose={() => { setViewer(null); setWide(false); }} onOpenPage={() => onOpenLesson(viewer)} onOpenTest={() => onOpenTest(viewer)}
                onSetStatus={st => setStatus(viewer, st)} onSaved={onLessonsChanged} />
            ) : one ? (
              <NodeInspector key={one.id} node={one} status={statuses[one.id]} lessons={lessonList} quizQuestions={one.type === "quiz" ? quizTests(one).length : 0}
                onChange={(patch, key) => { const s = snapRef.current, n = s.nodes[one.id]; if (n) commit({ ...s, nodes: { ...s.nodes, [n.id]: { ...n, ...patch } } }, key); }}
                onDelete={() => removeIds([one.id], [])} onOpen={() => openBlock(one.id)} onAttachQuiz={() => attachQuiz(one.id)} onStartQuiz={() => onStartQuiz(quizTests(one), one.title)}
                onSetStatus={st => setStatus(one.id, st)} onClose={() => setPanel(false)} />
            ) : oneEdge ? (
              <EdgeInspector key={oneEdge.id} edge={oneEdge} from={snap.nodes[oneEdge.source]?.title || "?"} to={snap.nodes[oneEdge.target]?.title || "?"}
                onChange={(patch, key) => { const s = snapRef.current, e = s.edges[oneEdge.id]; if (e) commit({ ...s, edges: { ...s.edges, [e.id]: { ...e, ...patch } } }, key); }}
                onDelete={() => removeIds([], [oneEdge.id])} onClose={() => setPanel(false)} />
            ) : null}
          </aside>
        )}
      </div>
    </div>
  );
}
