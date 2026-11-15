import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearCodexLaunchEnvironment } from '../src/commands.js';
import { checkCommand } from '../src/preflight.js';
import { reserve } from '../src/locking.js';
import { create, load, root, save } from '../src/workflow.js';

test('WindowsだけでCodexアプリの起動環境2変数を除去する', () => {
  const original = { CODEX_WINDOWS_REGISTERED_CORE: '1', CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY: 'family', PATH: 'keep', OTHER: 'value' };
  for (const platform of ['win32', 'linux', 'darwin']) {
    const env = { ...original };
    clearCodexLaunchEnvironment(env, platform);
    assert.deepEqual(env, platform === 'win32' ? { PATH: 'keep', OTHER: 'value' } : original);
  }
});

test('モジュール読み込み後はspawnCommandとcaptureの子へ起動環境を継承しない', () => {
  const moduleUrl = new URL('../src/commands.js', import.meta.url).href;
  const script = `
    import { capture, spawnCommand } from ${JSON.stringify(moduleUrl)};
    const args = ['-e', 'console.log(JSON.stringify([process.env.CODEX_WINDOWS_REGISTERED_CORE ?? null, process.env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY ?? null, process.env.LAUNCH_TEST_KEEP]))'];
    console.log((await capture(process.execPath, args, process.cwd())).trim());
    const child = spawnCommand(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.pipe(process.stdout);
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(String(code)))); });
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CODEX_WINDOWS_REGISTERED_CORE: '1', CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY: 'family', LAUNCH_TEST_KEEP: 'keep' },
  });
  const expected = process.platform === 'win32' ? [null, null, 'keep'] : ['1', 'family', 'keep'];
  assert.deepEqual(output.trim().split(/\r?\n/).map(line => JSON.parse(line)), [expected, expected]);
});

test('起動失敗は固定文と終了コードへ分類し、診断の原文を残さない', async () => {
  for (const [diagnostic, cause] of [
    ['registered Core launch requires an installed app', 'Codexアプリ専用のregistered Core起動に失敗（端末の初期セットアップでは解決しない可能性）'],
    ['registered Core setup has not completed', 'Codexアプリ専用のregistered Core起動に失敗（端末の初期セットアップでは解決しない可能性）'],
    ['orchestrator_helper_exit_nonzero', 'Windowsサンドボックスのセットアップ補助プロセスが失敗'],
    ['default_permissions requires', '権限プロファイルの設定が不整合'],
    ['Not logged in', 'Codexが未認証'],
    ['access is denied', 'アクセス拒否'],
    ['アクセスが拒否', 'アクセス拒否'],
    ['unknown failure', 'コマンドが失敗'],
  ]) {
    await assert.rejects(checkCommand(process.execPath, ['-e', `console.error(${JSON.stringify(diagnostic + ' secret-value')}); process.exit(7)`], process.cwd()),
      { message: `${cause} (終了コード 7)` });
  }
});

test('CLIのapprove --itemsは指定した項目だけを承認・予約し、省略時は残りを全件承認する', t => {
  const dir = mkdtempSync(join(root, 'agent-docs', 'approve-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(root, 'package.json'), join(dir, 'package.json'));
  cpSync(join(root, 'test/fixtures/workflow.config.json'), join(dir, 'workflow.config.json'));
  const base = join(dir, 'data');
  const target = join(dir, 'target');
  const extra = join(dir, 'extra');
  mkdirSync(target);
  mkdirSync(extra);
  const state = create(target, '部分承認の確認', base, undefined, { models: { execute: { model: 'claude-opus-5-5' } } });
  const pending = [
    { id: 'A1', gate: 'plan', action: '追加のパスを使う', grants: { network: false, paths: [extra] } },
    { id: 'A2', gate: 'plan', action: 'ファイルを確認する' },
    { id: 'A3', gate: 'plan', action: 'ファイルを更新する' },
  ];
  Object.assign(state, { stage: 'execute', status: 'waiting', approval: { status: 'pending', items: [], pending, nextId: 4 } });
  save(state, base);
  const cli = (...args) => execFileSync(process.execPath, [join(dir, 'src', 'cli.js'), 'approve', state.id, ...args],
    { encoding: 'utf8', windowsHide: true });
  const conditionFile = join(dir, '条件.txt');
  writeFileSync(conditionFile, '確認は1回まで');
  const release = reserve(base, () => ({ id: '別の案件', paths: [extra] }));
  try {
    cli('--items', 'A2', conditionFile);
    const current = load(state.id, base);
    assert.equal(current.status, 'waiting');
    assert.deepEqual(current.approval.items.map(item => item.id), ['A2']);
    assert.equal(current.approval.items[0].conditions, '確認は1回まで');
    assert.deepEqual(current.approval.pending.map(item => item.id), ['A1', 'A3']);
    assert.deepEqual(current.grants?.paths ?? [], []);
  } finally { release(); }
  cli();
  const current = load(state.id, base);
  assert.equal(current.status, 'ready');
  assert.deepEqual(current.approval.pending, []);
  assert.deepEqual(current.approval.items.map(item => item.id), ['A2', 'A1', 'A3']);
  assert.deepEqual(current.grants.paths, [extra]);
});
