import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { root, create, answer, lock, summary, load, list, retry } from '../src/workflow.js';
import { run } from '../src/executor.js';

const parent = join(root, 'agent-docs');
mkdirSync(parent, { recursive: true });
const resume = process.argv[2];
const dir = resume ? resolve(resume) : mkdtempSync(join(parent, 'e2e-'));
const within = relative(parent, dir);
assert.ok(within && !within.startsWith('..') && !isAbsolute(within), '試験対象はagent-docs内に限定する');
const target = join(dir, 'target');
const base = join(dir, 'executor-data');
if (!resume) {
  mkdirSync(target);
  execFileSync('git', ['init', '--quiet', target]);
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'workflow-e2e', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2));
  writeFileSync(join(target, 'AGENTS.md'), '# 開発ルール\n外部依存は追加しない。Node.jsの標準機能で実装・検証する。コミット、push、外部送信はしない。\n');
}
const requirement = '接続・開発試験として、小さな変更1タスクでgreet.jsとgreet.test.jsを作成する。greet.jsはgreet(name)をexportする。nameの前後の空白を除き、空または文字列以外ならTypeError。挨拶の文言はクライアントに必ず最初に質問し、回答後に仕様として用いる。ユーザーの回答を得るまでは計画工程を進めない。空入力、文字列以外、前後空白、通常入力をNode.js標準テストで検証する。それ以外の仕様や変更は不要。';
const release = lock(base);
try {
  const state = resume ? list(base)[0] : create(target, requirement, base);
  assert.equal(state.target, target);
  if (resume && state.status === 'failed') {
    retry(state, base);
  }
  const progress = current => console.log(JSON.stringify(summary(current, base)));
  console.log(JSON.stringify({ testDirectory: dir, id: state.id }));
  let question = state.answers[0]?.question;
  if (!state.answers.length) {
    await run(state, undefined, base, progress);
    assert.equal(state.status, 'waiting', '挨拶文言を確認するまで進めない');
    assert.equal(state.stage, 'plan');
    question = state.question;
    answer(state, '挨拶は英語で Hello, <name>! とする。例としてAdaへの出力は Hello, Ada!。追加仕様は不要。', base);
  }
  await run(state, undefined, base, progress);
  assert.equal(state.status, 'completed', JSON.stringify(summary(state)));
  assert.equal(load(state.id, base).status, 'completed');
  const testResult = execFileSync(process.execPath, ['--test'], { cwd: target, encoding: 'utf8' });
  const check = execFileSync(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict'; import { greet } from './greet.js'; assert.equal(greet(' Ada '), 'Hello, Ada!'); for (const input of ['', ' ', null, 1]) assert.throws(() => greet(input), TypeError);`], { cwd: target, encoding: 'utf8' });
  const sessions = [];
  for (let attempt = 1; attempt <= state.attempts; attempt++) {
    const events = readFileSync(join(base, state.id, `attempt-${String(attempt).padStart(4, '0')}`, 'codex.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const session = events.find(event => event.type === 'thread.started')?.thread_id;
    assert.ok(session, 'セッションIDが記録される');
    const metric = state.metrics?.find(entry => entry.attempt === attempt);
    if (metric?.resumed) {
      const previous = sessions.indexOf(session);
      assert.ok(previous >= 0, '回答後は保存されたセッションを再開する');
      assert.equal(state.metrics[previous].stage, metric.stage, '別工程のセッションは使わない');
    } else assert.ok(!sessions.includes(session), '新規試行は別コンテキスト');
    sessions.push(session);
  }
  const report = { passed: true, id: state.id, question, attempts: state.attempts, independentContexts: new Set(sessions).size, target, dashboard: join(base, 'dashboard.md'), testResult, check };
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  release();
}
