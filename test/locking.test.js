import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, withSharedLock } from '../src/locking.js';

test('Windowsの共有ロックは一時的な拒否を再試行し、書き込み拒否と競合を区別する', { skip: process.platform !== 'win32', timeout: 20000 }, t => {
  const parent = fileURLToPath(new URL('../agent-docs/', import.meta.url));
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(join(parent, 'shared-lock-'));
  const path = join(dir, 'shared-update.lock');
  const open = fs.openSync;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); });
  const denied = Object.assign(new Error('書き込み拒否'), { code: 'EPERM', syscall: 'open' });
  let denials = 3;
  let attempts = 0;
  t.mock.method(fs, 'openSync', (file, flags, ...args) => {
    if (file === path && flags === 'wx') {
      attempts++;
      if (attempts <= denials) throw denied;
    }
    return open(file, flags, ...args);
  });
  syncBuiltinESMExports();

  assert.equal(withSharedLock(dir, () => fs.existsSync(path)), true);
  assert.equal(attempts, 4);
  assert.equal(fs.existsSync(path), false);

  denials = Infinity;
  attempts = 0;
  const started = performance.now();
  assert.throws(() => withSharedLock(dir, () => assert.fail()), error => {
    assert.match(error.message, /書き込みが拒否.*open wx.*EPERM/);
    assert.ok(error.message.includes(path));
    assert.doesNotMatch(error.message, /競合|5秒以内に取得できません/);
    assert.equal(error.cause, denied);
    return true;
  });
  assert.ok(attempts > 1);
  assert.ok(performance.now() - started < 6500);
  assert.equal(fs.existsSync(path), false);

  const owner = JSON.stringify({ token: 'other', pid: 2147483647, startedAt: new Date(0).toISOString() });
  fs.writeFileSync(path, owner);
  assert.throws(() => withSharedLock(dir, () => assert.fail()), {
    message: `共有更新ロックを5秒以内に取得できませんでした: ${path}`
  });
  assert.equal(fs.readFileSync(path, 'utf8'), owner);
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
