import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { root, create, load, setModel, answer, retry, advance, summary, save } from '../src/workflow.js';
import { readConfig, validateModel, assignment } from '../src/config.js';
import { startChange, archive, validatePrereview } from '../src/changes.js';
import { resolveCodex } from '../src/commands.js';
import { codexArgs, claudeArgs, runAgent, step, run, resumeSession, inputFor } from '../src/executor.js';
import { preflight } from '../src/preflight.js';
import { parseCodexLimits, parseClaudeLimits, insufficient, limitError } from '../src/limits.js';
import { usage, performanceReport } from '../src/metrics.js';

const report = { scope: '入力検証の実装と受け入れ条件', decisions: [], verification: '試験で確認済み', remaining: 'なし' };
const passed = async () => ({ ok: true });
const noLimits = async () => null;
const task = { title: '入力検証', acceptance: '空入力を拒否する' };
const ok = { report, outcome: 'ok', summary: '検証済み', question: '', decisions: { requirements: '要求', granularity: '粒度', architecture: '設計' }, tasks: [task] };
const prereview = { ...ok, change: 'sample-change', decisions: { selection: '依存なし', applicability: '現状に合致', updates: '変更不要' } };

function fixture(t) {
  const dir = mkdtempSync(join(root, 'agent-docs', 'routing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'target');
  mkdirSync(target);
  return { dir, target, base: join(dir, 'data') };
}

test('既定割り当てと固定値を検証し、不正なCLI・モデル・推論を拒否する', t => {
  const { dir } = fixture(t);
  assert.deepEqual(assignment({ kind: 'change', stage: 'prereview' }), { cli: 'claude', model: 'claude-opus-5-5', effort: 'medium' });
  assert.deepEqual(assignment({ stage: 'plan' }), { cli: 'codex', model: null, effort: null });
  for (const value of [{ cli: 'unknown' }, { model: '' }, { model: '--flag' }, { model: 'claude-opus-5-5', effort: 'ultra' }, { effort: 'invalid' }]) {
    assert.throws(() => validateModel(value));
  }
  const config = readConfig();
  config.limits.execute.primary = -1;
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(config));
  assert.throws(() => readConfig(file), /固定値/);
});

test('開始時と途中の上書きを保存し、変更は次の割り当てに反映される', async t => {
  const { target, base } = fixture(t);
  const state = await startChange(target, 'sample-change', { execute: { model: 'gpt-6-luna', effort: 'high' } }, base,
    async () => JSON.stringify({ changes: [{ name: 'sample-change', totalTasks: 2, completedTasks: 0 }] }));
  state.stage = 'execute';
  const previous = assignment(state);
  setModel(state, 'execute', 'claude-opus-5-5', 'low', base);
  assert.equal(previous.cli, 'codex');
  assert.equal(assignment(load(state.id, base)).cli, 'claude');
  assert.throws(() => setModel(state, 'execute', 'claude-opus-5-5', 'ultra', base));
  assert.equal(assignment(load(state.id, base)).effort, 'low');
});

test('旧状態はrequestとして読み、completedの保存済み記録を変えない', t => {
  const { target, base } = fixture(t);
  const state = create(target, '旧要求', base);
  delete state.kind;
  delete state.models;
  state.status = 'completed';
  const file = join(base, state.id, 'state.json');
  writeFileSync(file, JSON.stringify(state));
  const before = readFileSync(file, 'utf8');
  const loaded = load(state.id, base);
  assert.equal(loaded.kind, 'request');
  assert.equal(assignment(loaded).model, null);
  assert.equal(loaded.session, undefined);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('Codex同梱版の最新を優先し、PATHへ戻り、未導入はモデル0回でfailed', async t => {
  const { dir, target, base } = fixture(t);
  const bin = join(dir, 'OpenAI', 'Codex', 'bin');
  for (const name of ['old', 'new']) {
    mkdirSync(join(bin, name), { recursive: true });
    writeFileSync(join(bin, name, 'codex.exe'), '');
  }
  utimesSync(join(bin, 'old', 'codex.exe'), 1, 1);
  const options = { localAppData: dir, platform: 'win32', path: target };
  assert.equal(resolveCodex(options), join(bin, 'new', 'codex.exe'));
  rmSync(bin, { recursive: true });
  writeFileSync(join(target, 'codex.exe'), '');
  assert.equal(resolveCodex(options), join(target, 'codex.exe'));
  rmSync(join(target, 'codex.exe'));
  assert.throws(() => resolveCodex(options), /導入/);
  const state = create(target, '試験', base);
  await step(state, () => assert.fail('呼び出さない'), base,
    value => preflight(value, async () => '', () => resolveCodex(options)), noLimits);
  assert.equal(state.status, 'failed');
  assert.equal(state.attempts, 0);
});

test('Codexの新規と再開引数は割り当てと読み取り専用を保持する', t => {
  const { target, base } = fixture(t);
  const state = create(target, '試験', base);
  state.stage = 'review';
  setModel(state, 'review', 'gpt-6-luna', 'high', base);
  let args = codexArgs(state, base);
  assert.ok(!args.includes('--ephemeral'));
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-luna');
  assert.ok(args.includes('model_reasoning_effort="high"'));
  state.session = { stage: 'review', ...assignment(state), sessionId: 'thread-1' };
  args = codexArgs(state, base);
  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'thread-1']);
  assert.ok(args.includes('sandbox_mode="read-only"'));
  assert.ok(!args.includes('--sandbox'));
});

test('Claudeの引数・構造化出力・usageを解釈し、不正応答はfailedにする', async t => {
  const { target, base } = fixture(t);
  const state = create(target, '試験', base);
  setModel(state, 'plan', 'claude-opus-5-5', 'medium', base);
  const fake = join(target, 'claude.cjs');
  const output = { type: 'result', structured_output: ok, session_id: 'claude-session', usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 5 }, modelUsage: {} };
  writeFileSync(fake, `process.stdin.resume(); process.stdin.on('end', () => console.log(${JSON.stringify(JSON.stringify(output))}));`);
  await step(state, (current, dir) => runAgent(current, dir, process.execPath, [fake]), base, passed, noLimits);
  assert.equal(state.stage, 'execute');
  assert.equal(state.metrics[0].sessionId, 'claude-session');
  assert.deepEqual(state.metrics[0].usage, { input_tokens: 60, cached_input_tokens: 20, output_tokens: 5 });
  state.stage = 'plan';
  writeFileSync(fake, "process.stdin.resume(); process.stdin.on('end', () => console.log('{}'));");
  await step(state, (current, dir) => runAgent(current, dir, process.execPath, [fake]), base, passed, noLimits);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /構造化出力/);
  state.kind = 'change'; state.stage = 'prereview'; state.change = 'sample-change';
  const args = claudeArgs(state, 'new-session');
  assert.ok(args.includes('--json-schema'));
  assert.ok(args.includes('dontAsk'));
  assert.ok(args.includes('new-session'));
  assert.ok(args.some(arg => arg.startsWith('Write(') && arg.endsWith('/sample-change/**)')));
  assert.ok(!args.includes('Bash'));
});

