import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, create, load, setModel, setFallback, save, answer, retry, summary } from '../src/workflow.js';
import { assignment, attemptAssignment, fallbackAssignment, readConfig, validateAssignments } from '../src/config.js';
import { step, run, runAgent, inputFor, resumeSession, codexArgs, claudeArgs } from '../src/executor.js';
import { preflight, checkGrantAccess } from '../src/preflight.js';

const codex = { model: 'gpt-6-luna', effort: 'high' };
const claude = { model: 'claude-opus-5-5', effort: 'medium' };
const enough = { primary: { usedPercent: 80 }, secondary: { usedPercent: 90 } };
const low = { primary: { usedPercent: 99 } };
const passed = async () => ({ ok: true });
const report = { scope: '代替選択', decisions: [], verification: '試験済み', remaining: 'なし' };
const ok = { report, returnTo: 'none', outcome: 'ok', summary: '検証済み', question: '', decisions: { requirements: '要求', granularity: '粒度', architecture: '設計' }, tasks: [{ title: '実装', acceptance: '動作する' }] };

function fixture(t) {
  const dir = mkdtempSync(join(root, 'agent-docs', 'fallback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'target');
  mkdirSync(target);
  const base = join(dir, 'data');
  return { dir, target, base };
}

test('設定の既定値・上書き・明示無効化を検証し、不正値と同一CLIを拒否する', t => {
  const { dir } = fixture(t);
  const config = readConfig();
  const file = join(dir, 'config.json');
  const read = () => { writeFileSync(file, JSON.stringify(config)); return readConfig(file); };
  const state = { kind: 'request', stage: 'execute' };
  assert.equal(fallbackAssignment(state, config), null);
  config.fallbacks = { request: { execute: claude } };
  assert.equal(fallbackAssignment(state, read()).cli, 'claude');
  assert.equal(fallbackAssignment({ ...state, fallbacks: { execute: null } }, config), null);
  assert.equal(fallbackAssignment({ ...state, fallbacks: { execute: { ...claude, effort: 'low' } } }, config).effort, 'low');
  for (const value of [{}, { model: null }, { model: '' }, { ...claude, effort: 'ultra' }, codex, [], 'claude']) {
    config.fallbacks.request.execute = value;
    assert.throws(read);
  }
  config.fallbacks.request = { unknown: claude };
  assert.throws(read, /工程/);
  config.fallbacks = [];
  assert.throws(read);
  assert.throws(() => validateAssignments({ ...state, fallbacks: { execute: {} } }));
});

test('停止中の変更は保存・再読込でき、不正操作はメモリと保存状態と履歴を変えない', t => {
  const { target, base } = fixture(t);
  const state = create(target, '要求', base, undefined, { models: { execute: codex }, fallbacks: { execute: claude } });
  assert.equal(fallbackAssignment({ ...load(state.id, base), stage: 'execute' }).cli, 'claude');
  for (const status of ['waiting', 'limited']) {
    Object.assign(state, { status, question: '確認', waitingFor: 'question' });
    save(state, base);
    setFallback(state, 'execute', null, undefined, base);
    assert.equal(state.status, status);
    assert.equal(state.question, '確認');
    assert.equal(load(state.id, base).fallbacks.execute, null);
    setFallback(state, 'execute', claude.model, claude.effort, base);
    const before = JSON.stringify(state);
    const saved = readFileSync(join(base, state.id, 'state.json'), 'utf8');
    const events = readFileSync(join(base, state.id, 'events.jsonl'), 'utf8');
    for (const action of [
      () => setFallback(state, 'execute', codex.model, codex.effort, base),
      () => setModel(state, 'execute', claude.model, claude.effort, base),
      () => setFallback(state, 'missing', claude.model, undefined, base),
    ]) {
      assert.throws(action);
      assert.equal(JSON.stringify(state), before);
      assert.equal(readFileSync(join(base, state.id, 'state.json'), 'utf8'), saved);
      assert.equal(readFileSync(join(base, state.id, 'events.jsonl'), 'utf8'), events);
    }
  }
});

test('CLIのstart・start-change・fallback・disableは引数を保存し、不正操作を拒否する', t => {
  const { dir, target } = fixture(t);
  const app = join(dir, 'app');
  mkdirSync(app);
  for (const name of ['src', 'package.json', 'workflow.config.json']) cpSync(join(root, name), join(app, name), { recursive: true });
  const specBin = join(app, 'node_modules', '@fission-ai', 'openspec', 'bin');
  mkdirSync(specBin, { recursive: true });
  writeFileSync(join(specBin, 'openspec.js'), `console.log(${JSON.stringify(JSON.stringify({ root: { path: target, source: 'nearest' }, changes: [{ name: 'sample', totalTasks: 1, completedTasks: 0 }] }))});`);
  const request = join(dir, 'request.md');
  writeFileSync(request, '試験要求');
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [join(app, 'src/cli.js'), ...args], { cwd: app, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const view = cli('start', target, request, '--fallback', 'execute', claude.model, claude.effort, '--model', 'execute', codex.model);
  const path = join(app, 'data', view.id, 'state.json');
  let state = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(state.fallbacks.execute.model, claude.model);
  state.status = 'waiting'; state.question = '確認'; writeFileSync(path, JSON.stringify(state));
  cli('fallback', view.id, 'execute', '--disable');
  state = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(state.fallbacks.execute, null);
  assert.equal(state.status, 'waiting'); assert.equal(state.question, '確認');
  cli('fallback', view.id, 'execute', claude.model, 'low');
  const before = readFileSync(path, 'utf8');
  assert.throws(() => cli('model', view.id, 'execute', claude.model));
  assert.throws(() => cli('fallback', view.id, 'execute', '--disable', 'extra'));
  assert.equal(readFileSync(path, 'utf8'), before);
  const change = join(target, 'openspec', 'changes', 'sample');
  mkdirSync(change, { recursive: true });
  writeFileSync(join(change, 'tasks.md'), '- [ ] 実装\n');
  const changeView = cli('start-change', target, 'sample', '--fallback', 'prereview', codex.model, 'high', '--fallback', 'execute', claude.model);
  assert.equal(JSON.parse(readFileSync(join(app, 'data', changeView.id, 'state.json'), 'utf8')).fallbacks.prereview.model, codex.model);
  const help = execFileSync(process.execPath, [join(app, 'src/cli.js'), '--help'], { encoding: 'utf8' });
  assert.match(help, /--fallback/); assert.match(help, /--disable/);
});

test('双方向の選択は閾値一致・片窓・通常未取得を扱い、不要な代替照会をしない', async t => {
  const { target, base } = fixture(t);
  for (const [normal, fallback] of [[codex, claude], [claude, codex]]) {
    for (const normalLimits of [low, enough, null]) {
      for (const alternative of [enough, { secondary: { usedPercent: 90 } }]) {
        const state = create(target, '要求', base, undefined, { models: { plan: normal }, fallbacks: { plan: fallback } });
        const calls = [];
        await step(state, async current => {
          const selected = attemptAssignment(current);
          assert.equal(selected.model, normalLimits === low ? fallback.model : normal.model);
          assert.equal(assignment(current).model, normal.model);
          return ok;
        }, base, passed, async (_, value) => { calls.push(value.model); return value.model === normal.model ? normalLimits : alternative; });
        assert.equal(state.attempts, 1);
        assert.deepEqual(calls, normalLimits === low ? [normal.model, fallback.model, fallback.model] : [normal.model, normal.model]);
        assert.equal(state.metrics[0].model, normalLimits === low ? fallback.model : normal.model);
      }
    }
  }
});

test('代替未指定・不足・全窓不明ではモデル0回・試行数不変で候補別の理由を保存する', async t => {
  const { target, base } = fixture(t);
  for (const alternative of [undefined, low, null, { primary: null, secondary: null }]) {
    const state = create(target, '要求', base, undefined, { fallbacks: alternative === undefined ? {} : { plan: claude } });
    await step(state, () => assert.fail('モデルを起動しない'), base, passed,
      async (_, value) => value.cli === 'codex' ? low : alternative);
    assert.equal(state.status, 'limited'); assert.equal(state.attempts, 0);
    assert.equal(state.selection.selected, null);
    assert.deepEqual(state.selection.normal.rateLimits, low);
    assert.match(state.error, /代替/);
    assert.match(readFileSync(join(base, state.id, 'events.jsonl'), 'utf8'), /assignment_selected/);
    assert.match(readFileSync(join(base, 'dashboard.md'), 'utf8'), /担当選択/);
  }
});

test('保存後に通常側が変わって同一CLIになった設定は実行前にfailedになる', async t => {
  const { target, base } = fixture(t);
  const state = create(target, '要求', base, undefined, { fallbacks: { plan: claude } });
  state.models.plan = claude;
  await step(state, () => assert.fail('起動しない'), base, passed, () => assert.fail('枠も照会しない'));
  assert.equal(state.status, 'failed'); assert.equal(state.attempts, 0);
  assert.match(state.error, /別CLI/);
});

test('模擬CLIの代替起動は引数・入力・invocation・metrics・statusの担当を一致させる', async t => {
  const { dir, target, base } = fixture(t);
  for (const [normal, fallback] of [[codex, claude], [claude, codex]]) {
    const state = create(target, '入力を渡す', base, undefined, { models: { plan: normal }, fallbacks: { plan: fallback } });
    const fake = join(dir, `fake-${fallback.model}.cjs`);
    const cli = fallback === claude ? 'claude' : 'codex';
    writeFileSync(fake, `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      if (!args.includes(${JSON.stringify(fallback.model)})) process.exit(2);
      let input = '';
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        if (!input.includes('入力を渡す')) process.exit(3);
        const result = ${JSON.stringify(ok)};
        if (${JSON.stringify(cli)} === 'claude') console.log(JSON.stringify({ type: 'result', session_id: 'fake', structured_output: result }));
        else {
          fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(result));
          console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake' }));
        }
      });
    `);
    await step(state, (current, attemptDir) => runAgent(current, attemptDir, process.execPath, [fake]), base, passed,
      async (_, value) => value.model === normal.model ? low : enough);
    assert.equal(state.status, 'ready');
    const view = summary(state, base);
    assert.equal(view.work.cli, cli); assert.equal(view.work.effort, fallback.effort);
    assert.equal(view.history[0].cli, cli); assert.equal(view.history[0].model, fallback.model);
    const invocation = JSON.parse(readFileSync(view.history[0].invocation, 'utf8'));
    const metric = JSON.parse(readFileSync(view.history[0].metrics, 'utf8'));
    for (const record of [invocation, metric]) {
      assert.equal(record.cli, cli); assert.equal(record.model, fallback.model); assert.equal(record.effort, fallback.effort);
    }
    assert.match(readFileSync(join(base, 'dashboard.md'), 'utf8'), /通常側の利用枠不足により代替を選択/);
  }
});

test('代替確認の失敗はfailed・0試行、未選択CLIは未確認、同じrunの確認は再利用する', async t => {
  const { target, base } = fixture(t);
  const make = () => create(target, '要求', base, undefined, { fallbacks: { plan: claude } });
  const failed = make();
  await step(failed, () => assert.fail('起動しない'), base,
    async current => ({ ok: !current.attemptAssignment, error: '代替が未認証' }),
    async (_, value) => value.cli === 'codex' ? low : enough);
  assert.equal(failed.status, 'failed'); assert.equal(failed.attempts, 0);
  const normal = make();
  let checks = 0;
  await step(normal, async () => ok, base, async current => { checks++; assert.equal(current.attemptAssignment, undefined); return { ok: true }; }, async () => enough);
  assert.equal(checks, 1);
  const state = make();
  state.stage = 'execute'; state.fallbacks = { execute: claude }; state.tasks = [{ ...ok.tasks[0], status: 'pending' }];
  let executions = 0; checks = 0;
  await run(state, async () => { executions++; return executions === 1 ? { ...ok, outcome: 'partial' } : { ...ok, outcome: 'question', question: '確認' }; }, base, undefined,
    async () => { checks++; return { ok: true }; }, async (_, value) => value.cli === 'codex' ? low : enough);
  assert.equal(checks, 2); assert.equal(executions, 2);
  answer(state, '回答', base);
  await step(state, async () => ({ ...ok, outcome: 'question', question: '確認' }), base, async () => { checks++; return { ok: true }; }, async (_, value) => value.cli === 'codex' ? low : enough);
  assert.equal(checks, 4);
});

test('選択CLIの権限確認と双方向の引数は承認・許可・工程制限を保持する', async t => {
  const { target, base } = fixture(t);
  const state = create(target, '要求', base);
  state.grants = { paths: [base], network: true };
  state.approval = { status: 'approved', items: [{ tasks: '実装', action: '検証', limits: '対象内', stopWhen: '失敗' }], conditions: '条件を保持' };
  for (const [normal, fallback] of [[codex, claude], [claude, codex]]) {
    for (const stage of ['prereview', 'execute', 'review']) {
      Object.assign(state, { kind: 'change', change: 'sample', stage, models: { [stage]: normal }, attemptAssignment: { ...fallback, cli: fallback === codex ? 'codex' : 'claude' } });
      const value = attemptAssignment(state);
      const args = value.cli === 'codex' ? codexArgs(state, base) : claudeArgs(state, 'new');
      assert.ok(args.includes(fallback.model));
      assert.match(inputFor(state), /条件を保持/);
      if (value.cli === 'codex') {
        assert.ok(args.includes(stage === 'review' ? 'read-only' : 'workspace-write'));
        assert.ok(args.includes('approval_policy="never"'));
      } else {
        assert.ok(args.includes('dontAsk'));
        assert.equal(args.includes('Bash'), stage === 'execute');
        assert.equal(args.includes('Write'), stage === 'execute');
        if (stage === 'prereview') assert.ok(args.some(arg => arg.startsWith('Write(')));
      }
      let sandbox = 0;
      await checkGrantAccess(state, [base], async () => { sandbox++; });
      assert.equal(sandbox, value.cli === 'codex' ? 1 : 0);
      if (stage === 'execute') {
        let accessChecks = 0;
        const report = await preflight(state, async (_, args) => {
          if (args[0] === 'sandbox' && args.includes('workflow-grant')) accessChecks++;
          return '{"loggedIn":true}';
        }, () => 'codex', () => 'claude', async () => JSON.stringify({ root: { path: target } }));
        assert.equal(report.ok, true);
        if (process.platform === 'win32') assert.equal(accessChecks, value.cli === 'codex' ? 1 : 0);
      }
    }
  }
});

test('回答後の同担当はresumeし、担当変更は回答・承認・証拠を含む完全入力で通常へ戻る', async t => {
  const { target, base } = fixture(t);
  const state = create(target, '完全な要求', base, undefined, { models: { plan: codex }, fallbacks: { plan: claude } });
  state.approval = { status: 'approved', items: [], conditions: '承認条件' };
  state.evidence = [{ changedFiles: ['実装.js'] }];
  const limits = async (_, value) => value.cli === 'codex' ? low : enough;
  const ask = async (current, dir) => {
    writeFileSync(join(dir, 'invocation.json'), JSON.stringify({ ...attemptAssignment(current), sessionId: '代替セッション' }));
    return { ...ok, outcome: 'question', question: '形式は？' };
  };
  await step(state, ask, base, passed, limits);
  assert.equal(state.session.cli, 'claude');
  answer(state, '文字列で', base);
  await step(state, async (current, dir) => {
    assert.equal(resumeSession(current).sessionId, '代替セッション');
    assert.equal(inputFor(current), '文字列で');
    return ask(current, dir);
  }, base, passed, limits);
  answer(state, '必須', base);
  await step(state, async current => {
    assert.equal(resumeSession(current), null);
    for (const text of ['完全な要求', '文字列で', '必須', '承認条件', '実装.js']) assert.ok(inputFor(current).includes(text));
    assert.equal(attemptAssignment(current).cli, 'codex');
    return ok;
  }, base, passed, async () => enough);
  assert.equal(state.models.plan.model, codex.model);
  assert.deepEqual(state.metrics.map(entry => entry.cli), ['claude', 'claude', 'codex']);
  assert.equal(state.attemptAssignment, undefined);
  assert.equal(summary(state, base).history[0].effort, claude.effort);
});

test('代替実行途中の上限は自動再試行せず、retry後は通常から判定する', async t => {
  const { target, base } = fixture(t);
  const state = create(target, '要求', base, undefined, { fallbacks: { plan: claude } });
  let calls = 0;
  await run(state, async () => { calls++; throw new Error('rate_limit_reached'); }, base, undefined, passed,
    async (_, value) => value.cli === 'codex' ? low : enough);
  assert.equal(calls, 1); assert.equal(state.status, 'limited');
  assert.equal(state.metrics[0].cli, 'claude');
  retry(state, base);
  await step(state, async current => { assert.equal(attemptAssignment(current).cli, 'codex'); return ok; }, base, passed, async () => enough);
  assert.equal(state.metrics[1].cli, 'codex');
});

test('統合: 枠不足で代替実装し、独立レビューを通り次の実装で通常へ復帰する', async t => {
  const { target, base } = fixture(t);
  const state = create(target, '要求', base, undefined, { fallbacks: { execute: claude } });
  let executeCount = 0;
  const observed = [];
  await run(state, async current => {
    observed.push([current.stage, attemptAssignment(current).cli]);
    if (current.stage === 'execute') executeCount++;
    return { ...ok, tasks: current.stage === 'plan' ? [...ok.tasks, { title: '次の実装', acceptance: '確認' }] : [] };
  }, base, undefined, passed, async (current, value) => current.stage === 'execute' && executeCount === 0 && value.cli === 'codex' ? low : enough);
  assert.deepEqual(observed, [['plan', 'codex'], ['execute', 'claude'], ['review', 'codex'], ['execute', 'codex'], ['review', 'codex'], ['acceptance', 'codex']]);
  assert.equal(state.status, 'completed');
  const saved = readFileSync(join(base, state.id, 'state.json'), 'utf8');
  const loaded = load(state.id, base);
  assert.equal(summary(loaded, base).history[1].cli, 'claude');
  assert.equal(readFileSync(join(base, state.id, 'state.json'), 'utf8'), saved);
});

test('進捗なしpartialは2回で止まり、回答後は同じタスクを新規入力で続ける', async t => {
  const { target, base } = fixture(t);
  const state = create(target, '要求', base);
  Object.assign(state, { stage: 'execute', tasks: [{ ...ok.tasks[0], status: 'pending' }] });
  const partial = async (current, dir) => {
    current.evidence ??= [];
    current.evidence.push({ attempt: current.attempts, changedFiles: [], openspec: { changedFiles: [] } });
    writeFileSync(join(dir, 'invocation.json'), JSON.stringify({ sessionId: 'partial-session' }));
    return { ...ok, outcome: 'partial', summary: '調査のみ' };
  };
  await step(state, partial, base, passed, async () => enough);
  assert.equal(state.status, 'ready');
  await step(state, partial, base, passed, async () => enough);
  assert.equal(state.status, 'waiting');
  assert.equal(state.session, undefined);
  for (const text of ['調査のみ', '続行', '計画見直し', 'close']) assert.ok(state.question.includes(text));
  answer(state, '別の手順で続行', base);
  assert.equal(state.idlePartials, 0);
  await step(state, async current => {
    assert.equal(resumeSession(current), null);
    assert.match(inputFor(current), /別の手順で続行/);
    assert.equal(current.stage, 'execute');
    return { ...ok, outcome: 'question', question: '確認' };
  }, base, passed, async () => enough);
  assert.equal(state.idlePartials, undefined);
});

test('対象またはOpenSpecの変更が進捗なしをリセットし、通算上限は維持する', async t => {
  const { target, base } = fixture(t);
  for (const spec of [false, true]) {
    const state = create(target, '要求', base);
    Object.assign(state, { stage: 'execute', tasks: [{ ...ok.tasks[0], status: 'pending' }] });
    for (let i = 0; i < 11; i++) {
      await step(state, async current => {
        const changed = i % 2 === 1;
        current.evidence ??= [];
        current.evidence.push({ attempt: current.attempts, changedFiles: changed && !spec ? ['code.js'] : [], openspec: { changedFiles: changed && spec ? ['tasks.md'] : [] } });
        return { ...ok, outcome: 'partial' };
      }, base, passed, async () => enough);
      assert.equal(state.status, i === 10 ? 'blocked' : 'ready');
    }
  }
});

test('失敗で代替へ切り替え、partialでも継続し、次のタスクは通常側に戻る', async t => {
  const { target, base } = fixture(t);
  const state = create(target, '要求', base, undefined, { fallbacks: { execute: claude } });
  Object.assign(state, { stage: 'execute', tasks: [{ ...ok.tasks[0], status: 'pending' }, { title: '次', acceptance: '確認', status: 'pending' }] });
  const observed = [];
  await run(state, async current => {
    observed.push([current.stage, attemptAssignment(current).cli]);
    if (observed.length === 1) throw new Error('環境エラー');
    if (observed.length === 2) {
      const input = JSON.parse(inputFor(current).split('\n').at(-1));
      assert.equal(input.failures[0].error, '環境エラー');
      assert.equal(resumeSession(current), null);
      assert.equal(current.selection.reason, '通常側の失敗により代替を選択');
      return { ...ok, outcome: 'partial' };
    }
    return ok;
  }, base, undefined, passed, async () => enough);
  assert.deepEqual(observed, [['execute', 'codex'], ['execute', 'claude'], ['execute', 'claude'], ['review', 'codex'], ['execute', 'codex'], ['review', 'codex'], ['acceptance', 'codex']]);
  assert.equal(state.failureStreak, undefined);
  assert.equal(state.envFallback, undefined);
});

test('代替も失敗すると2回で止まり、retryの入力と状態表示に失敗履歴が残る', async t => {
  const { target, base } = fixture(t);
  const state = create(target, '要求', base, undefined, { fallbacks: { plan: claude } });
  let calls = 0;
  const fail = async () => { calls++; throw new Error('E'.repeat(600)); };
  await step(state, fail, base, passed, async () => enough);
  assert.equal(calls, 2);
  assert.equal(state.status, 'failed');
  assert.equal(state.failureStreak.count, 2);
  assert.match(summary(state, base).nextAction, /2回連続.*人/);
  retry(state, base);
  assert.equal(state.failureStreak.count, 2);
  assert.equal(JSON.parse(inputFor(state).split('\n').at(-1)).failures[0].error.length, 500);
  await step(state, fail, base, passed, async () => enough);
  retry(state, base);
  await step(state, fail, base, passed, async () => enough);
  assert.equal(state.failureStreak.count, 4);
  assert.deepEqual(state.failureStreak.entries.map(entry => entry.attempt), [2, 3, 4]);
  retry(state, base);
  await step(state, async () => ok, base, passed, async () => enough);
  assert.equal(state.failureStreak, undefined);
});

test('代替なしは自動再実行せず、失敗後の代替不足・取得不能・確認失敗は停止する', async t => {
  const { target, base } = fixture(t);
  for (const alternative of [undefined, low, null, 'preflight']) {
    const state = create(target, '要求', base, undefined, { fallbacks: alternative === undefined ? {} : { plan: claude } });
    let calls = 0;
    await step(state, async () => { calls++; return { ...ok, outcome: 'error', summary: '環境エラー' }; }, base,
      async current => ({ ok: alternative !== 'preflight' || current.attemptAssignment?.cli !== 'claude', error: '代替確認失敗' }),
      async (_, value) => value.cli === 'codex' || alternative === 'preflight' ? enough : alternative);
    assert.equal(calls, 1);
    assert.equal(state.status, alternative === undefined || alternative === 'preflight' ? 'failed' : 'limited');
  }
});
