import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, symlinkSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { reserve, withSharedLock, canonicalDirectory, overlaps } from '../src/locking.js';
import { root, create, load, save } from '../src/workflow.js';
import { runPublisher } from '../src/publish.js';

function fixture(t) {
  mkdirSync(join(root, 'agent-docs'), { recursive: true });
  const dir = mkdtempSync(join(root, 'agent-docs', 'concurrency-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = join(dir, 'repo'), b = join(dir, 'repo-other'), child = join(a, 'child');
  for (const path of [a, b, child]) mkdirSync(path, { recursive: true });
  return { dir, a, b, child, base: join(dir, 'data') };
}
function worker(t) {
  const child = fork(join(root, 'test/fixtures/concurrency.mjs'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const queue = [], pending = [];
  child.on('message', message => pending.length ? pending.shift()(message) : queue.push(message));
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => pending.push(resolve));
  t.after(() => { if (child.connected) child.kill(); });
  return { child, next, send: value => child.send(value) };
}
async function start(t, value) {
  const w = worker(t);
  assert.equal((await w.next()).type, 'ready');
  w.send(value);
  return w;
}
async function finish(w) {
  assert.equal((await w.next()).type, 'done');
  if (w.child.exitCode === null) await once(w.child, 'exit');
}

test('共有更新の連続競合でも二つのプロセスの更新を失わない', { timeout: 20000 }, async t => {
  const { base } = fixture(t);
  mkdirSync(base); writeFileSync(join(base, 'counter'), '0');
  const workers = await Promise.all([0, 1].map(() => start(t, { mode: 'shared-loop', base })));
  for (const w of workers) {
    const result = await w.next(); assert.equal(result.type, 'counted', JSON.stringify(result)); await finish(w);
  }
  assert.equal(readFileSync(join(base, 'counter'), 'utf8'), '2000');
});

test('複数プロセスの原子的な対象予約、親子・別名・ID・独立対象、所有者限定解放', { timeout: 20000 }, async t => {
  const { dir, base, a, b, child } = fixture(t);
  const id = randomUUID();
  const secondId = randomUUID();
  const first = await start(t, { base, id, paths: [a] });
  const second = await start(t, { base, id: secondId, paths: [child] });
  const results = await Promise.all([first.next(), second.next()]);
  assert.deepEqual(results.map(x => x.type).sort(), ['acquired', 'error']);
  const winner = results[0].type === 'acquired' ? first : second;
  const loser = winner === first ? second : first;
  await finish(loser);
  assert.throws(() => reserve(base, () => ({ id: winner === first ? id : secondId, paths: [b] })), /競合/);
  const alias = join(dir, 'alias');
  symlinkSync(a, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(canonicalDirectory(alias), canonicalDirectory(a));
  for (const path of [a, child, alias, ...(process.platform === 'win32' ? [a.toUpperCase()] : [])]) {
    assert.throws(() => reserve(base, () => ({ id: randomUUID(), paths: [path] })), /競合/);
  }
  const independent = await start(t, { base, id: randomUUID(), paths: [b] });
  assert.equal((await independent.next()).type, 'acquired');
  assert.equal(readdirSync(join(base, 'reservations')).length, 2);
  winner.send({}); await finish(winner);
  assert.equal(readdirSync(join(base, 'reservations')).length, 1);
  independent.send({}); await finish(independent);
  assert.deepEqual(readdirSync(join(base, 'reservations')), []);
  assert.equal(overlaps(canonicalDirectory(a), canonicalDirectory(b)), false);
  if (process.platform === 'win32') assert.equal(overlaps('c:\\repo', 'd:\\repo'), false);
});

test('共有排他は例外後に解放し、残存・壊れた記録を5秒上限で拒否する', { timeout: 20000 }, async t => {
  const { base } = fixture(t);
  const w = await start(t, { mode: 'shared', base });
  assert.match((await w.next()).message, /共有内例外/); await finish(w);
  assert.doesNotThrow(() => withSharedLock(base, () => {}));
  for (const text of [JSON.stringify({ pid: 2147483647, token: randomUUID(), startedAt: new Date(0).toISOString() }), '{']) {
    const path = join(base, 'shared-update.lock');
    writeFileSync(path, text);
    const at = performance.now();
    assert.throws(() => withSharedLock(base, () => assert.fail()), /5秒|記録が不正/);
    assert.ok(performance.now() - at >= 4900);
    assert.ok(performance.now() - at < 6500);
    assert.equal(readFileSync(path, 'utf8'), text);
    rmSync(path);
  }
});

test('旧ロック・壊れた予約・解決不能・強制終了所有者は自動回収しない', { timeout: 10000 }, async t => {
  const { base, a } = fixture(t);
  mkdirSync(base);
  const take = () => reserve(base, () => ({ id: randomUUID(), paths: [a] }));
  writeFileSync(join(base, 'executor.lock'), '{}');
  assert.throws(take, /旧executor.lock/);
  rmSync(join(base, 'executor.lock'));
  mkdirSync(join(base, 'reservations'));
  const bad = join(base, 'reservations', 'bad.json');
  writeFileSync(bad, '{}'); assert.throws(take, /記録が不正/); rmSync(bad);
  writeFileSync(bad, JSON.stringify({ pid: 1, token: 'bad', startedAt: new Date().toISOString(), id: 'bad', paths: [join(a, 'missing')] }));
  assert.throws(take, /ENOENT/); rmSync(bad);
  const w = await start(t, { mode: 'orphan', base, id: randomUUID(), paths: [a] });
  assert.equal((await w.next()).type, 'acquired');
  const child = await w.next(); assert.equal(child.type, 'child');
  t.after(() => { try { process.kill(child.pid); } catch {} });
  const exited = once(w.child, 'exit'); w.child.kill(); await exited;
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  const files = readdirSync(join(base, 'reservations'));
  assert.equal(files.length, 1); assert.throws(take, /競合/);
  assert.deepEqual(readdirSync(join(base, 'reservations')), files);
});

test('合図付きrunは独立対象で工程を重ね、工程間・例外時も予約を保持し最後に解放する', { timeout: 20000 }, async t => {
  const { base, a, b } = fixture(t);
  const sa = create(a, '案件A', base), sb = create(b, '案件B', base);
  const wa = await start(t, { mode: 'run', base, id: sa.id, paths: [a] });
  const wb = await start(t, { mode: 'run', base, id: sb.id, paths: [b] });
  for (const w of [wa, wb]) assert.equal((await w.next()).type, 'acquired');
  wa.send({}); wb.send({});
  for (const w of [wa, wb]) assert.deepEqual(await w.next(), { type: 'stage', stage: 'plan' });
  assert.equal(load(sa.id, base).status, 'running'); assert.equal(load(sb.id, base).status, 'running');
  wa.send({});
  assert.deepEqual(await wa.next(), { type: 'stage', stage: 'execute' });
  assert.throws(() => reserve(base, () => ({ id: randomUUID(), paths: [a] })), /競合/);
  wa.send({ fail: true }); await finish(wa);
  assert.equal(load(sa.id, base).status, 'failed');
  const release = reserve(base, () => ({ id: sa.id, paths: [a] })); release();
  for (const stage of ['execute', 'review', 'acceptance']) { wb.send({}); assert.deepEqual(await wb.next(), { type: 'stage', stage }); }
  wb.send({}); await finish(wb);
  assert.equal(load(sb.id, base).status, 'completed');
  assert.deepEqual(readdirSync(join(base, 'reservations')), []);
});

test('並行保存とstatus生成は履歴付き二案件の最新行とJSONを保持する', { timeout: 20000 }, async t => {
  const { base, a, b } = fixture(t);
  const states = [create(a, '案件A', base), create(b, '案件B', base)];
  for (const state of states) {
    state.attempts = 60;
    for (let i = 1; i <= 60; i++) {
      const dir = join(base, state.id, `attempt-${String(i).padStart(4, '0')}`); mkdirSync(dir);
      writeFileSync(join(dir, 'result.json'), JSON.stringify({ summary: '過去の記録', outcome: 'ok' }));
    }
    save(state, base);
  }
  const workers = await Promise.all(states.map(state => start(t, { mode: 'save', base, id: state.id })));
  for (const w of workers) {
    const result = await w.next(); assert.equal(result.type, 'saved', JSON.stringify(result));
    t.diagnostic(`60試行×2案件、12回保存＋再生成: ${Math.round(result.elapsed)}ms`);
    await finish(w);
  }
  for (const state of states) assert.equal(load(state.id, base).lastResult, '保存11');
  const snapshot = JSON.parse(readFileSync(join(base, 'dashboard.json'), 'utf8'));
  assert.equal(snapshot.groups.flatMap(x => x.cases).length, 2);
  const md = readFileSync(join(base, 'dashboard.md'), 'utf8');
  assert.match(md, /案件A/); assert.match(md, /案件B/);
  assert.ok(!readdirSync(base).some(name => name.endsWith('.new')));
});

function isolatedCli(dir) {
  cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const config = JSON.parse(readFileSync(join(root, 'workflow.config.json'), 'utf8'));
  delete config.dashboardArtifact;
  writeFileSync(join(dir, 'workflow.config.json'), JSON.stringify(config));
  return async (...args) => {
    const child = spawn(process.execPath, [join(dir, 'src/cli.js'), ...args], { cwd: dir, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', x => { out += x; }); child.stderr.on('data', x => { err += x; });
    const [code] = await once(child, 'close');
    return { code, out, err };
  };
}
function filesUnder(path) {
  return Object.fromEntries(readdirSync(path, { recursive: true, withFileTypes: true }).filter(x => x.isFile())
    .map(x => { const file = join(x.parentPath, x.name); return [file, readFileSync(file, 'utf8')]; }));
}

test('全CLI更新は競合時にstate・events・attemptを変更せず、grant追加先と共有ストアも保護する', { timeout: 30000 }, async t => {
  const { dir, base, a, b } = fixture(t);
  const cli = isolatedCli(dir);
  const state = create(a, '旧状態を保持', base);
  state.kind = 'change'; state.change = 'sample'; state.openspec = { root: b, source: 'nearest', store: null };
  save(state, base);
  const input = join(dir, '入力.txt'); writeFileSync(input, '回答');
  const bin = join(dir, 'node_modules/@fission-ai/openspec/bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'openspec.js'), `console.log(${JSON.stringify(JSON.stringify({ changes: [{ name: 'sample', totalTasks: 1, completedTasks: 0, status: 'in-progress' }], root: { path: b, source: 'nearest' } }))});`);
  const release = reserve(base, () => ({ id: randomUUID(), paths: [a] }));
  const before = filesUnder(join(base, state.id));
  for (const args of [['run'], ['step'], ['answer', input], ['approve'], ['grant', '--network'], ['retry'], ['evidence', input], ['model', 'execute', 'gpt-6-luna'], ['archive']]) {
    const [command, ...rest] = args;
    const result = await cli(command, state.id, ...rest);
    assert.equal(result.code, 1, command); assert.match(result.err, /競合/, command);
    assert.deepEqual(filesUnder(join(base, state.id)), before, command);
  }
  for (const args of [['start', a, input], ['start-change', a, 'sample']]) {
    const result = await cli(...args); assert.equal(result.code, 1); assert.match(result.err, /競合/);
    assert.equal(readdirSync(base).filter(x => /^[0-9a-f-]{36}$/.test(x)).length, 1);
  }
  assert.equal((await cli('status', state.id)).code, 0);
  release();
  const holdStore = reserve(base, () => ({ id: randomUUID(), paths: [b] }));
  for (const args of [['archive', state.id], ['start-change', a, 'sample']]) {
    const result = await cli(...args); assert.match(result.err, /競合/);
  }
  holdStore();
  delete state.openspec; state.kind = 'request'; state.status = 'waiting'; state.permission = { network: false, paths: [b] };
  save(state, base);
  const holdGrant = reserve(base, () => ({ id: randomUUID(), paths: [b] }));
  const preGrant = filesUnder(join(base, state.id));
  const rejected = await cli('grant', state.id, '--path', b);
  assert.match(rejected.err, /競合/); assert.deepEqual(filesUnder(join(base, state.id)), preGrant);
  holdGrant();
  assert.deepEqual(readdirSync(join(base, 'reservations')), []);
});

test('独立案件の予約中もCLI更新でき、answer・modelの保存を後続が再読込し旧履歴を保持する', { timeout: 30000 }, async t => {
  const { dir, base, a, b } = fixture(t);
  const cli = isolatedCli(dir);
  const state = create(a, '旧状態', base);
  Object.assign(state, { status: 'waiting', question: '回答は？', attempts: 3, revisions: 2,
    approval: { status: 'approved', items: [], conditions: '保持' },
    evidence: [{ attempt: 1, changedFiles: ['既存.txt'] }],
    externalEvidence: [{ id: 'old', name: '測定', content: '旧証拠', expiresAt: '2099-01-01T00:00:00Z' }],
    session: { sessionId: 'old-session' } });
  save(state, base);
  const input = join(dir, '回答.txt'); writeFileSync(input, '先行回答');
  const release = reserve(base, () => ({ id: randomUUID(), paths: [b] }));
  assert.equal((await cli('answer', state.id, input)).code, 0);
  assert.equal((await cli('model', state.id, 'plan', 'gpt-6-luna')).code, 0);
  const current = load(state.id, base);
  assert.equal(current.answers.at(-1).answer, '先行回答'); assert.equal(current.models.plan.model, 'gpt-6-luna');
  assert.equal(current.attempts, 3); assert.equal(current.revisions, 2); assert.deepEqual(current.approval, state.approval);
  assert.deepEqual(current.externalEvidence, state.externalEvidence); assert.deepEqual(current.evidence, state.evidence);
  assert.equal(current.session, undefined);
  const operation = reserve(base, () => {
    const latest = load(state.id, base);
    assert.equal(latest.answers.at(-1).answer, '先行回答');
    return { id: latest.id, paths: [latest.target] };
  });
  assert.equal(load(state.id, base).models.plan.model, 'gpt-6-luna'); operation();
  release();
  assert.deepEqual(readdirSync(join(base, 'reservations')), []);
});

for (const mode of ['hold', 'hold-fail']) test(`公開通信(${mode})中の並行保存でも両案件を保持し、活動だけでは追随公開しない`, { timeout: 20000 }, async t => {
  const { base, a, b } = fixture(t);
  const sa = create(a, '案件A', base), sb = create(b, '案件B', base);
  const config = { url: 'https://claude.ai/artifact/concurrency-test', model: 'claude-haiku-5-5', intervalSeconds: 300, timeoutSeconds: 10 };
  let scheduled = 0;
  const publishing = runPublisher(base, config, { command: process.execPath, prefix: [join(root, 'test/fixtures/publisher.mjs'), mode, base], wait: async () => {}, launch: () => { scheduled++; } });
  t.after(() => { if (existsSync(base)) writeFileSync(join(base, 'fake-release'), 'done'); });
  // 起動合図のファイルを待つ。時間の経過だけでは成功としない。
  const { watch } = await import('node:fs/promises');
  if (!existsSync(join(base, 'fake-started'))) {
    const abort = AbortSignal.timeout(10000);
    for await (const _ of watch(base, { signal: abort })) if (existsSync(join(base, 'fake-started'))) break;
  }
  const workers = await Promise.all([sa, sb].map(s => start(t, { mode: 'save', base, id: s.id })));
  for (const w of workers) { const result = await w.next(); assert.equal(result.type, 'saved', JSON.stringify(result)); await finish(w); }
  assert.ok(existsSync(join(base, 'dashboard-publish.lock')));
  writeFileSync(join(base, 'fake-release'), 'done');
  assert.equal(await publishing, mode === 'hold');
  assert.equal(readFileSync(join(base, 'fake-count'), 'utf8'), mode === 'hold' ? '1' : '3');
  const markdown = readFileSync(join(base, 'dashboard.md'), 'utf8');
  assert.match(markdown, /案件A/); assert.match(markdown, /案件B/); assert.match(markdown, /公開状況: 最終成功/);
  const record = JSON.parse(readFileSync(join(base, 'dashboard-publish.json'), 'utf8'));
  if (mode === 'hold') assert.equal(record.cases.length, 2);
  else { assert.match(record.failureReason, /終了コード2/); assert.equal(scheduled, 0); }
});

test('活動保存と別案件の保存・statusが並行しても両案件の状態と要約を保持する', async t => {
  const { base, a, b } = fixture(t);
  const sa = create(a, '活動案件', base), sb = create(b, '保存案件', base);
  const workers = await Promise.all([
    start(t, { mode: 'activity', base, id: sa.id }),
    start(t, { mode: 'save', base, id: sb.id }),
  ]);
  for (const w of workers) { assert.equal((await w.next()).type, 'saved'); await finish(w); }
  assert.equal(load(sa.id, base).activity.text, '活動11');
  assert.equal(load(sb.id, base).lastResult, '保存11');
  const items = JSON.parse(readFileSync(join(base, 'dashboard.json'), 'utf8')).groups.flatMap(group => group.cases);
  assert.equal(items.length, 2);
  assert.equal(items.find(item => item.id === sa.id).activity, '活動11');
  assert.ok(items.find(item => item.id === sb.id));
});
