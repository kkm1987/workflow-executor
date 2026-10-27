import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { activity, eventStream } from '../src/activity.js';
import { root, create, summary, save, validateResult, prompt, setModel, answer } from '../src/workflow.js';
import { step, runAgent } from '../src/executor.js';

const report = { scope: 'sample.txt / 正常を含む', decisions: [], verification: '未検証', remaining: '読み取り確認' };
const result = { outcome: 'ok', summary: '確認', question: '', tasks: [], report };
function fixture(t) {
  const dir = mkdtempSync(join(root, 'agent-docs', 'progress-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'target');
  mkdirSync(target);
  const base = join(dir, 'data');
  const state = create(target, '試験', base);
  state.stage = 'review';
  state.tasks = [{ title: '第一の対象', acceptance: '条件', status: 'pending' }, { title: '第二の対象', acceptance: '条件', status: 'pending' }];
  return { dir, target, base, state };
}
const checked = (state, runner, base) => step(state, runner, base, async () => ({ ok: true }), async () => null);

test('実ログ由来Codex fixture: UTF-8の各バイト分割・未知イベント・未完末尾を許容する', () => {
  const entries = [];
  const receive = eventStream(entry => entries.push(entry));
  receive(Buffer.from('null\n42\n{}\n'));
  const bytes = Buffer.from(readFileSync(new URL('./fixtures/progress/codex.jsonl', import.meta.url), 'utf8') + '{"type":');
  for (const byte of bytes) receive(Buffer.from([byte]));
  assert.equal(entries.length, 6);
  const reports = entries.map(entry => activity(entry, 'codex')).filter(Boolean);
  assert.match(reports[0].text, /確認/);
  assert.deepEqual(reports.slice(1).map(({ tool, status }) => ({ tool, status })), [
    { tool: 'command_execution', status: 'in_progress' }, { tool: 'command_execution', status: 'completed' },
  ]);
  assert.doesNotMatch(JSON.stringify(reports), /秘密|内部推論|最終JSON/);
});

test('活動は500文字で切り詰め、内部思考・JSON応答・ツール引数・出力を転記しない', () => {
  const value = activity({ type: 'item.completed', item: { type: 'agent_message', text: '日'.repeat(501) } }, 'codex', '時刻');
  assert.equal(value.text.length, 500);
  assert.equal(value.truncated, true);
  assert.equal(value.at, '時刻');
  assert.equal(activity({ type: 'item.completed', item: { type: 'reasoning', text: '内部推論' } }, 'codex'), null);
  assert.equal(activity({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } }, 'codex'), null);
  const tool = activity({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: '内部推論' }, { type: 'tool_use', name: 'Read', input: { secret: '秘密' } },
  ] } }, 'claude');
  assert.equal(tool.tool, 'Read');
  assert.doesNotMatch(JSON.stringify(tool), /秘密|内部推論/);
  assert.equal(activity({ type: 'user', message: { content: [{ type: 'tool_result', content: '秘密', is_error: true }] } }, 'claude').status, 'failed');
});

test('両スキーマと実装・レビュー・最終確認はreportを必須にし、判断なし・未検証・差し戻しを保持する', () => {
  for (const file of ['result', 'prereview']) {
    const schema = JSON.parse(readFileSync(new URL(`../src/${file}.schema.json`, import.meta.url)));
    assert.ok(schema.required.includes('report'));
    assert.deepEqual(schema.properties.report.required, ['scope', 'decisions', 'verification', 'remaining']);
  }
  for (const stage of ['execute', 'review', 'acceptance']) {
    assert.equal(validateResult(result, stage).report, report);
    assert.throws(() => validateResult({ ...result, report: undefined }, stage), /工程報告/);
    assert.throws(() => validateResult({ ...result, report: { ...report, scope: ' ' } }, stage), /工程報告/);
    assert.throws(() => validateResult({ ...result, report: { ...report, decisions: [''] } }, stage), /工程報告/);
    if (stage !== 'execute') assert.equal(validateResult({ ...result, outcome: 'revise' }, stage).outcome, 'revise');
  }
});

test('試行の対象・担当・報告を固定し、次タスク・モデル変更後も旧履歴と失敗ログを参照する', async t => {
  const { state, base } = fixture(t);
  await checked(state, async current => {
    assert.equal(current.activity, null);
    assert.equal(current.work.scope, '第一の対象');
    current.activity = { kind: 'report', text: '確認中', at: '最初の時刻' };
    return result;
  }, base);
  assert.equal(state.stage, 'execute');
  assert.equal(state.work.scope, '第一の対象');
  setModel(state, 'execute', 'claude-opus-5-5', 'medium', base);
  await checked(state, async current => {
    assert.equal(current.activity, null);
    assert.equal(current.work.scope, '第二の対象');
    assert.equal(current.work.cli, 'claude');
    throw new Error('最終応答なし');
  }, base);
  const view = summary(state, base);
  assert.equal(view.history[0].work.scope, '第一の対象');
  assert.equal(view.history[0].cli, 'codex');
  assert.deepEqual(view.latestReport.report, report);
  assert.equal(view.history[1].report, null);
  assert.match(view.history[1].error, /最終応答なし/);
  assert.match(view.history[1].log, /claude/);
});

