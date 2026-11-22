import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { reserve } from './locking.js';
import { resolve, join } from 'node:path';
import { capture } from './commands.js';
import { create, save, event, close, dataRoot, validChangeName, temporaryDirectory } from './workflow.js';
import { attemptAssignment, validateModel, validateAssignments, stagesFor } from './config.js';

const openspec = fileURLToPath(new URL('../node_modules/@fission-ai/openspec/bin/openspec.js', import.meta.url));
export const runOpenSpec = (target, args) => capture(process.execPath, [openspec, ...args], target, 60_000);
export const openSpecRoot = state => state.openspec ?? { root: state.target, store: null };
export const separateOpenSpec = state => state.kind === 'change' && resolve(openSpecRoot(state).root) !== resolve(state.target);
export const storeArgs = state => openSpecRoot(state).store ? ['--store', openSpecRoot(state).store] : [];
export const prereviewChangeNames = state => state.change ? [state.change] : state.candidates.map(item => item.name);
export const changeDirectories = state => prereviewChangeNames(state)
  .map(name => join(openSpecRoot(state).root, 'openspec', 'changes', name));
export const goBuildCache = (base = dataRoot) => resolve(base, 'cache', 'go-build');
export const writablePaths = (state, base = dataRoot) => [
  ...(state.grants?.paths ?? []), ...(separateOpenSpec(state) ? changeDirectories(state) : []),
  temporaryDirectory(state, base), goBuildCache(base),
];

export function taskGate(state) {
  if (!validChangeName(state.change)) throw new Error('change名が不正です');
  const lines = readFileSync(join(openSpecRoot(state).root, 'openspec', 'changes', state.change, 'tasks.md'), 'utf8').split(/\r?\n/);
  return lines.filter(line => {
    if (/^\s*- \[ \]/.test(line)) return true;
    return [...line.matchAll(/省略（所有者の判断: 回答#(\d+)/g)].some(([, number]) => {
      const answer = state.answers[Number(number) - 1];
      return !answer || answer.inquiry;
    });
  });
}

export async function startChange(target, change, models = {}, base = dataRoot, execute = runOpenSpec, store, fallbacks = {}) {
  if (change !== undefined && !validChangeName(change)) throw new Error('change名が不正です');
  const normalized = {};
  for (const [stage, value] of Object.entries(models)) {
    if (!stagesFor('change').includes(stage)) throw new Error('工程が不正です');
    normalized[stage] = validateModel(value);
  }
  validateAssignments({ kind: 'change', models: normalized, fallbacks });
  const { changes, root } = JSON.parse(await execute(target, ['list', '--json', ...(store ? ['--store', store] : [])]));
  if (!root?.path || !root.source) throw new Error('OpenSpecのルートを解決できません。openspec list --jsonで設定を確認してください');
  const candidates = changes.filter(item => item.status !== 'complete' &&
    (item.totalTasks === 0 || item.completedTasks < item.totalTasks) && validChangeName(item.name));
  if (!candidates.length) throw new Error('未完了のchangeがありません');
  if (change && !candidates.some(item => item.name === change)) throw new Error('指定changeが未完了の候補にありません');
  const id = randomUUID();
  const release = reserve(base, () => ({ id, paths: [target, root.path] }));
  try {
    const state = create(target, `OpenSpec change: ${change ?? '次のchangeを選定して実行'}`, base, id,
      { kind: 'change', models: normalized, fallbacks });
    Object.assign(state, { kind: 'change', stage: 'prereview', change: change ?? null, candidates, models: normalized,
      openspec: { root: resolve(root.path), store: root.store_id ?? null, source: root.source } });
    save(state, base);
    return state;
  } finally { release(); }
}

export async function archive(state, base = dataRoot, execute = runOpenSpec) {
  if (state.kind !== 'change' || state.status !== 'completed' || !validChangeName(state.change)) throw new Error('completedのchangeだけアーカイブできます');
  try {
    const problems = taskGate(state);
    if (problems.length) throw new Error(`tasks.mdの確認に失敗しました:\n${problems.join('\n')}`);
    const output = await execute(openSpecRoot(state).root, ['archive', state.change, '-y', '--json', ...storeArgs(state)]);
    event(state, 'archived', { change: state.change, ...openSpecRoot(state), output }, base);
    close(state, 'archived', base);
    return output;
  } catch (error) {
    event(state, 'archive_failed', { change: state.change, ...openSpecRoot(state), error: error.message }, base);
    throw error;
  }
}

export async function validatePrereview(state, result, files, execute = runOpenSpec, evidence) {
  const outside = '実行前レビューが対象changeのディレクトリ外を変更しました';
  const claude = attemptAssignment(state).cli === 'claude';
  let external = [];
  if (separateOpenSpec(state)) {
    if (!Array.isArray(evidence?.openspec?.changedFiles)) throw new Error('OpenSpecの証拠がありません');
    if (files.length && !claude) throw new Error(outside);
    external = [...files];
    files = evidence.openspec.changedFiles;
  }
  const selected = state.change ?? result.change;
  if ((selected || result.outcome === 'ok') && (!validChangeName(selected) ||
      !state.candidates.some(item => item.name === selected) ||
      (result.outcome === 'ok' && selected !== result.change))) throw new Error('候補外のchangeです');
  const prefixes = prereviewChangeNames(state).map(name => `openspec/changes/${name}/`);
  for (const file of files) {
    const path = file.replaceAll('\\', '/');
    if (selected && path.startsWith(`openspec/changes/${selected}/`)) continue;
    if (!claude || prefixes.some(prefix => path.startsWith(prefix))) throw new Error(outside);
    external.push(file);
  }
  if (result.outcome === 'ok') await execute(openSpecRoot(state).root, ['validate', selected, ...storeArgs(state)]);
  return external;
}
