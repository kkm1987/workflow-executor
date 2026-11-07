import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const lock = join(process.cwd(), 'data', 'shared-update.lock');
const open = fs.openSync;
fs.openSync = (path, flags, ...args) => {
  if (path === lock && flags === 'wx') {
    throw Object.assign(new Error('書き込み拒否'), { code: 'EPERM', syscall: 'open', path });
  }
  return open(path, flags, ...args);
};
syncBuiltinESMExports();