test('旧履歴はsummaryを残して未記録を示し、Markdownをエスケープし、表示で履歴を変更しない', t => {
  const { state, base } = fixture(t);
  const dir = join(base, state.id, 'attempt-0001');
  mkdirSync(dir);
  const text = JSON.stringify({ summary: '旧報告' });
  writeFileSync(join(dir, 'result.json'), text);
  state.activity = { kind: 'report', text: '<script>|[リンク]'.repeat(40), at: '固定時刻', truncated: true };
  save(state, base);
  const previousTime = state.activity.at;
  save(state, base);
  assert.equal(state.activity.at, previousTime);
  assert.equal(summary(state, base).history[0].summary, '旧報告');
  assert.equal(readFileSync(join(dir, 'result.json'), 'utf8'), text);
  const md = readFileSync(join(base, 'dashboard.md'), 'utf8');
  assert.match(md, /&lt;script&gt;/);
  assert.match(md, /切り詰め/);
  assert.match(md, /未記録.*旧報告/);
  assert.doesNotMatch(md, /<script>/);
  state.activity = null;
  save(state, base);
  assert.equal(summary(state, base).activityLabel, '報告未取得');
  assert.match(prompt(state), /report.scope/);
});

test('実プロセス: 元ログ保存・活動更新・終了前の10秒保存・失敗・ログ保存不能', async t => {
  const { state, base, target } = fixture(t);
  const fake = join(target, 'fake.cjs');
  writeFileSync(fake, `const fs = require('node:fs'); process.stdin.resume(); process.stdin.on('end', () => {
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'日本語の確認中'}}));
    setTimeout(() => { const args = process.argv; fs.writeFileSync(args[args.indexOf('-o')+1], ${JSON.stringify(JSON.stringify(result))}); }, 11000);
  });`);
  const running = checked(state, (current, dir) => runAgent(current, dir, process.execPath, [fake]), base);
  await new Promise(resolve => setTimeout(resolve, 10500));
  const persisted = JSON.parse(readFileSync(join(base, state.id, 'state.json')));
  assert.equal(persisted.status, 'running');
  assert.equal(persisted.activity.text, '日本語の確認中');
  await running;
  const first = join(base, state.id, 'attempt-0001');
  assert.match(readFileSync(join(first, 'codex.jsonl'), 'utf8'), /日本語の確認中/);
  const failed = join(target, 'failed');
  mkdirSync(failed);
  mkdirSync(join(failed, 'codex.jsonl'));
  await assert.rejects(runAgent(state, failed, process.execPath, [fake]), /EISDIR|EPERM|EACCES/);
});

test('Claude実出力fixture: 最終result・usage・modelUsage・session_id・質問再開・エラーを維持する', async t => {
  const { state, target, base } = fixture(t);
  setModel(state, 'review', 'claude-opus-5-5', 'medium', base);
  const stream = readFileSync(new URL('./fixtures/progress/claude.jsonl', import.meta.url), 'utf8');
  const entries = stream.trim().split('\n').map(line => JSON.parse(line));
  const final = entries.at(-1);
  final.structured_output = { ...result, outcome: 'question', question: '続行？' };
  const fake = join(target, 'claude.cjs');
  const write = () => writeFileSync(fake, `process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(entries.map(entry => JSON.stringify(entry)).join('\n'))}));`);
  write();
  await checked(state, (current, dir) => runAgent(current, dir, process.execPath, [fake]), base);
  assert.equal(state.status, 'waiting');
  assert.equal(state.session.sessionId, 'fixture-session');
  const first = join(base, state.id, 'attempt-0001');
  assert.deepEqual(JSON.parse(readFileSync(join(first, 'claude.json'))).usage, final.usage);
  assert.deepEqual(state.metrics[0].modelUsage, final.modelUsage);
  assert.equal(state.metrics[0].usage.output_tokens, final.usage.output_tokens);
  answer(state, '続行', base);
  final.is_error = true;
  final.subtype = 'error_during_execution';
  write();
  await checked(state, (current, dir) => runAgent(current, dir, process.execPath, [fake]), base);
  // 再開失敗時は従来どおり新規試行を一度行い、失敗履歴を保持する。
  assert.equal(state.status, 'failed');
  assert.equal(state.metrics[1].resumed, true);
  assert.equal(state.metrics[1].sessionId, 'fixture-session');
  assert.equal(state.metrics[2].resumed, false);
  assert.match(state.error, /error_during_execution/);
});

test('Codexの中断は取得済み元ログと最新活動を保持する', async t => {
  const { state, dir, target } = fixture(t);
  const fake = join(target, 'wait.cjs');
  writeFileSync(fake, `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'中断前の活動'}}));setInterval(()=>{},1000);`);
  const attempt = join(dir, 'attempt');
  mkdirSync(attempt);
  const running = runAgent(state, attempt, process.execPath, [fake]);
  const stop = setInterval(() => { if (state.activity) { clearInterval(stop); process.emit('SIGTERM'); } }, 20);
  try { await assert.rejects(running, /中断/); } finally { clearInterval(stop); }
  assert.match(readFileSync(join(attempt, 'codex.jsonl'), 'utf8'), /中断前の活動/);
  assert.equal(JSON.parse(readFileSync(join(attempt, 'invocation.json'))).activity.text, '中断前の活動');
});

test('途中のログ保存失敗はCLIを止め、元の保存エラーを技術的失敗として残す', async t => {
  const { state, target, base } = fixture(t);
  const fake = join(target, 'output.cjs');
  writeFileSync(fake, `process.stdin.resume(); console.log(JSON.stringify({type:'turn.started'}));setInterval(()=>{},1000);`);
  const original = fs.writeSync;
  fs.writeSync = () => { throw new Error('試験用ログ保存失敗'); };
  syncBuiltinESMExports();
  try {
    await checked(state, (current, dir) => runAgent(current, dir, process.execPath, [fake]), base);
  } finally { fs.writeSync = original; syncBuiltinESMExports(); }
  assert.equal(state.status, 'failed');
  assert.equal(state.error, '試験用ログ保存失敗');
  assert.equal(summary(state, base).history[0].report, null);
});
