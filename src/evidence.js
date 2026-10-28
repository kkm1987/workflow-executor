import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function snapshot(target, path, pathspec = []) {
  const git = args => execFileSync('git', ['-C', target, ...args, '--', ...pathspec], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const names = new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean));
  const files = Object.create(null);
  for (const name of names) {
    const file = join(target, name);
    let stat;
    try { stat = lstatSync(file); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const hash = createHash('sha256');
    if (stat.isSymbolicLink()) hash.update(readlinkSync(file));
    else if (stat.isFile()) {
      for await (const chunk of createReadStream(file)) hash.update(chunk);
    } else continue;
    files[name] = hash.digest('hex');
  }
  const result = {
    capturedAt: new Date().toISOString(),
    status: git(['status', '--porcelain=v1', '--untracked-files=all']),
    diff: git(['diff', '--binary']),
    stagedDiff: git(['diff', '--cached', '--binary']),
    files,
  };
  writeFileSync(path, JSON.stringify(result, null, 2));
  return result;
}

export function changedFiles(before, after) {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter(name => before.files[name] !== after.files[name]);
}
