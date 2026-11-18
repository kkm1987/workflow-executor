import { spawn } from 'node:child_process';
import { statSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { openSpecRoot, storeArgs, runOpenSpec, separateOpenSpec, changeDirectories } from './changes.js';
import { resolveCodex, resolveExecutable, spawnCommand, windowsSandboxArgs, sandboxProfileArgs } from './commands.js';
import { assignment, codexApproval, stagesFor, validateExecuteAssignment } from './config.js';
import { codexSession } from './codex-app-server.js';

export function execpolicyRules(target, codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')) {
  const records = [];
  for (const dir of new Set([join(codexHome, 'rules'), join(target, '.codex', 'rules')])) {
    let names;
    try { names = readdirSync(dir); } catch (error) {
      if (error.code !== 'ENOENT') records.push({ path: dir, error: error.code ?? error.message });
      continue;
    }
    for (const name of names.filter(name => name.endsWith('.rules')).sort()) {
      const path = join(dir, name);
      try {
        const count = readFileSync(path, 'utf8').split(/\r?\n/).filter(line => !line.trimStart().startsWith('#') && /\bdecision\s*=\s*["']allow["']/.test(line)).length;
        if (count) records.push({ path, count });
      } catch (error) { records.push({ path, error: error.code ?? error.message }); }
    }
  }
  return records;
}

// Windows elevatedサンドボックスの初回準備は対象が大きいと15秒を超えるため、codex sandboxの起動だけ長くする。
const SANDBOX_TIMEOUT = 120_000;

export async function checkGrantAccess(state, paths, check = checkCommand) {
  if (!paths.length) return;
  const roots = [...(state.grants?.paths ?? []), ...paths, ...(separateOpenSpec(state) ? changeDirectories(state) : [])];
  for (const path of paths) {
    try {
      await check(state.executables?.codex ?? resolveCodex(), ['sandbox', ...sandboxProfileArgs(state.target, roots),
        '--', process.execPath, '-e', `require('node:fs').readdirSync(${JSON.stringify(path)})`], state.target, SANDBOX_TIMEOUT);
    } catch {
      throw new Error(`アクセス確認に失敗しました。OSのアクセス権・サンドボックス設定・管理ポリシーを確認してください: ${path}`);
    }
  }
}

// 出力には認証情報が含まれる可能性があるため、検査名と終了状態だけを保存する。
export function checkCommand(command, args, cwd, timeout = 15_000, thread) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, { cwd, stdio: [thread ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let diagnostic = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8192); });
    let timedOut = false;
    const kill = () => {
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => child.kill());
        killer.once('close', code => { if (code !== 0) child.kill(); });
      } else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    let probe;
    if (thread) {
      const fail = error => { reject(error); kill(); };
      probe = codexSession(child, { thread, probe: true, emit: () => {}, raw: () => {}, complete: () => child.stdin.end(), fail });
      child.stdin.on('error', fail);
      child.stdout.on('data', chunk => { try { probe.receive(chunk); } catch (error) { fail(error); } });
      probe.start();
    } else {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-8192); });
    }
    child.once('error', error => { clearTimeout(timer); reject(new Error(`起動失敗 (${error.code ?? 'unknown'})`)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`タイムアウト (${timeout}ms)`));
      else if (code !== 0) {
        // 生の診断は保存せず、既知の原因だけを固定文へ分類する。
        const cause = diagnostic.includes('registered Core') ? 'Codexアプリ専用のregistered Core起動に失敗（端末の初期セットアップでは解決しない可能性）' :
          diagnostic.includes('orchestrator_helper_exit_nonzero') ? 'Windowsサンドボックスのセットアップ補助プロセスが失敗' :
          diagnostic.includes('default_permissions requires') ? '権限プロファイルの設定が不整合' :
          /not logged in/i.test(diagnostic) ? 'Codexが未認証' :
          /アクセスが拒否|access is denied/i.test(diagnostic) ? 'アクセス拒否' : 'コマンドが失敗';
        reject(new Error(`${cause} (終了コード ${code})`));
      }
      else if (probe && !probe.finished) reject(new Error('app-serverの承認判断者の応答がありません'));
      else resolve(output);
    });
  });
}

export async function preflight(state, check = checkCommand, locate = resolveCodex, locateClaude = () => resolveExecutable('claude'), spec = runOpenSpec) {
  const report = { startedAt: new Date().toISOString(), target: state.target, checks: [], ok: false, execpolicyRules: execpolicyRules(state.target),
    ...(process.platform === 'win32' ? { requestedWindowsSandbox: 'elevated' } : {}) };
  let name = '開発対象';
  try {
    if (!statSync(state.target).isDirectory()) throw new Error('ディレクトリではありません');
    report.checks.push({ name, ok: true });
    name = 'executeのモデル';
    validateExecuteAssignment(state);
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
          '--include-managed-config', ...windowsSandboxArgs(),
          '--', process.execPath, '-e', 'process.exit(0)'], SANDBOX_TIMEOUT,
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
      const output = await check(entry[1], entry[2], state.target, entry[3]);
      if (name === 'Claude認証' && typeof output === 'string' && !JSON.parse(output).loggedIn) throw new Error('Claudeが未認証');
      report.checks.push({ name, ok: true, ...(entry[2][0] === '--version' ? { path: entry[1], version: typeof output === 'string' ? output.trim() : null } : {}) });
    }
    if (state.stage === 'execute' && !state.answers?.at(-1)?.inquiry) {
      name = 'Codexの承認判断者';
      const approval = codexApproval(state);
      await check(codex, ['app-server', ...windowsSandboxArgs(), '-c', `approvals_reviewer="${approval.approvalsReviewer}"`],
        state.target, undefined, { cwd: state.target, sandbox: 'workspace-write', ephemeral: true, ...approval });
      report.checks.push({ name, ok: true, approvalsReviewer: approval.approvalsReviewer });
    }
    if (state.stage === 'execute' && state.grants?.paths?.length && !state.answers?.at(-1)?.inquiry) {
      name = 'Codexの追加パスアクセス';
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
