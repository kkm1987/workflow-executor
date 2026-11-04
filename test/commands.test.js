import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { clearCodexLaunchEnvironment } from '../src/commands.js';
import { checkCommand } from '../src/preflight.js';

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
