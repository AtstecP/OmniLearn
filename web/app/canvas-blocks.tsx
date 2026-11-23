"use client";
/*
 * Custom React Flow pieces for the learning canvas: one block component for every block type
 * (topic, lesson, quiz, note, resource) and a "floating" edge that attaches to the nearest side
 * of each block, so connections never depend on which handle they were drawn from.
 */
import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Handle, NodeResizer, Position, useInternalNode, type EdgeProps, type InternalNode, type NodeProps } from "@xyflow/react";
import { BookOpen, CircleCheck, FileText, HelpCircle, Link2, Lightbulb, StickyNote } from "lucide-react";
import Markdown from "./markdown";
import type { CNode, EdgeType, NodeType } from "@/lib/canvas-sync";

export const COLORS = ["default", "yellow", "green", "blue", "pink", "purple"] as const;
export const QUICK_COLORS = ["default", "yellow", "green", "blue"] as const;   // the four shown first in the picker
export const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
export const TYPE_LABEL: Record<NodeType, string> = { topic: "Topic", material: "Lesson", quiz: "Quiz", note: "Note", resource: "Resource" };
export const TYPE_ICON: Record<NodeType, typeof BookOpen> = { topic: Lightbulb, material: BookOpen, quiz: HelpCircle, note: StickyNote, resource: Link2 };
export const EDGE_LABEL: Record<EdgeType, string> = { default: "Connection", related_to: "Related to", explains: "Explains", prerequisite: "Prerequisite", references: "References", tests: "Tests" };
export const STATUS_LABEL: Record<string, string> = { not_started: "Not started", in_progress: "In progress", mastered: "Mastered" };

export type BlockData = {
  node: CNode;
  status?: string;                       // lessons: not_started | in_progress | mastered
  questions?: number;                    // lessons and quizzes
  progress?: { done: number; total: number }; // topics: lessons connected to it
  match?: boolean;                       // highlighted by search
  onResizeEnd?: (id: string, size: { x: number; y: number; width: number; height: number }) => void;
};

const RESIZABLE: NodeType[] = ["topic", "material", "quiz", "note", "resource"];

function hostOf(url: string) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } }

