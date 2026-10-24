import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function usage(dir) {
  const path = join(dir, 'codex.jsonl');
  const totals = { input_tokens: null, cached_input_tokens: null, output_tokens: null };
  const missing = new Set();
  if (!existsSync(path)) return totals;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; } // 中断時の末尾を許容する。
    if (event.type !== 'turn.completed') continue;
    for (const key of Object.keys(totals)) {
      const value = event.usage?.[key];
      if (Number.isSafeInteger(value) && value >= 0) totals[key] = (totals[key] ?? 0) + value;
      else missing.add(key);
    }
  }
  for (const key of missing) totals[key] = null;
  return totals;
}

export function performanceReport(state) {
  const attempts = state.metrics ?? [];
  const tokens = {};
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
    const acquired = attempts.filter(attempt => attempt.usage[key] !== null);
    tokens[key] = { value: acquired.reduce((sum, attempt) => sum + attempt.usage[key], 0),
      complete: state.attempts > 0 && acquired.length === state.attempts, acquired: acquired.length, total: state.attempts };
  }
  const end = attempts.at(-1)?.finishedAt ?? state.updatedAt;
  return { id: state.id, target: state.target, status: state.status, attempts,
    attemptCount: state.attempts, activeComplete: attempts.length === state.attempts,
    activeMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
    elapsedMs: Math.max(0, Date.parse(end) - Date.parse(state.createdAt)), tokens };
}
