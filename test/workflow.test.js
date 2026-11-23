import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { root, create, load, save, answer, approve, retry, registerEvidence, grant, advance, resolveInquiry, validateResult, lock, prompt, summarizeEvidence, summary, brief, list, dashboard } from '../src/workflow.js';
import { step as nativeStep, run as nativeRun, codexArgs, codexThread, runCodex, inputFor, claudeArgs } from '../src/executor.js';
import { fakeCodex } from './fixtures/codex.js';
import { largeStageEvidence } from './fixtures/stage-evidence.js';
import { attemptAssignment } from '../src/config.js';
import { preflight as nativePreflight, checkCommand, checkGrantAccess } from '../src/preflight.js';
import { usage, performanceReport } from '../src/metrics.js';
import { taskGate, archive } from '../src/changes.js';

const report = { scope: '入力検証の実装と受け入れ条件', decisions: [], verification: '試験で確認済み', remaining: 'なし' };
const passed = async () => ({ ok: true });
const checkedStep = (state, runner, base, check) => nativeStep(state, runner, base, check, async () => ({ limits: null, failure: null }));
const checkedRun = (state, runner, base, progress, check) => nativeRun(state, runner, base, progress, check, async () => ({ limits: null, failure: null }));
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

test('証拠を変更せず、試行の記録と判断件数、変更ファイルの和集合を返す', () => {
  const specFile = 'openspec/changes/sample/tasks.md';
  const files = [specFile, ...Array.from({ length: 2999 }, (_, index) => `src/file-${index}.js`)];
  const before = 'attempt-0001/before.json';
  const after = 'attempt-0001/after.json';
  const log = 'attempt-0001/codex.jsonl';
  const openspec = { root: '/store', before: 'attempt-0001/openspec-before.json', after: 'attempt-0001/openspec-after.json' };
  const state = { evidence: [
    { attempt: 1, before, after, log, changedFiles: [specFile], openspec: { ...openspec, store: 'sample-store', changedFiles: [specFile] },
      escalations: Array.from({ length: 40 }, (_, index) => ({ decision: index < 31 ? 'accept' : 'decline', command: 'コマンド全文', reason: '理由の全文' })) },
    { attempt: 2, before, after, log, changedFiles: files, openspec: { ...openspec, changedFiles: [specFile] } },
  ] };
  const original = structuredClone(state.evidence);
  assert.deepEqual(summarizeEvidence(state.evidence), {
    evidence: [
      { attempt: 1, before, after, log, openspec, escalations: { total: 40, accept: 31, decline: 9 } },
      { attempt: 2, before, after, log, openspec },
    ],
    changedFiles: { files: [specFile, `openspec:${specFile}`, ...files.slice(1, 99)], total: 3001 },
  });
  assert.deepEqual(state.evidence, original);
});

test('executeは判断者に合った指示を受け、所有者の許可を再開時も自動レビューへ伝える', async t => {
  const { state, base } = fixture(t);
  state.stage = 'execute';
  const command = 'Write-Output test';
  advance(state, { ...ok(), outcome: 'permission', question: 'コマンド実行が必要', permission: { commands: [command] } });
  const value = attemptAssignment(state);
  state.session = { ...value, stage: 'execute', sessionId: 'old' };
  await grant(state, { commands: [command] }, base);
  assert.match(state.answers.at(-1).answer, /所有者が明示的に許可しました/);
  const automatic = prompt(state, Date.now(), { executeApprovalReviewer: 'auto-review' });
  assert.match(automatic, /その場で昇格を要求/);
  assert.match(automatic, /自動レビューが拒否した場合に限り.*outcome=permission/);
  assert.ok(automatic.includes(`所有者が明示的に許可したコマンドを示す。["${command}"]`));
  assert.match(inputFor(state), /所有者が明示的に許可したコマンド/);
  const legacy = prompt(state, Date.now(), { executeApprovalReviewer: 'executor' });
  assert.match(legacy, /パイプは全文一致/);
  assert.doesNotMatch(legacy, /自動レビューに判断させる/);
});

test('試行の計測と詳細表示に自動レビューの通知件数または未取得を出す', async t => {
  for (const expected of [null, 1]) {
    const { state, base } = fixture(t);
    state.stage = 'execute';
    state.tasks = [{ ...task, status: 'pending' }];
    await step(state, async (current, dir) => {
      if (expected) {
        const escalations = [{ layer: 'autoReview', decision: 'accept' }];
        current.evidence = [{ attempt: current.attempts, escalations }];
        writeFileSync(join(dir, 'invocation.json'), JSON.stringify({ escalations }));
      }
      return ok();
    }, base);
    const metric = JSON.parse(readFileSync(join(base, state.id, 'attempt-0001', 'metrics.json'), 'utf8'));
    assert.equal(metric.executeApprovalReviewer, 'auto-review');
    assert.equal(metric.escalationCounts.autoReview, expected);
    assert.equal(summary(state, base, true).escalationCounts.autoReview, expected);
  }
});
const decisions = { requirements: '要求と受け入れ条件を確認', granularity: '独立検証できる最小単位', architecture: '既存の標準機能で実装' };
const ok = (tasks = []) => ({ report, returnTo: 'none', outcome: 'ok', cause: '', summary: '確認済み', question: '', decisions, tasks });
const revise = { report, returnTo: 'prereview', outcome: 'revise', cause: '', summary: '空入力が保存されるため修正が必要', question: '', tasks: [] };

const approvalItems = [{ tasks: '1.1', action: 'VMで検証', limits: '合計€20以内', stopWhen: '上限に達した場合', gate: 'plan',
  scripts: [], files: [], effect: 'external', costCheck: '起動前に見積額を確認', grants: { network: false, paths: [] } }];
const approvedItems = approvalItems.map((item, index) => ({ ...item, id: `A${index + 1}` }));
const prereviewResult = (approvals = [], retainedApprovals = []) => ({ ...ok([task]), change: 'sample-change', approvals, retainedApprovals,
  decisions: { selection: '指定change', applicability: '実行可能', updates: '変更不要', granularity: '同じモジュールを同じ試験で確認' } });

test('replanはexecute専用で、セッションを破棄し手戻りに数えない', t => {
  const result = { ...ok(), outcome: 'replan' };
  assert.ok(JSON.parse(readFileSync(join(root, 'src/result.schema.json'))).properties.outcome.enum.includes('replan'));
  for (const stage of ['plan', 'prereview', 'review', 'acceptance']) assert.throws(() => validateResult(result, stage));
  for (const kind of ['request', 'change']) {
    const { state } = fixture(t);
    Object.assign(state, { kind, stage: 'execute', revisions: 3, session: { sessionId: 'old' } });
    advance(state, result);
    assert.equal(state.stage, kind === 'change' ? 'prereview' : 'plan');
    assert.equal(state.status, 'ready');
    assert.equal(state.replans, 1);
    assert.equal(state.revisions, 3);
    assert.equal(state.session, undefined);
  }
});

test('所有者の回答なしでreplanが2回続くと待機し、回答後に再び実行前レビューへ戻れる', async t => {
  const { state, base } = fixture(t);
  Object.assign(state, { kind: 'change', stage: 'execute', revisions: 3 });
  advance(state, { ...ok(), outcome: 'replan', summary: '全体でのみテストが失敗' });
  assert.equal(state.stage, 'prereview');
  advance(state, prereviewResult());
  const result = { ...ok(), outcome: 'replan', summary: '修正後も全体でテストが失敗' };
  await step(state, async (_current, dir) => {
    writeFileSync(join(dir, 'invocation.json'), JSON.stringify({ sessionId: 'replan-session' }));
    return result;
  }, base);
  const saved = load(state.id, base);
  assert.equal(saved.stage, 'execute');
  assert.equal(saved.status, 'waiting');
  assert.equal(saved.replans, 2);
  assert.equal(saved.revisions, 3);
  assert.equal(saved.session, undefined);
  for (const text of [result.summary, '指示を加えて計画を見直す', '検証の省略や変更を回答する', 'close']) {
    assert.ok(saved.question.includes(text), text);
  }

  answer(saved, '失敗の詳細は？', base, true);
  assert.equal(saved.replans, 2);
  resolveInquiry(saved, { outcome: 'question', question: '全体実行の終了時に失敗しました' });
  answer(saved, '検証を単独実行に変更する', base);
  assert.equal(load(saved.id, base).replans, undefined);
  advance(saved, { ...result, summary: '所有者の回答に沿って単独実行に変更する' });
  assert.equal(saved.stage, 'prereview');
  assert.equal(saved.status, 'ready');
  assert.equal(saved.replans, 1);
  assert.equal(saved.revisions, 3);
});

test('原因不明の検証の失敗は再試行でもerrorにしないよう指示する', t => {
  const { state } = fixture(t);
  state.stage = 'execute';
  const input = prompt(state);
  assert.match(input, /対象のコードを変えずに解消できる実行器・ツール・環境の問題と明確に判断できる場合だけoutcome=error/);
  assert.match(input, /明確に判断できない失敗はerrorにしない/);
  assert.match(input, /failures.*同じ基準でerrorか検証の失敗かを判断する/);
});

