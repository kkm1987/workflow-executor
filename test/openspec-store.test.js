import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { root, create, summary, prompt } from '../src/workflow.js';
import { startChange, archive, validatePrereview, runOpenSpec } from '../src/changes.js';
import { preflight } from '../src/preflight.js';
import { step, run, runAgent, codexArgs, claudeArgs } from '../src/executor.js';
import { snapshot } from '../src/evidence.js';

function fixture(t) {
  const dir = mkdtempSync(join(root, 'agent-docs', 'store-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'target');
  const store = join(dir, 'store');
  mkdirSync(target); mkdirSync(store);
  const state = create(target, '試験', join(dir, 'data'));
  Object.assign(state, { kind: 'change', stage: 'prereview', change: 'sample', candidates: [{ name: 'sample' }],
    openspec: { root: store, store: 'test-store', source: 'store' } });
  return { dir, target, store, state, base: join(dir, 'data') };
}
const result = { outcome: 'ok', change: 'sample' };

test('store指定・宣言・ローカルのルートをCLIから保存し、解決失敗は開始を拒否する', async t => {
  const { target, store, base } = fixture(t);
  for (const [id, path, source] of [['test-store', store, 'store'], [undefined, store, 'declared'], [undefined, target, 'nearest']]) {
    const state = await startChange(target, 'sample', {}, base, async (cwd, args) => {
      assert.equal(cwd, target);
      assert.deepEqual(args, ['list', '--json', ...(id ? ['--store', id] : [])]);
      return JSON.stringify({ root: { path, source, ...(path === store ? { store_id: 'test-store' } : {}) }, changes: [{ name: 'sample', totalTasks: 1, completedTasks: 0 }] });
    }, id);
    assert.deepEqual(state.openspec, { root: path, store: path === store ? 'test-store' : null, source });
  }
  await assert.rejects(startChange(target, 'sample', {}, base, async () => { throw new Error('store未登録: registerしてください'); }, 'missing'), /store未登録/);
  await assert.rejects(startChange(target, 'sample', {}, base, async () => '{}'), /ルート/);
});

test('検証とアーカイブは保存したルートとstoreを使い、イベントへ記録する', async t => {
  const { state, store, base } = fixture(t);
  const evidence = { openspec: { changedFiles: ['openspec/changes/sample/tasks.md'] } };
  await validatePrereview(state, result, [], async (cwd, args) => {
    assert.equal(cwd, store);
    assert.deepEqual(args, ['validate', 'sample', '--store', 'test-store']);
  }, evidence);
  await assert.rejects(validatePrereview(state, result, ['code.js'], async () => assert.fail(), evidence), /ディレクトリ外/);
  await assert.rejects(validatePrereview(state, result, [], async () => assert.fail(), { openspec: { changedFiles: ['openspec/config.yaml'] } }), /ディレクトリ外/);
  await assert.rejects(validatePrereview(state, result, [], async () => assert.fail()), /証拠/);
  state.status = 'completed';
  await archive(state, base, async (cwd, args) => {
    assert.equal(cwd, store);
    assert.deepEqual(args, ['archive', 'sample', '-y', '--json', '--store', 'test-store']);
    return '完了';
  });
  const events = readFileSync(join(base, state.id, 'events.jsonl'), 'utf8');
  assert.ok(events.includes(JSON.stringify(store)));
  assert.match(events, /test-store/);
  delete state.openspec;
  await validatePrereview(state, result, ['openspec/changes/sample/tasks.md'], async (cwd, args) => {
    assert.equal(cwd, state.target);
    assert.deepEqual(args, ['validate', 'sample']);
  });
});

test('登録解除・ルート変更・Git管理外はモデル呼び出し0回でfailedになる', async t => {
  const { state, base, target } = fixture(t);
  for (const failure of ['unregistered', 'moved', 'git']) {
    state.status = 'ready';
    await step(state, () => assert.fail('モデルを呼ばない'), base, current => preflight(current,
      async (command, args, cwd) => {
        if (failure === 'git' && command === 'git' && cwd === state.openspec.root) throw new Error('Git管理外');
        return '';
      }, () => 'codex', () => 'claude', async () => {
        if (failure === 'unregistered') throw new Error('store未登録');
        return JSON.stringify({ root: { path: failure === 'moved' ? target : state.openspec.root } });
      }));
    assert.equal(state.status, 'failed');
    assert.equal(state.attempts, 0);
    assert.match(state.error, /OpenSpec/);
  }
});

test('実行前レビューとapplyは対象changeだけを追加許可し、指示と要約にルートを含める', t => {
  const { state, store, base } = fixture(t);
  const path = join(store, 'openspec', 'changes', 'sample');
  for (const stage of ['prereview', 'execute']) {
    state.stage = stage;
    state.grants = { paths: [join(store, 'extra')] };
    const codex = codexArgs(state, base);
    assert.ok(codex.includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([...state.grants.paths, path])}`));
    const claude = claudeArgs(state, 'session');
    assert.ok(claude.includes('--add-dir'));
    assert.ok(claude.includes(path));
    if (stage === 'prereview') assert.ok(claude.includes(`Write(${path.replaceAll('\\', '/')}/**)`));
  }
  assert.ok(prompt(state).includes(path));
  assert.match(prompt(state), /--store "test-store"/);
  assert.deepEqual(summary(state, base).openspec, state.openspec);
  state.stage = 'prereview'; state.change = null; state.candidates.push({ name: 'second' });
  assert.ok(claudeArgs(state, 'session').includes(join(store, 'openspec', 'changes', 'second')));
  state.openspec.root = state.target;
  delete state.grants;
  assert.ok(!codexArgs(state, base).some(arg => arg.startsWith('sandbox_workspace_write.writable_roots=')));
  assert.ok(!claudeArgs(state, 'session').includes('--add-dir'));
});

test('実storeの開始からレビュー・apply・アーカイブまで、両方のGit証拠を保持する', async t => {
  const { dir, target, store, base } = fixture(t);
  const old = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  for (const name of Object.keys(old)) process.env[name] = join(dir, name);
  t.after(() => {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  for (const path of [target, store]) execFileSync('git', ['init', '--quiet', path]);
  mkdirSync(join(store, 'openspec', 'specs'), { recursive: true });
  mkdirSync(join(store, 'openspec', 'changes'), { recursive: true });
  writeFileSync(join(store, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
  await runOpenSpec(target, ['store', 'register', store, '--id', 'test-store', '--yes', '--json']);
  const change = join(store, 'openspec', 'changes', 'sample');
  mkdirSync(join(change, 'specs', 'greeting'), { recursive: true });
  writeFileSync(join(change, 'proposal.md'), '## Why\n挨拶を提供する。\n## What Changes\n挨拶を追加する。\n## Capabilities\n### New Capabilities\n- `greeting`: 挨拶\n## Impact\ngreet.txt\n');
  writeFileSync(join(change, 'specs', 'greeting', 'spec.md'), '## ADDED Requirements\n### Requirement: 挨拶\n挨拶はHelloでなければならない（MUST）。\n#### Scenario: 挨拶する\n- **WHEN** 挨拶を求める\n- **THEN** Helloを返す\n');
  writeFileSync(join(change, 'tasks.md'), '- [ ] 1. 挨拶を実装する\n');
  writeFileSync(join(store, 'unrelated.txt'), '証拠の対象外');
  const scoped = await snapshot(store, join(dir, 'scoped.json'), ['openspec']);
  assert.ok(!Object.hasOwn(scoped.files, 'unrelated.txt'));
  assert.ok(Object.keys(scoped.files).every(name => name.startsWith('openspec/')));
  const state = await startChange(target, 'sample', { prereview: { model: 'gpt-6-luna' } }, base, undefined, 'test-store');
  assert.equal(state.openspec.root, store);
  mkdirSync(join(target, 'openspec'));
  writeFileSync(join(target, 'openspec', 'config.yaml'), 'store: test-store\n');
  const inferred = await startChange(target, 'sample', {}, base);
  assert.equal(inferred.openspec.store, 'test-store');
  // 開始後の宣言変更が保存したstoreへ影響しないことも確かめる。
  writeFileSync(join(target, 'openspec', 'config.yaml'), 'store: missing-store\n');
  const fake = join(dir, 'agent.cjs');
  const stages = [];
  const report = { scope: '挨拶', decisions: [], verification: '固定応答で実行器を検証', remaining: 'なし' };
  const runner = async (current, attempt) => {
    stages.push(current.stage);
    const result = { outcome: 'ok', summary: '検証済み', question: '', report,
      decisions: current.stage === 'prereview' ? { selection: '指定', applicability: '実行可能', updates: 'タスク確認' } : { requirements: '', granularity: '', architecture: '' },
      tasks: current.stage === 'prereview' ? [{ title: '挨拶を実装', acceptance: 'Helloを保存' }] : [],
      ...(current.stage === 'prereview' ? { change: 'sample' } : {}) };
    const edits = current.stage === 'prereview'
      ? `fs.appendFileSync(${JSON.stringify(join(change, 'tasks.md'))}, '\\n');`
      : current.stage === 'execute'
        ? `fs.writeFileSync(${JSON.stringify(join(target, 'greet.txt'))}, 'Hello'); fs.writeFileSync(${JSON.stringify(join(change, 'tasks.md'))}, '- [x] 1. 挨拶を実装する\\n');`
        : '';
    writeFileSync(fake, `const fs = require('node:fs'); process.stdin.resume(); process.stdin.on('end', () => { ${edits} fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], ${JSON.stringify(JSON.stringify(result))}); });`);
    return runAgent(current, attempt, process.execPath, [fake]);
  };
  await run(state, runner, base, undefined, current => preflight(current, async (command, args, cwd) => {
    if (command === 'git') return execFileSync(command, args, { cwd, encoding: 'utf8' });
    return '';
  }, () => 'codex'), async () => null);
  assert.equal(state.status, 'completed', state.error);
  assert.deepEqual(stages, ['prereview', 'execute', 'review', 'acceptance']);
  assert.deepEqual(state.evidence[0].changedFiles, []);
  assert.deepEqual(state.evidence[0].openspec.changedFiles, ['openspec/changes/sample/tasks.md']);
  assert.deepEqual(state.evidence[1].changedFiles, ['greet.txt']);
  assert.deepEqual(state.evidence[1].openspec.changedFiles, ['openspec/changes/sample/tasks.md']);
  assert.equal(state.evidence[1].openspec.store, 'test-store');
  assert.equal(state.evidence[1].openspec.root, store);
  for (const stage of ['review', 'acceptance']) {
    state.stage = stage;
    const context = JSON.parse(prompt(state).split('\n').at(-1));
    assert.deepEqual(context.evidence, state.evidence);
  }
  await archive(state, base);
  assert.ok(!existsSync(change));
  assert.ok(readdirSync(join(store, 'openspec', 'changes', 'archive')).some(name => name.endsWith('-sample')));
  assert.ok(readFileSync(join(store, 'openspec', 'specs', 'greeting', 'spec.md'), 'utf8').includes('Hello'));
  // 同一ルートは従来の証拠形式を保つ。
  state.openspec.root = target; state.openspec.store = null; state.stage = 'execute'; state.attempts++;
  const attempt = join(dir, 'same-root'); mkdirSync(attempt);
  writeFileSync(fake, `const fs = require('node:fs'); process.stdin.resume(); process.stdin.on('end', () => fs.writeFileSync(process.argv[process.argv.indexOf('-o') + 1], '{}'));`);
  await runAgent(state, attempt, process.execPath, [fake]);
  assert.equal(state.evidence.at(-1).openspec, undefined);
});
