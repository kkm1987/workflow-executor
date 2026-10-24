import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root, create, summary } from '../src/workflow.js';
import { run, runCodex } from '../src/executor.js';
import { verify } from '../test/fixtures/expenses/verify.mjs';

const label = process.argv[2];
assert.ok(['control', 'improved'].includes(label), 'control または improved を指定する');
const parent = join(root, 'agent-docs');
mkdirSync(parent, { recursive: true });
const dir = mkdtempSync(join(parent, `benchmark-${label}-`));
const conditions = { model: 'gpt-6.1-sol', reasoning: 'low', platform: process.platform, node: process.version,
  codex: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
  cache: '通常の共有キャッシュを使用。各回のキャッシュ入力を記録し、冷キャッシュとは扱わない。',
  requirement: readFileSync(join(root, 'test/fixtures/expenses/request.md'), 'utf8') };
writeFileSync(join(dir, 'conditions.json'), JSON.stringify(conditions, null, 2));
console.log(JSON.stringify({ directory: dir, conditions }));
const results = [];
for (let i = 1; i <= 3; i++) {
  const target = join(dir, `run-${i}`);
  mkdirSync(target);
  execFileSync('git', ['init', '--quiet', target]);
  const originals = {
    'package.json': JSON.stringify({ name: 'expenses-benchmark', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2),
    'AGENTS.md': '# 開発ルール\nNode.js標準機能のみを使う。コミット・push・外部送信は禁止。要求の2ファイルだけを作成する。\n',
    'existing-note.txt': '既存の無関係なファイル。保持する。\n',
  };
  for (const [name, content] of Object.entries(originals)) writeFileSync(join(target, name), content);
  const base = join(dir, `data-${i}`);
  const state = create(target, conditions.requirement, base);
  await run(state, (current, attemptDir) => runCodex(current, attemptDir, 'codex', ['-m', conditions.model, '-c', `model_reasoning_effort="${conditions.reasoning}"`]), base,
    current => console.log(JSON.stringify({ run: i, ...summary(current, base) })));
  if (state.status !== 'completed') throw new Error(`測定停止: ${JSON.stringify(summary(state))}。保存先: ${dir}`);
  const checks = await verify(target);
  const generatedTests = execFileSync(process.execPath, ['--test'], { cwd: target, encoding: 'utf8' });
  for (const [name, content] of Object.entries(originals)) assert.equal(readFileSync(join(target, name), 'utf8'), content);
  assert.deepEqual(readdirSync(target).filter(name => !Object.hasOwn(originals, name) && name !== '.git').sort(), ['expenses.js', 'expenses.test.js']);
  assert.deepEqual(state.evidence.flatMap(item => item.changedFiles).sort(), ['expenses.js', 'expenses.test.js']);
  const sessions = [];
  for (let attempt = 1; attempt <= state.attempts; attempt++) {
    const lines = readFileSync(join(base, state.id, `attempt-${String(attempt).padStart(4, '0')}`, 'codex.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    sessions.push(lines.find(event => event.type === 'thread.started')?.thread_id);
  }
  assert.ok(sessions.every(Boolean));
  assert.equal(new Set(sessions).size, sessions.length);
  assert.equal(state.attempts, label === 'control' ? 6 : 4);
  const performance = JSON.parse(readFileSync(join(base, state.id, 'performance.json'), 'utf8'));
  results.push({ run: i, checks, generatedTests, sessions, performance });
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ label, conditions, results }, null, 2));
}
console.log(`測定完了: ${dir}`);
