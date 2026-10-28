import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { root, create, load, save, answer, grant, advance, validateResult, lock, prompt, summary, list, dashboard } from '../src/workflow.js';
import { step as nativeStep, run as nativeRun, codexArgs, runCodex } from '../src/executor.js';
import { preflight as nativePreflight, checkCommand, checkGrantAccess } from '../src/preflight.js';
import { usage, performanceReport } from '../src/metrics.js';

const report = { scope: '入力検証の実装と受け入れ条件', decisions: [], verification: '試験で確認済み', remaining: 'なし' };
const passed = async () => ({ ok: true });
const checkedStep = (state, runner, base, check) => nativeStep(state, runner, base, check, async () => null);
const checkedRun = (state, runner, base, progress, check) => nativeRun(state, runner, base, progress, check, async () => null);
const preflight = (state, check) => nativePreflight(state, check, () => 'codex');
const step = (state, runner, base) => checkedStep(state, runner, base, passed);
const run = (state, runner, base) => checkedRun(state, runner, base, undefined, passed);

function fixture(t) {
  const parent = join(root, 'agent-docs');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'target');
  mkdirSync(target);
  const base = join(dir, 'data');
  return { base, target, state: create(target, '入力を検証して保存する', base) };
}
const task = { title: '入力検証', acceptance: '空の入力は保存されない' };
const decisions = { requirements: '要求と受け入れ条件を確認', granularity: '独立検証できる最小単位', architecture: '既存の標準機能で実装' };
const ok = (tasks = []) => ({ report, outcome: 'ok', summary: '確認済み', question: '', decisions, tasks });
const revise = { report, outcome: 'revise', summary: '空入力が保存されるため修正が必要', question: '', tasks: [] };

test('ダッシュボードは回答待ちを先に示し、要約と対応者・状態・成果リンクが一致する', t => {
  const { state, base, target } = fixture(t);
  state.status = 'completed';
  state.attempts = 4;
  state.lastResult = '検証成功';
  save(state, base);
  const waiting = create(target, '# 案件|[危険](リンク)<script>\n長い要求本文', base);
  waiting.status = 'waiting';
  waiting.question = '入力形式は？\n停止中|回答が必要';
  waiting.lastResult = '仕様未確定';
  save(waiting, base);
  const failed = create(target, '# 技術的失敗', base);
  failed.status = 'failed';
  failed.error = '起動失敗';
  save(failed, base);
  const running = create(target, '# 進行中', base);
  running.status = 'running';
  save(running, base);
  const before = readFileSync(join(base, state.id, 'state.json'), 'utf8');
  dashboard(base);
  const markdown = readFileSync(join(base, 'dashboard.md'), 'utf8');
  assert.ok(markdown.indexOf('## 回答待ち') < markdown.indexOf('## 開発主体'));
  assert.ok(markdown.indexOf('## 開発主体') < markdown.indexOf('## 成果確認可能'));
  assert.ok(markdown.indexOf('## 成果確認可能') < markdown.indexOf('## 進行中'));
  assert.ok(!markdown.includes('<script>'));
  assert.ok(!markdown.includes('長い要求本文'));
  for (const current of [state, waiting, failed, running]) {
    const view = summary(current, base);
    assert.ok(markdown.includes(view.statusLabel));
    assert.ok(markdown.includes(view.owner));
    assert.ok(markdown.includes(view.nextAction));
  }
  assert.match(markdown, /attempt-0004\/result.json/);
  assert.match(markdown, /\[成果\]/);
  assert.match(summary(state, base).verification, /attempt-0004/);
  assert.equal(readFileSync(join(base, state.id, 'state.json'), 'utf8'), before);
});

