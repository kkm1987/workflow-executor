import { capture, spawnCommand, resolveCodex } from './commands.js';

const windowValue = value => value && Number.isFinite(value.usedPercent) && value.usedPercent >= 0 && value.usedPercent <= 100
  ? { usedPercent: value.usedPercent, resetsAt: value.resetsAt ?? null } : null;

export function parseCodexLimits(value) {
  const limits = value?.result?.rateLimits ?? value?.rateLimits ?? value;
  const primary = windowValue(limits?.primary);
  const secondary = windowValue(limits?.secondary);
  return primary || secondary ? { primary, secondary } : null;
}

export function parseClaudeLimits(output) {
  let value;
  try { value = typeof output === 'string' ? JSON.parse(output) : output; } catch { return null; }
  if (typeof value?.result !== 'string') return null;
  const parse = expression => {
    const match = value.result.match(expression);
    return match ? windowValue({ usedPercent: Number(match[1]) }) : null;
  };
  const primary = parse(/Current session:\s*(\d+(?:\.\d+)?)%\s*used/i);
  const secondary = parse(/Current week \(all models\):\s*(\d+(?:\.\d+)?)%\s*used/i);
  return primary || secondary ? { primary, secondary } : null;
}

export function codexLimits(command, cwd, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let pending = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('利用枠取得タイムアウト')), timeout);
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('close', () => finish(new Error('利用枠取得中に終了')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(new Error('利用枠の初期化失敗'));
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: 'account/rateLimits/read', params: {} });
        } else if (message.id === 2) finish(null, parseCodexLimits(message));
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'workflow-executor', version: '1.0' } } });
  });
}

export async function rateLimits(state, value) {
  try {
    if (value.cli === 'claude') return parseClaudeLimits(await capture(state.executables?.claude ?? 'claude', ['-p', '/usage', '--output-format', 'json'], state.target));
    return await codexLimits(state.executables?.codex ?? resolveCodex(), state.target);
  } catch { return null; }
}

export function insufficient(limits, minimum) {
  return ['primary', 'secondary'].some(key => limits?.[key] && 100 - limits[key].usedPercent < minimum[key]);
}

export const limitError = text => /rate_limit_reached|usage_limit_reached|usage limit|rate limit|hit your limit|out of extra usage|limit reached|insufficient_quota/i.test(text);
