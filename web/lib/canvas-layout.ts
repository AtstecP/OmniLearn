import type { CEdge, CNode } from "./canvas-sync";

/*
 * Tidy layout for the canvas ("Auto arrange"). Connected blocks are laid out like a tree:
 * a block's column is its distance from a root (a block nobody points at), rows follow a
 * depth-first walk, so a lesson's quiz and sub-topics end up next to it. Separate groups are
 * stacked under each other and lone blocks go into a grid at the end. Frames and plain text
 * labels are not moved (they are placed by hand around other blocks).
 */
const COL = 340, ROW = 120, GAP = 70, GRID_COLS = 5;

export const isLabel = (n: CNode) => n.type === "note" && (n.meta?.frame || n.meta?.plain);

export function autoLayout(all: CNode[], edges: CEdge[]): Record<string, { x: number; y: number }> {
  const nodes = all.filter(n => !isLabel(n));
  if (!nodes.length) return {};
  const ids = new Set(nodes.map(n => n.id));
  const out = new Map<string, string[]>(), nbr = new Map<string, Set<string>>(), inDeg = new Map<string, number>();
  for (const n of nodes) { out.set(n.id, []); nbr.set(n.id, new Set()); inDeg.set(n.id, 0); }
  for (const e of edges) {
    if (!ids.has(e.source) || !ids.has(e.target) || e.source === e.target) continue;
    out.get(e.source)!.push(e.target);
    nbr.get(e.source)!.add(e.target); nbr.get(e.target)!.add(e.source);
    inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
  }
  const byPos = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x);       // keep the current reading order
  const originX = Math.min(...nodes.map(n => n.x)), originY = Math.min(...nodes.map(n => n.y));
  const result: Record<string, { x: number; y: number }> = {};

  // connected groups
  const seen = new Set<string>(), groups: CNode[][] = [], singles: CNode[] = [];
  for (const n of byPos) {
    if (seen.has(n.id)) continue;
    const comp: CNode[] = [], stack = [n.id]; seen.add(n.id);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(nodes.find(x => x.id === id)!);
      for (const m of nbr.get(id)!) if (!seen.has(m)) { seen.add(m); stack.push(m); }
    }
    if (comp.length === 1) singles.push(comp[0]); else groups.push(comp.sort((a, b) => a.y - b.y || a.x - b.x));
  }

  let y = originY;
  for (const comp of groups) {
    const roots = comp.filter(n => !inDeg.get(n.id));
    const done = new Set<string>();
    let row = 0, bottom = y;
    const walk = (n: CNode, depth: number) => {
      done.add(n.id);
      const top = y + row * ROW;
      result[n.id] = { x: originX + depth * COL, y: top };
      bottom = Math.max(bottom, top + Math.max(ROW, (n.h || 0) + 30));
      row++;
      for (const t of out.get(n.id)!) { const c = comp.find(x => x.id === t)!; if (!done.has(t)) walk(c, depth + 1); }
    };
    for (const r of roots.length ? roots : [comp[0]]) if (!done.has(r.id)) walk(r, 0);
    for (const n of comp) if (!done.has(n.id)) walk(n, 0);      // blocks that are only on a cycle
    y = bottom + GAP;
  }
  singles.forEach((n, i) => {
    result[n.id] = { x: originX + (i % GRID_COLS) * 260, y: y + Math.floor(i / GRID_COLS) * ROW };
  });
  return result;
}
