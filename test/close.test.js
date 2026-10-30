import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, create, save, load, close, summary, answer, approve, grant, retry, registerEvidence, setModel, setFallback } from '../src/workflow.js';
import { run, step } from '../src/executor.js';
import { archive } from '../src/changes.js';

function fixture(t) {
  const dir = mkdtempSync(join(root, 'agent-docs', 'close-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'target');
  mkdirSync(target);
  const base = join(dir, 'data');
  return { dir, target, base, state: create(target, '終了する案件', base) };
}

test('終了は理由・前状態・履歴を保持し、実行中と終了済みを拒否する', t => {
  const { state, base, target } = fixture(t);
  state.status = 'failed'; state.session = { sessionId: '旧セッション' }; state.attempts = 1;
  const attempt = join(base, state.id, 'attempt-0001'); mkdirSync(attempt);
  writeFileSync(join(attempt, 'result.json'), '{"summary":"途中の結果"}');
  writeFileSync(join(target, '途中.txt'), '変更を保持');
  save(state, base);
  const history = summary(state, base).history;
  close(state, '別IDでやり直す', base);
  assert.equal(load(state.id, base).status, 'closed');
  assert.equal(state.closed.from, 'failed');
  assert.equal(state.closed.reason, '別IDでやり直す');
  assert.ok(Number.isFinite(Date.parse(state.closed.at)));
  assert.equal(state.session, undefined);
  assert.deepEqual(summary(state, base).history, history);
  assert.equal(summary(state, base).statusLabel, '終了');
  assert.equal(summary(state, base).nextAction, '対応は不要です');
  assert.deepEqual(summary(state, base).closed, state.closed);
  assert.equal(readFileSync(join(target, '途中.txt'), 'utf8'), '変更を保持');
  assert.match(readFileSync(join(base, state.id, 'events.jsonl'), 'utf8'), /"type":"closed"/);
  for (const status of ['closed', 'running']) {
    state.status = status; save(state, base);
    const before = readFileSync(join(base, state.id, 'state.json'), 'utf8');
    assert.throws(() => close(state, '', base));
    assert.equal(readFileSync(join(base, state.id, 'state.json'), 'utf8'), before);
  }
});

test('終了した案件のすべての変更操作は状態とイベントを変更せず拒否する', async t => {
  const { state, base } = fixture(t);
  close(state, '', base);
  const operations = [
    () => run(state, undefined, base), () => step(state, undefined, base),
    () => answer(state, '回答', base), () => approve(state, '', base),
    () => grant(state, {}, base), () => retry(state, base),
    () => registerEvidence(state, '存在しない.json', base),
    () => setModel(state, 'plan', 'gpt-6-luna', undefined, base),
    () => setFallback(state, 'plan', null, undefined, base),
    () => archive(state, base, async () => assert.fail('呼び出さない')),
  ];
  const before = structuredClone(state);
  const files = ['state.json', 'events.jsonl'].map(name => join(base, state.id, name));
  const saved = files.map(path => readFileSync(path, 'utf8'));
  for (const operation of operations) {
    await assert.rejects(async () => operation());
    assert.deepEqual(state, before);
    assert.deepEqual(files.map(path => readFileSync(path, 'utf8')), saved);
  }
});

test('アーカイブ失敗はcompletedを保持し、成功だけがarchivedの理由で終了する', async t => {
  const { state, base } = fixture(t);
  Object.assign(state, { kind: 'change', change: 'sample', status: 'completed' }); save(state, base);
  await assert.rejects(archive(state, base, async () => { throw new Error('失敗'); }), /失敗/);
  assert.equal(load(state.id, base).status, 'completed');
  assert.equal(state.closed, undefined);
  await archive(state, base, async () => '成功');
  assert.equal(load(state.id, base).status, 'closed');
  assert.equal(state.closed.from, 'completed');
  assert.equal(state.closed.reason, 'archived');
});

test('CLIの終了と一覧・全件・ID指定、Markdownと公開要約の除外', t => {
  const { dir, target, state } = fixture(t);
  cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(root, 'package.json'), join(dir, 'package.json'));
  cpSync(join(root, 'test', 'fixtures', 'workflow.config.json'), join(dir, 'workflow.config.json'));
  const base = join(dir, 'data');
  const waiting = create(target, '回答を待つ案件', base); waiting.status = 'waiting'; save(waiting, base);
  const reason = join(dir, '理由.txt'); writeFileSync(reason, '使わない');
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [join(dir, 'src', 'cli.js'), ...args], { encoding: 'utf8', windowsHide: true }));
  const closed = cli('close', state.id, reason);
  assert.equal(closed.closed.reason, '使わない');
  assert.deepEqual(cli('status').map(item => item.id), [waiting.id]);
  assert.equal(cli('status', '--all').length, 2);
  assert.deepEqual(cli('status', state.id).closed, closed.closed);
  assert.ok(!Object.hasOwn(cli('status', waiting.id), 'history'));
  assert.ok(!Object.hasOwn(cli('status')[0], 'selection'));
  assert.deepEqual(cli('status', waiting.id, '--detail').history, []);
  assert.ok(Object.hasOwn(cli('status', waiting.id, '--detail'), 'selection'));
  const json = JSON.parse(readFileSync(join(base, 'dashboard.json'), 'utf8'));
  assert.deepEqual(json.counts, { waiting: 1 });
  assert.deepEqual(json.groups.flatMap(group => group.cases).map(item => item.id), [waiting.id]);
  assert.ok(!readFileSync(join(base, 'dashboard.md'), 'utf8').includes(state.id));
  waiting.question = '元の質問'; save(waiting, base);
  assert.equal(cli('answer', waiting.id, reason, '--inquiry').status, 'ready');
  const answered = load(waiting.id, base);
  assert.equal(answered.answers.at(-1).inquiry, true);
  assert.equal(answered.question, '元の質問');
  assert.equal(cli('close', waiting.id).closed.reason, '');
  assert.deepEqual(cli('status'), []);
});
