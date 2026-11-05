import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, create, advance, answer, approve, grant, load, prompt, summary, save, normalizeApproval, validateResult } from '../src/workflow.js';
import { runAgent, step, claudeArgs } from '../src/executor.js';
import { readConfig } from '../src/config.js';
import { codexSession, escalationDecision } from '../src/codex-app-server.js';
import { resolveScript, safeGitRead, commandDecision, reviewCommand, reviewProblem, codexReview } from '../src/escalation.js';
import { decide, gateRequired, gateSettings, probeSettings } from '../src/claude-gate.js';
import { preflight } from '../src/preflight.js';
import { sandboxProfileArgs, resolveGitBash } from '../src/commands.js';
import { fakeCodex } from './fixtures/codex.js';

const method = 'item/commandExecution/requestApproval';
const params = (command, cwd) => ({ command, commandActions: [{ type: 'unknown', command }], cwd, reason: '必要' });
const item = { id: 'A1', tasks: '1.1', action: 'storeへ公開', limits: '1回', stopWhen: '失敗', gate: 'plan' };
const plan = { status: 'approved', items: [item, { ...item, id: 'A2', gate: 'each' }], pending: [], conditions: '条件', nextId: 3 };
const ok = { returnTo: 'none', outcome: 'ok', summary: '完了', question: '', tasks: [], report: { scope: '対象', decisions: [], verification: '確認', remaining: 'なし' } };
const allow = { decision: 'allow', approvalId: 'A1', riskLevel: 'low', rationale: '計画の範囲内' };