test('検証の不具合は範囲内で直すか実行前レビューへ戻すよう指示する', t => {
  const { state } = fixture(t);
  Object.assign(state, { kind: 'change', stage: 'execute', taskStartAttempt: 1,
    evidence: [{ attempt: 1, changedFiles: ['src/feature.js'] }] });
  const input = prompt(state);
  assert.match(input, /targetのタスクだけを実装し.*ただし、検証で見つけた不具合の原因がこのchangeの差分にあり、今のdesign・specの範囲で直せる場合は、質問や差し戻しをせずその場で直して検証を続ける/);
  assert.match(input, /summaryに直したファイルと、直したコードを作ったもとのタスクの番号/);
  assert.match(input, /changeの範囲外、design・spec・tasksの変更が必要、または原因を判断できない場合は、tasks.mdを編集せずoutcome=replan/);
  assert.match(input, /失敗の場所、単独と全体での再現の有無、ログの保存先、このchangeの変更ファイルとの重なり/);
  assert.match(input, /所有者が計画の見直しを指示した場合も同様/);
  assert.match(input, /原因の判断には入力のchangedFiles（この案件のexecuteで変わったファイル）も使う/);
  const context = JSON.parse(input.split('\n').at(-1));
  assert.deepEqual(context.evidence, []);
  assert.deepEqual(context.changedFiles, { files: ['src/feature.js'], total: 1 });
});

test('実行前レビューは戻された不具合を解析し、計画の更新・質問・errorで応じるよう指示する', t => {
  const { state } = fixture(t);
  state.stage = 'prereview';
  const input = prompt(state);
  assert.match(input, /previousがexecuteから戻された不具合の報告なら、報告とログを解析する/);
  assert.match(input, /失敗した検証の前に修正タスクを足し、解析に重い実行が必要なら調査タスクを足す/);
  assert.match(input, /tasks.mdと未完了タスクの一覧に反映/);
  assert.match(input, /業務判断が必要ならoutcome=question、対象のコードを変えずに解消できる環境の問題だと判明したらoutcome=error/);
});

test('独立レビューは検証タスクで修正したコードをもとの受け入れ条件でも確認するよう指示する', t => {
  const { state } = fixture(t);
  state.stage = 'review';
  const input = prompt(state);
  assert.match(input, /検証タスクで直した差分.*対象タスクのresult（executeのsummary）.*もとのタスクの番号.*その受け入れ条件も確認する/);
  assert.match(input, /満たしていなければoutcome=reviseとし、指摘にもとのタスクの番号と崩れた条件を書く/);
});

test('検証の省略・変更の指示と根拠の回答番号を渡す', t => {
  const { state, base } = fixture(t);
  state.answers = [{ answer: '理由付きで省略する' }, { answer: '理由は？', inquiry: true }];
  for (const [stage, patterns] of Object.entries({
    execute: [/自らの判断で省略しない/, /tasks.mdと受け入れ条件を編集せずoutcome=replan/],
    review: [/自らの判断で省略しない/, /検証が未実施ならrevise/],
    prereview: [/省略（所有者の判断: 回答#<n>、<理由>）/, /配列の1始まり/, /タスクと受け入れ条件を新しい方法に書き換える/],
    acceptance: [/実装をコードで確認/, /回答内容と照合/, /根拠のない省略があればrevise/, /report.verificationに未検証の項目と根拠の回答の番号/],
  })) {
    state.stage = stage;
    for (const pattern of patterns) assert.match(prompt(state), pattern);
  }
  assert.deepEqual(summary(state, base, true).answers.map(value => value.number), [1, 2]);
});

test('taskGateは未チェックと不正な省略を返し、指定OpenSpecルートを読む', t => {
  const { state, target } = fixture(t);
  const change = join(target, 'spec-store', 'openspec', 'changes', 'sample');
  mkdirSync(change, { recursive: true });
  Object.assign(state, { kind: 'change', change: 'sample', openspec: { root: join(target, 'spec-store') }, answers: [{ answer: '省略する' }, { inquiry: true }] });
  const lines = ['- [ ] 1. 未検証', '- [x] 2. 省略（所有者の判断: 回答#3、理由）', '- [x] 3. 省略（所有者の判断: 回答#2、理由）', '- [x] 4. 省略（所有者の判断: 回答#0、理由）'];
  writeFileSync(join(change, 'tasks.md'), lines.join('\n'));
  assert.deepEqual(taskGate(state), lines);
  writeFileSync(join(change, 'tasks.md'), '- [x] 1. ~~実機検証~~ 省略（所有者の判断: 回答#1、理由）\n- [x] 2. 試験済み');
  assert.deepEqual(taskGate(state), []);
});

test('acceptanceとarchiveはタスクの問題で完了を拒否し、読めなければfailed', async t => {
  const { state, target, base } = fixture(t);
  const change = join(target, 'openspec', 'changes', 'sample');
  mkdirSync(change, { recursive: true });
  Object.assign(state, { kind: 'change', change: 'sample', stage: 'acceptance', answers: [{ inquiry: true }, { answer: '続行' }] });
  for (const line of ['- [ ] 1. 未検証', '- [x] 1. 省略（所有者の判断: 回答#1、理由）', '- [x] 1. 省略（所有者の判断: 回答#3、理由）']) {
    writeFileSync(join(change, 'tasks.md'), line);
    Object.assign(state, { stage: 'acceptance', status: 'ready', revisions: 0 });
    await step(state, async () => ok(), base);
    assert.equal(state.stage, 'prereview');
    assert.equal(state.status, 'ready');
    assert.equal(state.revisions, 1);
    assert.ok(state.lastResult.includes(line));
    state.status = 'completed';
    await assert.rejects(archive(state, base, async () => assert.fail('OpenSpecを呼ばない')), /tasks.md/);
    assert.equal(state.status, 'completed');
  }
  assert.match(readFileSync(join(base, state.id, 'events.jsonl'), 'utf8'), /archive_failed/);
  writeFileSync(join(change, 'tasks.md'), '- [x] 1. 検証済み');
  Object.assign(state, { status: 'ready', stage: 'acceptance' });
  await step(state, async () => ok(), base);
  assert.equal(state.status, 'completed');
  rmSync(join(change, 'tasks.md'));
  Object.assign(state, { status: 'ready', stage: 'acceptance' });
  await step(state, async () => ok(), base);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /tasks.md/);
});

test('短い要約は履歴数によらず報告と外部証拠を制限する', t => {
  const { state, base } = fixture(t);
  const view = summary(state, base);
  view.latestReport = { attempt: 40, report: { ...report, scope: '長'.repeat(1000), decisions: ['理'.repeat(1000)] }, log: '元ログ' };
  view.externalEvidence = [{ name: '測定', valid: false, expiresAt: '期限', content: '本文', host: 'ホスト' }];
  const first = brief(view);
  view.history = Array.from({ length: 40 }, () => ({ report, log: '長'.repeat(1000) }));
  assert.deepEqual(brief(view), first);
  assert.equal(first.latestReport.report.scope.length, 500);
  assert.equal(first.latestReport.report.decisions[0].length, 500);
  assert.deepEqual(Object.keys(first.latestReport), ['attempt', 'report']);
  assert.deepEqual(first.externalEvidence, [{ name: '測定', valid: false, expiresAt: '期限' }]);
  assert.ok(!Object.hasOwn(first, 'history'));
  assert.ok(!Object.hasOwn(first, 'selection'));
  assert.equal(view.history.length, 40);
});

for (const permission of [undefined, { network: true, paths: [] }]) {
  test(`確認の質問は回答や許可にせず再開し待機へ戻る（権限要求=${Boolean(permission)}）`, async t => {
    const { state, base } = fixture(t);
    state.stage = 'execute';
    state.status = 'waiting';
    state.question = '元の質問';
    if (permission) state.permission = permission;
    state.session = { stage: state.stage, ...attemptAssignment(state), sessionId: '保存セッション' };
    answer(state, 'その判断の理由は？', base, true);
    assert.equal(state.answers.at(-1).inquiry, true);
    assert.equal(state.question, '元の質問');
    assert.deepEqual(state.permission, permission);
    assert.equal(state.grants, undefined);
    assert.match(inputFor(state), /回答ではなく確認の質問/);
    assert.match(inputFor(state), /その判断の理由は？/);
    assert.equal(codexThread(state).threadId, '保存セッション');
    const session = state.session;
    delete state.session;
    assert.match(inputFor(state), /answersの最後がinquiry/);
    const context = JSON.parse(inputFor(state).split('\n').at(-1));
    assert.equal(context.question, '元の質問');
    assert.deepEqual(context.permission, permission);
    state.session = session;
    await step(state, async current => {
      assert.equal(codexThread(current).threadId, '保存セッション');
      assert.match(inputFor(current), /回答ではなく確認の質問/);
      return { ...ok(), outcome: permission ? 'permission' : 'question',
        question: '判断の理由を説明。元の質問', ...(permission ? { permission } : {}) };
    }, base);
    assert.equal(state.status, 'waiting');
    assert.deepEqual(state.permission, permission);
  });
}

