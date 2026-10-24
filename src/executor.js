import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { root, dataRoot, directory, save, event, advance, prompt } from './workflow.js';
import { snapshot, changedFiles } from './evidence.js';
import { preflight } from './preflight.js';
import { usage, performanceReport } from './metrics.js';
import { assignment, readConfig } from './config.js';
import { resolveCodex, spawnCommand } from './commands.js';
import { validatePrereview } from './changes.js';
import { rateLimits, insufficient, limitError } from './limits.js';

export const schemaPath = state => join(root, 'src', state.stage === 'prereview' ? 'prereview.schema.json' : 'result.schema.json');

export function resumeSession(state) {
  const value = assignment(state);
  const session = state.session;
  return session?.sessionId && session.stage === state.stage &&
    ['cli', 'model', 'effort'].every(key => session[key] === value[key]) ? session : null;
}

export const inputFor = state => resumeSession(state) ? state.answers.at(-1).answer : prompt(state);

export function codexArgs(state, dir) {
  const value = assignment(state);
  const session = resumeSession(state);
  const mode = ['execute', 'prereview'].includes(state.stage) ? 'workspace-write' : 'read-only';
  return ['exec', ...(session ? ['resume', session.sessionId] : []), '--json',
    ...(!session ? ['--color', 'never', '-C', state.target] : []),
    ...(value.model ? ['-m', value.model] : []),
    ...(value.effort ? ['-c', `model_reasoning_effort="${value.effort}"`] : []),
    ...(process.platform === 'win32' ? ['-c', 'features.prefer_mxc=true'] : []),
    ...(session ? ['-c', `sandbox_mode="${mode}"`] : ['--sandbox', mode]),
    '-c', 'approval_policy="never"',
    '--output-schema', schemaPath(state),
    '-o', join(dir, 'response.json'), '-'];
}

export function claudeArgs(state, sessionId) {
  const value = assignment(state);
  const session = resumeSession(state);
  const tools = ['Read', 'Glob', 'Grep'];
  if (state.stage === 'prereview') {
    tools.push('Bash(openspec list:*)', 'Bash(openspec show:*)', 'Bash(openspec status:*)', 'Bash(openspec validate:*)');
    for (const name of state.change ? [state.change] : state.candidates.map(item => item.name)) {
      const path = `${state.target.replaceAll('\\', '/')}/openspec/changes/${name}/**`;
      tools.push(`Edit(${path})`, `Write(${path})`);
    }
  } else if (state.stage === 'execute') tools.push('Edit', 'Write', 'Bash');
  return ['-p', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', 'Read,Glob,Grep,Edit,Write,Bash',
    ...(value.model ? ['--model', value.model] : []), ...(value.effort ? ['--effort', value.effort] : []),
    '--output-format', 'json', '--json-schema', readFileSync(schemaPath(state), 'utf8'),
    ...(session ? ['--resume', session.sessionId] : ['--session-id', sessionId]),
    '--permission-mode', 'dontAsk', '--allowedTools', ...tools];
}

