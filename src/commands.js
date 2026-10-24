import { execFile, spawn } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, delimiter, resolve } from 'node:path';

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

export function resolveExecutable(command, path = process.env.PATH ?? '', platform = process.platform) {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const name of platform === 'win32' ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`] : [command]) {
      const candidate = resolve(dir.replace(/^"|"$/g, ''), name);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
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
