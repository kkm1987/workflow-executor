import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root, create, save, saveActivity, dashboard } from '../src/workflow.js';
import { readConfig } from '../src/config.js';
import { artifactCase, renderArtifact } from '../src/dashboard-artifact.js';
import { runPublisher, shouldPublish, requestPublish } from '../src/publish.js';

const keys = value => value.groups.flatMap(group => group.cases.map(({ id, stage, attempt }) => ({ id, group: group.label, stage, ...(group.label === '進行中' ? {} : { attempt }) })));
const config = { url: 'https://claude.ai/artifact/test-page', model: 'claude-haiku-5-5', intervalSeconds: 300, timeoutSeconds: 2 };
function fixture(t) {
  const dir = mkdtempSync(join(root, 'agent-docs', 'artifact-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'target'); mkdirSync(target);
  const base = join(dir, 'data');
  const state = create(target, '公開の試験', base);
  return { dir, base, state, target };
}
const snapshot = base => JSON.parse(readFileSync(join(base, 'dashboard.json'), 'utf8'));
const record = base => JSON.parse(readFileSync(join(base, 'dashboard-publish.json'), 'utf8'));
const fake = (mode, base) => ({ command: process.execPath, prefix: [join(root, 'test', 'fixtures', 'publisher.mjs'), mode, base], wait: async () => {} });

test('案件名は50文字を保持し、100文字は80文字と省略記号にする', () => {
  for (const length of [50, 100]) {
    const name = '案'.repeat(length);
    assert.equal(artifactCase({ name }, {}).name, length === 50 ? name : '案'.repeat(80) + '…');
  }
});

test('閲覧ページは案件一覧の前に分類別件数欄を含む', () => {
  const html = renderArtifact({ generatedAt: null, counts: {}, groups: [] });
  assert.match(html, /<ul id="counts" aria-label="分類別件数"><\/ul>/);
  assert.ok(html.indexOf('id="counts"') < html.indexOf('id="groups"'));
});

test('要約は分類・順序・対応をMarkdownと共有し、保存済み状態から決定的に生成する', t => {
  const { state, base, target } = fixture(t);
  state.status = 'failed'; state.error = '起動できません'; save(state, base);
  const waiting = create(target, '入力の確認', base);
  waiting.status = 'waiting'; waiting.question = 'どの形式ですか？'; waiting.lastResult = '形式が未確定'; save(waiting, base);
  const limited = create(target, '利用枠待ち', base); limited.status = 'limited'; save(limited, base);
  const blocked = create(target, '再計画', base); blocked.status = 'blocked'; blocked.lastResult = '差し戻しの上限'; save(blocked, base);
  const completed = create(target, '確認可能', base); completed.status = 'completed'; completed.lastResult = '検証成功'; save(completed, base);
  const value = snapshot(base);
  assert.deepEqual(value.groups.map(group => group.label), ['回答待ち', '利用枠不足', '開発主体の復旧・再計画待ち', '成果確認可能']);
  const cases = value.groups.flatMap(group => group.cases);
  assert.equal(cases[0].question, waiting.question);
  assert.equal(cases[0].attempt, waiting.attempts);
  assert.equal(cases[0].reason, waiting.lastResult);
  assert.match(cases[1].nextAction, /リセット/);
  assert.equal(cases.find(item => item.id === state.id).reason, state.error);
  assert.equal(cases.find(item => item.id === blocked.id).reason, blocked.lastResult);
  assert.equal(cases.at(-1).result, '検証成功');
  const markdown = readFileSync(join(base, 'dashboard.md'), 'utf8');
  assert.ok(markdown.indexOf('## 回答待ち') < markdown.indexOf('## 利用枠不足'));
  dashboard(base);
  assert.deepEqual(snapshot(base), value);
});

test('要約はパス・ログ参照・証拠本文・コマンド・内部思考・ツール出力を出さず、報告を切り詰める', t => {
  const { state, base } = fixture(t);
  state.status = 'waiting';
  state.question = `保存先は${state.target}です。C:\\private\\secret.txt /home/secret.txt ../secret.txt data/state.json raw.log\nnode secret-script.js --token private\nツール出力: confidential\n内部思考: confidential\n証拠の秘密本文`;
  state.externalEvidence = [{ name: '測定', content: '証拠の秘密本文', source: 'private-source', observedAt: '2026-10-27T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' }];
  state.activity = { kind: 'tool', tool: 'private-tool-output', status: 'private', at: state.updatedAt };
  const attempt = join(base, state.id, 'attempt-0001'); mkdirSync(attempt);
  writeFileSync(join(attempt, 'result.json'), JSON.stringify({ report: { scope: '対象'.repeat(1000), decisions: ['判断'], verification: '検証', remaining: 'なし' } }));
  save(state, base);
  const json = readFileSync(join(base, 'dashboard.json'), 'utf8');
  for (const secret of [state.target, 'secret.txt', 'state.json', 'raw.log', 'private-source', '証拠の秘密本文', 'confidential', 'secret-script', 'private-tool-output']) assert.ok(!json.includes(secret), secret);
  assert.ok(snapshot(base).groups[0].cases[0].report.scope.length <= 301);
  assert.ok(!json.includes('externalEvidence'));
  assert.ok(!json.includes('invocation'));
});

test('Artifact設定は既定値を補い、不正URL・モデル・間隔・打ち切りを拒否する', t => {
  const { dir } = fixture(t);
  const path = join(dir, 'config.json');
  const full = readConfig();
  const read = value => { writeFileSync(path, JSON.stringify({ ...full, dashboardArtifact: value })); return readConfig(path); };
  assert.deepEqual(read({ url: config.url }).dashboardArtifact, { url: config.url, model: config.model, timeoutSeconds: 120 });
  assert.equal(read({}).dashboardArtifact.url, undefined);
  for (const value of [null, [], 'x', { url: 'http://claude.ai/artifact/a' }, { url: 'https://evil.example/artifact/a' }, { url: config.url + '?token=secret' },
    { model: 'gpt-6' }, { model: 'claude-x;bad' }, { intervalSeconds: 0 }, { intervalSeconds: -1 }, { timeoutSeconds: 1.5 }, { timeoutSeconds: '120' }]) assert.throws(() => read(value));
});

test('ローカル公開設定は共有設定を置き換え、既定値を補い、不正な設定を拒否する', t => {
  const { dir } = fixture(t);
  const path = join(dir, 'config.json');
  const localPath = join(dir, 'workflow.config.local.json');
  const shared = { ...readConfig(), dashboardArtifact: { ...config, model: 'claude-shared', intervalSeconds: 999 } };
  writeFileSync(path, JSON.stringify(shared));
  assert.deepEqual(readConfig(path).dashboardArtifact, shared.dashboardArtifact);
  const read = value => { writeFileSync(localPath, JSON.stringify(value)); return readConfig(path); };
  assert.deepEqual(read({ dashboardArtifact: { url: 'https://claude.ai/artifact/local' } }).dashboardArtifact,
    { url: 'https://claude.ai/artifact/local', model: 'claude-haiku-5-5', timeoutSeconds: 120 });
  assert.equal(read({ dashboardArtifact: {} }).dashboardArtifact.url, undefined);
  assert.deepEqual(read({}).dashboardArtifact, shared.dashboardArtifact);
  for (const value of [null, [], 'x', { models: {} }, { dashboardArtifact: {}, limits: {} }]) {
    assert.throws(() => read(value), /workflow\.config\.local\.json/);
  }
  for (const value of [null, { url: 'https://evil.example/artifact/a' }, { model: 'gpt-6' }, { intervalSeconds: 0 }, { timeoutSeconds: -1 }]) {
    assert.throws(() => read({ dashboardArtifact: value }), /dashboardArtifact/);
  }
  writeFileSync(localPath, '{');
  assert.throws(() => readConfig(path), /workflow\.config\.local\.json/);
  rmSync(localPath);
  mkdirSync(localPath);
  assert.throws(() => readConfig(path), /workflow\.config\.local\.json/);
});

test('起動判定は通知キーとURLの変化だけを公開する', t => {
  const { base } = fixture(t);
  const value = snapshot(base);
  const at = Date.now();
  const previous = { url: config.url, cases: keys(value), startedAt: new Date(at).toISOString() };
  assert.equal(shouldPublish(value, previous, config, at + 600000), false);
  assert.equal(shouldPublish(value, previous, { ...config, url: 'https://claude.ai/artifact/another-page' }, at), true);
  const changed = structuredClone(value); changed.groups[0].cases[0].activity = '新しい報告';
  assert.equal(shouldPublish(changed, previous, config, at + 299999), false);
  assert.equal(shouldPublish(changed, previous, config, at + 300000), false);
  for (const [key, next] of [['stage', 'execute']]) {
    const transition = structuredClone(value); transition.groups[0].cases[0][key] = next;
    assert.equal(shouldPublish(transition, previous, config, at), true);
  }
  const running = structuredClone(value); running.groups[0].cases[0].status = 'running'; running.groups[0].cases[0].attempt++;
  assert.equal(shouldPublish(running, previous, config), false);
  const waiting = structuredClone(value); waiting.groups[0].label = '回答待ち';
  assert.equal(shouldPublish(waiting, previous, config), true);
  const question = structuredClone(waiting); question.groups[0].cases[0].attempt++;
  assert.equal(shouldPublish(question, { ...previous, cases: keys(waiting) }, config), true);
  const added = structuredClone(value); added.groups[0].cases.push({ ...added.groups[0].cases[0], id: '追加' });
  assert.equal(shouldPublish(added, previous, config), true);
  const removed = { ...value, groups: [] };
  assert.equal(shouldPublish(removed, previous, config, at), true);
  assert.equal(shouldPublish(value, { ...previous, hash: '旧要約', cases: [] }, config, at), true);
  assert.equal(shouldPublish(value, {}, undefined, at), false);
});

test('dashboardは公開終了を待たずに起動関数を呼び、未設定・起動失敗でも状態を変えない', t => {
  const { base, state } = fixture(t);
  const saved = readFileSync(join(base, state.id, 'state.json'), 'utf8');
  let launches = 0;
  dashboard(base, { config: {}, launch: () => { launches++; } });
  assert.equal(launches, 0);
  const start = performance.now();
  dashboard(base, { config: { dashboardArtifact: config }, launch: () => { launches++; return new Promise(() => {}); } });
  assert.equal(launches, 1);
  assert.ok(performance.now() - start < 1000);
  requestPublish(snapshot(base), base, config, () => { throw new Error('起動エラー'); });
  assert.match(record(base).failureReason, /起動できません/);
  assert.equal(readFileSync(join(base, state.id, 'state.json'), 'utf8'), saved);
});

test('公開の成功・失敗・成功証拠なし・別URL・起動失敗・打ち切りを記録し、状態ファイルを変更しない', async t => {
  const { base, state } = fixture(t);
  const saved = readFileSync(join(base, state.id, 'state.json'), 'utf8');
  assert.equal(await runPublisher(base, config, fake('success', base)), true);
  const success = record(base);
  assert.deepEqual(success.cases, keys(snapshot(base)));
  assert.equal(success.hash, undefined);
  assert.ok(success.succeededAt);
  for (const mode of ['fail', 'no-proof', 'wrong-url', 'timeout', 'missing', 'mutate']) {
    const current = snapshot(base); current.groups[0].cases[0].stage = mode; writeFileSync(join(base, 'dashboard.json'), JSON.stringify(current));
    assert.equal(await runPublisher(base, { ...config, timeoutSeconds: 1 }, mode === 'missing' ? { command: join(base, 'missing-cli'), wait: async () => {} } : fake(mode, base)), false);
    const value = record(base);
    assert.ok(value.failedAt);
    assert.deepEqual(value.cases, success.cases);
    assert.equal(value.succeededAt, success.succeededAt);
    assert.match(value.failureReason, mode === 'timeout' ? /タイムアウト/ : mode === 'fail' ? /終了コード2/ : mode === 'missing' ? /起動できません/ : mode === 'mutate' ? /HTMLが変更/ : /成功を確認できません/);
    assert.equal(existsSync(join(base, 'dashboard-publish.lock')), false);
  }
  assert.equal(readFileSync(join(base, state.id, 'state.json'), 'utf8'), saved);
  const markdown = readFileSync(join(base, 'dashboard.md'), 'utf8');
  assert.match(markdown, /公開状況: 最終成功 .*失敗:/);
  dashboard(base, { config: {} });
  assert.doesNotMatch(readFileSync(join(base, 'dashboard.md'), 'utf8'), /公開状況:/);
});

test('公開中の変更を再公開し、ロック保持中の別起動は何もしない。古い死んだ所有者のロックは奪取する', async t => {
  const { base, state } = fixture(t);
  state.status = 'waiting'; state.attempts = 1; state.question = '質問1'; save(state, base);
  assert.equal(await runPublisher(base, config, fake('change', base)), true);
  assert.equal(readFileSync(join(base, 'fake-count'), 'utf8'), '2');
  assert.match(readFileSync(join(base, 'published-2.html'), 'utf8'), /公開中に届いた新しい活動/);
  const current = snapshot(base); current.groups[0].cases[0].attempt++; writeFileSync(join(base, 'dashboard.json'), JSON.stringify(current));
  const running = runPublisher(base, { ...config, timeoutSeconds: 5 }, fake('hold', base));
  t.after(() => { if (existsSync(base)) writeFileSync(join(base, 'fake-release'), 'done'); });
  for (let i = 0; i < 100 && !existsSync(join(base, 'fake-started')); i++) await delay(20);
  assert.ok(existsSync(join(base, 'fake-started')));
  assert.equal(await runPublisher(base, config, fake('success', base)), false);
  assert.equal(readFileSync(join(base, 'fake-count'), 'utf8'), '3');
  writeFileSync(join(base, 'fake-release'), 'done');
  assert.equal(await running, true);
  current.groups[0].cases[0].attempt++; writeFileSync(join(base, 'dashboard.json'), JSON.stringify(current));
  writeFileSync(join(base, 'dashboard-publish.lock'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
  utimesSync(join(base, 'dashboard-publish.lock'), new Date(0), new Date(0));
  assert.equal(await runPublisher(base, config, fake('success', base)), true);
});

test('HTML埋め込みはscript終了文字を無害化し、未知データをコードとして実行しない', () => {
  const html = renderArtifact({ generatedAt: null, counts: {}, groups: [], question: '</script><script>alert(1)</script>&\u2028' });
  assert.ok(html.includes('\\u003c/script\\u003e'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /textContent/);
});

test('内容が同じでも公開先変更時は転送し、失敗中の新しい要約にも終了後の起動機会を渡す', async t => {
  const { base } = fixture(t);
  assert.equal(await runPublisher(base, config, fake('success', base)), true);
  const changedConfig = { ...config, url: 'https://claude.ai/artifact/new-page' };
  assert.equal(await runPublisher(base, changedConfig, fake('success', base)), true);
  assert.equal(record(base).url, changedConfig.url);
  assert.equal(readFileSync(join(base, 'fake-count'), 'utf8'), '2');
  const value = snapshot(base); value.groups[0].cases[0].stage = '更新'; writeFileSync(join(base, 'dashboard.json'), JSON.stringify(value));
  let scheduled = 0;
  assert.equal(await runPublisher(base, changedConfig, { ...fake('change-fail', base), launch: () => {
    assert.equal(existsSync(join(base, 'dashboard-publish.lock')), false);
    scheduled++;
  } }), false);
  assert.equal(scheduled, 1);
});

test('活動保存は当該案件の活動だけを秘匿して更新し、Markdownと他案件を保持する', t => {
  const { state, base, target } = fixture(t);
  create(target, '他の案件', base);
  const before = snapshot(base);
  const markdown = readFileSync(join(base, 'dashboard.md'), 'utf8');
  state.activity = { kind: 'report', text: `確認中 ${state.target} 内部思考: 秘密`, at: '2026-10-31T12:00:00Z' };
  saveActivity(state, base);
  const after = snapshot(base);
  const item = after.groups.flatMap(group => group.cases).find(item => item.id === state.id);
  assert.equal(item.activityAt, state.activity.at);
  assert.ok(!item.activity.includes(state.target));
  assert.ok(!item.activity.includes('秘密'));
  const old = before.groups.flatMap(group => group.cases).find(item => item.id === state.id);
  old.activity = item.activity; old.activityAt = item.activityAt;
  assert.deepEqual(after, before);
  assert.equal(readFileSync(join(base, 'dashboard.md'), 'utf8'), markdown);
  assert.deepEqual(JSON.parse(readFileSync(join(base, state.id, 'state.json'))).activity, state.activity);
  assert.equal(existsSync(join(base, 'dashboard-publish.json')), false);
  writeFileSync(join(base, 'dashboard.json'), JSON.stringify({ groups: [], counts: {} }));
  saveActivity(state, base);
  assert.deepEqual(snapshot(base).groups, []);
  rmSync(join(base, 'dashboard.json'));
  assert.doesNotThrow(() => saveActivity(state, base));
});

test('Markdownは41試行を最新3件と省略件数・全記録リンクに絞る', t => {
  const { state, base } = fixture(t);
  for (let i = 1; i <= 41; i++) {
    const path = join(base, state.id, `attempt-${String(i).padStart(4, '0')}`);
    mkdirSync(path);
    writeFileSync(join(path, 'result.json'), JSON.stringify({ summary: `結果${i}` }));
  }
  state.attempts = 41; save(state, base);
  const markdown = readFileSync(join(base, 'dashboard.md'), 'utf8');
  assert.equal((markdown.match(/試行\d+:/g) ?? []).length, 3);
  for (const i of [39, 40, 41]) assert.match(markdown, new RegExp(`試行${i}:`));
  assert.ok(markdown.includes(`38件の試行を省略。[全試行の記録](${state.id}/)`));
});

test('一時的な公開失敗はロックを保持して再試行し、活動だけの変化は再公開しない', async t => {
  const { base } = fixture(t);
  const waits = [];
  assert.equal(await runPublisher(base, config, { ...fake('transient', base), wait: async ms => {
    waits.push(ms);
    assert.ok(existsSync(join(base, 'dashboard-publish.lock')));
    const current = snapshot(base);
    current.groups[0].cases[0].stage = 'review';
    current.groups[0].cases[0].question = '再試行前の新しい質問';
    writeFileSync(join(base, 'dashboard.json'), JSON.stringify(current));
  } }), true);
  assert.deepEqual(waits, [60000]);
  assert.deepEqual(record(base).cases, keys(snapshot(base)));
  assert.match(readFileSync(join(base, 'published-2.html'), 'utf8'), /再試行前の新しい質問/);
  const current = snapshot(base); current.groups[0].cases[0].activity = '活動更新';
  writeFileSync(join(base, 'dashboard.json'), JSON.stringify(current));
  assert.equal(await runPublisher(base, config, fake('success', base)), false);
  assert.equal(readFileSync(join(base, 'fake-count'), 'utf8'), '2');
});

test('全失敗後は成功キーを変更せず、statusのダッシュボード更新で再起動する', async t => {
  const { base } = fixture(t);
  const waits = [];
  assert.equal(await runPublisher(base, config, { ...fake('fail', base), wait: async ms => { waits.push(ms); } }), false);
  assert.deepEqual(waits, [60000, 300000]);
  assert.equal(record(base).cases, undefined);
  let launches = 0;
  dashboard(base, { config: { dashboardArtifact: config }, launch: () => { launches++; } });
  assert.equal(launches, 1);
  assert.match(readFileSync(join(base, 'dashboard.md'), 'utf8'), /失敗:/);
});