export const BlockNode = memo(function BlockNode({ data, selected }: NodeProps) {
  const { node: n, status, questions = 0, progress, match, onResizeEnd } = data as unknown as BlockData;
  const Icon = TYPE_ICON[n.type];
  const label = n.type === "note" && n.meta?.frame ? " cb-frame" : n.type === "note" && n.meta?.plain ? " cb-plain" : "";
  const custom = isHex(n.meta?.color) ? n.meta.color : null;   // a colour picked from the palette
  const color = !custom && n.meta?.color && n.meta.color !== "default" ? ` cb-color-${n.meta.color}` : "";
  const tint: React.CSSProperties | undefined = custom
    ? label === " cb-plain" ? { color: custom } : { borderColor: custom, background: `color-mix(in srgb, ${custom} 20%, var(--surface))` }
    : undefined;
  const fixed = n.w ? { width: "100%", height: "100%", ...tint } : tint;
  return (
    <div className={`cb cb-${n.type}${label}${color}${selected ? " selected" : ""}${match ? " match" : ""}${status ? " st-" + status : ""}`} style={fixed}>
      {RESIZABLE.includes(n.type) && (
        <NodeResizer isVisible={!!selected} minWidth={130} minHeight={56} lineClassName="cb-resize-line" handleClassName="cb-resize-handle"
          onResizeEnd={(_, p) => onResizeEnd?.(n.id, p)} />
      )}
      {(["top", "right", "bottom", "left"] as const).map(side => (
        <Handle key={side} id={side} type="source" className="cb-handle" position={side === "top" ? Position.Top : side === "right" ? Position.Right : side === "bottom" ? Position.Bottom : Position.Left} />
      ))}
      {!label && <div className="cb-head">
        <span className="cb-icon"><Icon size={14} /></span>
        <span className="cb-kind">{n.type === "resource" && n.meta?.kind === "pdf" ? "PDF" : TYPE_LABEL[n.type]}</span>
        {n.type === "material" && status === "mastered" && <CircleCheck size={15} className="cb-done" aria-label="Mastered" />}
        {n.type === "material" && status === "in_progress" && <span className="cb-dot" title="In progress" aria-label="In progress" />}
      </div>}
      {n.type !== "note" && <div className="cb-title">{n.title}</div>}
      {n.type === "material" && <div className="cb-sub">{[n.level, questions ? `${questions} question${questions === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || STATUS_LABEL[status || "not_started"]}</div>}
      {n.type === "topic" && n.meta?.description && <div className="cb-sub cb-desc">{n.meta.description}</div>}
      {n.type === "topic" && progress && progress.total > 0 && (
        <div className="cb-progress" title={`${progress.done} of ${progress.total} connected lessons mastered`}>
          <span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
        </div>
      )}
      {n.type === "quiz" && <div className="cb-sub">{questions ? `${questions} question${questions === 1 ? "" : "s"} · double-click to start` : "Pick lessons in the panel"}</div>}
      {n.type === "note" && (n.meta?.frame
        ? <div className="cb-frame-title">{n.meta?.text ? String(n.meta.text).split("\n")[0] : <span className="cb-placeholder">Frame: type a title</span>}</div>
        : <div className="cb-notetext">{n.meta?.text ? <Markdown text={String(n.meta.text)} /> : <span className="cb-placeholder">{n.meta?.plain ? "Type here" : "Empty note"}</span>}</div>)}
      {n.type === "resource" && <div className="cb-sub">{n.meta?.url ? <><FileText size={12} /> {hostOf(String(n.meta.url))}</> : "No link yet"}</div>}
    </div>
  );
});

// ---------------------------------------------------------------- floating edge

function intersection(a: InternalNode, b: InternalNode) {
  const w = (a.measured.width || 1) / 2, h = (a.measured.height || 1) / 2;
  const pa = a.internals.positionAbsolute, pb = b.internals.positionAbsolute;
  const x2 = pa.x + w, y2 = pa.y + h;
  const x1 = pb.x + (b.measured.width || 1) / 2, y1 = pb.y + (b.measured.height || 1) / 2;
  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h);
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h);
  const k = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);
  const xx3 = k * xx1, yy3 = k * yy1;
  return { x: w * (xx3 + yy3) + x2, y: h * (-xx3 + yy3) + y2 };
}
function side(node: InternalNode, p: { x: number; y: number }) {
  const { x, y } = node.internals.positionAbsolute;
  const w = node.measured.width || 0, h = node.measured.height || 0;
  if (p.x <= x + 1) return Position.Left;
  if (p.x >= x + w - 1) return Position.Right;
  if (p.y <= y + 1) return Position.Top;
  if (p.y >= y + h - 1) return Position.Bottom;
  return Position.Top;
}

export function FloatingEdge({ id, source, target, markerEnd, selected, data }: EdgeProps) {
  const s = useInternalNode(source), t = useInternalNode(target);
  if (!s || !t) return null;
  const sp = intersection(s, t), tp = intersection(t, s);
  const [path, lx, ly] = getBezierPath({ sourceX: sp.x, sourceY: sp.y, sourcePosition: side(s, sp), targetX: tp.x, targetY: tp.y, targetPosition: side(t, tp) });
  const type = ((data as any)?.type || "default") as EdgeType;
  const label = (data as any)?.label || (type !== "default" ? EDGE_LABEL[type] : "");
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className={`ce ce-${type}${selected ? " selected" : ""}`} interactionWidth={18} />
      {label && (
        <EdgeLabelRenderer>
          <div className={`ce-label ce-${type}${selected ? " selected" : ""}`} style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>{label}</div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