for (const outcome of ['ok', 'partial', 'revise', 'approval', 'question', 'permission']) {
  test(`確認の質問の${outcome}は元の状態を保つ`, async t => {
    const { state, base } = fixture(t);
    Object.assign(state, { stage: 'execute', status: 'waiting', question: '元の質問',
      tasks: [{ ...task, status: 'pending' }], permission: { network: true, paths: [base] },
      approval: { status: 'approved', items: approvedItems, pending: [] }, partials: 2, revisions: 1, lastResult: '元の結果' });
    state.session = { stage: state.stage, ...attemptAssignment(state), sessionId: '保存セッション' };
    answer(state, '理由は？', base, true);
    const preserved = ['question', 'permission', 'approval', 'stage', 'tasks', 'partials', 'revisions', 'lastResult'];
    const before = structuredClone(state);
    await step(state, async () => ({ outcome, question: ' 別の説明 ', summary: '要約', permission: { paths: [] } }), base);
    for (const key of preserved) assert.deepEqual(state[key], before[key]);
    assert.equal(state.status, 'waiting');
    assert.equal(state.answers.at(-1).reply, '別の説明');
    assert.equal(state.answers.at(-1).deviation, ['question', 'permission'].includes(outcome) ? undefined : outcome);
    assert.equal(state.session.sessionId, '保存セッション');
    const view = summary(state, base);
    assert.equal(view.question, '元の質問');
    assert.equal(view.inquiry.question, '理由は？');
    assert.equal(brief(view).inquiry.reply, '別の説明');
    answer(state, '通常の回答', base);
    assert.match(inputFor(state), /^通常の回答\n.*自動レビュー/);
    assert.equal(codexThread(state).threadId, '保存セッション');
    assert.ok(codexArgs(state).includes('sandbox_mode="workspace-write"'));
  });
}

for (const stage of ['execute', 'prereview']) {
  test(`${stage}の確認の質問は読み取り専用で工程の検証を呼ばない`, async t => {
    const { state, base } = fixture(t);
    Object.assign(state, { kind: 'change', change: 'sample-change', stage, status: 'waiting', question: '元の質問', grants: { network: true, paths: [base] } });
    answer(state, '理由は？', base, true);
    assert.equal(summary(state, base).inquiry, undefined);
    for (const resumed of [false, true]) {
      if (resumed) state.session = { stage, ...attemptAssignment(state), sessionId: '保存セッション' };
      const codex = codexArgs(state);
      assert.ok(codex.includes('sandbox_mode="read-only"'));
      assert.ok(!codex.some(arg => /writable_roots|network_access/.test(arg)));
      const claude = claudeArgs(state, '新規');
      assert.equal(claude[claude.indexOf('--tools') + 1], 'Read,Glob,Grep');
      assert.deepEqual(claude.slice(claude.indexOf('--allowedTools') + 1), ['Read', 'Glob', 'Grep']);
      assert.ok(!claude.includes('--add-dir'));
    }
    await nativeStep(state, async () => ({ outcome: 'ok', summary: '説明' }), base, passed, async () => ({ limits: null, failure: null }),
      async () => assert.fail('確認の質問では検証しない'));
    assert.equal(state.status, 'waiting');
    assert.equal(state.stage, stage);
    assert.equal(state.answers.at(-1).reply, '説明');
    state.answers.at(-1).reply = '長'.repeat(600);
    assert.equal(brief(summary(state, base)).inquiry.reply.length, 500);
  });
}

for (const kind of ['error', 'empty', 'invalid', 'exception', 'limited']) {
  test(`確認の質問の失敗を記録する: ${kind}`, async t => {
    const { state, base } = fixture(t);
    Object.assign(state, { stage: 'execute', status: 'waiting', question: '元の質問', permission: { network: true, paths: [] } });
    answer(state, '理由は？', base, true);
    await step(state, async (current, dir) => {
      if (kind === 'exception') {
        writeFileSync(join(dir, 'invocation.json'), JSON.stringify({ sessionId: 'エラー時のセッション' }));
        throw new Error('実行時エラー');
      }
      if (kind === 'limited') throw Object.assign(new Error('利用枠不足'), { limited: true });
      if (kind === 'invalid') return null;
      return { outcome: kind === 'error' ? 'error' : 'ok', summary: kind === 'empty' ? ' ' : 'エラーの説明' };
    }, base);
    assert.equal(state.status, kind === 'limited' ? 'limited' : 'waiting');
    assert.equal(state.question, '元の質問');
    assert.deepEqual(state.permission, { network: true, paths: [] });
    assert.equal(state.failureStreak, undefined);
    if (kind === 'exception') assert.equal(state.session.sessionId, 'エラー時のセッション');
    if (kind !== 'limited') {
      assert.ok(state.answers.at(-1).reply);
      assert.equal(state.answers.at(-1).deviation, 'error');
    }
  });
}

test('確認の質問の説明は空のquestionならsummaryを使う', t => {
  const { state, base } = fixture(t);
  state.status = 'waiting';
  answer(state, '理由は？', base, true);
  resolveInquiry(state, { outcome: 'question', question: ' ', summary: '要約' });
  assert.equal(state.answers.at(-1).reply, '要約');
  state.status = 'ready';
  assert.equal(summary(state, base).inquiry, undefined);
});

test('承認待ちへの確認の質問は保存状態も変更しない', t => {
  const { state, base } = fixture(t);
  state.status = 'waiting';
  state.approval = { status: 'pending', items: [], pending: approvedItems };
  state.permission = { network: true, paths: [] };
  save(state, base);
  const before = structuredClone(state);
  const saved = load(state.id, base);
  assert.throws(() => answer(state, '理由は？', base, true), /承認待ち/);
  assert.deepEqual(state, before);
  assert.deepEqual(load(state.id, base), saved);
});

test('全工程で質問だけで判断できる理由・選択肢・影響と権限要求の説明を求める', t => {
  const { state } = fixture(t);
  for (const stage of ['plan', 'prereview', 'execute', 'review', 'acceptance']) {
    state.stage = stage;
    const input = prompt(state);
    for (const text of ['他の資料を読まなくてもそれだけで判断できる', '判断が必要な理由',
      '選択肢とそれぞれの影響（作業量・リスク・後戻りの可否）', '推奨があれば推奨と理由',
      'permissionでは必要な理由と許可しない場合の影響']) assert.ok(input.includes(text), `${stage}: ${text}`);
  }
});

test('実行前レビューはユーザーの作業をまとめ、依頼回数と根拠を求める', t => {
  const { state } = fixture(t);
  state.stage = 'prereview';
  const input = prompt(state);
  for (const text of ['ユーザーの作業（ビルド、実機・手動確認、外部での承認や操作）',
    '依存関係と検証可能性を損なわない範囲', '先行するソースコード変更をまとめてから一度に依頼する順序と粒度',
    '承認計画の項目も同じ操作はまとめる', 'decisions.applicabilityにユーザーへの依頼回数とその根拠']) assert.ok(input.includes(text));
  state.stage = 'plan';
  assert.ok(!prompt(state).includes('ユーザーへの依頼回数'));
});

test('実行前レビューは統合と分割の基準を示し、根拠がなければ計画を変更しない', t => {
  const { state } = fixture(t);
  state.stage = 'prereview';
  const input = prompt(state);
  for (const text of ['同じモジュール', '同じ検証', '独立レビューで確認できる', '間にユーザーの作業や承認がなく',
    '承認の扱い・検証環境・必要な権限が異なる項目', '失敗時のやり直しが高くつく操作',
    'decisions.granularity', 'タイトルに含まれるtasks.mdの項目番号']) assert.ok(input.includes(text), text);
  const schema = JSON.parse(readFileSync(join(root, 'src/prereview.schema.json'), 'utf8'));
  assert.ok(schema.properties.decisions.required.includes('granularity'));
  const before = structuredClone(state);
  for (const granularity of [undefined, ' ']) {
    const result = prereviewResult(approvalItems);
    result.decisions.granularity = granularity;
    assert.throws(() => advance(state, result), /統合と分割の根拠/);
    assert.deepEqual(state, before);
  }
});

