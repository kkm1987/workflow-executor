import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { root, create, grant, advance, validateResult, summary, brief, prompt, load, save } from '../src/workflow.js';
import { runAgent, step, codexArgs, codexThread } from '../src/executor.js';
import { escalationDecision } from '../src/codex-app-server.js';
import { execpolicyRules, preflight } from '../src/preflight.js';
import { fakeCodex } from './fixtures/codex.js';

const method = 'item/commandExecution/requestApproval';
const command = 'Get-CimInstance Win32_Processor | Select-Object -ExpandProperty Name';
const params = (text = command) => ({ command: `pwsh -Command '${text}'`, commandActions: [{ type: 'unknown', command: text }], cwd: 'target', reason: 'CIM取得' });
const result = { returnTo: 'none', outcome: 'ok', summary: '確認済み', question: '', tasks: [],
  report: { scope: 'CIM', decisions: [], verification: '取得結果', remaining: 'なし' } };
const permission = { ...result, outcome: 'permission', question: 'CIM取得が必要。許可しない場合は検証できません。', permission: { network: false, paths: [], commands: [command] } };
const jsonLines = path => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
function fixture(t) {
  const dir = mkdtempSync(join(root, 'agent-docs', 'escalations-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'target'); mkdirSync(target);
  const base = join(dir, 'data');
  const state = create(target, 'CIMを確認する', base);
  state.stage = 'execute';
  state.models = { execute: { model: 'gpt-6-luna', effort: 'low' } };
  state.tasks = [{ title: 'CIM', acceptance: 'CPU名を取得', status: 'pending' }];
  return { dir, target, base, state };
}

test('昇格は単一コマンドの全文一致だけを一回許可し、旧状態と連結・改行を拒否する', () => {
  const state = { stage: 'execute', grants: { commands: [command] } };
  assert.deepEqual(escalationDecision(state, method, params()).result, { decision: 'accept' });
  assert.equal(escalationDecision(state, method, params(`  ${command.replaceAll(' ', '  ')}  `)).decision, 'accept');
  assert.equal(escalationDecision(state, method, params(command + ' -Extra')).decision, 'decline');
  for (const suffix of ['; Write-Output extra', ' && Write-Output extra', '\nWrite-Output extra', '\rWrite-Output extra']) {
    const text = command + suffix;
    assert.equal(escalationDecision({ ...state, grants: { commands: [command, text] } }, method, params(text)).decision, 'decline');
  }
  assert.equal(escalationDecision(state, method, params('Write-Output "a;b"')).decision, 'decline');
  assert.equal(escalationDecision(state, method, { ...params(), commandActions: [...params().commandActions, ...params().commandActions] }).decision, 'decline');
  for (const value of [{}, { commandActions: [] }, { commandActions: [{ command: '' }] }]) assert.equal(escalationDecision(state, method, value).decision, 'decline');
  for (const grants of [undefined, { paths: [], network: true }]) assert.equal(escalationDecision({ ...state, grants }, method, params()).decision, 'decline');
  for (const stage of ['plan', 'prereview', 'review', 'acceptance']) assert.equal(escalationDecision({ ...state, stage }, method, params()).decision, 'decline');
  assert.equal(escalationDecision({ ...state, answers: [{ inquiry: true }] }, method, params()).decision, 'decline');
});

test('ネットワークの文脈はnetwork許可で判断し、ファイル・追加権限・対話を許可しない', () => {
  for (const network of [false, true]) {
    const state = { stage: 'execute', grants: { network, commands: [command] } };
    assert.deepEqual(escalationDecision(state, method, { ...params('other'), networkApprovalContext: { host: 'example.com' } }).result, { decision: network ? 'accept' : 'decline' });
    assert.equal(escalationDecision({ ...state, stage: 'review' }, method, { ...params(), networkApprovalContext: {} }).decision, 'decline');
    assert.deepEqual(escalationDecision(state, 'item/fileChange/requestApproval', {}).result, { decision: 'decline' });
    assert.deepEqual(escalationDecision(state, 'item/permissions/requestApproval', {}).result, { permissions: {}, scope: 'turn' });
    assert.deepEqual(escalationDecision(state, 'mcpServer/elicitation/request', {}).result, { action: 'cancel' });
    assert.deepEqual(escalationDecision(state, 'item/tool/requestUserInput', {}).result, { answers: {} });
  }
});

test('拒否→権限要求→grant→同じセッションで許可を記録し、短い表示には履歴を含めない', async t => {
  const { target, base, state } = fixture(t);
  const fake = join(target, 'fake.cjs');
  fakeCodex(fake, `
    send({ id: 'approval', method: '${method}', params: ${JSON.stringify(params())} });
    setTimeout(() => finish(input.includes('許可しました') ? ${JSON.stringify(result)} : ${JSON.stringify(permission)}), 100);`);
  const runner = (current, dir) => runAgent(current, dir, process.execPath, [fake]);
  const check = async () => ({ ok: true });
  const limits = async () => ({ limits: null, failure: null });
  await step(state, runner, base, check, limits);
  assert.equal(state.status, 'waiting');
  assert.equal(state.session.sessionId, 'fake');
  assert.equal(state.evidence[0].escalations[0].decision, 'decline');
  const short = brief(summary(state, base));
  assert.deepEqual(short.permission.commands, [command]);
  assert.equal(short.escalations, undefined);
  assert.equal(short.history, undefined);
  assert.match(prompt(state), /同じ文字列で再実行/);
  const previous = structuredClone(state);
  for (const commands of [[''], ['   '], ['other'], [42]]) {
    await assert.rejects(grant(state, { commands }, base), /コマンド/);
    assert.deepEqual(state, previous);
  }
  await grant(state, { commands: [command, command] }, base);
  assert.deepEqual(load(state.id, base).grants.commands, [command]);
  assert.equal(state.session.sessionId, 'fake');
  await step(state, runner, base, check, limits);
  assert.equal(state.stage, 'review');
  assert.equal(state.evidence.at(-1).escalations[0].decision, 'accept');
  assert.match(state.evidence.at(-1).escalations[0].basis, /grants.commands/);
  assert.ok(state.evidence.at(-1).escalations[0].decidedAt);
  const dir = join(base, state.id);
  const rpc = jsonLines(join(dir, 'attempt-0002', 'codex-rpc.jsonl')).map(entry => JSON.parse(entry.line));
  const start = rpc.find(entry => entry.method === 'thread/resume');
  assert.equal(start.params.threadId, 'fake');
  assert.equal(start.params.approvalPolicy, 'on-request');
  assert.equal(start.params.approvalsReviewer, 'user');
  assert.deepEqual(rpc.find(entry => entry.id === 'approval' && entry.result).result, { decision: 'accept' });
  assert.equal(jsonLines(join(dir, 'events.jsonl')).filter(entry => entry.type === 'escalation_requested').length, 2);
  assert.equal(jsonLines(join(dir, 'events.jsonl')).filter(entry => entry.type === 'escalation_decided').length, 2);
  const detail = summary(state, base, true);
  assert.deepEqual(detail.grants.commands, [command]);
  assert.deepEqual(detail.escalations.map(entry => entry.decision), ['decline', 'accept']);
  assert.ok(summary(state, base).history.every(entry => !Object.hasOwn(entry, 'escalations')));
});

test('権限要求のcommandsは必須配列としてスキーマにあり、空コマンドを拒否する', t => {
  const { state } = fixture(t);
  assert.ok(JSON.parse(readFileSync(join(root, 'src/result.schema.json'), 'utf8')).properties.permission.required.includes('commands'));
  assert.equal(validateResult(permission, 'execute'), permission);
  for (const commands of [[], [' '], 'command', [1]]) assert.throws(() => validateResult({ ...permission, permission: { network: false, paths: [], commands } }, 'execute'), /権限要求/);
  advance(state, permission);
  assert.deepEqual(state.permission.commands, [command]);
  assert.ok(codexArgs(state).includes('approval_policy="on-request"'));
  state.answers = [{ inquiry: true }];
  assert.equal(codexThread(state).approvalPolicy, 'never');
});

test('CLIのgrant --commandは未要求を拒否し、要求された全文だけを保存してセッションを保持する', t => {
  const { dir, base, state } = fixture(t);
  for (const name of ['src', 'package.json']) cpSync(join(root, name), join(dir, name), { recursive: true });
  cpSync(join(root, 'test/fixtures/workflow.config.json'), join(dir, 'workflow.config.json'));
  advance(state, permission);
  state.session = { stage: 'execute', cli: 'codex', model: 'gpt-6-luna', effort: 'low', sessionId: 'original' };
  save(state, base);
  const cli = commands => spawnSync(process.execPath, [join(dir, 'src/cli.js'), 'grant', state.id, ...commands], { cwd: dir, encoding: 'utf8', windowsHide: true });
  for (const commands of [['--command', 'other'], ['--command', ''], ['--command']]) {
    assert.equal(cli(commands).status, 1);
    assert.equal(load(state.id, base).status, 'waiting');
    assert.equal(load(state.id, base).grants, undefined);
  }
  const granted = cli(['--command', command]);
  assert.equal(granted.status, 0, granted.stderr);
  const stored = load(state.id, base);
  assert.equal(stored.status, 'ready');
  assert.deepEqual(stored.grants.commands, [command]);
  assert.equal(stored.session.sessionId, 'original');
});

test('reviewに届いた全要求をプロトコルに合う形式で拒否・取り消し、試行の証拠に残す', async t => {
  const { base, target, state } = fixture(t);
  state.stage = 'review';
  state.grants = { commands: [command], network: true, paths: [] };
  const methods = [method, 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request', 'item/tool/requestUserInput'];
  const fake = join(target, 'fake.cjs');
  fakeCodex(fake, `
    ${methods.map((method, id) => `send({ id: 'request-${id}', method: ${JSON.stringify(method)}, params: ${JSON.stringify(params())} });`).join('\n')}
    setTimeout(() => finish(${JSON.stringify(result)}), 100);`);
  const attempt = join(base, state.id, 'attempt-0001'); mkdirSync(attempt);
  await runAgent(state, attempt, process.execPath, [fake]);
  const sent = jsonLines(join(attempt, 'codex-rpc.jsonl')).filter(entry => entry.direction === 'send').map(entry => JSON.parse(entry.line));
  const responses = methods.map((_, id) => sent.find(entry => entry.id === `request-${id}`).result);
  assert.deepEqual(responses, [{ decision: 'decline' }, { decision: 'decline' }, { permissions: {}, scope: 'turn' }, { action: 'cancel' }, { answers: {} }]);
  assert.equal(state.evidence[0].escalations.length, 5);
});

test('execpolicyのallowを利用者・対象別に記録し、規則があってもpreflightを継続する', async t => {
  const { dir, target, base, state } = fixture(t);
  const home = join(dir, 'codex-home');
  for (const path of [join(home, 'rules'), join(target, '.codex', 'rules')]) mkdirSync(path, { recursive: true });
  const userRules = join(home, 'rules', 'default.rules');
  const projectRules = join(target, '.codex', 'rules', 'project.rules');
  writeFileSync(userRules, '# decision="allow"\nprefix_rule(pattern=["a"], decision="allow")\nprefix_rule(pattern=["b"], decision = \'allow\')\n');
  writeFileSync(projectRules, 'prefix_rule(pattern=["c"], decision="allow")\n');
  assert.deepEqual(execpolicyRules(target, home), [{ path: userRules, count: 2 }, { path: projectRules, count: 1 }]);
  const report = await preflight(state, async () => '{"loggedIn":true}', () => 'codex', () => 'claude');
  assert.equal(report.ok, true);
  assert.ok(report.execpolicyRules.some(entry => entry.path === projectRules && entry.count === 1));
  await step(state, async () => permission, base, async () => report, async () => ({ limits: null, failure: null }));
  assert.deepEqual(summary(state, base, true).execpolicyRules, report.execpolicyRules);
  assert.equal(readFileSync(projectRules, 'utf8'), 'prefix_rule(pattern=["c"], decision="allow")\n');
});
