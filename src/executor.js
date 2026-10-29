import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync, writeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { root, dataRoot, directory, save, event, advance, prompt } from './workflow.js';
import { snapshot, changedFiles } from './evidence.js';
import { preflight } from './preflight.js';
import { usage, performanceReport } from './metrics.js';
import { assignment, readConfig } from './config.js';
import { resolveCodex, spawnCommand } from './commands.js';
import { validatePrereview, openSpecRoot, separateOpenSpec, changeDirectories } from './changes.js';
import { rateLimits, insufficient, limitError } from './limits.js';
import { evidenceSelection } from './external-evidence.js';
import { activity, eventStream } from './activity.js';

export const schemaPath = state => join(root, 'src', state.stage === 'prereview' ? 'prereview.schema.json' : 'result.schema.json');

export function resumeSession(state) {
  const value = assignment(state);
  const session = state.session;
  const selected = evidenceSelection(state, state.status === 'running' ? Date.parse(state.inputAt) : Date.now());
  return session?.sessionId && JSON.stringify(session.externalEvidence ?? []) === JSON.stringify(selected) && session.stage === state.stage &&
    ['cli', 'model', 'effort'].every(key => session[key] === value[key]) ? session : null;
}

export const inputFor = state => resumeSession(state) ? state.answers.at(-1).answer : prompt(state, state.status === 'running' ? Date.parse(state.inputAt) : Date.now());

