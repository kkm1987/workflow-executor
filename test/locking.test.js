import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from '../src/locking.js';

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
