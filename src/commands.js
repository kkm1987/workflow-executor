import { execFile, spawn } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { basename, dirname, join, delimiter, resolve } from 'node:path';

export function clearCodexLaunchEnvironment(env, platform) {
  if (platform !== 'win32') return;
  delete env.CODEX_WINDOWS_REGISTERED_CORE;
  delete env.CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY;
}

clearCodexLaunchEnvironment(process.env, process.platform);

export function resolveCodex({ localAppData = process.env.LOCALAPPDATA, path = process.env.PATH ?? '', platform = process.platform } = {}) {
  if (platform === 'win32' && localAppData) {
    const bin = join(localAppData, 'OpenAI', 'Codex', 'bin');
    if (existsSync(bin)) {
      const files = readdirSync(bin).map(name => join(bin, name, 'codex.exe')).filter(existsSync);
      files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || a.localeCompare(b));
      if (files.length) return files[0];
    }
  }
  const found = resolveExecutable('codex', path, platform);
  if (found) return found;
  throw new Error('Codex実行ファイルがありません。Codexを導入してください');
}

export const gitBashRecovery = 'Git for Windowsを導入するか、CLAUDE_CODE_GIT_BASH_PATHにbash.exeを指定してください';

export function resolveGitBash(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return 'bash';
  if (env.CLAUDE_CODE_GIT_BASH_PATH) return env.CLAUDE_CODE_GIT_BASH_PATH;
  const path = env.PATH ?? '';
  // WSLのbash.exeはsandbox内でE_ACCESSDENIEDになる。
  const dirs = path.split(delimiter).map(dir => dir.replace(/^"|"$/g, ''))
    .filter(dir => dir && !/[\\/](?:System32|WindowsApps)[\\/]*$/i.test(dir));
  const found = resolveExecutable('bash.exe', dirs.join(delimiter), platform);
  if (found) return found;

  const git = resolveExecutable('git.exe', path, platform);
  if (git) {
    const dir = dirname(git);
    const parent = dirname(dir);
    const name = basename(dir).toLowerCase();
    if (name === 'cmd' || name === 'bin') {
      const root = name === 'bin' && /^(?:mingw64|mingw32|clangarm64)$/i.test(basename(parent)) ? dirname(parent) : parent;
      const bash = join(root, 'bin', 'bash.exe');
      if (statSync(bash, { throwIfNoEntry: false })?.isFile()) return bash;
    }
  }
  throw new Error(`Git Bashが見つかりません。${gitBashRecovery}`);
}

export function resolveExecutable(command, path = process.env.PATH ?? '', platform = process.platform) {
  const names = platform === 'win32' && !command.endsWith('.exe') ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`] : [command];
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = resolve(dir.replace(/^"|"$/g, ''), name);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

export const windowsSandboxArgs = (platform = process.platform) => platform === 'win32' ? ['-c', 'features.prefer_mxc=false', '-c', 'windows.sandbox=elevated'] : [];

// Windowsの`codex sandbox`は`-P`使用時に`sandbox_workspace_write.*`を無視するため、呼び出し単位のプロファイルで渡す（2026-11-05実測）。
export function sandboxProfileArgs(target, roots, network = false, platform = process.platform) {
  if (platform !== 'win32') return ['-P', ':workspace', '-C', target, '--include-managed-config',
    ...(network ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
    ...(roots.length ? ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`] : [])];
  return ['-P', 'workflow-grant', '-C', target, '--include-managed-config', ...windowsSandboxArgs(platform),
    '-c', 'permissions.workflow-grant.extends=":workspace"',
    '-c', `permissions.workflow-grant.workspace_roots={${[...new Set([target, ...roots])].map(root => `${JSON.stringify(root)}=true`).join(',')}}`,
    ...(network ? ['-c', 'permissions.workflow-grant.network.enabled=true'] : [])];
}

// Windowsのnpm shimはシェルへ渡さず、同梱されたJSをNodeで直接起動する。
export function commandSpec(command, args) {
  if (process.platform === 'win32' && /codex\.cmd$/i.test(command)) {
    const script = join(command, '..', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(script)) return [process.execPath, [script, ...args]];
  }
  return [command, args];
}

export function capture(command, args, cwd, timeout = 15_000) {
  const [file, argv] = commandSpec(command, args);
  return new Promise((resolve, reject) => {
    execFile(file, argv, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve(stdout);
    });
  });
}

export function spawnCommand(command, args, options) {
  const [file, argv] = commandSpec(command, args);
  return spawn(file, argv, options);
}