test('計画の3判断を必須にし、次工程へ根拠を渡す', t => {
  const { state } = fixture(t);
  for (const key of Object.keys(decisions)) {
    assert.throws(() => validateResult({ ...ok([task]), decisions: { ...decisions, [key]: ' ' } }, 'plan'), /根拠が必要/);
  }
  assert.throws(() => validateResult({ ...ok([task]), decisions: undefined }, 'plan'), /根拠が必要/);
  advance(state, ok([task]));
  assert.equal(state.stage, 'execute');
  assert.deepEqual(state.decisions, decisions);
  assert.deepEqual(JSON.parse(prompt(state).split('\n').at(-1)).decisions, decisions);
});

test('旧工程の再開は実行前確認後に移行し、保持データと完了済み履歴を変更しない', async t => {
  const { state, base } = fixture(t);
  for (const stage of ['granularity', 'architecture']) {
    state.stage = stage;
    state.status = 'ready';
    state.tasks = [{ ...task, status: 'completed', result: '成果の証拠' }];
    state.answers = [{ stage, question: '質問', answer: '回答' }];
    state.evidence = [{ attempt: 1, changedFiles: ['a.js'] }];
    state.revisions = 2;
    const previousAttempts = state.attempts;
    const preserved = structuredClone({ answers: state.answers, evidence: state.evidence, task: state.tasks[0] });
    await checkedStep(state, async current => {
      assert.equal(current.stage, 'plan');
      return ok([task]);
    }, base, async current => {
      assert.equal(current.stage, stage);
      return { ok: true };
    });
    assert.equal(state.stage, 'execute');
    assert.equal(state.revisions, 2);
    assert.equal(state.attempts, previousAttempts + 1);
    assert.deepEqual({ answers: state.answers, evidence: state.evidence, task: state.tasks[0] }, preserved);
  }
  assert.match(readFileSync(join(base, state.id, 'events.jsonl'), 'utf8'), /stage_migrated/);
  state.status = 'completed';
  state.stage = 'architecture';
  const before = structuredClone(state);
  await checkedRun(state, async () => assert.fail('完了済みは実行しない'), base);
  assert.deepEqual(state, before);
});

test('失敗と再試行の計測を残し、欠落usageを0にせずキャッシュを入力へ重複加算しない', async t => {
  const { state, base } = fixture(t);
  await step(state, async (current, dir) => {
    writeFileSync(join(dir, 'codex.jsonl'), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 5 } }) + '\n{"中断');
    throw new Error('接続失敗');
  }, base);
  state.status = 'ready';
  await step(state, async () => ok([task]), base);
  assert.equal(state.metrics.length, 2);
  assert.equal(state.metrics[0].status, 'failed');
  assert.equal(state.metrics[0].stage, 'plan');
  assert.equal(state.metrics[0].attempt, 1);
  assert.equal(state.metrics[1].usage.input_tokens, null);
  const report = performanceReport(state);
  assert.equal(report.tokens.input_tokens.value, 100);
  assert.equal(report.tokens.input_tokens.complete, false);
  assert.equal(report.tokens.cached_input_tokens.value, 70);
  assert.ok(report.activeMs > 0);
  assert.ok(report.elapsedMs >= report.activeMs - 2);
  assert.deepEqual(JSON.parse(readFileSync(join(base, state.id, 'performance.json'), 'utf8')), report);
  const dir = join(base, state.id, 'attempt-0002');
  writeFileSync(join(dir, 'codex.jsonl'), [
    { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 2 } },
    { type: 'turn.completed', usage: { input_tokens: 30, cached_input_tokens: 10, output_tokens: 3 } },
  ].map(JSON.stringify).join('\n'));
  assert.deepEqual(usage(dir), { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5 });
  writeFileSync(join(dir, 'codex.jsonl'), [
    { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 2 } },
    { type: 'turn.completed', usage: { input_tokens: 30, output_tokens: 3 } },
  ].map(JSON.stringify).join('\n'));
  assert.deepEqual(usage(dir), { input_tokens: 50, cached_input_tokens: null, output_tokens: 5 });
  state.createdAt = new Date(Date.parse(state.createdAt) - 60_000).toISOString();
  assert.ok(performanceReport(state).elapsedMs - report.elapsedMs >= 60_000);
  assert.equal(performanceReport(state).activeMs, report.activeMs);
  state.attempts += 6; // 計測導入前の履歴から再開した場合。
  assert.equal(performanceReport(state).tokens.input_tokens.total, 8);
  assert.equal(performanceReport(state).tokens.output_tokens.complete, false);
  assert.equal(performanceReport(state).activeComplete, false);
});