test('preflightは使用するCLIだけを検査し、同じCodexパスと版を保存する', async t => {
  const { target, base } = fixture(t);
  const state = create(target, '試験', base);
  const calls = [];
  const check = async (command, args) => { calls.push([command, args]); return args[0] === '--version' ? '1.2.3' : '{"loggedIn":true}'; };
  let report = await preflight(state, check, () => 'resolved-codex');
  assert.ok(report.ok);
  assert.ok(!calls.some(([command]) => command === 'claude'));
  assert.equal(report.executables.codex, 'resolved-codex');
  assert.equal(report.checks.find(entry => entry.name === 'Codex CLI').version, '1.2.3');
  state.kind = 'change';
  report = await preflight(state, check, () => 'resolved-codex', () => 'claude');
  assert.ok(report.ok);
  assert.ok(calls.some(([command, args]) => command === 'claude' && args[0] === 'auth'));
});

test('質問のセッションは回答だけで再開し、進行・変更・retryで捨てる', async t => {
  const { target, base } = fixture(t);
  const state = create(target, '試験', base);
  await step(state, async (current, dir) => {
    writeFileSync(join(dir, 'invocation.json'), JSON.stringify({ sessionId: 'thread-1' }));
    return { ...ok, outcome: 'question', question: '入力形式は？' };
  }, base, passed, noLimits);
  assert.equal(state.session.sessionId, 'thread-1');
  answer(state, '文字列', base);
  assert.equal(inputFor(state), '文字列');
  await step(state, async () => ok, base, passed, noLimits);
  assert.equal(state.stage, 'execute');
  assert.equal(state.session, undefined);
  state.stage = 'plan';
  state.session = { stage: 'plan', ...assignment(state), sessionId: 'old' };
  setModel(state, 'plan', 'gpt-6-luna', 'low', base);
  assert.equal(resumeSession(state), null);
  assert.match(inputFor(state), /文字列/);
  state.status = 'failed';
  state.session = { stage: 'plan', ...assignment(state), sessionId: 'old' };
  retry(state, base);
  assert.equal(state.session, undefined);
});