test('統合した実行タスクを実装・レビューし、最終確認で全項目を照合する', async t => {
  const { state, target, base } = fixture(t);
  Object.assign(state, { kind: 'change', stage: 'prereview' });
  const grouped = { ...task, title: '1.1・1.2 入力検証' };
  advance(state, { ...prereviewResult(), tasks: [grouped] });
  const change = join(target, 'openspec', 'changes', state.change);
  mkdirSync(change, { recursive: true });
  const tasksFile = join(change, 'tasks.md');
  const lines = ['- [ ] 1.1 空入力', '- [ ] 1.2 空白入力'];
  writeFileSync(tasksFile, lines.join('\n'));
  assert.deepEqual(taskGate(state), lines);
  for (const stage of ['execute', 'review']) {
    assert.equal(state.stage, stage);
    await step(state, async current => {
      assert.deepEqual(JSON.parse(prompt(current).split('\n').at(-1)).target, { index: 0, ...grouped });
      if (stage === 'execute') writeFileSync(tasksFile, lines.map(line => line.replace('[ ]', '[x]')).join('\n'));
      return ok();
    }, base);
  }
  assert.equal(state.stage, 'acceptance');
  assert.equal(state.tasks[0].status, 'completed');
  assert.deepEqual(taskGate(state), []);
  await step(state, async () => ok(), base);
  assert.equal(state.status, 'completed');
});

test('承認計画の必須項目を検証し、空配列を受理する', () => {
  const schema = JSON.parse(readFileSync(join(root, 'src/prereview.schema.json'), 'utf8'));
  assert.ok(schema.required.includes('approvals'));
  assert.deepEqual(schema.properties.approvals.items.required, ['tasks', 'action', 'limits', 'stopWhen', 'gate',
    'scripts', 'files', 'effect', 'costCheck', 'grants', 'replaces', 'basisAnswer']);
  assert.doesNotThrow(() => validateResult(prereviewResult(), 'prereview'));
  assert.doesNotThrow(() => validateResult(prereviewResult([{ ...approvalItems[0], costCheck: '' }]), 'prereview'));
  for (const approvals of [undefined, null, {}, [null], ...['tasks', 'action', 'limits', 'stopWhen', 'gate'].flatMap(key =>
    ['', ' ', undefined, 1].map(value => [{ ...approvalItems[0], [key]: value }])),
    ...[{ effect: 'unknown' }, { scripts: [1] }, { files: undefined }, { costCheck: undefined }, { grants: undefined },
      { grants: { network: 'true', paths: [] } }, { grants: { network: true, paths: [1] } },
      { grants: { network: false, paths: [], commands: [] } }].map(fields => [{ ...approvalItems[0], ...fields }])]) {
    assert.throws(() => validateResult({ ...prereviewResult(), approvals }, 'prereview'), /承認計画/);
  }
});

test('承認待ちの要約とダッシュボードに照合用の欄を表示する', t => {
  const { state, base } = fixture(t);
  state.stage = 'prereview';
  const item = { ...approvalItems[0], scripts: ['verify.ps1'], files: ['sample.txt'],
    grants: { network: true, paths: ['/extra'] } };
  advance(state, prereviewResult([item]));
  assert.deepEqual(summary(state, base).approval.pending[0], { ...item, id: 'A1', replaces: '', basisAnswer: 0 });
  save(state, base);
  const markdown = readFileSync(join(base, 'dashboard.md'), 'utf8');
  for (const text of ['スクリプト: verify.ps1', '対象ファイル: sample.txt', '影響: external',
    '費用確認: 起動前に見積額を確認', 'ネットワーク許可: true', 'パス許可: /extra']) assert.ok(markdown.includes(text), text);
});

test('照合用の欄を持たない旧項目は承認と継続で内容が変わらない', async t => {
  const { state, base } = fixture(t);
  const item = { id: 'A1', tasks: '1.1', action: '検証', limits: '1回', stopWhen: '失敗', gate: 'plan' };
  Object.assign(state, { kind: 'change', stage: 'execute', status: 'waiting',
    approval: { status: 'pending', items: [item], conditions: '' } });
  save(state, base);
  const legacy = load(state.id, base);
  await approve(legacy, '', base);
  assert.equal(legacy.status, 'ready');
  assert.deepEqual(legacy.approval.items, [item]);
  legacy.stage = 'prereview';
  advance(legacy, prereviewResult([], ['A1']));
  assert.equal(legacy.status, 'ready');
  assert.deepEqual(legacy.approval.items, [item]);
});

test('新しい計画は承認待ち、同じ承認済み計画と空配列は実装へ進む', async t => {
  const { state, base } = fixture(t);
  Object.assign(state, { kind: 'change', stage: 'prereview' });
  advance(state, prereviewResult(approvalItems));
  assert.equal(state.stage, 'execute');
  assert.equal(state.status, 'waiting');
  assert.equal(state.tasks[0].status, 'pending');
  assert.equal(state.approval.status, 'pending');
  assert.ok(Number.isFinite(Date.parse(state.approval.proposedAt)));
  assert.match(state.question, /承認計画.*1件/);
  const view = summary(state, base);
  assert.deepEqual(view.approval.pending, [{ ...approvedItems[0], replaces: '', basisAnswer: 0 }]);
  assert.match(view.nextAction, /承認計画.*1件/);
  save(state, base);
  const markdown = readFileSync(join(base, 'dashboard.md'), 'utf8');
  assert.match(markdown, /承認計画.*1件/);
  for (const key of ['tasks', 'action', 'limits', 'stopWhen']) assert.ok(markdown.includes(approvalItems[0][key]));
  await approve(state, '検証終了後にVMを停止する', base);
  const approval = structuredClone(state.approval);
  state.stage = 'prereview';
  advance(state, prereviewResult([], ['A1']));
  assert.equal(state.status, 'ready');
  assert.deepEqual(state.approval, approval);
  state.stage = 'prereview';
  advance(state, prereviewResult([{ ...approvalItems[0], limits: '合計€30以内', replaces: 'A1' }]));
  assert.equal(state.status, 'waiting');
  assert.equal(state.approval.status, 'pending');
  assert.deepEqual(state.approval.items, approval.items);
  assert.equal(state.approval.pending[0].id, 'A1');
  await approve(state, '停止を記録する', base);
  assert.deepEqual(state.approval.items.map(item => [item.id, item.limits]), [['A1', '合計€30以内']]);
  assert.equal(state.approval.items[0].conditions, '検証終了後にVMを停止する\n停止を記録する');
  assert.equal(state.approval.conditions, '');
  state.stage = 'prereview';
  const events = [];
  advance(state, prereviewResult(), { log: (type, detail) => events.push([type, detail.items?.[0].id]) });
  assert.equal(state.status, 'ready');
  assert.deepEqual(state.approval.items, []);
  assert.deepEqual(events, [['approval_removed', 'A1']]);
});