function fixture(t) {
  const dir = mkdtempSync(join(root, 'agent-docs', 'layers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const target = join(dir, 'target'); mkdirSync(target);
  writeFileSync(join(target, 'upload.ps1'), 'Write-Output upload\n');
  const base = join(dir, 'data');
  const state = create(target, '公開する', base);
  Object.assign(state, { stage: 'execute', models: { execute: { model: 'gpt-6-luna', effort: 'low' } },
    tasks: [{ title: '公開', acceptance: '公開済み', status: 'pending' }] });
  return { dir, target, base, state };
}

test('スクリプトは3つの形から対象内の既存ファイルだけを解決する', t => {
  const { dir, target } = fixture(t);
  mkdirSync(join(target, 'a b'));
  writeFileSync(join(target, 'a b', 'x.py'), 'print(1)');
  writeFileSync(join(dir, 'outside.ps1'), 'x');
  for (const command of ['& ./upload.ps1 -Force', '& "./upload.ps1"', 'pwsh -NoProfile -File ./upload.ps1 a', 'powershell.exe -file upload.ps1', 'node upload.ps1 x'])
    assert.match(resolveScript(command, target, target).path, /upload\.ps1$/, command);
  assert.match(resolveScript('python "a b/x.py"', target, target).path, /x\.py$/);
  assert.equal(resolveScript('& ./upload.ps1', target, target).hash.length, 64);
  for (const command of ['& ./none.ps1', '& ../outside.ps1', 'node -e 1', 'git status', '& (Join-Path a b)']) assert.equal(resolveScript(command, target, target), null, command);
});

test('安全なgit読み取りは許可された形だけを通す', () => {
  for (const command of ['git fetch --quiet origin', 'git ls-remote origin refs/heads/main', 'git diff --stat', 'git status --short', 'git log --oneline -5', 'git show HEAD~1 --stat', 'git rev-parse HEAD'])
    assert.equal(safeGitRead(command), true, command);
  for (const command of ['git diff --output=x', 'git diff --output x', 'git -c core.pager=x log', 'git fetch ext::sh', 'git fetch origin main:main', 'git fetch --upload-pack=x origin',
    'git ls-remote https://example.com/x', 'git log --ext-diff', 'git status | tee x', 'git push origin main', 'git diff "a"', 'git log > x', 'git commit -m x'])
    assert.equal(safeGitRead(command), false, command);
  const state = { stage: 'execute', answers: [] };
  assert.equal(commandDecision(state, 'git fetch origin').decision, 'accept');
  assert.equal(commandDecision({ ...state, grants: { paths: ['C:/repo/.git'] } }, 'git fetch origin').decision, 'decline');
});

test('全文一致の許可はスクリプトの内容に束縛し、旧許可は有効のまま、pushは所有者へ回す', async t => {
  const { target, base, state } = fixture(t);
  const command = '& ./upload.ps1';
  Object.assign(state, { status: 'waiting', permission: { network: false, paths: [], commands: [command] } });
  await grant(state, { commands: [command] }, base);
  state.status = 'ready'; state.stage = 'execute';
  const hash = Object.values(state.grants.commandHashes)[0];
  assert.equal(hash.length, 64);
  assert.equal(commandDecision(state, command, target).decision, 'accept');
  writeFileSync(join(target, 'upload.ps1'), 'Write-Output changed\n');
  const changed = commandDecision(state, command, target);
  assert.equal(changed.decision, 'decline');
  assert.match(changed.basis, /変更/);
  assert.equal(commandDecision({ ...state, grants: { commands: [command] } }, command, target).decision, 'accept');
  writeFileSync(join(target, 'push.ps1'), 'git push origin main\n');
  state.approval = plan;
  for (const text of ['& ./push.ps1', 'git push origin main', 'git -C x push']) {
    const choice = commandDecision(state, text, target);
    assert.equal(choice.layer, 3, text);
    assert.equal(choice.reviewRequest, undefined, text);
  }
  assert.equal(commandDecision({ ...state, grants: { commands: ['git push origin main'] } }, 'git push origin main', target).decision, 'accept');
});

test('権限要求の表示は実行するスクリプトのハッシュと先頭部分を示す', t => {
  const { base, state } = fixture(t);
  Object.assign(state, { status: 'waiting', permission: { network: false, paths: [], commands: ['& ./upload.ps1', 'other'] } });
  const [script, ...rest] = summary(state, base).permission.scripts;
  assert.equal(rest.length, 0);
  assert.equal(script.sha256.length, 64);
  assert.match(script.head, /Write-Output upload/);
});

test('審査の許可は実行器が検証し、失敗は所有者へ戻す', async t => {
  const { target, state } = fixture(t);
  state.approval = plan;
  const choice = () => escalationDecision(state, method, params('& ./upload.ps1', target));
  assert.ok(choice().reviewRequest);
  const accepted = await reviewCommand(state, choice(), async input => { assert.match(input, /主張であり根拠ではない/); assert.match(input, /Write-Output upload/); return allow; }, '必要');
  assert.deepEqual([accepted.decision, accepted.layer, accepted.review.approvalId], ['accept', 2, 'A1']);
  for (const output of [{ ...allow, decision: 'ask' }, { ...allow, approvalId: 'A9' }, { ...allow, approvalId: 'A2' }, { ...allow, riskLevel: 'critical' }, null]) {
    const final = await reviewCommand(state, choice(), async () => output);
    assert.deepEqual([final.decision, final.layer], ['decline', 3]);
  }
  const failed = await reviewCommand(state, choice(), async () => { throw new Error('枠の不足'); });
  assert.equal(failed.decision, 'decline');
  assert.match(failed.basis, /枠の不足/);
  const moved = await reviewCommand(state, choice(), async () => { writeFileSync(join(target, 'upload.ps1'), 'changed'); return allow; });
  assert.match(moved.basis, /前後/);
  assert.equal(reviewProblem(state, allow, null, null), null);
  assert.equal((await reviewCommand(state, escalationDecision(state, method, params('& ./upload.ps1', target)), null)).decision, 'decline');
  assert.equal(commandDecision({ ...state, approval: { ...plan, items: [plan.items[1]] } }, 'other').reviewRequest, undefined);
  assert.equal(commandDecision({ ...state, approval: undefined }, 'other').reviewRequest, undefined);
});

test('実行中の審査は別スレッドで行い、許可を再利用しない', async t => {
  const { target, base, state } = fixture(t);
  state.approval = plan;
  const fake = join(target, 'fake.cjs');
  fakeCodex(fake, `
    if (input.startsWith('計画審査')) { fs.appendFileSync(${JSON.stringify(join(target, 'reviews.log'))}, JSON.stringify(message.params) + '\\n'); finish(${JSON.stringify(allow)}); }
    else {
      send({ id: 'one', method: '${method}', params: ${JSON.stringify(params('& ./upload.ps1', target))} });
      send({ id: 'two', method: '${method}', params: ${JSON.stringify(params('& ./upload.ps1', target))} });
      setTimeout(() => finish(${JSON.stringify(ok)}), 3000);
    }`);
  await step(state, (current, dir) => runAgent(current, dir, process.execPath, [fake]), base, async () => ({ ok: true }), async () => ({ limits: null, failure: null }));
  assert.equal(state.stage, 'review');
  const entries = state.evidence.at(-1).escalations;
  assert.deepEqual(entries.map(entry => [entry.decision, entry.layer, entry.review.approvalId, entry.cli]), [['accept', 2, 'A1', 'codex'], ['accept', 2, 'A1', 'codex']]);
  const reviews = readFileSync(join(target, 'reviews.log'), 'utf8').trim().split('\n');
  assert.equal(reviews.length, 2);
  const detail = summary(state, base, true);
  assert.deepEqual(detail.escalationCounts, { deterministic: 0, planReview: 2, owner: 0 });
  assert.deepEqual(detail.approvalItems.map(entry => [entry.id, entry.gate]), [['A1', 'plan'], ['A2', 'each']]);
  const rpc = readFileSync(join(base, state.id, `attempt-${String(state.attempts).padStart(4, '0')}`, 'review-1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(JSON.parse(line).line));
  const start = rpc.find(entry => entry.method === 'thread/start');
  assert.deepEqual([start.params.sandbox, start.params.approvalPolicy, start.params.ephemeral], ['read-only', 'never', true]);
});

test('審査のタイムアウトと不正な出力は失敗として返す', async t => {
  const { target } = fixture(t);
  const hang = join(target, 'hang.cjs'); fakeCodex(hang, 'setInterval(() => {}, 1000);');
  const bad = join(target, 'bad.cjs'); fakeCodex(bad, "notify('item/completed', { item: { type: 'agentMessage', id: 'f', text: '不正' } }); finish();");
  const options = { command: process.execPath, cwd: root, setting: { model: 'gpt-6-luna', effort: 'medium' }, input: '計画審査' };
  await assert.rejects(codexReview({ ...options, prefix: [hang], timeout: 300 }), /タイムアウト/);
  await assert.rejects(codexReview({ ...options, prefix: [bad] }), /出力が不正/);
  const aborted = new AbortController();
  const running = codexReview({ ...options, prefix: [hang], signal: aborted.signal });
  aborted.abort();
  await assert.rejects(running, /中断/);
});

test('応答の保留中も通知を処理し、中断で保留中の要求を拒否する', async () => {
  const sent = []; const events = [];
  let release;
  const session = codexSession({ stdin: { write: line => sent.push(JSON.parse(line)) } }, { thread: {}, turn: {}, emit: entry => events.push(entry), raw() {}, output() {}, complete() {}, fail: error => { throw error; },
    approval: () => new Promise(resolve => { release = resolve; }) });
  const feed = value => session.receive(Buffer.from(JSON.stringify(value) + '\n'));
  feed({ id: 'a', method, params: {} });
  feed({ method: 'item/completed', params: { item: { id: 'm', type: 'agentMessage', text: '進行中' } } });
  assert.equal(events.length, 1);
  assert.equal(sent.length, 0);
  session.interrupt();
  assert.deepEqual(sent.find(entry => entry.id === 'a').result, { decision: 'decline' });
  release({ decision: 'accept' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.filter(entry => entry.id === 'a').length, 1);
  feed({ id: 'b', method, params: {} });
  release({ decision: 'accept' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.find(entry => entry.id === 'b').result, { decision: 'accept' });
});

test('計画審査の設定は既定・無効・Claude拒否を検証する', t => {
  const { dir } = fixture(t);
  const valid = JSON.parse(readFileSync(join(root, 'workflow.config.json'), 'utf8'));
  const read = value => {
    const path = join(dir, 'config.json');
    const config = { ...valid, escalationReview: value };
    if (value === undefined) delete config.escalationReview;
    writeFileSync(path, JSON.stringify(config));
    return readConfig(path).escalationReview;
  };
  assert.equal(read(undefined).model, 'gpt-6-luna');
  assert.equal(read(undefined).effort, 'medium');
  assert.equal(read(null), null);
  assert.equal(read({ model: 'gpt-6.1-sol', effort: 'low' }).model, 'gpt-6.1-sol');
  assert.throws(() => read({ model: 'claude-sonnet-5-5' }), /Codexモデル/);
  assert.throws(() => read({ effort: 'low' }), /Codexモデル/);
});

const pre = (approvals = [], retainedApprovals = []) => ({ ...ok, tasks: [{ title: 'T', acceptance: 'A' }], approvals, retainedApprovals, change: 'sample-change',
  decisions: { selection: 's', applicability: 'a', updates: 'u' } });

test('回答を根拠とする変更は審査で置き換え、範囲外は承認待ち、差し戻しで承認済みを保持する', async t => {
  const { base, state } = fixture(t);
  Object.assign(state, { kind: 'change', change: 'sample-change', stage: 'prereview', approval: structuredClone(plan), answers: [{ answer: '上限は3回' }] });
  save(state, base);
  const changed = { ...item, limits: '3回', replaces: 'A1', basisAnswer: 1 };
  delete changed.id;
  const noLimits = async () => ({ limits: null, failure: null });
  const passed = async () => ({ ok: true });
  const seen = [];
  const reviewer = output => async input => { seen.push(input); return output; };
  await step(state, async () => pre([changed], ['A2']), base, passed, noLimits, async () => {}, reviewer(allow));
  assert.equal(state.status, 'ready');
  assert.match(seen[0], /上限は3回/);
  assert.deepEqual(state.approval.items.map(entry => [entry.id, entry.limits]), [['A2', '1回'], ['A1', '3回']]);
  const events = readFileSync(join(base, state.id, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const replaced = events.find(entry => entry.type === 'approval_replaced').detail;
  assert.deepEqual([replaced.before.limits, replaced.after.limits, replaced.answer, replaced.review.rationale], ['1回', '3回', '上限は3回', '計画の範囲内']);
  state.stage = 'prereview';
  await step(state, async () => pre([{ ...changed, limits: '9回' }], ['A2']), base, passed, noLimits, async () => {}, reviewer({ ...allow, decision: 'ask' }));
  assert.equal(state.status, 'waiting');
  assert.deepEqual(state.approval.pending.map(entry => entry.limits), ['9回']);
  assert.match(state.question, /1件/);
  answer(state, '9回は不可', base);
  assert.equal(state.approval.status, 'approved');
  assert.deepEqual(state.approval.pending, []);
  assert.deepEqual(state.approval.items.map(entry => [entry.id, entry.limits]), [['A2', '1回'], ['A1', '3回']]);
  assert.equal(state.approval.conditions, '条件');
  state.stage = 'prereview'; state.status = 'ready';
  await step(state, async () => pre([{ ...changed, gate: 'each' }, { ...changed, replaces: 'A2', basisAnswer: 0, action: '追加' }]), base, passed, noLimits, async () => {}, () => assert.fail('審査しない'));
  assert.equal(state.status, 'waiting');
  assert.equal(state.approval.pending.length, 2);
});

test('未知のIDの継続と二重指定を拒否し、新規項目だけを承認待ちにして旧状態を補完する', t => {
  const { state } = fixture(t);
  Object.assign(state, { kind: 'change', stage: 'prereview', approval: structuredClone(plan) });
  for (const value of [pre([], ['A9']), pre([{ ...item, replaces: 'A9' }]), pre([{ ...item, replaces: 'A1' }], ['A1']), { ...pre(), retainedApprovals: undefined }]) {
    const before = structuredClone(state);
    assert.throws(() => advance(state, value), /ID/);
    assert.deepEqual(state, before);
  }
  const { id, ...added } = item;
  advance(state, pre([added], ['A1', 'A2']));
  assert.equal(state.status, 'waiting');
  assert.deepEqual(state.approval.pending.map(entry => entry.id), ['A3']);
  assert.equal(state.approval.items.length, 2);
  const old = { approval: { status: 'approved', items: [{ tasks: 'a', action: 'b', limits: 'c', stopWhen: 'd' }], conditions: '' } };
  assert.deepEqual(normalizeApproval(old).approval.items.map(entry => [entry.id, entry.gate]), [['A1', 'each']]);
  assert.equal(commandDecision({ stage: 'execute', answers: [], ...old }, 'other').reviewRequest, undefined);
  const waiting = normalizeApproval({ approval: { status: 'pending', items: [{ tasks: 'a' }] } }).approval;
  assert.deepEqual([waiting.items.length, waiting.pending.length], [0, 1]);
});

test('Claudeのフックは通常のBashをsandboxで包み、Edit・Writeを範囲内に限る', async t => {
  const { dir, target, base, state } = fixture(t);
  const attempt = join(base, state.id, 'attempt'); mkdirSync(attempt);
  const extra = join(dir, 'extra'); mkdirSync(extra);
  const context = { state: { ...state, answers: [], approval: plan }, attempt: 1, scope: { stage: 'execute', task: 0 }, writable: [target, extra], dir: attempt, review: null, codex: { command: 'codex' }, sandbox: "'codex' sandbox -- 'bash' -c" };
  const wrapped = await decide({ tool_name: 'Bash', tool_input: { command: "echo 'a'", description: 'd' } }, context);
  assert.equal(wrapped.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(wrapped.hookSpecificOutput.updatedInput, { command: "'codex' sandbox -- 'bash' -c 'echo '\\''a'\\'''", description: 'd' });
  const write = file_path => decide({ tool_name: 'Write', tool_input: { file_path }, cwd: target }, context);
  for (const path of [join(target, 'new', 'a.txt'), 'relative.txt', join(extra, 'x')]) assert.equal((await write(path)).hookSpecificOutput.permissionDecision, 'allow', path);
  for (const path of [join(dir, 'outside'), '../outside', join(target, '.git', 'config')]) assert.equal((await write(path)).hookSpecificOutput.permissionDecision, 'deny', path);
  const push = await decide({ tool_name: 'Bash', tool_input: { command: '# workflow-escalate: 公開\ngit push origin main' }, cwd: target }, context);
  assert.equal(push.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(push.hookSpecificOutput.permissionDecisionReason, /outcome=permission/);
  const read = await decide({ tool_name: 'Bash', tool_input: { command: '# workflow-escalate: 取得\ngit fetch origin', timeout: 5 }, cwd: target }, context);
  assert.deepEqual(read.hookSpecificOutput.updatedInput, { command: 'git fetch origin', timeout: 5 });
  assert.equal((await decide({ tool_name: 'Bash', tool_input: { command: '# workflow-escalate: x\ngit status\ngit push' } }, context)).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal((await decide({ tool_name: 'NotebookEdit', tool_input: {} }, context)).hookSpecificOutput.permissionDecision, 'deny');
  const lines = readFileSync(join(attempt, 'gate.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const recorded = lines.find(entry => entry.command === 'git push origin main');
  assert.deepEqual([recorded.cli, recorded.decision, recorded.layer, recorded.reason, recorded.commandActions[0].command], ['claude', 'decline', 3, '公開', 'git push origin main']);
  assert.ok(lines.some(entry => entry.kind === 'claude/Write'));
  // フックのプロセスは壊れた入力で実行を許可しない。
  const script = join(root, 'src', 'claude-gate.js');
  const broken = spawnSync(process.execPath, [script, join(dir, 'none.json')], { input: '{}', encoding: 'utf8', windowsHide: true });
  assert.equal(JSON.parse(broken.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(spawnSync(process.execPath, [script, '--probe'], { encoding: 'utf8', windowsHide: true }).stdout, /workflow-gate-probe/);
});

test('フックはClaudeのexecuteだけに付き、判断の記録はCodexと同じ形式で取り込む', async t => {
  const { target, base, state } = fixture(t);
  state.models.execute = { model: 'claude-sonnet-5-5', effort: 'medium' };
  assert.equal(gateRequired(state), true);
  assert.ok(claudeArgs(state, 'id', 'dir').includes('--settings'));
  assert.match(gateSettings('c'), /PreToolUse/);
  for (const change of [{ stage: 'review' }, { answers: [{ inquiry: true }] }]) assert.ok(!claudeArgs({ ...state, ...change }, 'id', 'dir').includes('--settings'));
  assert.ok(!claudeArgs({ ...state, models: { execute: { model: 'gpt-6-luna' } } }, 'id', 'dir').includes('--settings'));
  assert.match(prompt(state), /workflow-escalate/);
  assert.match(prompt(state), /絶対パス/);
  const fake = join(target, 'fake-claude.cjs');
  writeFileSync(fake, `const fs = require('node:fs'); const path = require('node:path');
    const context = process.argv[process.argv.indexOf('--settings') + 1];
    const file = JSON.parse(context).hooks.PreToolUse[0].hooks[0].command.split("' '").at(-1).replace(/'$/, '');
    fs.appendFileSync(path.join(path.dirname(file), 'gate.jsonl'), JSON.stringify({ time: 't', attempt: 1, stage: 'execute', task: 0, cli: 'claude', kind: 'claude/Bash', command: 'git push', commandActions: [{ type: 'unknown', command: 'git push' }], reason: 'r', cwd: 'c', decidedAt: 't', decision: 'decline', basis: 'b', layer: 3 }) + '\\n');
    console.log(JSON.stringify({ type: 'result', session_id: 's', structured_output: ${JSON.stringify(ok)} }));`);
  state.executables = { codex: 'codex.exe' };
  await step(state, (current, dir) => runAgent(current, dir, process.execPath, [fake]), base, async () => ({ ok: true }), async () => ({ limits: null, failure: null }));
  assert.equal(state.status, 'ready', state.error);
  assert.equal(state.evidence.at(-1).escalations[0].layer, 3);
  const types = readFileSync(join(base, state.id, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).type);
  assert.ok(types.includes('escalation_requested') && types.includes('escalation_decided'));
  assert.deepEqual(summary(state, base, true).escalationCounts, { deterministic: 0, planReview: 0, owner: 1 });
});

test('フックの動作を確認できなければ実行前確認で失敗する', async t => {
  const { state } = fixture(t);
  state.models.execute = { model: 'claude-sonnet-5-5', effort: 'medium' };
  state.attemptAssignment = { cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' };
  const report = output => preflight(state, async (_, args) => args.includes('--settings') ? output : '{"loggedIn":true}', () => 'codex', () => 'claude');
  assert.equal((await report('{"result":"workflow-gate-probe"}')).ok, true);
  const failed = await report('{}');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /フック/);
  assert.match(probeSettings(), /UserPromptSubmit/);
});

test('sandboxの設定はWindowsではプロファイルで書き込み先とネットワークを渡し、WSLのbashを選ばない', () => {
  const windows = sandboxProfileArgs('T', ['E'], true, 'win32');
  assert.ok(windows.includes('workflow-grant'));
  assert.ok(windows.includes('permissions.workflow-grant.workspace_roots={"T"=true,"E"=true}'));
  assert.ok(windows.includes('permissions.workflow-grant.network.enabled=true'));
  assert.ok(!sandboxProfileArgs('T', [], false, 'win32').some(arg => arg.includes('network.enabled')));
  const linux = sandboxProfileArgs('T', ['E'], true, 'linux');
  assert.ok(linux.includes(':workspace') && linux.includes('sandbox_workspace_write.network_access=true'));
  assert.equal(resolveGitBash({ CLAUDE_CODE_GIT_BASH_PATH: 'x' }, 'win32'), 'x');
  assert.equal(resolveGitBash({}, 'linux'), 'bash');
  assert.throws(() => resolveGitBash({ PATH: 'C:\\Windows\\System32' }, 'win32'), /Git Bash/);
});

test('状態の詳細は読み込み後も承認項目のIDを返し、スキーマは差分の項目を持つ', t => {
  const { base, state } = fixture(t);
  state.approval = { status: 'approved', items: [{ tasks: 'a', action: 'b', limits: 'c', stopWhen: 'd' }], conditions: '' };
  save(state, base);
  assert.deepEqual(summary(load(state.id, base), base, true).approvalItems.map(entry => entry.id), ['A1']);
  const schema = JSON.parse(readFileSync(join(root, 'src/prereview.schema.json'), 'utf8'));
  assert.ok(schema.required.includes('retainedApprovals'));
  assert.ok(['gate', 'replaces', 'basisAnswer'].every(key => schema.properties.approvals.items.required.includes(key)));
  assert.ok(!existsSync(join(state.target, 'gate.jsonl')));
  assert.ok(validateResult(pre(), 'prereview'));
});
