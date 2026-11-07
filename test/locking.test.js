import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, withSharedLock } from '../src/locking.js';

test('Windowsの共有ロックは一時的な拒否を再試行し、期限時の記録と最後のエラーで判定する', { skip: process.platform !== 'win32' }, t => {
  const parent = fileURLToPath(new URL('../agent-docs/', import.meta.url));
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(join(parent, 'shared-lock-'));
  const path = join(dir, 'shared-update.lock');
  const open = fs.openSync;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); });
  const denied = Object.assign(new Error('書き込み拒否'), { code: 'EPERM', syscall: 'open' });
  const exists = Object.assign(new Error('ファイルあり'), { code: 'EEXIST', syscall: 'open' });
  let failure = () => attempts <= 3 ? denied : undefined;
  let elapsed = 0;
  let attempts = 0;
  t.mock.method(performance, 'now', () => elapsed);
  t.mock.method(Atomics, 'wait', (_array, _index, _value, timeout) => {
    elapsed += timeout;
    assert.ok(elapsed <= 5010, 'ロックの再試行は5秒で打ち切る');
    return 'timed-out';
  });
  t.mock.method(fs, 'openSync', (file, flags, ...args) => {
    if (file === path && flags === 'wx') {
      attempts++;
      const error = failure();
      if (error) throw error;
    }
    return open(file, flags, ...args);
  });
  syncBuiltinESMExports();

  assert.equal(withSharedLock(dir, () => fs.existsSync(path)), true);
  assert.equal(attempts, 4);
  assert.equal(fs.existsSync(path), false);

  const writeDenial = error => {
    assert.match(error.message, /書き込みが拒否.*open wx.*EPERM/);
    assert.ok(error.message.includes(path));
    assert.doesNotMatch(error.message, /競合|5秒以内に取得できません/);
    assert.equal(error.cause, denied);
    return true;
  };
  const contention = { message: `共有更新ロックを5秒以内に取得できませんでした: ${path}` };
  const owner = JSON.stringify({ token: 'other', pid: 2147483647, startedAt: new Date(0).toISOString() });
  for (const { record, initial, last, expected } of [
    { initial: denied, last: denied, expected: writeDenial },
    { initial: exists, last: denied, expected: writeDenial },
    { initial: denied, last: exists, expected: contention },
    { record: owner, initial: denied, last: denied, expected: contention },
    { record: '{', initial: denied, last: denied, expected: /ロック記録が不正/ },
  ]) {
    if (record !== undefined) fs.writeFileSync(path, record);
    failure = () => elapsed < 5000 ? initial : last;
    elapsed = attempts = 0;
    assert.throws(() => withSharedLock(dir, () => assert.fail('操作を実行してはいけない')), expected);
    assert.equal(elapsed, 5000);
    assert.ok(attempts > 1);
    if (record === undefined) assert.equal(fs.existsSync(path), false);
    else {
      assert.equal(fs.readFileSync(path, 'utf8'), record);
      fs.unlinkSync(path);
    }
  }

  for (const [code, syscall] of [['EACCES', 'open'], ['EPERM', 'write']]) {
    const error = Object.assign(new Error('入出力エラー'), { code, syscall });
    failure = () => error;
    elapsed = attempts = 0;
    assert.throws(() => withSharedLock(dir, () => assert.fail('操作を実行してはいけない')), actual => actual === error);
    assert.equal(attempts, 1);
    assert.equal(elapsed, 0);
  }
});

test('Windowsの原子的保存は一時的な置換拒否を再試行し、恒久エラーでは元ファイルを保持する', { skip: process.platform !== 'win32' }, t => {
  const parent = fileURLToPath(new URL('../agent-docs/', import.meta.url));
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(join(parent, 'atomic-write-'));
  const path = join(dir, 'state.json');
  const rename = fs.renameSync;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); });
  let calls = 0;
  let failure = null;
  t.mock.method(fs, 'renameSync', (from, to) => {
    calls++;
    if (failure || calls <= 3) {
      assert.equal(fs.readFileSync(path, 'utf8'), 'old');
      throw Object.assign(new Error('置換拒否'), { code: failure ?? ['EPERM', 'EACCES', 'EBUSY'][calls - 1] });
    }
    rename(from, to);
  });
  syncBuiltinESMExports();
  fs.writeFileSync(path, 'old');
  atomicWrite(path, 'new');
  assert.equal(calls, 4);
  assert.equal(fs.readFileSync(path, 'utf8'), 'new');
  for (const code of ['EPERM', 'EIO']) {
    fs.writeFileSync(path, 'old'); calls = 0; failure = code;
    const started = performance.now();
    assert.throws(() => atomicWrite(path, 'new'), { code });
    assert.equal(fs.readFileSync(path, 'utf8'), 'old');
    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
    if (code === 'EPERM') {
      assert.ok(calls > 1);
      assert.ok(performance.now() - started < 2000);
    } else assert.equal(calls, 1);
  }
});
