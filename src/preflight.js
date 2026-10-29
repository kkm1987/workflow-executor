import { spawn } from 'node:child_process';
import { statSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openSpecRoot, storeArgs, runOpenSpec, separateOpenSpec, changeDirectories } from './changes.js';
import { resolveCodex, resolveExecutable, spawnCommand } from './commands.js';
import { assignment, attemptAssignment, stagesFor } from './config.js';

export async function checkGrantAccess(state, paths, check = checkCommand) {
  if (!paths.length) return;
  const codex = (state.attemptAssignment ?? assignment({ ...state, stage: 'execute' })).cli === 'codex';
  const roots = [...(state.grants?.paths ?? []), ...paths, ...(separateOpenSpec(state) ? changeDirectories(state) : [])];
  for (const path of paths) {
    try {
      if (codex) {
        await check(state.executables?.codex ?? resolveCodex(), ['sandbox', '-P', process.platform === 'win32' ? 'workflow-grant' : ':workspace', '-C', state.target,
          '--include-managed-config', ...(process.platform === 'win32' ? ['-c', 'features.prefer_mxc=false', '-c', 'windows.sandbox=elevated'] : []),
          ...(process.platform === 'win32' ? ['-c', 'permissions.workflow-grant.extends=":workspace"',
            '-c', `permissions.workflow-grant.workspace_roots={${[...new Set(roots)].map(root => `${JSON.stringify(root)}=true`).join(',')}}`] :
            ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`]),
          '--', process.execPath, '-e', `require('node:fs').readdirSync(${JSON.stringify(path)})`], state.target);
      } else readdirSync(path);
    } catch {
      throw new Error(`アクセス確認に失敗しました。OSのアクセス権・サンドボックス設定・管理ポリシーを確認してください: ${path}`);
    }
  }
}

// 出力には認証情報が含まれる可能性があるため、検査名と終了状態だけを保存する。
export function checkCommand(command, args, cwd, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-8192); });
    let diagnostic = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8192); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => child.kill());
        killer.once('close', code => { if (code !== 0) child.kill(); });
      } else child.kill('SIGKILL');
    }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(new Error(`起動失敗 (${error.code ?? 'unknown'})`)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`タイムアウト (${timeout}ms)`));
      else if (code !== 0) {
        // 生の診断は保存せず、既知の原因だけを固定文へ分類する。
        const cause = diagnostic.includes('orchestrator_helper_exit_nonzero') ? 'Windowsサンドボックスのセットアップ補助プロセスが失敗' :
          diagnostic.includes('default_permissions requires') ? '権限プロファイルの設定が不整合' :
          /not logged in/i.test(diagnostic) ? 'Codexが未認証' :
          /アクセスが拒否|access is denied/i.test(diagnostic) ? 'アクセス拒否' : 'コマンドが失敗';
        reject(new Error(`${cause} (終了コード ${code})`));
      }
      else resolve(output);
    });
  });
}

export async function preflight(state, check = checkCommand, locate = resolveCodex, locateClaude = () => resolveExecutable('claude'), spec = runOpenSpec) {
  const report = { startedAt: new Date().toISOString(), target: state.target, checks: [], ok: false,
    ...(process.platform === 'win32' ? { requestedWindowsSandbox: 'elevated' } : {}) };
  let name = '開発対象';
  try {
    if (!statSync(state.target).isDirectory()) throw new Error('ディレクトリではありません');
    report.checks.push({ name, ok: true });
    if (state.kind === 'change') {
      name = 'OpenSpecルートの解決';
      const root = openSpecRoot(state).root;
      const listing = JSON.parse(await spec(root, ['list', '--json', ...storeArgs(state)]));
      if (!listing.root?.path || resolve(listing.root.path) !== resolve(root)) throw new Error('保存したルートと一致しません');
      report.checks.push({ name, ok: true });
      name = 'OpenSpecのGit作業ツリー';
      await check('git', ['rev-parse', '--show-toplevel'], root);
      report.checks.push({ name, ok: true });
    }
    name = 'Codex実行ファイル';
    const codex = locate();
    report.executables = { codex };
    const commands = [
      ['Git作業ツリー', 'git', ['rev-parse', '--show-toplevel']],
      ['Codex CLI', codex, ['--version']],
      ['Codex認証', codex, ['login', 'status']],
      ...[':read-only', ':workspace'].map(profile => [
        `サンドボックス ${profile}`, codex, ['sandbox', '-P', profile, '-C', state.target,
          '--include-managed-config', ...(process.platform === 'win32' ? ['-c', 'features.prefer_mxc=false', '-c', 'windows.sandbox=elevated'] : []),
          '--', process.execPath, '-e', 'process.exit(0)'],
      ]),
    ];
    if (state.attemptAssignment?.cli === 'claude' || stagesFor(state.kind).some(stage => assignment({ ...state, stage }).cli === 'claude')) {
      name = 'Claude実行ファイル';
      const claude = locateClaude();
      if (!claude) throw new Error('Claude CLIを導入してください');
      report.executables.claude = claude;
      commands.push(['Claude CLI', claude, ['--version']], ['Claude認証', claude, ['auth', 'status', '--json']]);
    }
    for (const entry of commands) {
      name = entry[0];
      const output = await check(entry[1], entry[2], state.target);
      if (name === 'Claude認証' && typeof output === 'string' && !JSON.parse(output).loggedIn) throw new Error('Claudeが未認証');
      report.checks.push({ name, ok: true, ...(entry[2][0] === '--version' ? { path: entry[1], version: typeof output === 'string' ? output.trim() : null } : {}) });
    }
    if (state.attemptAssignment && state.stage === 'execute') {
      name = `${attemptAssignment(state).cli}の追加パスアクセス`;
      await checkGrantAccess({ ...state, executables: { ...state.executables, ...report.executables } }, state.grants?.paths ?? [], check);
      report.checks.push({ name, ok: true });
    }
    report.ok = true;
  } catch (error) {
    report.error = `${name}: ${error.code ?? error.message}。開発主体が環境を復旧してからretryしてください`;
    report.checks.push({ name, ok: false, error: report.error });
  }
  report.finishedAt = new Date().toISOString();
  return report;
}
