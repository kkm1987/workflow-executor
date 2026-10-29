import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync, realpathSync, statSync, renameSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';

const pause = new Int32Array(new SharedArrayBuffer(4));
const owner = () => ({ token: randomUUID(), pid: process.pid, startedAt: new Date().toISOString() });
const validOwner = value => typeof value?.token === 'string' && value.token.length > 0 && Number.isInteger(value.pid) && value.pid > 0 && Number.isFinite(Date.parse(value.startedAt));
const readOwner = path => {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!validOwner(value)) throw new Error();
    return value;
  } catch { throw new Error(`ロック記録が不正です。所有者・子プロセス・差分を確認してください: ${path}`); }
};
function removeOwned(path, token) {
  if (readOwner(path).token !== token) throw new Error(`ロック所有者が変わりました: ${path}`);
  unlinkSync(path);
}
function createOwner(path, value) {
  const fd = openSync(path, 'wx');
  try { writeFileSync(fd, JSON.stringify(value)); }
  catch (error) { closeSync(fd); unlinkSync(path); throw error; }
  closeSync(fd);
}

export function withSharedLock(base, action) {
  mkdirSync(base, { recursive: true });
  const path = join(base, 'shared-update.lock');
  const value = owner();
  const deadline = performance.now() + 5000;
  while (true) {
    try { createOwner(path, value); break; }
    catch (error) {
      // Windowsでは削除処理中のファイルへの排他作成もEPERMになる。
      const deleting = process.platform === 'win32' && error.code === 'EPERM' && error.syscall === 'open';
      if (error.code !== 'EEXIST' && !deleting) throw error;
      // 作成直後の所有者記録の書き込み中も、取得せず上限まで待つ。
      if (performance.now() >= deadline) {
        if (existsSync(path)) readOwner(path);
        throw new Error(`共有更新ロックを5秒以内に取得できませんでした: ${path}`);
      }
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  try { return action(); }
  finally { removeOwned(path, value.token); }
}

export function atomicWrite(path, text) {
  const temporary = `${path}.${randomUUID()}.new`;
  try {
    writeFileSync(temporary, text);
    const deadline = performance.now() + 1000;
    while (true) {
      try { renameSync(temporary, path); break; }
      catch (error) {
        // Windowsで一時的に保持された置換先は、元ファイルを残したまま再試行する。
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || performance.now() >= deadline) throw error;
        Atomics.wait(pause, 0, 0, 20);
      }
    }
  }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

export function canonicalDirectory(path) {
  const actual = realpathSync(resolve(path));
  if (!statSync(actual).isDirectory()) throw new Error(`予約対象はディレクトリが必要です: ${path}`);
  return process.platform === 'win32' ? actual.toLowerCase() : actual;
}
export function overlaps(a, b) {
  const inside = (parent, child) => {
    const suffix = relative(parent, child);
    return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
  };
  return inside(a, b) || inside(b, a);
}
export function reserve(base, select) {
  return withSharedLock(base, () => {
    if (existsSync(join(base, 'executor.lock'))) throw new Error('旧executor.lockが残っています。全実行器・子プロセスを停止しREADMEの復旧手順を確認してください');
    const { id, paths } = select();
    if (typeof id !== 'string' || !id || !Array.isArray(paths) || !paths.length) throw new Error('予約対象が不正です');
    const directories = [...new Set(paths.map(canonicalDirectory))];
    const folder = join(base, 'reservations');
    mkdirSync(folder, { recursive: true });
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      const other = readOwner(path);
      if (typeof other.id !== 'string' || !Array.isArray(other.paths) || !other.paths.length || other.paths.some(value => typeof value !== 'string')) throw new Error(`予約記録が不正です: ${path}`);
      const targets = other.paths.map(canonicalDirectory);
      if (other.id === id || directories.some(a => targets.some(b => overlaps(a, b)))) throw new Error(`別の操作と予約対象が競合しています: ${other.id} (PID ${other.pid})`);
    }
    const value = { ...owner(), id, paths: directories };
    const path = join(folder, `${value.token}.json`);
    createOwner(path, value);
    return () => withSharedLock(base, () => removeOwned(path, value.token));
  });
}
