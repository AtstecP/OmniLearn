// Remembers a test that was left half way (per subject, in this browser) so the Test center can
// offer "Continue last attempt". Only ids and answers are stored; the questions come from the workspace.
export type SavedExam = {
  title: string; ids: string[]; secs: number; left: number; idx: number;
  answers: Record<string, number>; flags: string[]; struck: Record<string, number[]>; at: number;
};
const key = (subject: string) => `learnify.exam.last.${subject}`;
export function loadExam(subject: string): SavedExam | null {
  try {
    const v = JSON.parse(localStorage.getItem(key(subject)) || "null");
    return v && Array.isArray(v.ids) && v.ids.length ? v : null;
  } catch { return null; }
}
export function saveExam(subject: string, s: SavedExam) { try { localStorage.setItem(key(subject), JSON.stringify(s)); } catch { /* storage blocked */ } }
export function clearExam(subject: string) { try { localStorage.removeItem(key(subject)); } catch { /* ignore */ } }

export type ExamSettings = { showAnswer: boolean };
const skey = "learnify.exam.settings";
export function loadExamSettings(): ExamSettings {
  try { return { showAnswer: false, ...JSON.parse(localStorage.getItem(skey) || "{}") }; } catch { return { showAnswer: false }; }
}
export function saveExamSettings(s: ExamSettings) { try { localStorage.setItem(skey, JSON.stringify(s)); } catch { /* ignore */ } }
