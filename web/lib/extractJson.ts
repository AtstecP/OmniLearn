// Finds the JSON in whatever was pasted: bare JSON, a ```json code block, or a whole
// AI reply with chat text around it. Returns the parsed value or a helpful error.

const FENCE = "`".repeat(3);

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false, message: String(e?.message || e) };
  }
}

function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const closed = new RegExp(FENCE + "[ \\t]*(?:json|JSON)?[ \\t]*\\r?\\n?([\\s\\S]*?)" + FENCE, "g");
  for (const m of text.matchAll(closed)) blocks.push(m[1].trim());
  if (!blocks.length) {
    // An opening fence whose closing fence was cut off or never copied.
    const open = text.indexOf(FENCE);
    if (open >= 0) blocks.push(text.slice(open + 3).replace(/^[ \t]*(?:json|JSON)?[ \t]*\r?\n?/, "").trim());
  }
  return blocks.filter(Boolean);
}

function objectSlice(text: string): string | null {
  const start = text.search(/[\[{]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

export function extractJson(raw: string): { value: any } | { error: string } {
  const text = raw.replace(/^﻿/, "").trim();
  if (!text) return { error: "Paste your study material (JSON) first, or choose a file." };

  const candidates: string[] = [text];
  for (const block of fencedBlocks(text)) candidates.push(block);
  const slice = objectSlice(text);
  if (slice && !candidates.includes(slice)) candidates.push(slice);
  for (const block of fencedBlocks(text)) {
    const inner = objectSlice(block);
    if (inner && !candidates.includes(inner)) candidates.push(inner);
  }

  let firstError = "";
  for (const candidate of candidates) {
    const result = tryParse(candidate);
    if (result.ok && result.value && typeof result.value === "object") return { value: result.value };
    // The last candidate is the most cleaned-up one, so its error is the most relevant.
    if (!result.ok && /[\[{]/.test(candidate)) firstError = result.message;
  }
  // Last resort: trailing commas, a common slip in generated JSON.
  for (const candidate of candidates) {
    const result = tryParse(candidate.replace(/,(\s*[}\]])/g, "$1"));
    if (result.ok && result.value && typeof result.value === "object") return { value: result.value };
  }

  if (!/[\[{]/.test(text)) {
    return { error: "I can't find any JSON in this text. Ask the AI to put the JSON in one code block, then copy that block." };
  }
  const cutOff = /unexpected end|end of json|unterminated/i.test(firstError);
  return {
    error: cutOff
      ? "The JSON looks cut off, as if the AI stopped before finishing. Ask it to continue or to return a shorter version (fewer lessons at a time), then paste the full result."
      : `This isn't valid JSON (${firstError || "parse error"}). Ask the AI to fix the JSON and return it again in one code block.`,
  };
}