export function codexArgs(state, dir) {
  const value = assignment(state);
  const session = resumeSession(state);
  const mode = ['execute', 'prereview'].includes(state.stage) ? 'workspace-write' : 'read-only';
  const paths = [...(state.grants?.paths ?? []), ...(separateOpenSpec(state) ? changeDirectories(state) : [])];
  return ['exec', ...(session ? ['resume', session.sessionId] : []), '--json',
    ...(!session ? ['--color', 'never', '-C', state.target] : []),
    ...(value.model ? ['-m', value.model] : []),
    ...(value.effort ? ['-c', `model_reasoning_effort="${value.effort}"`] : []),
    ...(process.platform === 'win32' ? ['-c', 'features.prefer_mxc=false', '-c', 'windows.sandbox=elevated'] : []),
    ...(mode === 'workspace-write' && state.grants?.network ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
    ...(mode === 'workspace-write' && paths.length ? ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(paths)}`] : []),
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
    tools.push('Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(ls:*)');
    tools.push('Bash(openspec list:*)', 'Bash(openspec show:*)', 'Bash(openspec status:*)', 'Bash(openspec validate:*)');
    for (const name of state.change ? [state.change] : state.candidates.map(item => item.name)) {
      const path = `${openSpecRoot(state).root.replaceAll('\\', '/')}/openspec/changes/${name}/**`;
      tools.push(`Edit(${path})`, `Write(${path})`);
    }
  } else if (state.stage === 'execute') {
    tools.push('Edit', 'Write', 'Bash');
    if (state.grants?.network) tools.push('WebFetch', 'WebSearch');
  }
  const granted = state.stage === 'execute' ? state.grants : null;
  const paths = [...(granted?.paths ?? []), ...(separateOpenSpec(state) ? changeDirectories(state) : [])];
  return ['-p', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', `Read,Glob,Grep,Edit,Write,Bash${granted?.network ? ',WebFetch,WebSearch' : ''}`,
    ...(paths.length ? ['--add-dir', ...paths] : []),
    ...(value.model ? ['--model', value.model] : []), ...(value.effort ? ['--effort', value.effort] : []),
    '--output-format', 'stream-json', '--verbose', '--json-schema', readFileSync(schemaPath(state), 'utf8'),
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
  let finalOutput;
  const tools = new Map();
  const metadata = { ...value, sessionId, resumed: Boolean(resumeSession(state)), work: state.work ?? null };
  const receive = eventStream(entry => {
    const latest = activity(entry, value.cli, new Date().toISOString(), tools);
    if (latest) state.activity = latest;
    if (entry.type === 'thread.started') metadata.sessionId = entry.thread_id;
    if (entry.type === 'turn.failed' || entry.type === 'error') failure ??= new Error(JSON.stringify(entry));
    if (value.cli === 'claude' && entry.type === 'result') finalOutput = entry;
  });
  try {
    stdout = openSync(join(dir, value.cli === 'codex' ? 'codex.jsonl' : 'claude.jsonl'), 'w');
    stderr = openSync(join(dir, 'stderr.log'), 'w');
    await new Promise((resolve, reject) => {
      const args = value.cli === 'codex' ? codexArgs(state, dir) : claudeArgs(state, sessionId);
      const child = spawnCommand(command, [...prefix, ...args], {
        cwd: state.target, stdio: ['pipe', 'pipe', stderr], windowsHide: true,
      });
      let interrupted = false;
      const stop = () => {
        interrupted = true;
        if (!child.pid) return;
        if (process.platform === 'win32') {
          // Stop the process tree so a tool cannot keep editing after interruption.
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
          killer.once('exit', code => { if (code !== 0) child.kill(); });
        } else child.kill('SIGTERM');
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      child.stdout.on('data', chunk => {
        try {
          // 同期保存で次のチャンクを待たせ、未保存データを蓄積しない。
          let offset = 0;
          while (offset < chunk.length) offset += writeSync(stdout, chunk, offset);
          receive(chunk);
        } catch (error) { failure ??= error; stop(); }
      });
      child.stdout.on('error', error => { failure ??= error; stop(); });
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
    failure ??= error;
  } finally {
    for (const handle of [stdout, stderr]) {
      if (handle !== undefined) { try { closeSync(handle); } catch (error) { failure ??= error; } }
    }
  }
  let result;
  try {
    if (value.cli === 'claude') {
      const output = finalOutput;
      if (!output) throw new Error('Claudeの最終構造化出力がありません');
      writeFileSync(join(dir, 'claude.json'), JSON.stringify(output, null, 2));
      metadata.sessionId = output.session_id ?? sessionId;
      metadata.modelUsage = output.modelUsage ?? null;
      if (output.is_error || output.subtype?.startsWith('error')) throw new Error(JSON.stringify(output));
      result = output.structured_output;
      if (!result || typeof result !== 'object') throw new Error('Claudeの構造化出力がありません');
      writeFileSync(join(dir, 'response.json'), JSON.stringify(result, null, 2));
    } else {
      result = JSON.parse(readFileSync(join(dir, 'response.json'), 'utf8'));
    }
  } catch (error) { failure ??= error; }
  writeFileSync(join(dir, 'invocation.json'), JSON.stringify({ ...metadata, activity: state.activity ?? null }, null, 2));
  if (failure) {
    const logs = [value.cli === 'claude' ? 'claude.jsonl' : 'codex.jsonl', 'stderr.log'].map(file => {
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
  let specBefore;
  if (['execute', 'prereview'].includes(state.stage)) {
    evidence = { attempt: state.attempts, before: join(dir, 'before.json'), after: join(dir, 'after.json'),
      log: join(dir, assignment(state).cli === 'claude' ? 'claude.jsonl' : 'codex.jsonl') };
    before = await snapshot(state.target, evidence.before);
    if (separateOpenSpec(state)) {
      evidence.openspec = { ...openSpecRoot(state), before: join(dir, 'openspec-before.json'), after: join(dir, 'openspec-after.json') };
      delete evidence.openspec.source;
      specBefore = await snapshot(evidence.openspec.root, evidence.openspec.before, ['openspec']);
    }
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
      if (evidence.openspec) {
        try { evidence.openspec.changedFiles = changedFiles(specBefore, await snapshot(evidence.openspec.root, evidence.openspec.after, ['openspec'])); }
        catch (error) { failure ??= error; }
      }
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
  state.inputAt = new Date().toISOString();
  if (!resumeSession(state)) delete state.session;
  const resumed = Boolean(resumeSession(state));
  const metric = { attempt: state.attempts + 1, stage: state.stage, ...value, resumed,
    sessionId: state.session?.sessionId ?? null, beforeLimits, startedAt: state.inputAt,
    externalEvidence: evidenceSelection(state, Date.parse(state.inputAt)) };
  const started = performance.now();
  state.attempts += 1;
  const dir = join(directory(state.id, base), `attempt-${String(state.attempts).padStart(4, '0')}`);
  mkdirSync(dir);
  state.status = 'running';
  state.work = { attempt: state.attempts, stage: state.stage, ...value,
    scope: (['execute', 'review'].includes(state.stage) ? state.tasks.find(task => task.status !== 'completed')?.title : state.change)
      ?? state.requirement.split(/\r?\n/).find(line => line.trim())?.slice(0, 500) ?? '対象未記録',
    startedAt: state.inputAt };
  state.activity = null;
  writeFileSync(join(dir, 'invocation.json'), JSON.stringify({ ...value, work: state.work, activity: null }, null, 2));
  writeFileSync(join(dir, 'prompt.txt'), inputFor(state));
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
      await validate(state, result, evidence?.changedFiles ?? [], undefined, evidence);
    }
    if (result.outcome === 'error' && limitError(result.summary)) {
      const error = new Error(result.summary);
      error.limited = true;
      throw error;
    }
    advance(state, result);
    if (state.status !== 'waiting') delete state.session;
    if (state.status === 'waiting' && metric.sessionId) state.session = { stage: metric.stage, ...value, sessionId: metric.sessionId, externalEvidence: metric.externalEvidence };
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
    const invocationPath = join(dir, 'invocation.json');
    const invocation = JSON.parse(readFileSync(invocationPath, 'utf8'));
    writeFileSync(invocationPath, JSON.stringify({ ...invocation, activity: state.activity }, null, 2));
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