test('再開エラーは試行として記録し、新規コンテキストで一度だけやり直す', async t => {
  const { target, base } = fixture(t);
  const state = create(target, '試験', base);
  state.answers = [{ stage: 'plan', question: '形式？', answer: '文字列' }];
  state.session = { stage: 'plan', ...assignment(state), sessionId: 'old' };
  let calls = 0;
  await step(state, async current => {
    calls++;
    if (calls === 1) { assert.equal(inputFor(current), '文字列'); throw new Error('再開できない'); }
    assert.equal(current.session, undefined);
    assert.match(inputFor(current), /文字列/);
    return ok;
  }, base, passed, noLimits);
  assert.equal(calls, 2);
  assert.equal(state.metrics[0].resumed, true);
  assert.equal(state.metrics[0].status, 'failed');
  assert.equal(state.metrics[1].resumed, false);
  assert.equal(state.stage, 'execute');
});

test('利用枠を解析し、不明値を未取得とし、足りない窓だけで停止を判断する', () => {
  const limits = parseCodexLimits({ result: { rateLimits: { primary: { usedPercent: 85, resetsAt: 123 }, secondary: { usedPercent: 5 } } } });
  assert.equal(limits.primary.resetsAt, 123);
  assert.equal(insufficient(limits, { primary: 20, secondary: 10 }), true);
  assert.equal(insufficient(limits, { primary: 15, secondary: 10 }), false);
  const claude = parseClaudeLimits(JSON.stringify({ result: 'Current session: 82% used\nCurrent week (all models): 42% used' }));
  assert.equal(claude.primary.usedPercent, 82);
  assert.equal(claude.secondary.usedPercent, 42);
  assert.equal(parseClaudeLimits('invalid'), null);
  assert.equal(parseCodexLimits({ primary: { usedPercent: 101 } }), null);
  assert.equal(insufficient(null, { primary: 20, secondary: 10 }), false);
  assert.ok(limitError('rate_limit_reached'));
});

test('利用枠不足はモデル0回でlimitedになり、modelまたはretryで新規再開できる', async t => {
  const { target, base } = fixture(t);
  const state = create(target, '試験', base);
  await step(state, () => assert.fail('呼び出さない'), base, passed, async () => ({ primary: { usedPercent: 99, resetsAt: 123 } }));
  assert.equal(state.status, 'limited');
  assert.equal(state.attempts, 0);
  assert.match(summary(state).nextAction, /別モデル/);
  assert.equal(summary(state).owner, 'クライアント');
  setModel(state, 'plan', 'gpt-6-luna', 'low', base);
  assert.equal(state.status, 'ready');
  await step(state, () => { throw new Error('rate_limit_reached'); }, base, passed, noLimits);
  assert.equal(state.status, 'limited');
  state.session = { sessionId: 'old' };
  retry(state, base);
  assert.equal(state.status, 'ready');
  assert.equal(state.session, undefined);
});

test('CodexとClaudeのusage・割り当て・セッション・前後利用枠を集計する', async t => {
  const { target, base } = fixture(t);
  const state = create(target, '試験', base);
  let count = 0;
  const limits = async () => ({ primary: { usedPercent: count++ }, secondary: null });
  await step(state, async (current, dir) => {
    writeFileSync(join(dir, 'codex.jsonl'), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 5 } }));
    writeFileSync(join(dir, 'invocation.json'), JSON.stringify({ sessionId: 'codex-1' }));
    return ok;
  }, base, passed, limits);
  state.stage = 'plan';
  setModel(state, 'plan', 'claude-opus-5-5', 'medium', base);
  await step(state, async (current, dir) => {
    writeFileSync(join(dir, 'claude.json'), JSON.stringify({ usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 } }));
    return ok;
  }, base, passed, limits);
  const report = performanceReport(state);
  assert.deepEqual(report.attempts.map(entry => entry.cli), ['codex', 'claude']);
  assert.equal(report.tokens.input_tokens.value, 35);
  assert.equal(report.tokens.cached_input_tokens.value, 12);
  assert.equal(report.attempts[0].sessionId, 'codex-1');
  assert.equal(report.attempts[0].beforeLimits.primary.usedPercent, 0);
  assert.equal(report.attempts[0].afterLimits.primary.usedPercent, 1);
  assert.equal(report.attempts[1].model, 'claude-opus-5-5');
});