async function invokeAgent(state, dir, command, prefix = []) {
  const value = assignment(state);
  command ??= value.cli === 'codex' ? state.executables?.codex ?? resolveCodex() : state.executables?.claude ?? 'claude';
  const sessionId = value.cli === 'claude' ? resumeSession(state)?.sessionId ?? randomUUID() : null;
  const input = inputFor(state);
  writeFileSync(join(dir, 'prompt.txt'), input);
  let stdout;
  let stderr;
  let failure;
  try {
    stdout = openSync(join(dir, value.cli === 'codex' ? 'codex.jsonl' : 'claude.json'), 'w');
    stderr = openSync(join(dir, 'stderr.log'), 'w');
    await new Promise((resolve, reject) => {
      const args = value.cli === 'codex' ? codexArgs(state, dir) : claudeArgs(state, sessionId);
      const child = spawnCommand(command, [...prefix, ...args], {
        cwd: state.target, stdio: ['pipe', stdout, stderr], windowsHide: true,
      });
      let interrupted = false;
      const stop = () => {
        interrupted = true;
        if (!child.pid) return;
        if (process.platform === 'win32') {
          // Stop the process tree so a tool cannot keep editing after interruption.
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
        } else child.kill('SIGTERM');
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      child.once('error', reject);
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
      child.once('close', code => {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        if (interrupted) reject(new Error('実行が中断されました。対象の変更を確認してからretryしてください'));
        else if (code !== 0) reject(new Error(`${value.cli} CLIが終了コード${code}で失敗しました。stderr.logを確認してください`));
        else resolve();
      });
      child.stdin.end(input);
    });
  } catch (error) {
    failure = error;
  } finally {
    if (stdout !== undefined) closeSync(stdout);
    if (stderr !== undefined) closeSync(stderr);
  }
  const metadata = { ...value, sessionId, resumed: Boolean(resumeSession(state)) };
  let result;
  try {
    if (value.cli === 'claude') {
      const output = JSON.parse(readFileSync(join(dir, 'claude.json'), 'utf8'));
      metadata.sessionId = output.session_id ?? sessionId;
      metadata.modelUsage = output.modelUsage ?? null;
      if (output.is_error || output.subtype?.startsWith('error')) throw new Error(JSON.stringify(output));
      result = output.structured_output;
      if (!result || typeof result !== 'object') throw new Error('Claudeの構造化出力がありません');
      writeFileSync(join(dir, 'response.json'), JSON.stringify(result, null, 2));
    } else {
      for (const line of readFileSync(join(dir, 'codex.jsonl'), 'utf8').split('\n')) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.type === 'thread.started') metadata.sessionId = entry.thread_id;
        if (entry.type === 'turn.failed' || entry.type === 'error') failure ??= new Error(JSON.stringify(entry));
      }
      result = JSON.parse(readFileSync(join(dir, 'response.json'), 'utf8'));
    }
  } catch (error) { failure ??= error; }
  writeFileSync(join(dir, 'invocation.json'), JSON.stringify(metadata, null, 2));
  if (failure) {
    const logs = [value.cli === 'claude' ? 'claude.json' : 'codex.jsonl', 'stderr.log'].map(file => {
      try { return readFileSync(join(dir, file), 'utf8'); } catch { return ''; }
    }).join('\n');
    if (limitError(logs)) failure.limited = true;
    throw failure;
  }
  return result;
}

export async function runAgent(state, dir, command, prefix = []) {
  let evidence;
  let before;
  if (['execute', 'prereview'].includes(state.stage)) {
    evidence = { attempt: state.attempts, before: join(dir, 'before.json'), after: join(dir, 'after.json'),
      log: join(dir, assignment(state).cli === 'claude' ? 'claude.json' : 'codex.jsonl') };
    before = await snapshot(state.target, evidence.before);
    state.evidence ??= [];
    state.evidence.push(evidence);
  }
  let result;
  let failure;
  try { result = await invokeAgent(state, dir, command, prefix); }
  catch (error) { failure = error; }
  finally {
    if (evidence) {
      try { evidence.changedFiles = changedFiles(before, await snapshot(state.target, evidence.after)); }
      catch (error) { failure ??= error; }
    }
  }
  if (failure) throw failure;
  return result;
}

// 既存の呼び出し元とテスト向けの公開名を維持する。
export const runCodex = runAgent;