test('承認は計画・条件・日時とイベントを保存し、承認待ち以外を拒否する', async t => {
  const { state, base } = fixture(t);
  await assert.rejects(() => approve(state, '', base), /承認待ちでは/);
  state.stage = 'prereview';
  advance(state, prereviewResult(approvalItems));
  const proposedAt = state.approval.proposedAt;
  state.session = { stage: 'prereview', sessionId: '計画' };
  await approve(state, '合計€20以内', base);
  assert.equal(state.session, undefined);
  assert.equal(state.status, 'ready');
  assert.equal(state.stage, 'execute');
  assert.equal(state.question, '');
  assert.deepEqual(state.approval.items, [{ ...approvedItems[0], conditions: '合計€20以内' }]);
  assert.equal(state.approval.conditions, '');
  assert.equal(state.approval.proposedAt, proposedAt);
  assert.ok(Number.isFinite(Date.parse(state.approval.approvedAt)));
  assert.deepEqual(load(state.id, base).approval, state.approval);
  const events = readFileSync(join(base, state.id, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.at(-1).detail, state.approval);
  assert.equal(events.at(-1).type, 'approved');
  await assert.rejects(() => approve(state, '', base), /承認待ちでは/);
  state.status = 'waiting';
  await assert.rejects(() => approve(state, '', base), /承認待ちでは/);
});

test('承認は申告した許可を由来とともに保存し、存在するスクリプトを固定する', async t => {
  const { state, target, base } = fixture(t);
  const extra = join(target, '..', 'extra');
  mkdirSync(extra);
  const script = join(target, 'verify.ps1');
  writeFileSync(script, 'Write-Output ok');
  state.stage = 'prereview';
  state.grants = { network: false, paths: [], commands: ['git status'] };
  advance(state, prereviewResult([
    { ...approvalItems[0], scripts: ['verify.ps1', 'later.ps1'], grants: { network: true, paths: [extra] } },
    { ...approvalItems[0], gate: 'each', grants: { network: true, paths: [homedir()] } },
  ]));
  const seen = [];
  await approve(state, '', base, async (current, paths) => {
    assert.equal(current.status, 'waiting');
    seen.push(...paths);
  });
  assert.deepEqual(seen, [extra]);
  const grants = { network: true, paths: [extra], commands: ['git status'], sources: [{ approvalId: 'A1', network: true, paths: [extra] }] };
  assert.deepEqual(load(state.id, base).grants, grants);
  assert.match(state.approval.items[0].pinned['verify.ps1'].hash, /^[a-f0-9]{64}$/);
  assert.equal(state.approval.items[0].pinned['verify.ps1'].path, script);
  assert.equal(state.approval.items[0].pinned['later.ps1'], null);
  state.stage = 'prereview';
  advance(state, prereviewResult([], ['A2']));
  assert.deepEqual(state.grants, grants);
});

test('許可できないパス・アクセス確認の失敗・対象外のスクリプトでは承認前の状態を保つ', async t => {
  const { state, target, base } = fixture(t);
  for (const [item, expected, check] of [
    [{ grants: { network: true, paths: [homedir()] } }, /許可できない/, () => assert.fail('アクセス確認は不要')],
    [{ grants: { network: true, paths: [target] } }, /アクセス不可/, async () => { throw new Error('アクセス不可'); }],
    [{ scripts: ['../outside.ps1'] }, /相対パス/, passed],
  ]) {
    state.stage = 'prereview';
    advance(state, prereviewResult([approvalItems[0], { ...approvalItems[0], ...item }]));
    save(state, base);
    const before = structuredClone(state);
    await assert.rejects(approve(state, '', base, check), expected);
    assert.deepEqual(state, before);
    assert.deepEqual(load(state.id, base), before);
  }
});

test('部分承認は指定項目だけを固定して許可を反映し、残件とセッションを保持する', async t => {
  const { state, target, base } = fixture(t);
  const paths = ['extra1', 'extra2'].map(name => join(target, '..', name));
  paths.forEach(path => mkdirSync(path));
  const scripts = ['first.ps1', 'second.ps1'];
  scripts.forEach(script => writeFileSync(join(target, script), 'Write-Output ok'));
  state.stage = 'prereview';
  advance(state, prereviewResult(scripts.map((script, index) => ({
    ...approvalItems[0], scripts: [script], grants: { network: index === 1, paths: [paths[index]] },
  }))));
  const first = structuredClone(state.approval.pending[0]);
  const session = { stage: 'prereview', sessionId: '計画' };
  state.session = session;
  save(state, base);
  const before = structuredClone(state);
  await assert.rejects(approve(state, '', base, passed, ['A2', 'A9']), /項目ID/);
  assert.deepEqual(state, before);
  assert.deepEqual(load(state.id, base), before);
  await approve(state, '検証後に停止', base, async (_, granted) => assert.deepEqual(granted, [paths[1]]), ['A2']);
  assert.equal(state.status, 'waiting');
  assert.equal(state.approval.status, 'pending');
  assert.deepEqual(state.approval.pending, [first]);
  assert.match(state.question, /1件/);
  assert.equal(state.session, session);
  assert.deepEqual(load(state.id, base).session, session);
  assert.deepEqual(state.approval.items.map(item => item.id), ['A2']);
  assert.match(state.approval.items[0].pinned[scripts[1]].hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(state.grants.paths, [paths[1]]);
  assert.equal(state.grants.network, true);
  assert.deepEqual(state.grants.sources.map(source => source.approvalId), ['A2']);
  await approve(state, '', base, passed, ['A1']);
  assert.equal(state.status, 'ready');
  assert.equal(state.approval.status, 'approved');
  assert.deepEqual(state.approval.pending, []);
  assert.equal(state.session, undefined);
  assert.deepEqual(state.approval.items.map(item => [item.id, item.conditions]), [['A2', '検証後に停止'], ['A1', undefined]]);
  assert.equal(state.approval.conditions, '');
});

test('指定項目の承認で残りを保留し、有効な許可と外部への変更を警告する', async t => {
  const { state, target, base } = fixture(t);
  const extra = join(target, '..', 'extra');
  mkdirSync(extra);
  mkdirSync(join(extra, '..child'));
  const local = { ...approvalItems[0], effect: 'write', grants: { network: false, paths: [] } };
  state.stage = 'prereview';
  advance(state, prereviewResult([
    { ...local, grants: { network: true, paths: [extra] } },
    { ...local, grants: { network: true, paths: [join(extra, '..child')] } },
    { ...local, effect: 'external' },
    local,
  ]));
  state.session = { stage: 'prereview', sessionId: '計画' };
  save(state, base);
  const before = structuredClone(state);
  await assert.rejects(approve(state, '', base, passed, ['A1', 'A9'], true), /項目ID/);
  await assert.rejects(approve(state, '', base, passed, undefined, true), /項目ID/);
  assert.deepEqual(state, before);
  assert.deepEqual(load(state.id, base), before);

  const warnings = await approve(state, '承認条件', base, passed, ['A1'], true);
  assert.equal(state.status, 'ready');
  assert.equal(state.stage, 'execute');
  assert.equal(state.question, '');
  assert.equal(state.session, undefined);
  assert.equal(state.approval.status, 'approved');
  assert.equal(state.approval.deferredAt, state.approval.approvedAt);
  assert.deepEqual(state.approval.items.map(item => [item.id, item.conditions]), [['A1', '承認条件']]);
  assert.deepEqual(state.approval.pending, []);
  assert.deepEqual(state.approval.returned, before.approval.pending.slice(1));
  const view = summary(state, base, true);
  assert.deepEqual(view.approvalItems.map(item => [item.id, item.status]),
    [['A1', undefined], ['A2', 'deferred'], ['A3', 'deferred'], ['A4', 'deferred']]);
  assert.deepEqual(brief(view).deferredApprovals, state.approval.returned.map(({ id, tasks }) => ({ id, tasks })));
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /A2: ネットワーク許可.*パス許可.*sandbox/);
  assert.match(warnings[1], /A3: 外部への変更/);
  const events = readFileSync(join(base, state.id, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.find(entry => entry.type === 'approval_deferred').detail, { items: state.approval.returned, warnings });

  const all = structuredClone(before);
  const explicit = structuredClone(before);
  assert.deepEqual(await approve(all, '', base, passed), []);
  assert.deepEqual(await approve(explicit, '', base, passed, ['A1', 'A2', 'A3', 'A4'], true), []);
  const { approvedAt: allAt, ...allApproval } = all.approval;
  const { approvedAt: explicitAt, ...explicitApproval } = explicit.approval;
  assert.deepEqual(explicitApproval, allApproval);
  assert.deepEqual(explicit.grants, all.grants);
  assert.equal(explicit.status, all.status);
});

test('実行工程だけに保留中の項目と操作を止める指示を渡す', async t => {
  const { state, base } = fixture(t);
  const deferred = { ...approvalItems[0], tasks: '11.5', action: '追加検証を実施' };
  state.stage = 'prereview';
  advance(state, prereviewResult([approvalItems[0], deferred]));
  await approve(state, '', base, passed, ['A1'], true);
  for (const stage of ['execute', 'review', 'acceptance', 'prereview']) {
    const input = prompt({ ...state, stage });
    const data = JSON.parse(input.split('\n').at(-1));
    assert.deepEqual(data.approval.items.map(item => item.id), ['A1']);
    if (stage === 'execute') {
      assert.match(input, /deferredApprovalsの操作が必要になったら、その操作をせずにoutcome=approval/);
      assert.deepEqual(data.deferredApprovals, [{ id: 'A2', tasks: deferred.tasks, action: deferred.action }]);
    } else {
      assert.doesNotMatch(input, /deferredApprovals/);
      if (stage !== 'prereview') assert.doesNotMatch(input, /追加検証を実施/);
    }
  }
});

test('保留中の変更案は旧版も承認根拠から外れ、再提示時に審査せず承認待ちになる', async t => {
  const { state, base } = fixture(t);
  const local = { ...approvalItems[0], effect: 'write' };
  Object.assign(state, { kind: 'change', stage: 'prereview', change: 'sample-change' });
  advance(state, prereviewResult([local]));
  await approve(state, '引き継ぐ条件', base);
  state.stage = 'prereview';
  advance(state, prereviewResult([{ ...local, replaces: 'A1' }, local, local]));
  assert.deepEqual(await approve(state, '', base, passed, ['A2'], true), []);
  assert.deepEqual(state.approval.items.map(item => item.id), ['A2']);
  assert.deepEqual(state.approval.returned.map(item => item.id), ['A1', 'A3']);
  advance(state, { ...ok(), outcome: 'question', question: 'A1を再検討しますか' });
  answer(state, 'A1を出し直す', base);
  advance(state, { ...ok(), outcome: 'approval' });
  let reviewed = 0;
  await nativeStep(state, async () => prereviewResult([{ ...local, replaces: 'A1', basisAnswer: 1 }], ['A2']),
    base, passed, async () => ({ limits: null, failure: null }), async () => {}, async () => { reviewed++; });
  assert.equal(reviewed, 0);
  assert.equal(state.status, 'waiting');
  assert.deepEqual(state.approval.items.map(item => item.id), ['A2']);
  assert.deepEqual(state.approval.pending.map(item => [item.id, item.conditions]), [['A1', '引き継ぐ条件']]);
  assert.deepEqual(state.approval.returned, []);
  assert.ok(!Object.hasOwn(state.approval, 'deferredAt'));
  const events = readFileSync(join(base, state.id, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.find(entry => entry.type === 'approval_removed' && entry.detail.reason === 'returned')
    .detail.items.map(item => item.id), ['A3']);
});

test('f894917bの回答は部分承認がある場合だけA2〜A8を継続できる', async t => {
  const initial = Array.from({ length: 8 }, (_, index) => ({ ...approvalItems[0], action: `操作${index + 1}` }));
  const followup = ['A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'];
  const revised = prereviewResult([{ ...initial[0], action: '再検討した操作', replaces: 'A1', basisAnswer: 1 }], followup);
  for (const partial of [false, true]) {
    const { state, base } = fixture(t);
    Object.assign(state, { kind: 'change', stage: 'prereview', change: 'sample-change' });
    advance(state, prereviewResult(initial));
    if (partial) await approve(state, '', base, passed, followup);
    answer(state, partial ? 'A1は再検討' : 'A1は再検討、ほかはok', base);
    const before = structuredClone(state.approval);
    assert.deepEqual(before.returned.map(item => item.id), partial ? ['A1'] : ['A1', ...followup]);
    let reviewed = 0;
    await nativeStep(state, async () => revised, base, passed, async () => ({ limits: null, failure: null }), async () => {},
      async () => { reviewed++; });
    assert.equal(reviewed, 0);
    if (partial) {
      assert.equal(state.status, 'waiting');
      assert.deepEqual(state.approval.items.map(item => item.id), followup);
      assert.deepEqual(state.approval.pending.map(item => item.id), ['A1']);
      assert.deepEqual(state.approval.returned, []);
    } else {
      assert.equal(state.status, 'failed');
      assert.match(state.error, /継続・変更のIDが不正/);
      assert.deepEqual(load(state.id, base).approval, before);
    }
  }
});

test('承認計画へのanswerは回答を保存して実行前レビューへ差し戻す', t => {
  const { state, base } = fixture(t);
  state.stage = 'prereview';
  advance(state, prereviewResult(Array.from({ length: 8 }, () => approvalItems[0])));
  const proposed = structuredClone(state.approval.pending);
  const question = state.question;
  const session = { stage: 'prereview', sessionId: '計画' };
  state.session = session;
  answer(state, 'VMは使用しない', base);
  assert.equal(state.status, 'ready');
  assert.equal(state.stage, 'prereview');
  assert.deepEqual(state.approval.items, []);
  assert.deepEqual(state.approval.pending, []);
  assert.deepEqual(state.approval.returned, proposed);
  assert.equal(state.approval.nextId, 9);
  assert.deepEqual(state.session, session);
  assert.deepEqual(state.answers.at(-1), { stage: 'execute', question, answer: 'VMは使用しない', approval: true });
  assert.deepEqual(load(state.id, base).session, session);
  assert.equal(load(state.id, base).stage, 'prereview');
  assert.deepEqual(load(state.id, base).approval, state.approval);
  assert.deepEqual(summary(state, base, true).approvalItems.map(item => [item.id, item.status]),
    proposed.map(item => [item.id, 'returned']));
  assert.ok(!Object.hasOwn(brief(summary(state, base)), 'deferredApprovals'));
  advance(state, prereviewResult(approvalItems));
  assert.equal(state.approval.pending[0].id, 'A9');
});

test('approval結果は実装だけで有効で、完了タスクと承認を保持し手戻りに数えない', async t => {
  const { state, base } = fixture(t);
  state.kind = 'change';
  state.stage = 'prereview';
  advance(state, prereviewResult(approvalItems));
  await approve(state, '', base);
  state.tasks.unshift({ ...task, status: 'completed', result: '検証済み' });
  const tasks = structuredClone(state.tasks);
  const approval = structuredClone(state.approval);
  const result = { ...ok(), outcome: 'approval', summary: '費用上限の変更が必要' };
  const schema = JSON.parse(readFileSync(join(root, 'src/result.schema.json'), 'utf8'));
  assert.ok(schema.properties.outcome.enum.includes('approval'));
  for (const stage of ['plan', 'prereview', 'review', 'acceptance']) {
    assert.throws(() => validateResult(result, stage), /使えない結果/);
  }
  for (let count = 1; count <= 4; count++) {
    state.stage = 'execute';
    advance(state, result);
    assert.equal(state.revisions, 0);
    assert.equal(state.stage, 'prereview');
    assert.equal(state.status, 'ready');
    assert.deepEqual(state.tasks, tasks);
    assert.deepEqual(state.approval, approval);
    assert.equal(state.lastResult, result.summary);
  }
});

test('retry・partial・revise・証拠登録は承認計画と条件を保持する', async t => {
  const { state, base, target } = fixture(t);
  state.kind = 'change';
  state.stage = 'prereview';
  advance(state, prereviewResult(approvalItems));
  await approve(state, '検証後に停止', base);
  assert.match(prompt(state), /入力のapprovalで承認済みの項目の範囲を除き/);
  assert.match(prompt(state), /範囲内の操作は質問せず/);
  assert.match(prompt(state), /停止条件.*outcome=approval/);
  assert.match(prompt(state), /report.decisionsに使った承認項目/);
  const approval = structuredClone(state.approval);
  state.status = 'failed';
  retry(state, base);
  assert.deepEqual(state.approval, approval);
  advance(state, { ...ok(), outcome: 'partial' });
  assert.deepEqual(state.approval, approval);
  state.stage = 'review';
  advance(state, revise);
  assert.deepEqual(state.approval, approval);
  const path = join(target, '測定.json');
  writeFileSync(path, JSON.stringify({ name: 'memory', subject: '検証用容量', host: 'test-host', method: '試験用測定',
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), content: '8 GiB' }));
  registerEvidence(state, path, base);
  assert.deepEqual(state.approval, approval);
  assert.deepEqual(load(state.id, base).approval, approval);
});

test('実行前レビューの新規入力と再開入力は同じ継続・変更元IDを渡す', t => {
  const { state } = fixture(t);
  const [approved] = approvedItems;
  const returned = { ...approved, id: 'A2', action: '再検討する操作' };
  Object.assign(state, { kind: 'change', stage: 'prereview',
    approval: { status: 'approved', items: [approved], returned: [returned], conditions: '' },
    answers: [{ approval: true, answer: 'A2は再検討' }] });
  const full = JSON.parse(inputFor(state).split('\n').at(-1));
  assert.deepEqual(full.approval, { items: [approved], returned: [returned], conditions: '' });
  assert.deepEqual(full.approvalIds, { retain: ['A1'], replace: ['A1', 'A2'] });
  state.session = { ...attemptAssignment(state), stage: state.stage, sessionId: '計画' };
  const resumed = inputFor(state);
  assert.match(resumed, /承認計画への所有者の回答.*\nA2は再検討/);
  assert.ok(!resumed.includes(returned.action));
  assert.deepEqual(JSON.parse(resumed.split('\n').at(-1)), full.approvalIds);
});

test('実行前レビューと実装の新規入力は項目の条件と旧状態の全体条件を渡す', async t => {
  const { state, base } = fixture(t);
  const input = () => JSON.parse(prompt(state).split('\n').at(-1));
  assert.equal(input().approval, undefined);
  state.stage = 'prereview';
  assert.match(prompt(state), /未完了の全タスク/);
  assert.match(prompt(state), /retainedApprovals/);
  assert.match(prompt(state), /個別|1回ごとの承認/);
  advance(state, prereviewResult([approvalItems[0], approvalItems[0]]));
  assert.equal(input().approval, undefined);
  state.approval.conditions = '旧状態の全体条件';
  await approve(state, '検証後に停止', base, passed, ['A1']);
  await approve(state, '', base);
  const items = [{ ...approvedItems[0], conditions: '検証後に停止' }, { ...approvedItems[0], id: 'A2' }];
  for (const stage of ['execute', 'prereview']) {
    state.stage = stage;
    assert.deepEqual(input().approval, { items, conditions: '旧状態の全体条件',
      ...(stage === 'prereview' ? { returned: [] } : {}) });
  }
});

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
    if (current.attempts === 2) return ok([task]);
    writeFileSync(join(dir, 'codex.jsonl'), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 5 } }) + '\n{"中断');
    throw new Error('接続失敗');
  }, base);
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
  assert.deepEqual(calls.map(call => call[3]), [undefined, undefined, undefined, 120_000, 120_000]);
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

