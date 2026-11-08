"use client";
import { useEffect, useMemo, useRef, useState } from "react";

/*
 * Mind-map view of a subject's roadmap.
 *
 * Layout: main steps (nodes without a parent) form a vertical spine down the
 * middle. Each step's sub-topics branch out to the left and right with dotted
 * connectors. Deeper levels (sub-sub-topics and below) are shown as small chips
 * above their sub-topic. Everything is computed from parent_node_id and
 * order_index, so the map is just another view of the same roadmap data.
 *
 * Edit mode lets the learner rename, add, delete, reorder and re-parent nodes.
 * The parent component performs the API calls through the callbacks.
 */

export type MapNode = { id: string; title: string; parent_node_id?: string | null; order_index: number };
export type Placement = { id: string; parent_node_id: string | null; order_index: number };

type Props = {
  nodes: MapNode[];
  statuses: Record<string, string>;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onAdd: (parentId: string | null, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onLayout: (placements: Placement[]) => Promise<void>;
};

const ROOT_W = 220, ROOT_H = 40, CHILD_W = 210, CHILD_H = 36;
const CHIP_H = 28, CHIP_GAP = 6, CHIP_W = (CHILD_W - CHIP_GAP) / 2;
const ROW_GAP = 12, H_GAP = 64, SECTION_GAP = 40, MARGIN = 24;
const WIDTH = 2 * (MARGIN + CHILD_W + H_GAP) + ROOT_W;
const CX = WIDTH / 2;

type Box = { id: string; x: number; y: number; w: number; h: number; kind: "root" | "child" | "chip"; title: string };
type Line = { d: string; kind: "spine" | "branch" | "twig" };

function buildTree(nodes: MapNode[]) {
  const ids = new Set(nodes.map(n => n.id));
  const kids = new Map<string | null, MapNode[]>();
  for (const n of nodes) {
    const parent = n.parent_node_id && ids.has(n.parent_node_id) && n.parent_node_id !== n.id ? n.parent_node_id : null;
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent)!.push(n);
  }
  for (const list of kids.values()) list.sort((a, b) => a.order_index - b.order_index || a.id.localeCompare(b.id));
  const parentOf = (n: MapNode) => (n.parent_node_id && ids.has(n.parent_node_id) && n.parent_node_id !== n.id ? n.parent_node_id : null);
  return { kids, parentOf };
}

function descendants(kids: Map<string | null, MapNode[]>, id: string): MapNode[] {
  const out: MapNode[] = [];
  const seen = new Set<string>([id]);
  const walk = (pid: string) => {
    for (const k of kids.get(pid) || []) {
      if (seen.has(k.id)) continue; // guards against bad data with cycles
      seen.add(k.id);
      out.push(k);
      walk(k.id);
    }
  };
  walk(id);
  return out;
}

function layout(nodes: MapNode[]) {
  const { kids } = buildTree(nodes);
  const roots = kids.get(null) || [];
  const boxes: Box[] = [];
  const lines: Line[] = [];
  let top = MARGIN;
  const rootCenters: number[] = [];

  roots.forEach((root, i) => {
    const children = kids.get(root.id) || [];
    const leftCount = i % 2 === 0 ? Math.ceil(children.length / 2) : Math.floor(children.length / 2);
    const sides: [MapNode[], "left" | "right"][] = [[children.slice(0, leftCount), "left"], [children.slice(leftCount), "right"]];
    const blockHeight = (child: MapNode) => {
      const rows = Math.ceil(descendants(kids, child.id).length / 2);
      return rows * (CHIP_H + CHIP_GAP) + CHILD_H;
    };
    const columnHeight = (list: MapNode[]) => list.reduce((sum, c) => sum + blockHeight(c), 0) + Math.max(0, list.length - 1) * ROW_GAP;
    const sectionH = Math.max(ROOT_H, ...sides.map(([list]) => columnHeight(list)));
    const rootY = top + (sectionH - ROOT_H) / 2;
    boxes.push({ id: root.id, x: CX - ROOT_W / 2, y: rootY, w: ROOT_W, h: ROOT_H, kind: "root", title: root.title });
    rootCenters.push(rootY + ROOT_H / 2);

    for (const [list, side] of sides) {
      let y = top + (sectionH - columnHeight(list)) / 2;
      const x = side === "left" ? CX - ROOT_W / 2 - H_GAP - CHILD_W : CX + ROOT_W / 2 + H_GAP;
      for (const child of list) {
        const chips = descendants(kids, child.id);
        const chipRows = Math.ceil(chips.length / 2);
        chips.forEach((chip, ci) => {
          const row = Math.floor(ci / 2), col = ci % 2;
          boxes.push({ id: chip.id, x: x + col * (CHIP_W + CHIP_GAP), y: y + row * (CHIP_H + CHIP_GAP), w: CHIP_W, h: CHIP_H, kind: "chip", title: chip.title });
        });
        const childY = y + chipRows * (CHIP_H + CHIP_GAP);
        if (chips.length) {
          for (let col = 0; col < Math.min(2, chips.length); col++) {
            const cx = x + col * (CHIP_W + CHIP_GAP) + CHIP_W / 2;
            lines.push({ d: `M${cx},${childY - CHIP_GAP} L${cx},${childY}`, kind: "twig" });
          }
        }
        boxes.push({ id: child.id, x, y: childY, w: CHILD_W, h: CHILD_H, kind: "child", title: child.title });
        const fromX = side === "left" ? CX - ROOT_W / 2 : CX + ROOT_W / 2;
        const toX = side === "left" ? x + CHILD_W : x;
        const fromY = rootY + ROOT_H / 2, toY = childY + CHILD_H / 2, midX = (fromX + toX) / 2;
        lines.push({ d: `M${fromX},${fromY} C${midX},${fromY} ${midX},${toY} ${toX},${toY}`, kind: "branch" });
        y += blockHeight(child) + ROW_GAP;
      }
    }
    top += sectionH + SECTION_GAP;
  });

  if (rootCenters.length > 1) lines.unshift({ d: `M${CX},${rootCenters[0]} L${CX},${rootCenters[rootCenters.length - 1]}`, kind: "spine" });
  return { boxes, lines, height: Math.max(top - SECTION_GAP + MARGIN, 160) };
}