async function prepare(state, base, check) {
  const report = await check(state);
  if (report.executables) state.executables = report.executables;
  const dir = directory(state.id, base);
  const path = join(dir, `preflight-${Date.now()}-${process.hrtime.bigint()}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  event(state, 'preflight', { path, ...report }, base);
  if (!report.ok) {
    state.status = 'failed';
    state.error = report.error;
    state.question = '';
    event(state, 'failed', report.error, base);
    save(state, base);
  }
  return report.ok;
}

export async function step(state, runner = runCodex, base = dataRoot, check = preflight, limits = rateLimits, validate = validatePrereview) {
  if (state.status !== 'ready') throw new Error(`実行できない状態です: ${state.status}`);
  if (!await prepare(state, base, check)) return state;
  return executeStep(state, runner, base, limits, validate);
}

async function executeStep(state, runner, base, limits, validate) {
  if (['granularity', 'architecture'].includes(state.stage)) {
    event(state, 'stage_migrated', { from: state.stage, to: 'plan' }, base);
    state.stage = 'plan';
  }
  const config = readConfig();
  const value = assignment(state, config);
  const beforeLimits = await limits(state, value);
  state.rateLimits = beforeLimits;
  if (insufficient(beforeLimits, config.limits[state.stage])) {
    state.status = 'limited';
    state.error = '利用枠が固定値を下回っています。別モデルへの変更、またはリセット待ち後にretryしてください';
    delete state.session;
    event(state, 'limited', { ...value, rateLimits: beforeLimits }, base);
    save(state, base);
    return state;
  }
  if (!resumeSession(state)) delete state.session;
  const resumed = Boolean(resumeSession(state));
  const metric = { attempt: state.attempts + 1, stage: state.stage, ...value, resumed,
    sessionId: state.session?.sessionId ?? null, beforeLimits, startedAt: new Date().toISOString() };
  const started = performance.now();
  state.attempts += 1;
  const dir = join(directory(state.id, base), `attempt-${String(state.attempts).padStart(4, '0')}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'prompt.txt'), inputFor(state));
  state.status = 'running';
  save(state, base);
  event(state, 'started', { stage: state.stage, attempt: state.attempts }, base);
  let heartbeatError;
  const heartbeat = setInterval(() => {
    try { save(state, base); } catch (error) {
      heartbeatError = error;
      clearInterval(heartbeat);
    }
  }, 10_000);
  try {
    const result = await runner(state, dir);
    if (heartbeatError) throw heartbeatError;
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
    try { Object.assign(metric, JSON.parse(readFileSync(join(dir, 'invocation.json'), 'utf8'))); } catch {}
    if (state.stage === 'prereview') {
      const evidence = state.evidence?.findLast(entry => entry.attempt === state.attempts);
      await validate(state, result, evidence?.changedFiles ?? []);
    }
    if (result.outcome === 'error' && limitError(result.summary)) {
      const error = new Error(result.summary);
      error.limited = true;
      throw error;
    }
    advance(state, result);
    if (state.status !== 'waiting') delete state.session;
    if (state.status === 'waiting' && metric.sessionId) state.session = { stage: metric.stage, ...value, sessionId: metric.sessionId };
    metric.outcome = result.outcome;
    event(state, state.status === 'completed' ? 'completed' : state.status === 'failed' ? 'failed' : 'finished', result, base);
  } catch (error) {
    state.status = error.limited || limitError(error.message) ? 'limited' : 'failed';
    state.error = error.message;
    delete state.session;
    metric.outcome = 'error';
    event(state, state.status, error.message, base);
  } finally {
    clearInterval(heartbeat);
    metric.finishedAt = new Date().toISOString();
    metric.durationMs = performance.now() - started;
    try { Object.assign(metric, JSON.parse(readFileSync(join(dir, 'invocation.json'), 'utf8'))); } catch {}
    metric.afterLimits = await limits(state, value);
    if (state.status === 'limited') state.rateLimits = metric.afterLimits ?? beforeLimits;
    metric.status = state.status;
    metric.error = ['failed', 'limited'].includes(state.status) ? state.error : null;
    metric.usage = usage(dir, value.cli);
    state.metrics ??= [];
    state.metrics.push(metric);
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metric, null, 2));
    writeFileSync(join(directory(state.id, base), 'performance.json'), JSON.stringify(performanceReport(state), null, 2));
    save(state, base);
  }
  if (resumed && metric.status === 'failed') {
    event(state, 'resume_failed', { attempt: state.attempts, error: state.error }, base);
    state.status = 'ready';
    delete state.error;
    save(state, base);
    return executeStep(state, runner, base, limits, validate);
  }
  return state;
}

export async function run(state, runner = runCodex, base = dataRoot, onProgress = () => {}, check = preflight, limits = rateLimits, validate = validatePrereview) {
  if (state.status !== 'ready') return state;
  if (!await prepare(state, base, check)) { onProgress(state); return state; }
  while (state.status === 'ready') {
    await executeStep(state, runner, base, limits, validate);
    onProgress(state);
  }
  return state;
}