test('registered Core失敗はモデル0回で固定原因だけを状態とpreflightへ保存する', async t => {
  const { state, base } = fixture(t);
  await checkedStep(state, () => assert.fail('モデルを呼ばない'), base, value => preflight(value, async (_, args) => {
    if (args[0] === 'sandbox') return checkCommand(process.execPath,
      ['-e', 'console.error("registered Core launch requires an installed app secret-value"); process.exit(1)'], state.target);
    return '';
  }));
  assert.equal(state.status, 'failed');
  assert.equal(state.attempts, 0);
  const persisted = load(state.id, base);
  assert.match(persisted.error, /registered Core起動に失敗/);
  assert.match(persisted.error, /終了コード 1/);
  const dir = join(base, state.id);
  const record = readFileSync(join(dir, readdirSync(dir).find(name => name.startsWith('preflight-'))), 'utf8');
  assert.match(record, /registered Core起動に失敗/);
  for (const text of [JSON.stringify(persisted), record]) {
    assert.ok(!text.includes('secret-value'));
    assert.ok(!text.includes('requires an installed app'));
  }
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
  assert.equal(checks, 2);
  state.status = 'ready';
  state.stage = 'plan';
  await checkedStep(state, runner, base, check);
  assert.equal(checks, 3);
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
  await step(state, async () => ({ report, returnTo: 'none', outcome: 'question', cause: '', summary: '保存先が不明', question: '保存先は？', tasks: [] }), base);
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

test('計画への差し戻しと最終確認の差し戻しが合計4回になると停止する', t => {
  const { state } = fixture(t);
  state.kind = 'change';
  for (let i = 0; i < 4; i++) {
    state.stage = i % 2 ? 'acceptance' : 'review';
    advance(state, state.stage === 'review' ? revise : { ...revise, returnTo: 'none' });
    assert.equal(state.stage, 'prereview');
    assert.equal(state.status, i < 3 ? 'ready' : 'blocked');
  }
  assert.equal(state.status, 'blocked');
  assert.equal(state.revisions, 4);
});

test('実装の途中終了は正常系で、同じ工程の実行待ちに戻り、上限で停止する', t => {
  const { state } = fixture(t);
  state.tasks = [{ ...task, status: 'pending' }];
  state.stage = 'execute';
  const partial = { report, returnTo: 'none', outcome: 'partial', cause: '', summary: '半分完了', question: '', tasks: [] };
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
  advance(state, { report, returnTo: 'none', outcome: 'permission', cause: '', summary: '遮断', question: 'npm installに必要', permission: { network: true, paths: [outside] }, tasks: [] });
  assert.equal(state.status, 'waiting');
  assert.equal(summary(state, base).permission.network, true);
  await assert.rejects(grant(state, { paths: [homedir()] }, base, passed), /許可できない/);
  await grant(state, { network: true, paths: [outside] }, base, passed);
  assert.equal(state.status, 'ready');
  assert.ok(codexArgs(state).includes('sandbox_workspace_write.network_access=true'));
  assert.ok(codexArgs(state).some(arg => arg.startsWith('sandbox_workspace_write.writable_roots=')));
  assert.throws(() => validateResult({ report, returnTo: 'none', outcome: 'permission', cause: '', summary: 'x', question: 'y', permission: { network: false, paths: [] }, tasks: [] }, 'execute'), /権限要求/);
});

test('アクセス確認に失敗した許可は保存せず、修正後に同じパスで再開できる', async t => {
  const { state, base, target } = fixture(t);
  state.stage = 'execute';
  const permission = { network: true, paths: [target] };
  advance(state, { report, returnTo: 'none', outcome: 'permission', cause: '', summary: '遮断', question: 'アクセスが必要', permission, tasks: [] });
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
  assert.deepEqual(args.slice(0, 5), ['sandbox', '-P', process.platform === 'win32' ? 'workflow-grant' : ':workspace', '-C', target]);
  const roots = [base, target, join(base, 'openspec', 'changes', 'sample')];
  if (process.platform === 'win32') {
    assert.ok(args.includes('permissions.workflow-grant.extends=":workspace"'));
    assert.ok(args.includes(`permissions.workflow-grant.workspace_roots={${[...new Set([target, ...roots])].map(path => `${JSON.stringify(path)}=true`).join(',')}}`));
    assert.ok(!args.some(arg => arg.startsWith('sandbox_workspace_write.')));
  } else assert.ok(args.includes(`sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`));
  assert.ok(args.at(-1).includes('readdirSync'));
  await assert.rejects(checkGrantAccess(state, [target], async () => { throw new Error('secret'); }), error => error.message.includes(target) && !error.message.includes('secret'));
  state.stage = 'execute';
  advance(state, { report, returnTo: 'none', outcome: 'permission', cause: '', summary: '遮断', question: 'ネットワークが必要', permission: { network: true, paths: [] }, tasks: [] });
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
  assert.equal(existsSync(join(base, state.id, 'attempt-0003', 'result.json')), true);
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
    const args = codexArgs(state);
    assert.equal(args[0], 'app-server');
    assert.equal(codexThread(state).sandbox, stage === 'execute' ? 'workspace-write' : 'read-only');
    assert.ok(!args.includes('--ephemeral'));
    assert.ok(!codexThread(state).threadId);
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
  fakeCodex(fake, `
      if (!input.includes('入力を検証して保存する')) process.exit(2);
      console.error('進捗');
      finish(${JSON.stringify(ok([task]))});`);
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
    return { report, returnTo: 'none', outcome: 'question', cause: '', summary: '入力形式の確認', question: '入力形式は？', tasks: [] };
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
  assert.equal(calls, 2);
  assert.equal(state.status, 'failed');
  state.status = 'ready';
  state.stage = 'review';
  state.revisions = 3;
  state.tasks = [{ ...task, status: 'pending' }];
  await run(state, async () => { calls++; return revise; }, base);
  assert.equal(calls, 3);
  assert.equal(state.status, 'blocked');
});

test('エージェントが報告した環境エラーは質問待ちにせず失敗として保存する', async t => {
  const { state, base } = fixture(t);
  await run(state, async () => ({ report, returnTo: 'none', outcome: 'error', cause: 'environment', summary: 'サンドボックス初期化に失敗', question: '', tasks: [] }), base);
  const saved = load(state.id, base);
  assert.equal(saved.status, 'failed');
  assert.equal(saved.stage, 'plan');
  assert.equal(saved.question, '');
  assert.match(saved.error, /初期化に失敗/);
  assert.match(readFileSync(join(base, state.id, 'events.jsonl'), 'utf8'), /"type":"failed"/);
});

test('空の原因区分は報告された障害とせずinvalidで一度再試行する', async t => {
  const { state, base } = fixture(t);
  await step(state, async () => ({ ...ok(), outcome: 'error', summary: '原因の報告' }), base);
  assert.equal(state.status, 'failed');
  assert.deepEqual(state.failureStreak.entries.map(entry => entry.kind), ['invalid', 'invalid']);
  assert.match(state.error, /原因の区分cause/);
});

test('ハートビート保存失敗はprocessとして一度再試行する', async t => {
  const { state, base } = fixture(t);
  const dashboardPath = join(base, 'dashboard.json');
  t.mock.timers.enable({ apis: ['setInterval'] });
  await step(state, async () => {
    const dashboard = readFileSync(dashboardPath);
    try {
      writeFileSync(dashboardPath, '{');
      t.mock.timers.tick(10_000);
    } finally { writeFileSync(dashboardPath, dashboard); }
    return ok([task]);
  }, base);
  assert.equal(state.status, 'failed');
  assert.deepEqual(state.failureStreak.entries.map(entry => entry.kind), ['process', 'process']);
  assert.match(state.error, /JSON/);
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
  assert.deepEqual(context.changedFiles.files.sort(), ['deleted.txt', 'edited.txt', 'new.txt']);
  assert.equal(context.changedFiles.total, 3);
});

test('実装の実行で記録した変更ファイルが保存され、次のレビューへ渡る', async t => {
  const { state, base, target } = fixture(t);
  execFileSync('git', ['init', '--quiet', target]);
  const fake = join(target, 'execute.cjs');
  fakeCodex(fake, `
      fs.writeFileSync('feature.js', 'export const feature = true;');
      finish(${JSON.stringify(ok())});`);
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
  assert.deepEqual(reviewContext.evidence[0], {
    attempt: 1, before: saved.evidence[0].before, after: saved.evidence[0].after, log: saved.evidence[0].log,
  });
  assert.deepEqual(reviewContext.changedFiles, { files: ['feature.js'], total: 1 });
});

test('reviewの入力は、前後の記録とログのパスを残し、3000件の変更ファイルを100件に収める', t => {
  const { state } = fixture(t);
  const entry = { attempt: 1, before: 'before.json', after: 'after.json', log: 'codex.jsonl' };
  const files = Array.from({ length: 3000 }, (_, index) => `src/file-${index}.js`);
  Object.assign(state, { stage: 'review', evidence: [{ ...entry, changedFiles: files }] });
  const input = prompt(state);
  assert.match(input, /evidenceの実装前後の記録とchangedFilesを使い/);
  assert.match(input, /evidence\.logのCLI実行ログ/);
  const context = JSON.parse(input.split('\n').at(-1));
  assert.deepEqual(context.evidence, [entry]);
  assert.deepEqual(context.changedFiles, { files: files.slice(0, 100), total: 3000 });
  assert.deepEqual(state.evidence, [{ ...entry, changedFiles: files }]);
});

test('20試行の大量の証拠があっても全工程の入力は要求と回答の本文を除いて2万字以下になる', t => {
  const { state } = fixture(t);
  Object.assign(state, {
    requirement: '要求の本文'.repeat(5000), answers: [{ answer: '回答の本文'.repeat(5000) }],
    tasks: [{ ...task, status: 'pending' }], taskStartAttempt: 0, evidence: largeStageEvidence(),
  });
  for (const kind of ['request', 'change']) {
    const planningStage = kind === 'request' ? 'plan' : 'prereview';
    for (const stage of [planningStage, 'execute', 'review', 'acceptance']) {
      const input = prompt({ ...state, kind, stage, change: kind === 'change' ? 'sample' : undefined });
      const jsonStart = input.lastIndexOf('\n') + 1;
      const context = JSON.parse(input.slice(jsonStart));
      assert.equal(context.evidence.length, kind === 'change' && stage === 'execute' ? 0 : 20);
      assert.equal(context.changedFiles.total, 60000);
      context.requirement = '';
      for (const answer of context.answers) answer.answer = '';
      const length = jsonStart + JSON.stringify(context).length;
      assert.ok(length <= 20000, `${kind}/${stage}の入力は${length}字`);
    }
  }
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


test('tasks.mdの完了状態によらずexecuteとreviewは同じtargetを使う', async t => {
  const { state, base, target } = fixture(t);
  state.kind = 'change';
  state.stage = 'prereview';
  advance(state, { ...prereviewResult(), tasks: [task, { title: '次', acceptance: '次の条件' }] });
  const input = () => JSON.parse(prompt(state).split('\n').at(-1));
  const expected = { index: 0, ...task };
  assert.deepEqual(input().target, expected);
  await step(state, async () => {
    writeFileSync(join(target, 'tasks.md'), '- [x] 入力検証\n- [ ] 次\n');
    return ok();
  }, base);
  assert.deepEqual(input().target, expected);
  assert.equal(state.work.scope, task.title);
  await step(state, async () => ok(), base);
  assert.deepEqual(input().target, { index: 1, title: '次', acceptance: '次の条件' });
  state.stage = 'acceptance';
  assert.ok(!Object.hasOwn(input(), 'target'));
});

test('全工程でerrorの原因区分を要求する', t => {
  const { state } = fixture(t);
  for (const file of ['result', 'prereview']) {
    const schema = JSON.parse(readFileSync(join(root, `src/${file}.schema.json`), 'utf8'));
    assert.ok(schema.required.includes('cause'));
    assert.deepEqual(schema.properties.cause.enum, ['', 'transient', 'environment']);
  }
  for (const stage of ['plan', 'prereview', 'execute', 'review', 'acceptance']) {
    state.stage = stage;
    assert.match(prompt(state), /区分の判断がつかなければenvironment/);
    for (const cause of ['', undefined, 'other']) {
      assert.throws(() => validateResult({ ...ok(), outcome: 'error', cause }, stage), /原因の区分cause/);
    }
    for (const cause of ['transient', 'environment']) {
      assert.doesNotThrow(() => validateResult({ ...ok(), outcome: 'error', cause }, stage));
    }
  }
});

test('returnToはreviewのreviseだけが差し戻し先を指定できる', () => {
  for (const file of ['result', 'prereview']) {
    const schema = JSON.parse(readFileSync(join(root, `src/${file}.schema.json`), 'utf8'));
    assert.ok(schema.required.includes('returnTo'));
  }
  for (const stage of ['plan', 'prereview', 'execute', 'review', 'acceptance']) {
    for (const outcome of ['ok', 'question', 'revise', 'error', 'partial', 'permission', 'approval']) {
      const valid = stage === 'review' && outcome === 'revise' ? ['execute', 'prereview'] : ['none'];
      for (const returnTo of [undefined, 'invalid', 'none', 'execute', 'prereview']) {
        if (valid.includes(returnTo)) continue;
        const result = { ...ok([task]), outcome, cause: outcome === 'error' ? 'environment' : '', returnTo, question: '確認', permission: { network: true, paths: [] } };
        assert.throws(() => validateResult(result, stage));
      }
    }
  }
  for (const returnTo of ['execute', 'prereview']) assert.equal(validateResult({ ...revise, returnTo }, 'review').returnTo, returnTo);
});

test('同じタスクの実装差し戻しは4回目で回答待ちになり、指示を回答すると回数が戻る', t => {
  const { state, base } = fixture(t);
  state.attempts = 1;
  advance(state, ok([task]));
  const input = () => JSON.parse(prompt(state).split('\n').at(-1));
  const expected = input().target;
  for (let count = 1; count <= 4; count++) {
    advance(state, ok());
    advance(state, { ...revise, returnTo: 'execute' });
    assert.equal(state.tasks[0].status, 'pending');
    assert.equal(state.tasks[0].revisions, count);
    assert.equal(state.stage, 'execute');
    assert.equal(state.status, count < 4 ? 'ready' : 'waiting');
    assert.equal(input().previous, revise.summary);
    assert.deepEqual(input().target, expected);
    assert.equal(state.taskStartAttempt, 1);
  }
  assert.equal(state.revisions, 0);
  for (const text of [revise.summary, '指示を加えて続行', '計画見直し', 'close']) assert.ok(state.question.includes(text));
  answer(state, '差し戻しの根拠は？', base, true);
  assert.equal(state.tasks[0].revisions, 4);
  state.status = 'waiting';
  answer(state, '指摘された入力条件を追加する', base);
  assert.equal(state.tasks[0].revisions, undefined);
  assert.equal(state.status, 'ready');
  assert.equal(state.stage, 'execute');
  assert.equal(input().answers.at(-1).answer, '指摘された入力条件を追加する');
  advance(state, ok());
  advance(state, { ...revise, returnTo: 'execute' });
  assert.equal(state.tasks[0].revisions, 1);
});

test('承認要求の後に別々の3タスクが実装差し戻しを受けても止まらない', t => {
  const { state } = fixture(t);
  const tasks = Array.from({ length: 3 }, (_, i) => ({ ...task, title: `タスク ${i + 1}` }));
  advance(state, ok(tasks));
  advance(state, { ...ok(), outcome: 'approval' });
  assert.equal(state.stage, 'plan');
  advance(state, ok(tasks));
  for (const [index] of tasks.entries()) {
    advance(state, ok());
    advance(state, { ...revise, returnTo: 'execute' });
    assert.equal(state.status, 'ready');
    assert.equal(state.tasks[index].revisions, 1);
    advance(state, ok());
    advance(state, ok());
  }
  assert.equal(state.stage, 'acceptance');
  assert.equal(state.revisions, 0);
});

test('executeとreviewの証拠はタスク開始以降のpartialと再実装を含み、次タスクとは分離する', t => {
  const { state } = fixture(t);
  const input = () => JSON.parse(prompt(state).split('\n').at(-1));
  state.attempts = 1;
  advance(state, ok([task, { title: '次', acceptance: '次の条件' }]));
  assert.equal(state.taskStartAttempt, 1);
  state.evidence = [{ attempt: 0 }, { attempt: 2 }];
  state.attempts = 2;
  advance(state, { ...ok(), outcome: 'partial' });
  assert.equal(state.stage, 'execute');
  assert.deepEqual(input().evidence, [{ attempt: 2 }]);
  state.evidence.push({ attempt: 3 });
  state.attempts = 3;
  advance(state, ok());
  assert.deepEqual(input().evidence, [{ attempt: 2 }, { attempt: 3 }]);
  state.attempts = 4;
  advance(state, { ...revise, returnTo: 'execute' });
  assert.deepEqual(input().evidence, [{ attempt: 2 }, { attempt: 3 }]);
  state.evidence.push({ attempt: 5 });
  state.attempts = 5;
  advance(state, ok());
  assert.deepEqual(input().evidence, [{ attempt: 2 }, { attempt: 3 }, { attempt: 5 }]);
  state.attempts = 6;
  advance(state, ok());
  assert.equal(state.taskStartAttempt, 6);
  assert.equal(state.stage, 'execute');
  assert.deepEqual(input().evidence, []);
  state.evidence.push({ attempt: 7 });
  state.attempts = 7;
  advance(state, ok());
  assert.deepEqual(input().evidence, [{ attempt: 7 }]);
  state.attempts = 8;
  advance(state, ok());
  assert.equal(state.stage, 'acceptance');
  assert.deepEqual(input().evidence, state.evidence);
  delete state.taskStartAttempt;
  for (const stage of ['execute', 'review']) {
    state.stage = stage;
    assert.deepEqual(input().evidence, state.evidence);
  }
  advance(state, revise);
  state.attempts = 9;
  advance(state, ok([task]));
  assert.equal(state.taskStartAttempt, 9);
});