export default function RoadmapMap({ nodes, statuses, onOpen, onRename, onAdd, onDelete, onLayout }: Props) {
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [childDraft, setChildDraft] = useState("");
  const [rootDraft, setRootDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scale, setScale] = useState(1);
  const [userZoomed, setUserZoomed] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const { boxes, lines, height } = useMemo(() => layout(nodes), [nodes]);
  const tree = useMemo(() => buildTree(nodes), [nodes]);
  const byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);
  const node = selected ? byId.get(selected) : undefined;

  // Fit the map to narrow screens until the learner zooms by hand.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => { if (!userZoomed) setScale(Math.min(1, Math.max(0.45, (el.clientWidth - 2) / WIDTH))); };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [userZoomed]);

  useEffect(() => { setTitleDraft(node?.title || ""); setChildDraft(""); setError(""); }, [selected, node?.title]);
  useEffect(() => { if (selected && !byId.has(selected)) setSelected(null); }, [byId, selected]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (e: any) { setError(e?.message || "Something went wrong"); } finally { setBusy(false); }
  }

  const siblingsOf = (n: MapNode) => tree.kids.get(tree.parentOf(n)) || [];
  const reindex = (list: MapNode[], parent: string | null): Placement[] => list.map((n, i) => ({ id: n.id, parent_node_id: parent, order_index: i }));

  function move(delta: number) {
    if (!node) return;
    const list = [...siblingsOf(node)];
    const i = list.findIndex(n => n.id === node.id), j = i + delta;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    run(() => onLayout(reindex(list, tree.parentOf(node))));
  }

  function reparent(newParent: string | null) {
    if (!node || newParent === tree.parentOf(node)) return;
    const oldList = siblingsOf(node).filter(n => n.id !== node.id);
    const newList = [...(tree.kids.get(newParent) || []), node];
    run(() => onLayout([...reindex(oldList, tree.parentOf(node)), ...reindex(newList, newParent)]));
  }

  // Valid new parents: anything except the node itself and its own sub-topics.
  const parentOptions = useMemo(() => {
    if (!node) return [];
    const blocked = new Set([node.id, ...descendants(tree.kids, node.id).map(n => n.id)]);
    const out: { id: string; label: string }[] = [];
    const walk = (pid: string | null, depth: number) => {
      for (const n of tree.kids.get(pid) || []) {
        if (blocked.has(n.id)) continue;
        out.push({ id: n.id, label: `${"— ".repeat(depth)}${n.title}` });
        walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [node, tree]);

  const statusClass = (id: string) => (statuses[id] === "mastered" ? "done" : statuses[id] === "in_progress" ? "active" : "");

  return (
    <section className="roadmap-map-panel">
      <div className="roadmap-map-toolbar">
        <div className="roadmap-map-legend">
          <span><i className="legend-swatch root" />Main step</span>
          <span><i className="legend-swatch child" />Sub-topic</span>
          <span><i className="legend-swatch done" />Mastered</span>
        </div>
        <div className="roadmap-map-actions">
          <button className="btn small" type="button" onClick={() => { setUserZoomed(true); setScale(s => Math.max(0.4, +(s - 0.1).toFixed(2))); }} aria-label="Zoom out">−</button>
          <span className="zoom-label">{Math.round(scale * 100)}%</span>
          <button className="btn small" type="button" onClick={() => { setUserZoomed(true); setScale(s => Math.min(1.6, +(s + 0.1).toFixed(2))); }} aria-label="Zoom in">+</button>
          <button className={`btn small ${editing ? "primary" : ""}`} type="button" onClick={() => { setEditing(e => !e); setSelected(null); }}>
            {editing ? "✓ Done editing" : "✎ Edit map"}
          </button>
        </div>
      </div>

      {editing && (
        <div className="roadmap-editor">
          {error && <div className="feedback wrong">{error}</div>}
          {node ? (
            <>
              <div className="roadmap-editor-row">
                <input className="input" value={titleDraft} onChange={e => setTitleDraft(e.target.value)} aria-label="Title" maxLength={255} />
                <button className="btn small primary" type="button" disabled={busy || !titleDraft.trim() || titleDraft.trim() === node.title}
                  onClick={() => run(() => onRename(node.id, titleDraft.trim()))}>Save title</button>
              </div>
              <div className="roadmap-editor-row">
                <input className="input" value={childDraft} onChange={e => setChildDraft(e.target.value)} placeholder="New sub-topic title" aria-label="New sub-topic title" maxLength={255}
                  onKeyDown={e => { if (e.key === "Enter" && childDraft.trim()) run(async () => { await onAdd(node.id, childDraft.trim()); setChildDraft(""); }); }} />
                <button className="btn small" type="button" disabled={busy || !childDraft.trim()}
                  onClick={() => run(async () => { await onAdd(node.id, childDraft.trim()); setChildDraft(""); })}>＋ Add sub-topic</button>
              </div>
              <div className="roadmap-editor-row">
                <button className="btn small" type="button" disabled={busy} onClick={() => move(-1)}>↑ Move up</button>
                <button className="btn small" type="button" disabled={busy} onClick={() => move(1)}>↓ Move down</button>
                <label className="roadmap-editor-select">Place under
                  <select className="input" value={tree.parentOf(node) || ""} disabled={busy} onChange={e => reparent(e.target.value || null)}>
                    <option value="">Main path (top level)</option>
                    {parentOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </label>
                <button className="btn small" type="button" onClick={() => onOpen(node.id)}>Open lesson</button>
                <button className="btn small danger" type="button" disabled={busy}
                  onClick={() => { if (window.confirm(`Delete "${node.title}"? Its sub-topics move up one level. Linked questions stay in the test bank.`)) run(async () => { await onDelete(node.id); setSelected(null); }); }}>
                  Delete
                </button>
              </div>
            </>
          ) : (
            <p className="muted-copy">Select a box to rename, move, or delete it, or add a new main step below.</p>
          )}
          <div className="roadmap-editor-row">
            <input className="input" value={rootDraft} onChange={e => setRootDraft(e.target.value)} placeholder="New main step title" aria-label="New main step title" maxLength={255}
              onKeyDown={e => { if (e.key === "Enter" && rootDraft.trim()) run(async () => { await onAdd(null, rootDraft.trim()); setRootDraft(""); }); }} />
            <button className="btn small" type="button" disabled={busy || !rootDraft.trim()}
              onClick={() => run(async () => { await onAdd(null, rootDraft.trim()); setRootDraft(""); })}>＋ Add main step</button>
          </div>
        </div>
      )}

      {nodes.length > 1 && nodes.every(n => !n.parent_node_id) && (
        <p className="roadmap-map-hint">Every lesson is a main step right now. Choose <strong>Edit map</strong>, select a lesson, and use <strong>Place under</strong> to group it under a main step.</p>
      )}
      <div className="roadmap-map-scroll" ref={wrapRef}>
        {nodes.length === 0 ? (
          <div className="empty-state"><strong>No roadmap yet</strong>Import a curriculum JSON{editing ? " or add a main step above" : ", or choose “Edit map” to start one"}.</div>
        ) : (
          <div className="roadmap-map-frame" style={{ width: WIDTH * scale, height: height * scale }}>
            <div className="roadmap-map-canvas" style={{ width: WIDTH, height, transform: `scale(${scale})` }}>
              <svg className="roadmap-map-lines" width={WIDTH} height={height} aria-hidden="true">
                {lines.map((l, i) => <path key={i} d={l.d} className={`map-line ${l.kind}`} />)}
              </svg>
              {boxes.map(b => (
                <button
                  key={b.id}
                  type="button"
                  className={`map-box ${b.kind} ${statusClass(b.id)} ${selected === b.id ? "selected" : ""}`}
                  style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
                  title={b.title}
                  onClick={() => (editing ? setSelected(b.id) : onOpen(b.id))}
                >
                  {statuses[b.id] === "mastered" && <span className="map-check">✓</span>}
                  <span className="map-label">{b.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
