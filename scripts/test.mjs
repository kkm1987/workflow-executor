import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const parent = join(root, 'agent-docs');
mkdirSync(parent, { recursive: true });
const dir = mkdtempSync(join(parent, 'test-suite-'));
try {
  // 運用中の共有・ローカル設定を読まないよう、CLIの子プロセスも含めて隔離する。
  for (const name of ['src', 'test', 'docs', 'package.json', 'node_modules/@fission-ai/openspec']) {
    const destination = join(dir, name);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(root, name), destination, { recursive: true });
  }
  cpSync(join(root, 'test/fixtures/workflow.config.json'), join(dir, 'workflow.config.json'));
  mkdirSync(join(dir, 'agent-docs'));
  const tests = readdirSync(join(dir, 'test')).filter(name => name.endsWith('.test.js')).map(name => join(dir, 'test', name));
  const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...tests], { cwd: dir, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  const within = relative(parent, dir);
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within));
  rmSync(dir, { recursive: true, force: true });
}
