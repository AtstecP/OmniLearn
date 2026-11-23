/*
 * Canvas state and autosave.
 *
 * The canvas keeps two snapshots: `base` (what the server last confirmed, with its version)
 * and `local` (what the learner sees). Every edit changes `local` at once; a debounced save
 * sends diff(base, local) as one batch to PUT /subjects/{sid}/canvas/layout. Because the
 * batch is computed from the snapshots, undo/redo, offline edits and retries need no extra
 * bookkeeping: whatever differs from the server is pending.
 *
 * Both snapshots are kept in IndexedDB (lib/cache.ts) so a refresh or a closed tab loses
 * nothing. If the server's version moved on (another tab, an import, the old map editor),
 * the save answers 409: the client loads the server canvas, re-applies its own pending
 * changes on top of it (field by field) and saves again. Nothing is silently overwritten.
 */
import { api, json } from "./api";
import { cacheGet, cacheSet } from "./cache";

export type NodeType = "material" | "topic" | "quiz" | "note" | "resource";
export type EdgeType = "default" | "related_to" | "explains" | "prerequisite" | "references" | "tests";
export const NODE_TYPES: NodeType[] = ["topic", "material", "quiz", "note", "resource"];
export const EDGE_TYPES: EdgeType[] = ["default", "related_to", "explains", "prerequisite", "references", "tests"];

export type CNode = {
  id: string; type: NodeType; title: string; level?: string | null;
  x: number; y: number; w?: number | null; h?: number | null;
  meta: Record<string, any>;
  testIds?: string[];  // lessons: their questions (read only, from the server)
  copyOf?: string;     // a duplicated lesson not saved yet: the server copies this lesson's text
};
export type CEdge = { id: string; source: string; target: string; type: EdgeType; label?: string | null };
export type Snap = { nodes: Record<string, CNode>; edges: Record<string, CEdge> };
export type Stored = { sid?: string; version: number; base: Snap; local: Snap; viewport?: { x: number; y: number; zoom: number } };
export type SaveState = "saved" | "pending" | "saving" | "offline" | "error";

type Batch = {
  base_version: number;
  create_nodes: any[]; update_nodes: any[]; delete_nodes: string[];
  create_edges: any[]; update_edges: any[]; delete_edges: string[];
};

export const tempId = () => "tmp-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const isTemp = (id: string) => id.startsWith("tmp-");

// ---------------------------------------------------------------- server data -> snapshot

export function nodeFromApi(n: any): CNode {
  return { id: String(n.id), type: (n.node_type || "material") as NodeType, title: n.title, level: n.level ?? null,
    x: Number(n.position_x) || 0, y: Number(n.position_y) || 0, w: n.width ?? null, h: n.height ?? null,
    meta: n.metadata || {}, testIds: n.test_ids || [] };
}
export function edgeFromApi(e: any): CEdge {
  return { id: String(e.id), source: String(e.source_node_id), target: String(e.target_node_id), type: e.edge_type || "default", label: e.label ?? null };
}
export function snapFrom(nodes: any[], edges: any[]): Snap {
  const s: Snap = { nodes: {}, edges: {} };
  for (const n of nodes) s.nodes[String(n.id)] = nodeFromApi(n);
  for (const e of edges) s.edges[String(e.id)] = edgeFromApi(e);
  return s;
}

// ---------------------------------------------------------------- diff / apply

/** A snapshot without connections to blocks that do not exist (they can only come from stale data). */
export function clean(s: Snap): Snap {
  const bad = Object.values(s.edges).filter(e => !s.nodes[e.source] || !s.nodes[e.target] || e.source === e.target);
  if (!bad.length) return s;
  const edges = { ...s.edges };
  for (const e of bad) delete edges[e.id];
  return { nodes: s.nodes, edges };
}

const same = (a: any, b: any) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function diff(base: Snap, local: Snap, version: number): Batch {
  const b: Batch = { base_version: version, create_nodes: [], update_nodes: [], delete_nodes: [], create_edges: [], update_edges: [], delete_edges: [] };
  for (const n of Object.values(local.nodes)) {
    const o = base.nodes[n.id];
    if (!o) {
      b.create_nodes.push({ client_id: n.id, node_type: n.type, title: n.title, level: n.level ?? null, position_x: n.x, position_y: n.y,
        width: n.w ?? null, height: n.h ?? null, metadata: n.meta || {}, ...(n.copyOf ? { copy_of: n.copyOf } : {}) });
      continue;
    }
    const p: any = { id: n.id };
    if (n.x !== o.x) p.position_x = n.x;
    if (n.y !== o.y) p.position_y = n.y;
    if ((n.w ?? null) !== (o.w ?? null)) p.width = n.w ?? null;
    if ((n.h ?? null) !== (o.h ?? null)) p.height = n.h ?? null;
    if (n.title !== o.title && n.title.trim()) p.title = n.title;
    if ((n.level ?? null) !== (o.level ?? null)) p.level = n.level ?? null;
    if (!same(n.meta, o.meta)) p.metadata = n.meta || {};
    if (Object.keys(p).length > 1) b.update_nodes.push(p);
  }
  for (const id of Object.keys(base.nodes)) if (!local.nodes[id]) b.delete_nodes.push(id);
  for (const e of Object.values(local.edges)) {
    const o = base.edges[e.id];
    if (!local.nodes[e.source] || !local.nodes[e.target] || e.source === e.target) continue; // never send a dangling connection
    if (!o) { b.create_edges.push({ client_id: e.id, source: e.source, target: e.target, edge_type: e.type, label: e.label || null }); continue; }
    if (o.source !== e.source || o.target !== e.target) { // re-attached: replace it
      b.delete_edges.push(e.id);
      b.create_edges.push({ client_id: e.id, source: e.source, target: e.target, edge_type: e.type, label: e.label || null });
      continue;
    }
    const p: any = { id: e.id };
    if (e.type !== o.type) p.edge_type = e.type;
    if ((e.label || null) !== (o.label || null)) p.label = e.label || null;
    if (Object.keys(p).length > 1) b.update_edges.push(p);
  }
  for (const id of Object.keys(base.edges)) if (!local.edges[id]) b.delete_edges.push(id);
  return b;
}