test('実行前確認は対象・Git・CLI・認証・両プロファイルをモデルなしで検査する', async t => {
  const { state } = fixture(t);
  const calls = [];
  const report = await preflight(state, async (...args) => calls.push(args));
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 6);
  assert.deepEqual(calls.map(call => call[0]), ['git', 'codex', 'codex', 'codex', 'codex']);
  assert.ok(calls[3][1].includes(':read-only'));
  assert.ok(calls[4][1].includes(':workspace'));
  assert.ok(calls.every(call => !call[1].includes('exec')));
  const failed = await preflight(state, async () => { throw new Error('終了コード1'); });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Git作業ツリー/);
  await assert.rejects(checkCommand(process.execPath, ['-e', 'console.error("orchestrator_helper_exit_nonzero secret-value"); process.exit(1)'], state.target), error => {
    assert.match(error.message, /セットアップ補助/);
    assert.ok(!error.message.includes('secret-value'));
    return true;
  });
});

test('検査失敗・タイムアウトはモデル0回で停止し、再開時に再検査する', async t => {
  const { state, base } = fixture(t);
  let calls = 0;
  const runner = async () => { calls++; return ok([task]); };
  const timeout = await preflight(state, () => checkCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], state.target, 100));
  assert.match(timeout.error, /タイムアウト/);
  await checkedStep(state, runner, base, async () => timeout);
  assert.equal(state.status, 'failed');
  assert.equal(state.attempts, 0);
  assert.equal(calls, 0);
  assert.equal(load(state.id, base).status, 'failed');
  assert.ok(readdirSync(join(base, state.id)).some(name => name.startsWith('preflight-')));
  state.status = 'ready';
  await checkedRun(state, runner, base, undefined, async () => ({ ok: false, error: '認証失敗' }));
  assert.equal(calls, 0);
  state.status = 'ready';
  let checks = 0;
  const check = async () => { checks++; return { ok: true }; };
  await checkedRun(state, async current => ok(current.stage === 'plan' ? [task] : []), base, undefined, check);
  assert.equal(state.status, 'completed');
  assert.equal(checks, 1);
  state.status = 'ready';
  state.stage = 'plan';
  await checkedStep(state, runner, base, check);
  assert.equal(checks, 2);
});

test('全工程が独立して進み、レビュー後だけタスクが完了する', async t => {
  const { state, base, target } = fixture(t);
  const seen = [];
  const runner = async current => {
    seen.push(current.stage);
    return ok(current.stage === 'plan' ? [task, { title: '保存', acceptance: '有効な入力を保存する' }] : []);
  };
  for (let i = 0; i < 2; i++) await step(state, runner, base);
  assert.equal(state.stage, 'review');
  assert.equal(state.tasks[0].status, 'pending');
  await step(state, runner, base);
  assert.equal(state.tasks[0].status, 'completed');
  assert.equal(state.stage, 'execute');
  while (state.status === 'ready') await step(state, runner, base);
  assert.deepEqual(seen, ['plan', 'execute', 'review', 'execute', 'review', 'acceptance']);
  assert.equal(load(state.id, base).status, 'completed');
  assert.match(readFileSync(join(base, 'dashboard.md'), 'utf8'), /完了/);
  assert.match(readFileSync(join(base, state.id, 'events.jsonl'), 'utf8'), /"type":"completed"/);
  assert.deepEqual(readdirSync(target), []);
});

