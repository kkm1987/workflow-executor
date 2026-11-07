import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { root, create } from '../src/workflow.js';
import { runAgent } from '../src/executor.js';
import { usage } from '../src/metrics.js';
import { execItem, codexSession } from '../src/codex-app-server.js';
import { fakeCodex } from './fixtures/codex.js';

function fixture(t, body, onResume) {
  const dir = mkdtempSync(join(root, 'agent-docs', 'rpc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'target'); mkdirSync(target);
  const state = create(target, '試験', join(dir, 'data'));
  state.stage = 'review';
  const fake = join(target, 'fake.cjs'); fakeCodex(fake, body, onResume);
  const attempt = join(dir, 'attempt'); mkdirSync(attempt);
  return { state, attempt, run: () => runAgent(state, attempt, process.execPath, [fake]) };
}
const lines = (attempt, file) => readFileSync(join(attempt, file), 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('RPCの初期化・再開・承認方針・スキーマ・effortと最終応答を維持し、復元分のusageを除く', async t => {
  const { state, attempt, run } = fixture(t, `
    notify('unknown', { value: '生ログのみ' });
    notify('item/completed', { item: { type: 'agentMessage', id: 'comment', text: '日本語の報告' } });
    notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 17, cachedInputTokens: 4, outputTokens: 6 } } });
    finish({ summary: '最後' });`, `
    notify('thread/tokenUsage/updated', { threadId: 'old', tokenUsage: { total: { inputTokens: 6, cachedInputTokens: 1, outputTokens: 2 } } });
    notify('thread/tokenUsage/updated', { threadId: 'old', tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 5 } } });
    notify('thread/tokenUsage/updated', { threadId: 'child', tokenUsage: { total: { inputTokens: 99, cachedInputTokens: 99, outputTokens: 99 } } });`);
  state.attemptAssignment = { cli: 'codex', model: 'gpt-6-luna', effort: 'high' };
  state.session = { ...state.attemptAssignment, stage: 'review', sessionId: 'old' };
  state.answers = [{ answer: '回答' }];
  assert.deepEqual(await run(), { summary: '最後' });
  const rpc = lines(attempt, 'codex-rpc.jsonl').map(entry => JSON.parse(entry.line));
  const start = rpc.find(entry => entry.method === 'thread/resume');
  assert.equal(start.params.threadId, 'old');
  assert.equal(start.params.approvalPolicy, 'never');
  assert.equal(start.params.approvalsReviewer, 'user');
  assert.equal(start.params.sandbox, 'read-only');
  assert.ok(!start.params.ephemeral);
  const turn = rpc.find(entry => entry.method === 'turn/start');
  assert.equal(turn.params.effort, 'high');
  assert.ok(turn.params.outputSchema.required.includes('outcome'));
  assert.equal(turn.params.input[0].text, '回答');
  assert.deepEqual(usage(attempt), { input_tokens: 7, cached_input_tokens: 1, output_tokens: 1 });
  assert.deepEqual(lines(attempt, 'codex.jsonl').at(-1).thread_usage, { input_tokens: 17, cached_input_tokens: 4, output_tokens: 6 });
  assert.equal(lines(attempt, 'codex.jsonl')[0].thread_id, 'old');
  assert.doesNotMatch(readFileSync(join(attempt, 'codex.jsonl'), 'utf8'), /生ログのみ/);
});

for (const [name, baseline, expected] of [
  ['負の差分', { inputTokens: 20, cachedInputTokens: 4, outputTokens: 5 }, { input_tokens: null, cached_input_tokens: 0, output_tokens: 1 }],
  ['復元通知なし', null, { input_tokens: null, cached_input_tokens: null, output_tokens: null }],
]) test(`再開時の${name}を未取得とする`, async t => {
  const { state, attempt, run } = fixture(t, `
    notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 17, cachedInputTokens: 4, outputTokens: 6 } } });
    finish({});`, baseline ? `
    notify('thread/tokenUsage/updated', { threadId: 'old', tokenUsage: { total: ${JSON.stringify(baseline)} } });` : '');
  state.attemptAssignment = { cli: 'codex', model: 'gpt-6-luna', effort: 'high' };
  state.session = { ...state.attemptAssignment, stage: 'review', sessionId: 'old' };
  state.answers = [{ answer: '回答' }];
  await run();
  const event = lines(attempt, 'codex.jsonl').at(-1);
  assert.deepEqual(event.usage, expected);
  assert.deepEqual(usage(attempt), expected);
  assert.deepEqual(event.thread_usage, { input_tokens: 17, cached_input_tokens: 4, output_tokens: 6 });
});

test('既知itemをexec形式へ変換し未知itemを除外する', () => {
  assert.deepEqual(execItem({ id: '1', type: 'commandExecution', command: 'echo', aggregatedOutput: '出力', exitCode: 0, status: 'inProgress' }),
    { id: '1', type: 'command_execution', command: 'echo', aggregated_output: '出力', exit_code: 0, status: 'in_progress' });
  assert.equal(execItem({ type: 'mcpToolCall', server: 's', tool: 't', status: 'completed' }).type, 'mcp_tool_call');
  assert.deepEqual(execItem({ id: '2', type: 'fileChange', status: 'completed', changes: [{ path: 'a', kind: { type: 'add' } }] }),
    { id: '2', type: 'file_change', status: 'completed', changes: [{ path: 'a', kind: 'add' }] });
  assert.equal(execItem({ type: 'webSearch', query: 'q' }).query, 'q');
  assert.equal(execItem({ type: 'unknown' }), null);
});

test('承認要求はdeclineし、未知のサーバー要求は未対応エラーで返す', async t => {
  const { attempt, run } = fixture(t, `
    send({ id: 'approval', method: 'item/commandExecution/requestApproval', params: {} });
    send({ id: 'file', method: 'item/fileChange/requestApproval', params: {} });
    send({ id: 'unknown', method: 'unknown/request', params: {} });
    setTimeout(() => finish({}), 100);`);
  await run();
  const sent = lines(attempt, 'codex-rpc.jsonl').filter(entry => entry.direction === 'send').map(entry => JSON.parse(entry.line));
  assert.deepEqual(sent.find(entry => entry.id === 'approval').result, { decision: 'decline' });
  assert.deepEqual(sent.find(entry => entry.id === 'file').result, { decision: 'decline' });
  assert.equal(sent.find(entry => entry.id === 'unknown').error.code, -32601);
});

for (const status of ['failed', 'interrupted']) test(`turnの${status}は失敗になりエラー種別を保持する`, async t => {
  const { attempt, run } = fixture(t, `notify('turn/completed', { turn: { id: 'turn', status: '${status}', error: { message: '失敗', codexErrorInfo: 'serverError' } } });`);
  await assert.rejects(run(), /失敗/);
  assert.equal(lines(attempt, 'codex.jsonl').at(-1).type, 'turn.failed');
  assert.equal(lines(attempt, 'codex.jsonl').at(-1).error.codexErrorInfo, 'serverError');
});

test('最終agentMessageなしの正常終了は構造化出力の欠落で失敗する', async t => {
  const { run } = fixture(t, 'finish();');
  await assert.rejects(run(), /構造化出力がありません/);
});

for (const status of ['completed', 'failed']) test(`サブエージェントのturn ${status}では親turnを終了せず親の最終応答を返す`, async t => {
  const { attempt, run } = fixture(t, `
    notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
    notify('item/completed', { threadId: 'child', item: { type: 'agentMessage', id: 'child-message', text: '子の報告' } });
    notify('thread/tokenUsage/updated', { threadId: 'child', tokenUsage: { total: { inputTokens: 99, cachedInputTokens: 99, outputTokens: 99 } } });
    notify('error', { threadId: 'child', message: '子の失敗', willRetry: false });
    notify('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: '${status}' } });
    setTimeout(() => {
      notify('thread/tokenUsage/updated', { threadId: 'fake', tokenUsage: { total: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2 } } });
      finish({ summary: '親' });
    }, 50);`);
  assert.deepEqual(await run(), { summary: '親' });
  assert.deepEqual(usage(attempt), { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 });
  assert.deepEqual(lines(attempt, 'codex.jsonl').at(-1).thread_usage, { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 });
  assert.equal(lines(attempt, 'codex.jsonl').filter(entry => entry.type === 'turn.started').length, 1);
});

test('サブエージェントのturn開始後も中断先は親turnのままである', () => {
  const sent = [];
  const session = codexSession({ stdin: { write: line => sent.push(JSON.parse(line)) } }, { thread: {}, turn: {}, emit() {}, raw() {}, output() {}, complete() {}, fail: error => { throw error; } });
  session.receive(Buffer.from([
    { id: 2, result: { thread: { id: 'parent' } } },
    { method: 'turn/started', params: { threadId: 'parent', turn: { id: 'parent-turn' } } },
    { method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn' } } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n'));
  session.interrupt();
  assert.deepEqual(sent.at(-1).params, { threadId: 'parent', turnId: 'parent-turn' });
});

test('生ログだけの利用枠エラーもlimitedになる', async t => {
  const { run } = fixture(t, `notify('unknown', { detail: 'usage_limit_reached' }); process.exit(8);`);
  await assert.rejects(run(), error => error.limited === true);
});

test('最終応答の後でもturn完了前の終了と非ゼロ終了は失敗する', async t => {
  for (const [body, code] of [
    [`notify('item/completed', { item: { id: 'final', type: 'agentMessage', text: '{}' } }); process.exit(0);`, 0],
    ['finish({}); process.exit(5);', 5],
  ]) {
    const { run } = fixture(t, body);
    await assert.rejects(run(), new RegExp('終了コード' + code));
  }
});

test('一時的なerror通知は回復を許容し、再試行されないerrorは失敗する', async t => {
  for (const willRetry of [true, false]) {
    const { run } = fixture(t, `notify('error', { message: '通信エラー', willRetry: ${willRetry} }); finish({});`);
    if (willRetry) assert.deepEqual(await run(), {});
    else await assert.rejects(run(), /通信エラー/);
  }
});

test('UTF-8を1バイトずつ受信してもイベントと生ログを保持する', () => {
  const events = []; const raw = []; const output = [];
  const session = codexSession({ stdin: { write() {} } }, { thread: {}, turn: {}, emit: entry => events.push(entry), raw: (...args) => raw.push(args), output: text => output.push(text), complete() {}, fail: error => { throw error; } });
  const stream = Buffer.from([
    { id: 2, result: { thread: { id: 't' } } },
    { method: 'item/completed', params: { item: { id: 'm', type: 'agentMessage', text: '日本語' } } },
    { method: 'turn/completed', params: { turn: { status: 'completed' } } },
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  for (const byte of stream) session.receive(Buffer.from([byte]));
  assert.deepEqual(output, ['日本語']);
  assert.equal(events[1].item.text, '日本語');
  assert.equal(raw.filter(([direction]) => direction === 'receive').map(([, line]) => line).join(''), stream.toString());
});
