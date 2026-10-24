import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { root, dataRoot, directory, save, event, advance, prompt } from './workflow.js';
import { snapshot, changedFiles } from './evidence.js';
import { preflight } from './preflight.js';
import { usage, performanceReport } from './metrics.js';

export function codexArgs(state, dir) {
  return ['exec', '--ephemeral', '--json', '--color', 'never', '-C', state.target,
    ...(process.platform === 'win32' ? ['-c', 'features.prefer_mxc=true'] : []),
    '--sandbox', state.stage === 'execute' ? 'workspace-write' : 'read-only',
    '-c', 'approval_policy="never"',
    '--output-schema', join(root, 'src', 'result.schema.json'),
    '-o', join(dir, 'response.json'), '-'];
}

export async function runCodex(state, dir, command = 'codex', prefix = []) {
  let before;
  let evidence;
  if (state.stage === 'execute') {
    evidence = { attempt: state.attempts, before: join(dir, 'before.json'), after: join(dir, 'after.json') };
    before = await snapshot(state.target, evidence.before);
    state.evidence ??= [];
    state.evidence.push(evidence);
  }
  const input = prompt(state);
  writeFileSync(join(dir, 'prompt.txt'), input);
  let stdout;
  let stderr;
  let failure;
  try {
    stdout = openSync(join(dir, 'codex.jsonl'), 'w');
    stderr = openSync(join(dir, 'stderr.log'), 'w');
    await new Promise((resolve, reject) => {
      const child = spawn(command, [...prefix, ...codexArgs(state, dir)], {
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
        else if (code !== 0) reject(new Error(`Codex CLIが終了コード${code}で失敗しました。stderr.logを確認してください`));
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
  if (evidence) {
    try { evidence.changedFiles = changedFiles(before, await snapshot(state.target, evidence.after)); }
    catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  return JSON.parse(readFileSync(join(dir, 'response.json'), 'utf8'));
}

async function prepare(state, base, check) {
  const report = await check(state);
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

export async function step(state, runner = runCodex, base = dataRoot, check = preflight) {
  if (state.status !== 'ready') throw new Error(`実行できない状態です: ${state.status}`);
  if (!await prepare(state, base, check)) return state;
  return executeStep(state, runner, base);
}

async function executeStep(state, runner, base) {
  if (['granularity', 'architecture'].includes(state.stage)) {
    event(state, 'stage_migrated', { from: state.stage, to: 'plan' }, base);
    state.stage = 'plan';
  }
  const metric = { attempt: state.attempts + 1, stage: state.stage, startedAt: new Date().toISOString() };
  const started = performance.now();
  state.attempts += 1;
  const dir = join(directory(state.id, base), `attempt-${String(state.attempts).padStart(4, '0')}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'prompt.txt'), prompt(state));
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
    advance(state, result);
    metric.outcome = result.outcome;
    event(state, state.status === 'completed' ? 'completed' : state.status === 'failed' ? 'failed' : 'finished', result, base);
  } catch (error) {
    state.status = 'failed';
    state.error = error.message;
    metric.outcome = 'error';
    event(state, 'failed', error.message, base);
  } finally {
    clearInterval(heartbeat);
    metric.finishedAt = new Date().toISOString();
    metric.durationMs = performance.now() - started;
    metric.status = state.status;
    metric.error = state.status === 'failed' ? state.error : null;
    metric.usage = usage(dir);
    state.metrics ??= [];
    state.metrics.push(metric);
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metric, null, 2));
    writeFileSync(join(directory(state.id, base), 'performance.json'), JSON.stringify(performanceReport(state), null, 2));
    save(state, base);
  }
  return state;
}

export async function run(state, runner = runCodex, base = dataRoot, onProgress = () => {}, check = preflight) {
  if (state.status !== 'ready') return state;
  if (!await prepare(state, base, check)) { onProgress(state); return state; }
  while (state.status === 'ready') {
    await executeStep(state, runner, base);
    onProgress(state);
  }
  return state;
}
