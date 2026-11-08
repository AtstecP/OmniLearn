"use client";
import { useEffect, useState } from "react";
import { Flame } from "lucide-react";
import { api } from "@/lib/api";

/* GitHub-style practice heatmap for the dashboard hero: weeks as columns (Monday first),
   one square per day, darker = more practice (test answers, word reviews, lessons mastered). */

type Activity = { today: string; current_streak: number; longest_streak: number; total_days: number; active_today: boolean; days: Record<string, number> };

const pad = (n: number) => String(n).padStart(2, "0");
const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const level = (n: number) => (n >= 20 ? 3 : n >= 8 ? 2 : n > 0 ? 1 : 0);

export default function ActivityHeatmap() {
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState(false);
  const [weeks, setWeeks] = useState(20);

  useEffect(() => {
    let alive = true;
    setWeeks(window.innerWidth < 768 ? 13 : 20);
    api<Activity>("/activity").then(d => alive && setData(d)).catch(() => alive && setError(true));
    return () => { alive = false; };
  }, []);

  if (error) return null;
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - ((today.getDay() + 6) % 7) - (weeks - 1) * 7); // Monday of the first column
  const cols = Array.from({ length: weeks }, (_, w) => Array.from({ length: 7 }, (_, r) => { const d = new Date(start); d.setDate(start.getDate() + w * 7 + r); return d; }));
  const months = cols.map((c, i) => (i === 0 || c[0].getMonth() !== cols[i - 1][0].getMonth() ? c[0].toLocaleDateString(undefined, { month: "short" }) : ""));
  const streak = data?.current_streak ?? 0;

  return (
    <div className="heat">
      <div className="heat-top">
        <span className="heat-streak"><Flame size={15} /> <strong>{streak}</strong> day streak</span>
        <small>Longest {data?.longest_streak ?? 0} · {data?.total_days ?? 0} days practiced</small>
      </div>
      <div className="heat-grid" style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }} role="img" aria-label="Practice calendar">
        {months.map((m, i) => <span className="heat-month" key={`m${i}`}>{m}</span>)}
        {cols.map((c, w) => c.map((d, r) => {
          const k = key(d), future = d > today, n = data?.days[k] || 0;
          return <span key={k} className={`heat-cell ${future ? "future" : `l${level(n)}`} ${k === key(today) ? "today" : ""}`}
            style={{ gridColumn: w + 1, gridRow: r + 2 }}
            title={future ? "" : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}: ${n ? n + (n === 1 ? " action" : " actions") : "no practice"}`} />;
        }))}
      </div>
      <div className="heat-legend"><small>Less</small>{[0, 1, 2, 3].map(l => <span key={l} className={`heat-cell l${l}`} />)}<small>More</small></div>
    </div>
  );
}