test('質問は同じ工程で停止し、回答を保存して新しい実行へ渡す', async t => {
  const { state, base } = fixture(t);
  await step(state, async () => ({ report, outcome: 'question', summary: '保存先が不明', question: '保存先は？', tasks: [] }), base);
  assert.equal(state.status, 'waiting');
  assert.equal(state.stage, 'plan');
  await assert.rejects(step(state, async () => ok([task]), base), /実行できない/);
  assert.throws(() => answer(state, ' ', base), /空/);
  answer(state, 'ローカルファイル', base);
  assert.match(prompt(load(state.id, base)), /ローカルファイル/);
  await step(state, async () => ok([task]), base);
  assert.equal(state.stage, 'execute');
  assert.equal(state.attempts, 2);
});

test('差し戻しは未完了タスクを再定義し、完了済み成果を保持する', t => {
  const { state } = fixture(t);
  state.tasks = [{ ...task, status: 'completed', result: '保存済み' }, { title: '別タスク', acceptance: '動作する', status: 'pending' }];
  state.stage = 'review';
  advance(state, revise);
  assert.equal(state.stage, 'plan');
  advance(state, ok([{ title: '修正', acceptance: '空入力を拒否する' }]));
  assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks[0].result, '保存済み');
  assert.equal(state.tasks[1].title, '修正');
});

test('手戻りが上限を超えると停止する', t => {
  const { state } = fixture(t);
  for (let i = 0; i < 4; i++) {
    state.stage = 'acceptance';
    advance(state, revise);
  }
  assert.equal(state.status, 'blocked');
  assert.equal(state.revisions, 4);
});

test('実装の途中終了は正常系で、同じ工程の実行待ちに戻り、上限で停止する', t => {
  const { state } = fixture(t);
  state.tasks = [{ ...task, status: 'pending' }];
  state.stage = 'execute';
  const partial = { report, outcome: 'partial', summary: '半分完了', question: '', tasks: [] };
  advance(state, partial);
  assert.deepEqual([state.status, state.stage], ['ready', 'execute']);
  assert.throws(() => validateResult(partial, 'review'), /使えない/);
  for (let i = 0; i < 10; i++) advance(state, partial);
  assert.equal(state.status, 'blocked');
});

test('権限要求は回答待ちになり、許可は保存されて次の実行引数へ反映される', async t => {
  const { state, base } = fixture(t);
  state.tasks = [{ ...task, status: 'pending' }];
  state.stage = 'execute';
  const outside = join(root, 'agent-docs');
  advance(state, { report, outcome: 'permission', summary: '遮断', question: 'npm installに必要', permission: { network: true, paths: [outside] }, tasks: [] });
  assert.equal(state.status, 'waiting');
  assert.equal(summary(state, base).permission.network, true);
  await assert.rejects(grant(state, { paths: [homedir()] }, base, passed), /許可できない/);
  await grant(state, { network: true, paths: [outside] }, base, passed);
  assert.equal(state.status, 'ready');
  assert.ok(codexArgs(state, base).includes('sandbox_workspace_write.network_access=true'));
  assert.ok(codexArgs(state, base).some(arg => arg.startsWith('sandbox_workspace_write.writable_roots=')));
  assert.throws(() => validateResult({ report, outcome: 'permission', summary: 'x', question: 'y', permission: { network: false, paths: [] }, tasks: [] }, 'execute'), /権限要求/);
});