export const isEmpty = (b: Batch) => !b.create_nodes.length && !b.update_nodes.length && !b.delete_nodes.length && !b.create_edges.length && !b.update_edges.length && !b.delete_edges.length;

/** Re-apply a batch of local changes on top of a (newer) server snapshot. */
export function applyBatch(server: Snap, b: Batch): Snap {
  const out: Snap = { nodes: { ...server.nodes }, edges: { ...server.edges } };
  for (const id of b.delete_nodes) delete out.nodes[id];
  for (const c of b.create_nodes) {
    out.nodes[c.client_id] = { id: c.client_id, type: c.node_type, title: c.title, level: c.level, x: c.position_x, y: c.position_y,
      w: c.width, h: c.height, meta: c.metadata || {}, testIds: [], ...(c.copy_of ? { copyOf: c.copy_of } : {}) };
  }
  for (const p of b.update_nodes) {
    const n = out.nodes[p.id];
    if (!n) continue; // deleted elsewhere: the change has nothing to apply to
    out.nodes[p.id] = { ...n,
      ...(p.position_x !== undefined ? { x: p.position_x } : {}), ...(p.position_y !== undefined ? { y: p.position_y } : {}),
      ...(p.width !== undefined ? { w: p.width } : {}), ...(p.height !== undefined ? { h: p.height } : {}),
      ...(p.title !== undefined ? { title: p.title } : {}), ...(p.level !== undefined ? { level: p.level } : {}),
      ...(p.metadata !== undefined ? { meta: p.metadata } : {}) };
  }
  for (const id of b.delete_edges) delete out.edges[id];
  for (const c of b.create_edges) out.edges[c.client_id] = { id: c.client_id, source: c.source, target: c.target, type: c.edge_type, label: c.label };
  for (const p of b.update_edges) {
    const e = out.edges[p.id];
    if (e) out.edges[p.id] = { ...e, ...(p.edge_type ? { type: p.edge_type } : {}), ...(p.label !== undefined ? { label: p.label } : {}) };
  }
  for (const e of Object.values(out.edges)) if (!out.nodes[e.source] || !out.nodes[e.target]) delete out.edges[e.id];
  return out;
}

/** Replace client ids with the ids the server generated. */
export function remap(s: Snap, map: Record<string, string>): Snap {
  if (!Object.keys(map).length) return s;
  const m = (id: string) => map[id] || id;
  const out: Snap = { nodes: {}, edges: {} };
  for (const n of Object.values(s.nodes)) { const id = m(n.id); const { copyOf, ...rest } = n; out.nodes[id] = { ...(map[n.id] ? rest : n), id }; }
  for (const e of Object.values(s.edges)) { const id = m(e.id); out.edges[id] = { ...e, id, source: m(e.source), target: m(e.target) }; }
  return out;
}

// ---------------------------------------------------------------- autosave

// "canvas2": entries written by the first version could hold another subject's blocks, so they are ignored.
const storeKey = (sid: string) => "canvas2." + sid;
export const loadStored = (userId: string, sid: string) => cacheGet<Stored>(userId, storeKey(sid));

type Opts = {
  userId: string; sid: string;
  onLocal: (s: Snap) => void;          // the snapshot the UI shows changed (remap, rebase, revert)
  onState: (s: SaveState, msg?: string) => void;
  onLessonsChanged: () => void;        // lessons were created/renamed/deleted: refresh the lesson list
  onRemap?: (map: Record<string, string>) => void;
};

export class CanvasSync {
  version = 0;
  base: Snap = { nodes: {}, edges: {} };
  local: Snap = { nodes: {}, edges: {} };
  viewport?: Stored["viewport"];
  private timer: any = null;
  private persistTimer: any = null;
  private inFlight = false;
  private retryMs = 2000;
  private stopped = false;
  private lastRefused = "";
  constructor(private o: Opts) {
    if (typeof window !== "undefined") window.addEventListener("online", this.onOnline);
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.persistNow(); if (typeof window !== "undefined") window.removeEventListener("online", this.onOnline); }
  private onOnline = () => { this.retryMs = 2000; this.schedule(0); };

