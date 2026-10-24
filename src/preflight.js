import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';

// 出力には認証情報が含まれる可能性があるため、検査名と終了状態だけを保存する。
export function checkCommand(command, args, cwd, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
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
      else resolve();
    });
  });
}

export async function preflight(state, check = checkCommand) {
  const report = { startedAt: new Date().toISOString(), target: state.target, checks: [], ok: false };
  let name = '開発対象';
  try {
    if (!statSync(state.target).isDirectory()) throw new Error('ディレクトリではありません');
    report.checks.push({ name, ok: true });
    const commands = [
      ['Git作業ツリー', 'git', ['rev-parse', '--show-toplevel']],
      ['Codex CLI', 'codex', ['--version']],
      ['Codex認証', 'codex', ['login', 'status']],
      ...[':read-only', ':workspace'].map(profile => [
        `サンドボックス ${profile}`, 'codex', ['sandbox', '-P', profile, '-C', state.target,
          '--include-managed-config', ...(process.platform === 'win32' ? ['-c', 'features.prefer_mxc=true'] : []),
          '--', process.execPath, '-e', 'process.exit(0)'],
      ]),
    ];
    for (const entry of commands) {
      name = entry[0];
      await check(entry[1], entry[2], state.target);
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