test('アクセス確認に失敗した許可は保存せず、修正後に同じパスで再開できる', async t => {
  const { state, base, target } = fixture(t);
  state.stage = 'execute';
  const permission = { network: true, paths: [target] };
  advance(state, { report, outcome: 'permission', summary: '遮断', question: 'アクセスが必要', permission, tasks: [] });
  save(state, base);
  const before = structuredClone(state);
  let accessible = false;
  const check = async (current, paths) => {
    assert.equal(current, state);
    assert.equal(paths.length, 1);
    if (!accessible) throw new Error(`OSのアクセス権の修正が必要: ${paths[0]}`);
  };
  await assert.rejects(grant(state, permission, base, check), /OSのアクセス権/);
  assert.deepEqual(state, before);
  assert.equal(load(state.id, base).status, 'waiting');
  const events = readFileSync(join(base, state.id, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).type, 'grant-rejected');
  assert.equal(events.at(-1).detail.paths.length, 1);
  assert.ok(!events.some(entry => ['granted', 'answered'].includes(entry.type)));
  accessible = true;
  await grant(state, permission, base, check);
  assert.equal(state.status, 'ready');
  assert.equal(state.permission, undefined);
  assert.equal(state.grants.paths.length, 1);
  assert.equal(state.answers.length, 1);
});