  /** Start from the stored state and/or a server snapshot (whichever is newer, merged when both changed). */
  init(server: { version: number; snap: Snap } | null, stored: Stored | null) {
    if (stored && stored.sid !== this.o.sid) stored = null; // never trust data of another subject
    if (stored) stored = { ...stored, base: clean(stored.base), local: clean(stored.local) };
    if (stored && (!server || stored.version >= server.version)) {
      this.version = stored.version; this.base = stored.base; this.local = stored.local; this.viewport = stored.viewport;
    } else if (server) {
      const pending = stored ? diff(stored.base, stored.local, stored.version) : null;
      this.version = server.version; this.base = server.snap;
      this.local = clean(pending && !isEmpty(pending) ? applyBatch(server.snap, pending) : server.snap);
      this.viewport = stored?.viewport;
    }
    this.o.onLocal(this.local);
    this.persist();
    if (this.pending()) this.schedule(300); else this.o.onState("saved");
  }
  /** A fresh server snapshot arrived (workspace refresh). Older ones are ignored. */
  server(version: number, snap: Snap) {
    if (version <= this.version || this.inFlight) return;
    const pending = diff(this.base, this.local, this.version);
    this.version = version; this.base = snap;
    this.local = clean(isEmpty(pending) ? snap : applyBatch(snap, pending));
    this.o.onLocal(this.local);
    this.persist();
    if (!isEmpty(pending)) this.schedule(300);
  }
  pending() { return !isEmpty(diff(this.base, this.local, this.version)); }
  setLocal(s: Snap) {
    this.local = s;
    this.persist();
    this.o.onState("pending");
    this.schedule(800);
  }
  setViewport(v: Stored["viewport"]) { this.viewport = v; this.persist(); }
  flushSoon() { this.schedule(0); }

  private persist() { clearTimeout(this.persistTimer); this.persistTimer = setTimeout(() => this.persistNow(), 400); }
  private persistNow() { cacheSet(this.o.userId, storeKey(this.o.sid), { sid: this.o.sid, version: this.version, base: this.base, local: this.local, viewport: this.viewport } satisfies Stored); }
  private schedule(ms: number) { if (this.stopped) return; clearTimeout(this.timer); this.timer = setTimeout(() => void this.flush(), ms); }

  private async flush() {
    if (this.inFlight || this.stopped) return;
    const sent = this.local;
    const batch = diff(this.base, sent, this.version);
    if (isEmpty(batch)) { this.o.onState("saved"); return; }
    this.inFlight = true;
    this.o.onState("saving");
    try {
      const res = await api<{ version: number; id_map: Record<string, string>; lessons_changed: boolean }>(`/subjects/${this.o.sid}/canvas/layout`, json("PUT", batch));
      this.retryMs = 2000;
      this.lastRefused = "";
      this.version = res.version;
      this.base = remap(sent, res.id_map);
      if (Object.keys(res.id_map).length) {
        this.local = remap(this.local, res.id_map);
        this.o.onRemap?.(res.id_map);
        this.o.onLocal(this.local);
      }
      // Lessons created/duplicated on the server carry new data (copied text, order): they must not stay "copyOf".
      this.persist();
      if (res.lessons_changed) this.o.onLessonsChanged();
      this.inFlight = false;
      if (this.pending()) this.schedule(300); else this.o.onState("saved");
    } catch (e: any) {
      this.inFlight = false;
      if (e?.status === 409) {           // someone else saved: load theirs, re-apply ours, try again
        try {
          const cv = await api<any>(`/subjects/${this.o.sid}/canvas`);
          this.server(cv.version, snapFrom(cv.nodes, cv.edges));
          this.o.onLessonsChanged(); // the newer server state may hold lessons added elsewhere
          this.schedule(0);
        } catch { this.offline(); }
      } else if (e?.status === 422 || e?.status === 404) {   // the server refuses these changes
        const sig = JSON.stringify(batch);
        let fixed = false;
        if (sig !== this.lastRefused) {   // first refusal: our copy may be stale. Load the server's, re-apply what still makes sense, retry once.
          this.lastRefused = sig;
          try {
            const cv = await api<any>(`/subjects/${this.o.sid}/canvas`);
            const pending = diff(this.base, this.local, this.version);
            const snap = snapFrom(cv.nodes, cv.edges);
            this.version = cv.version; this.base = snap;
            this.local = clean(applyBatch(snap, pending));
            this.o.onLocal(this.local); this.persist(); this.o.onLessonsChanged();
            fixed = true;
          } catch { /* fall through to the error */ }
        }
        if (fixed) this.schedule(0);
        else {
          this.local = this.base;
          this.o.onLocal(this.local);
          this.persist();
          this.o.onState("error", e.message || "Some changes could not be saved and were undone.");
        }
      } else if (e?.status === 401) {
        this.o.onState("offline", "Signed out. Your changes are kept in this browser.");
      } else {
        this.offline();
      }
    }
  }
  private offline() {
    this.o.onState("offline");
    this.schedule(this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 60_000);
  }
}
