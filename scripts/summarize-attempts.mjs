import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  data: { type: 'string', default: fileURLToPath(new URL('../data/', import.meta.url)) },
  from: { type: 'string' },
  to: { type: 'string' },
} });
const from = values.from === undefined ? -Infinity : Date.parse(values.from);
const to = values.to === undefined ? Infinity : Date.parse(values.to);
if (!(from < to)) throw new Error('--from と --to には昇順のISO日時を指定してください（開始を含み、終了を含まない）');

const groups = new Map();
for (const workflow of readdirSync(values.data, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
  const dir = join(values.data, workflow.name);
  for (const attempt of readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^attempt-\d+$/.test(entry.name))) {
    const path = join(dir, attempt.name, 'metrics.json');
    let metric;
    try { metric = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw new Error(path, { cause: error }); }
    const started = Date.parse(metric.startedAt);
    if (!(started >= from && started < to)) continue;
    const { stage, cli } = metric;
    const reviewer = metric.executeApprovalReviewer === undefined && stage === 'execute' ? 'executor' : metric.executeApprovalReviewer ?? null;
    const key = JSON.stringify([stage, cli, reviewer]);
    if (!groups.has(key)) groups.set(key, { stage, cli, reviewer, outcomes: new Map(), durations: [], ownerWaits: 0, attempts: 0 });
    const group = groups.get(key);
    const outcome = metric.outcome ?? 'unknown';
    group.outcomes.set(outcome, (group.outcomes.get(outcome) ?? 0) + 1);
    if (Number.isFinite(metric.durationMs)) group.durations.push(metric.durationMs);
    if (metric.status === 'waiting') group.ownerWaits++;
    group.attempts++;
  }
}

const results = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, { durations, outcomes, ...group }]) => {
  durations.sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const medianDurationMs = durations.length === 0 ? null : durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
  return { ...group, medianDurationMs, outcomes: Object.fromEntries([...outcomes].map(([outcome, count]) =>
    [outcome, { count, share: count / group.attempts }])) };
});
console.log(JSON.stringify({ from: values.from ?? null, to: values.to ?? null, groups: results }, null, 2));