test('許可の確認はCodexの実装用設定を使い、Claudeは直接読み取り、ネットワークだけなら省略する', async t => {
  const { state, target, base } = fixture(t);
  state.executables = { codex: 'saved-codex' };
  state.grants = { paths: [base], network: false };
  state.kind = 'change'; state.change = 'sample';
  state.openspec = { root: base, store: 'store' };
  const calls = [];
  const check = async (...args) => { calls.push(args); };
  await checkGrantAccess(state, [target], check);
  assert.equal(calls[0][0], 'saved-codex');
  const args = calls[0][1];
  assert.deepEqual(args.slice(0, 5), ['sandbox', '-P', ':workspace', '-C', target]);
  assert.ok(args.includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([base, target, join(base, 'openspec', 'changes', 'sample')])}`));
  assert.ok(args.at(-1).includes('readdirSync'));
  await assert.rejects(checkGrantAccess(state, [target], async () => { throw new Error('secret'); }), error => error.message.includes(target) && !error.message.includes('secret'));
  state.models = { execute: { model: 'claude-opus-5-5' } };
  await checkGrantAccess(state, [target], async () => { assert.fail('Claudeでは起動しない'); });
  await assert.rejects(checkGrantAccess(state, [join(target, 'missing')]), /OSのアクセス権/);
  state.stage = 'execute';
  advance(state, { report, outcome: 'permission', summary: '遮断', question: 'ネットワークが必要', permission: { network: true, paths: [] }, tasks: [] });
  await grant(state, { network: true }, base, async () => { assert.fail('パスなしでは確認しない'); });
  assert.equal(state.status, 'ready');
});

test('実行例外と不正な結果は失敗として永続化され、成功に進まない', async t => {
  const { state, base } = fixture(t);
  await step(state, async () => { throw new Error('接続に失敗'); }, base);
  assert.equal(load(state.id, base).status, 'failed');
  assert.equal(state.stage, 'plan');
  state.status = 'ready';
  await step(state, async () => ok(), base);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /1件以上/);
  assert.equal(existsSync(join(base, state.id, 'attempt-0002', 'result.json')), true);
  assert.throws(() => validateResult({ ...ok([task]), outcome: 'revise' }, 'execute'), /差し戻せません/);
});

test('排他ロックは二重取得を拒否し、解放後に取得できる', t => {
  const { base } = fixture(t);
  const release = lock(base);
  assert.throws(() => lock(base), /別の操作/);
  release();
  lock(base)();
});

test('実装のみ書き込み可能で、質問セッションがなければ新規コンテキストを起動する', t => {
  const { state, base } = fixture(t);
  for (const stage of ['plan', 'execute', 'review', 'acceptance']) {
    state.stage = stage;
    const args = codexArgs(state, base);
    assert.equal(args[0], 'exec');
    assert.equal(args[args.indexOf('--sandbox') + 1], stage === 'execute' ? 'workspace-write' : 'read-only');
    assert.ok(!args.includes('--ephemeral'));
    assert.ok(args.includes('--output-schema'));
    assert.ok(!args.includes('resume'));
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  }
});

test('空要求、不正ID、対象外の回答を拒否する', t => {
  const { state, base, target } = fixture(t);
  assert.throws(() => create(target, ' ', base), /要求が空/);
  assert.throws(() => load('../outside', base), /IDが不正/);
  assert.throws(() => answer(state, '回答', base), /回答待ち/);
});

test('CLI接続はstdinを渡し、応答とイベント・標準エラーを別に保存する', async t => {
  const { state, base, target } = fixture(t);
  const fake = join(target, 'fake.cjs');
  writeFileSync(fake, `const fs = require('node:fs');
    let input = ''; process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      const args = process.argv.slice(2);
      if (!input.includes('入力を検証して保存する')) process.exit(2);
      fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(${JSON.stringify(ok([task]))}));
      console.log(JSON.stringify({ type: 'turn.completed' }));
      console.error('進捗');
    });`);
  await step(state, (current, dir) => runCodex(current, dir, process.execPath, [fake]), base);
  assert.equal(state.status, 'ready');
  assert.equal(state.stage, 'execute');
  const dir = join(base, state.id, 'attempt-0001');
  assert.match(readFileSync(join(dir, 'codex.jsonl'), 'utf8'), /turn.completed/);
  assert.match(readFileSync(join(dir, 'stderr.log'), 'utf8'), /進捗/);
});

test('実プロセスの非ゼロ終了と起動不能は永続化した失敗になる', async t => {
  const { state, base, target } = fixture(t);
  const fake = join(target, 'fail.cjs');
  writeFileSync(fake, "console.error('認証エラー'); process.exit(9);");
  await step(state, (current, dir) => runCodex(current, dir, process.execPath, [fake]), base);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /終了コード9/);
  state.status = 'ready';
  await step(state, (current, dir) => runCodex(current, dir, join(target, 'missing.exe')), base);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /ENOENT/);
});

test('自動進行は質問で止まり、回答後は全工程を進めて完了する', async t => {
  const { state, base } = fixture(t);
  let calls = 0;
  await run(state, async () => {
    calls++;
    return { report, outcome: 'question', summary: '入力形式の確認', question: '入力形式は？', tasks: [] };
  }, base);
  assert.equal(calls, 1);
  assert.equal(state.status, 'waiting');
  answer(state, 'テキスト', base);
  await run(state, async current => {
    calls++;
    return ok(current.stage === 'plan' ? [task] : []);
  }, base);
  assert.equal(state.status, 'completed');
  assert.equal(calls, 5);
});

test('自動進行は失敗・手戻り上限で止まり、再実行を繰り返さない', async t => {
  const { state, base } = fixture(t);
  let calls = 0;
  await run(state, async () => { calls++; throw new Error('CLI接続失敗'); }, base);
  assert.equal(calls, 1);
  assert.equal(state.status, 'failed');
  state.status = 'ready';
  state.stage = 'review';
  state.revisions = 3;
  state.tasks = [{ ...task, status: 'pending' }];
  await run(state, async () => { calls++; return revise; }, base);
  assert.equal(calls, 2);
  assert.equal(state.status, 'blocked');
});

test('エージェントが報告した環境エラーは質問待ちにせず失敗として保存する', async t => {
  const { state, base } = fixture(t);
  await run(state, async () => ({ report, outcome: 'error', summary: 'サンドボックス初期化に失敗', question: '', tasks: [] }), base);
  const saved = load(state.id, base);
  assert.equal(saved.status, 'failed');
  assert.equal(saved.stage, 'plan');
  assert.equal(saved.question, '');
  assert.match(saved.error, /初期化に失敗/);
  assert.match(readFileSync(join(base, state.id, 'events.jsonl'), 'utf8'), /"type":"failed"/);
});

test('チャット用の要約は必要な対応を示し、要求や回答履歴を再送しない', t => {
  const { state, base } = fixture(t);
  state.answers = [{ question: '保存先は？', answer: '秘密の回答' }];
  state.status = 'waiting';
  state.question = '入力形式は？';
  const view = summary(state);
  assert.equal(view.question, state.question);
  assert.match(view.nextAction, /回答が必要/);
  assert.ok(!Object.hasOwn(view, 'requirement'));
  assert.ok(!JSON.stringify(view).includes('秘密の回答'));
  assert.equal(list(base).length, 1);
  state.status = 'running';
  assert.match(summary(state).nextAction, /判断は必要ありません/);
  assert.equal(summary(state).question, undefined);
});

test('実装前後の記録で新規・変更・削除と既存の変更を区別できる', async t => {
  const { state, base, target } = fixture(t);
  const { snapshot, changedFiles } = await import('../src/evidence.js');
  execFileSync('git', ['init', '--quiet', target]);
  writeFileSync(join(target, 'existing.txt'), '以前からの未追跡ファイル');
  writeFileSync(join(target, 'deleted.txt'), '削除するファイル');
  writeFileSync(join(target, 'edited.txt'), '実装前');
  const before = await snapshot(target, join(base, 'before.json'));
  writeFileSync(join(target, 'edited.txt'), '実装後');
  writeFileSync(join(target, 'new.txt'), '新規');
  rmSync(join(target, 'deleted.txt'));
  const after = await snapshot(target, join(base, 'after.json'));
  assert.deepEqual(changedFiles(before, after).sort(), ['deleted.txt', 'edited.txt', 'new.txt']);
  state.evidence = [{ before: join(base, 'before.json'), after: join(base, 'after.json'), changedFiles: changedFiles(before, after) }];
  state.stage = 'review';
  const context = JSON.parse(prompt(state).split('\n').at(-1));
  assert.deepEqual(context.evidence[0].changedFiles.sort(), ['deleted.txt', 'edited.txt', 'new.txt']);
});

test('実装の実行で記録した変更ファイルが保存され、次のレビューへ渡る', async t => {
  const { state, base, target } = fixture(t);
  execFileSync('git', ['init', '--quiet', target]);
  const fake = join(target, 'execute.cjs');
  writeFileSync(fake, `const fs = require('node:fs');
    process.stdin.resume();
    process.stdin.on('end', () => {
      const args = process.argv.slice(2);
      fs.writeFileSync('feature.js', 'export const feature = true;');
      fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(${JSON.stringify(ok())}));
    });`);
  state.stage = 'execute';
  state.tasks = [{ ...task, status: 'pending' }];
  await step(state, (current, dir) => runCodex(current, dir, process.execPath, [fake]), base);
  const saved = load(state.id, base);
  assert.equal(saved.stage, 'review');
  assert.deepEqual(saved.evidence[0].changedFiles, ['feature.js']);
  assert.ok(existsSync(saved.evidence[0].before));
  assert.ok(existsSync(saved.evidence[0].after));
  assert.equal(saved.evidence[0].log, join(base, state.id, 'attempt-0001', 'codex.jsonl'));
  const reviewContext = JSON.parse(prompt(saved).split('\n').at(-1));
  assert.deepEqual(reviewContext.evidence[0].changedFiles, ['feature.js']);
});

test('実装が途中で失敗しても変更前後の記録と元のエラーを保持する', async t => {
  const { state, base, target } = fixture(t);
  execFileSync('git', ['init', '--quiet', target]);
  const fake = join(target, 'partial.cjs');
  writeFileSync(fake, "require('node:fs').writeFileSync('partial.txt', '途中の変更'); process.exit(9);");
  state.stage = 'execute';
  state.tasks = [{ ...task, status: 'pending' }];
  await step(state, (current, dir) => runCodex(current, dir, process.execPath, [fake]), base);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /終了コード9/);
  assert.deepEqual(load(state.id, base).evidence[0].changedFiles, ['partial.txt']);
  assert.ok(existsSync(state.evidence[0].after));
});

