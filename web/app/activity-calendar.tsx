"use client";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Flame } from "lucide-react";
import { api } from "@/lib/api";

/* Streak counter and month calendar of practice days (test answers, word reviews, lessons mastered). */

type Activity = { today: string; current_streak: number; longest_streak: number; total_days: number; active_today: boolean; days: Record<string, number> };

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function ActivityCalendar() {
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState(false);
  const now = new Date();
  const [view, setView] = useState({ y: now.getFullYear(), m: now.getMonth() });

  useEffect(() => {
    let alive = true;
    api<Activity>("/activity").then(d => alive && setData(d)).catch(() => alive && setError(true));
    return () => { alive = false; };
  }, []);

  const first = new Date(view.y, view.m, 1);
  const offset = (first.getDay() + 6) % 7; // Monday first
  const count = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(offset).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
  const todayIso = iso(now.getFullYear(), now.getMonth(), now.getDate());
  const monthDays = data ? Object.keys(data.days).filter(d => d.startsWith(`${view.y}-${pad(view.m + 1)}-`)).length : 0;
  const shift = (by: number) => setView(v => { const d = new Date(v.y, v.m + by, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const level = (n: number) => (n >= 20 ? 3 : n >= 8 ? 2 : 1);

  if (error) return null;
  return (
    <section className="panel activity-panel" style={{ marginBottom: 16 }}>
      <div className="panel-header">
        <div>
          <div className="panel-title">Practice streak</div>
          <div className="panel-subtitle">{data ? (data.active_today ? "You practiced today. Nice." : data.current_streak ? "Practice today to keep your streak." : "Practice today to start a streak.") : "Loading…"}</div>
        </div>
        <span className="tag streak-tag"><Flame size={14} /> {data?.current_streak ?? 0} {data?.current_streak === 1 ? "day" : "days"}</span>
      </div>
      <div className="activity-stats">
        <div><strong>{data?.current_streak ?? 0}</strong><small>Current streak</small></div>
        <div><strong>{data?.longest_streak ?? 0}</strong><small>Longest streak</small></div>
        <div><strong>{data?.total_days ?? 0}</strong><small>Days practiced</small></div>
      </div>
      <div className="cal-head">
        <button className="btn" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft size={16} /></button>
        <strong>{first.toLocaleDateString(undefined, { month: "long", year: "numeric" })} <small>· {monthDays} {monthDays === 1 ? "day" : "days"}</small></strong>
        <button className="btn" aria-label="Next month" onClick={() => shift(1)}><ChevronRight size={16} /></button>
      </div>
      <div className="cal-grid" role="grid">
        {WEEK.map(w => <span className="cal-dow" key={w}>{w}</span>)}
        {cells.map((d, i) => {
          if (!d) return <span key={`e${i}`} />;
          const key = iso(view.y, view.m, d);
          const n = data?.days[key] || 0;
          return <span key={key} className={`cal-day ${n ? `on l${level(n)}` : ""} ${key === todayIso ? "today" : ""}`}
            title={n ? `${n} ${n === 1 ? "action" : "actions"}` : "No practice"} aria-label={`${key}: ${n ? n + " actions" : "no practice"}`}>{d}</span>;
        })}
      </div>
    </section>
  );
}