test('実際のOpenSpecで候補を列挙し、候補なし・指定なしを開始前に拒否する', async t => {
  const { target, base } = fixture(t);
  const change = join(target, 'openspec', 'changes', 'sample-change');
  mkdirSync(change, { recursive: true });
  writeFileSync(join(change, 'tasks.md'), '- [ ] 1. 入力を検証する\n');
  const state = await startChange(target, undefined, {}, base);
  assert.equal(state.candidates[0].name, 'sample-change');
  assert.equal(state.change, null);
  await assert.rejects(startChange(target, 'missing', {}, base), /候補/);
  writeFileSync(join(change, 'tasks.md'), '- [x] 1. 入力を検証する\n');
  await assert.rejects(startChange(target, undefined, {}, base), /未完了/);
});

test('changeの1タスク群でも独立レビューと最終確認を通り、差し戻しはprereviewへ戻る', async t => {
  const { target, base } = fixture(t);
  const state = await startChange(target, 'sample-change', {}, base,
    async () => JSON.stringify({ changes: [{ name: 'sample-change', totalTasks: 1, completedTasks: 0 }] }));
  const stages = [];
  await run(state, async current => {
    stages.push(current.stage);
    return current.stage === 'prereview' ? prereview : { ...ok, tasks: [] };
  }, base, undefined, passed, noLimits, async () => {});
  assert.deepEqual(stages, ['prereview', 'execute', 'review', 'acceptance']);
  assert.equal(state.status, 'completed');
  for (let index = 0; index < 4; index++) {
    state.stage = 'review';
    advance(state, { ...ok, outcome: 'revise', summary: '修正が必要' });
    assert.equal(state.stage, 'prereview');
  }
  assert.equal(state.status, 'blocked');
  const completed = structuredClone(state.tasks[0]);
  advance(state, prereview);
  assert.deepEqual(state.tasks[0], completed);
});

test('prereviewの範囲外変更と検証失敗はfailedにし、選定前の質問を受け付ける', async t => {
  const { target, base } = fixture(t);
  const state = await startChange(target, 'sample-change', {}, base,
    async () => JSON.stringify({ changes: [{ name: 'sample-change', totalTasks: 1, completedTasks: 0 }] }));
  await step(state, async current => {
    current.evidence = [{ attempt: current.attempts, changedFiles: ['src/outside.js'] }];
    return prereview;
  }, base, passed, noLimits);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /ディレクトリ外/);
  retry(state, base);
  await step(state, async current => {
    current.evidence.push({ attempt: current.attempts, changedFiles: ['openspec/changes/sample-change/tasks.md'] });
    return prereview;
  }, base, passed, noLimits, (current, result, files) => validatePrereview(current, result, files, async () => { throw new Error('仕様検証失敗'); }));
  assert.equal(state.status, 'failed');
  assert.match(state.error, /仕様検証失敗/);
  await validatePrereview({ ...state, change: null }, { ...prereview, outcome: 'question', change: '' }, [], async () => assert.fail('検証不要'));
});

test('archiveはcompletedのchangeだけ実行し、失敗してもcompletedを維持する', async t => {
  const { target, base } = fixture(t);
  const state = create(target, '試験', base);
  await assert.rejects(archive(state, base, async () => assert.fail('呼び出さない')), /completed/);
  state.kind = 'change'; state.change = 'sample-change'; state.status = 'completed';
  await archive(state, base, async (cwd, args) => {
    assert.equal(cwd, target);
    assert.deepEqual(args, ['archive', 'sample-change', '-y', '--json']);
    return '{"success":true}';
  });
  await assert.rejects(archive(state, base, async () => { throw new Error('同期失敗'); }), /同期失敗/);
  assert.equal(state.status, 'completed');
  const events = readFileSync(join(base, state.id, 'events.jsonl'), 'utf8');
  assert.match(events, /archived/);
  assert.match(events, /archive_failed/);
});

test('ダッシュボードはchangeと実行前レビュー、利用枠と対応を表示する', t => {
  const { target, base } = fixture(t);
  const state = create(target, '試験', base);
  Object.assign(state, { kind: 'change', change: 'sample-change', stage: 'prereview', status: 'limited', rateLimits: { primary: { usedPercent: 99, resetsAt: 123 } } });
  save(state, base);
  const markdown = readFileSync(join(base, 'dashboard.md'), 'utf8');
  for (const value of ['sample-change', '実行前レビュー', '利用枠不足', 'リセット待ち', '123']) assert.ok(markdown.includes(value));
  assert.equal(summary(state).change, 'sample-change');
});
