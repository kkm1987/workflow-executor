import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync, writeSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { root, dataRoot, directory, save, saveActivity, event, advance, validateResult, resolveInquiry, prompt, approvalIds, targetTask, attemptScope, sameScope, executePermissions, escalationCounts, temporaryDirectory } from './workflow.js';
import { snapshot, changedFiles } from './evidence.js';
import { preflight } from './preflight.js';
import { tokenMetrics, performanceReport } from './metrics.js';
import { assignment, attemptAssignment, fallbackAssignment, validateAssignments, readConfig, codexApproval, AUTO_APPROVAL_REVIEWER } from './config.js';
import { resolveCodex, spawnCommand, windowsSandboxArgs } from './commands.js';
import { validatePrereview, openSpecRoot, separateOpenSpec, changeDirectories, writablePaths, taskGate, goBuildCache } from './changes.js';
import { rateLimits, insufficient, limitError, rateLimitsFailures } from './limits.js';
import { evidenceSelection } from './external-evidence.js';
import { activity, eventStream } from './activity.js';
import { codexSession, escalationDecision, rejectApproval } from './codex-app-server.js';
import { reviewCommand, codexReview, answerReviewPrompt, planItems } from './escalation.js';

export const schemaPath = state => join(root, 'src', state.stage === 'prereview' ? 'prereview.schema.json' : 'result.schema.json');

function writeAll(handle, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(handle, bytes, offset);
}

export function resumeSession(state) {
  const value = attemptAssignment(state);
  const session = state.session;
  const selected = evidenceSelection(state, state.status === 'running' ? Date.parse(state.inputAt) : Date.now());
  return session?.sessionId && JSON.stringify(session.externalEvidence ?? []) === JSON.stringify(selected) && session.stage === state.stage &&
    ['cli', 'model', 'effort'].every(key => session[key] === value[key]) ? session : null;
}

export function inputFor(state, config) {
  if (!resumeSession(state)) return prompt(state, state.status === 'running' ? Date.parse(state.inputAt) : Date.now(), config);
  const last = state.answers.at(-1);
  if (last.inquiry) return '回答ではなく確認の質問である。作業を進めず、判断の理由をquestionに書いてoutcome=questionで返す。\n' + last.answer;
  const answer = (last.approval ? '承認計画への所有者の回答です。反映し、継続する項目はIDで示して追加・変更分だけを返してください。\n' : '') + last.answer;
  if (state.stage === 'execute') return answer + '\n' + executePermissions(state, config);
  return state.stage === 'prereview'
    ? answer + '\n承認項目に使えるID（継続: retain、変更元: replace）\n' + JSON.stringify(approvalIds(state))
    : answer;
}

export function codexSandbox(state) {
  return !state.answers.at(-1)?.inquiry && ['execute', 'prereview'].includes(state.stage) ? 'workspace-write' : 'read-only';
}

export function codexThread(state, config) {
  const value = attemptAssignment(state);
  const session = resumeSession(state);
  return { cwd: state.target, sandbox: codexSandbox(state), ...codexApproval(state, config),
    ...(value.model ? { model: value.model } : {}), ...(session ? { threadId: session.sessionId } : {}) };
}

export { writablePaths };

export function codexArgs(state, config = readConfig(), base = dataRoot) {
  const value = attemptAssignment(state);
  const mode = codexSandbox(state);
  const paths = mode === 'workspace-write' ? writablePaths(state, base) : [];
  const disabled = config.codexDisabledSkills;
  const skills = [...new Set([...(disabled?.['*'] ?? []), ...(disabled?.[state.stage] ?? [])])];
  const { approvalPolicy, approvalsReviewer } = codexApproval(state, config);
  return ['app-server',
    ...(value.model ? ['-c', `model=${JSON.stringify(value.model)}`] : []),
    ...(value.effort ? ['-c', `model_reasoning_effort="${value.effort}"`] : []),
    ...windowsSandboxArgs(),
    ...(skills.length ? ['-c', `skills.config=[${skills.map(name => `{name='${name}',enabled=false}`).join(',')}]`] : []),
    ...(mode === 'workspace-write' && state.grants?.network ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
    ...(paths.length ? ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(paths)}`] : []),
    '-c', `sandbox_mode="${mode}"`, '-c', `approval_policy="${approvalPolicy}"`, '-c', `approvals_reviewer="${approvalsReviewer}"`];
}

export function claudeArgs(state, sessionId) {
  const value = attemptAssignment(state);
  const session = resumeSession(state);
  const tools = ['Read', 'Glob', 'Grep'];
  const inquiry = state.answers.at(-1)?.inquiry;
  if (!inquiry && state.stage === 'prereview') {
    tools.push('Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(ls:*)');
    tools.push('Bash(openspec list:*)', 'Bash(openspec show:*)', 'Bash(openspec status:*)', 'Bash(openspec validate:*)');
    for (const directory of changeDirectories(state)) {
      const path = directory.replaceAll('\\', '/');
      tools.push(`Edit(${path}/**)`, `Write(${path}/**)`);
    }
  }
  const paths = !inquiry && separateOpenSpec(state) ? changeDirectories(state) : [];
  return ['-p', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--tools', inquiry ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write,Bash',
    ...(paths.length ? ['--add-dir', ...paths] : []),
    ...(value.model ? ['--model', value.model] : []), ...(value.effort ? ['--effort', value.effort] : []),
    '--output-format', 'stream-json', '--verbose', '--json-schema', readFileSync(schemaPath(state), 'utf8'),
    ...(session ? ['--resume', session.sessionId] : ['--session-id', sessionId]),
    '--permission-mode', 'dontAsk', '--allowedTools', ...tools];
}

// 審査は工程の担当によらず常にCodexで行う。無効または起動できない場合はnullで所有者の判断へ戻す。
function reviewer(state, dir, command, prefix, signal, { escalationReview: setting }) {
  if (!setting) return null;
  let count = 0;
  return input => {
    const path = join(dir, `review-${++count}.jsonl`);
    return codexReview({ command, prefix, cwd: state.target, setting, input, signal, log: line => appendFileSync(path, line) });
  };
}

async function invokeAgent(state, dir, command, prefix, config, base) {
  const value = attemptAssignment(state);
  command ??= value.cli === 'codex' ? state.executables?.codex ?? resolveCodex() : state.executables?.claude ?? 'claude';
  const sessionId = value.cli === 'claude' ? resumeSession(state)?.sessionId ?? randomUUID() : null;
  const input = inputFor(state, config);
  const isAutoReview = codexApproval(state, config).approvalsReviewer === AUTO_APPROVAL_REVIEWER;
  writeFileSync(join(dir, 'prompt.txt'), input);
  let stdout;
  let stderr;
  let rpc;
  let failure;
  let finalOutput;
  const tools = new Map();
  const metadata = { ...value, sessionId, resumed: Boolean(resumeSession(state)), work: state.work ?? null };
  const escalations = [];
  const recordEscalation = (type, detail) => {
    appendFileSync(join(dir, '..', 'events.jsonl'), JSON.stringify({ time: new Date().toISOString(), type, detail }) + '\n');
  };
  const addEscalation = entry => {
    escalations.push(entry);
    state.evidence ??= [];
    let evidence = state.evidence.findLast(item => item.attempt === state.attempts);
    if (!evidence) { evidence = { attempt: state.attempts, stage: state.stage }; state.evidence.push(evidence); }
    evidence.escalations = escalations;
  };
  const receive = eventStream(entry => {
    const latest = activity(entry, value.cli, new Date().toISOString(), tools);
    if (latest) state.activity = latest;
    if (entry.type === 'thread.started') metadata.sessionId = entry.thread_id;
    if (entry.type === 'thread.forked') metadata.forkedFrom = entry.from;
    if (entry.type === 'turn.failed' || entry.type === 'error') failure ??= new Error(JSON.stringify(entry));
    if (value.cli === 'claude' && entry.type === 'result') finalOutput = entry;
  });
  try {
    let env;
    if (value.cli === 'codex') {
      const tmp = temporaryDirectory(state, base);
      const cache = goBuildCache(base);
      for (const path of [tmp, cache]) mkdirSync(path, { recursive: true });
      env = { ...process.env, TMP: tmp, TEMP: tmp, GOTMPDIR: tmp, GOCACHE: cache };
    }
    stdout = openSync(join(dir, value.cli === 'codex' ? 'codex.jsonl' : 'claude.jsonl'), 'w');
    stderr = openSync(join(dir, 'stderr.log'), 'w');
    if (value.cli === 'codex') rpc = openSync(join(dir, 'codex-rpc.jsonl'), 'w');
    await new Promise((resolve, reject) => {
      const args = value.cli === 'codex' ? codexArgs(state, config, base) : claudeArgs(state, sessionId);
      const child = spawnCommand(command, [...prefix, ...args], {
        cwd: state.target, stdio: ['pipe', 'pipe', stderr], windowsHide: true, env,
      });
      let interrupted = false;
      let killed = false;
      let shutdownTimer;
      let session;
      const reviews = new AbortController();
      const kill = () => {
        if (!child.pid) return;
        killed = true;
        if (process.platform === 'win32') {
          // Stop the process tree so a tool cannot keep editing after interruption.
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
          killer.once('exit', code => { if (code !== 0) child.kill(); });
        } else child.kill('SIGTERM');
      };
      const stop = () => {
        interrupted = true;
        failure ??= new Error('実行が中断されました。対象の変更を確認してからretryしてください');
        reviews.abort();
        if (session) {
          try { session.interrupt(); } catch (error) { failure ??= error; }
          shutdownTimer ??= setTimeout(kill, 1000);
        } else kill();
      };
      const fail = error => { failure ??= error; kill(); };
      if (value.cli === 'codex') session = codexSession(child, {
        thread: codexThread(state, config),
        approval: (method, params) => {
          const choice = isAutoReview ? rejectApproval(method) : escalationDecision(state, method, params);
          if (!choice) return null;
          if (isAutoReview) choice.basis = '自動レビューの設定中に実行器へ届いた要求';
          const entry = { time: new Date().toISOString(), attempt: state.attempts, ...attemptScope(state), cli: 'codex', kind: method,
            command: params.command ?? null, commandActions: params.commandActions ?? [], reason: params.reason ?? null, cwd: params.cwd ?? null };
          recordEscalation('escalation_requested', entry);
          const decided = final => {
            Object.assign(entry, { decidedAt: new Date().toISOString(), decision: final.decision, basis: final.basis, layer: final.layer, ...(final.review ? { review: final.review } : {}) });
            addEscalation(entry);
            recordEscalation('escalation_decided', entry);
            return final === choice ? choice.result : { decision: final.decision };
          };
          if (!choice.reviewRequest) return decided(choice);
          return reviewCommand(state, choice, reviewer(state, dir, command, prefix, reviews.signal, config), params.reason).then(decided);
        },
        autoReview: ({ reviewId, review, action, startedAtMs, completedAtMs, decisionSource }) => {
          if (!isAutoReview || !['approved', 'denied', 'timedOut', 'aborted'].includes(review?.status)) return;
          const now = new Date().toISOString();
          const entry = { time: Number.isFinite(startedAtMs) ? new Date(startedAtMs).toISOString() : now,
            decidedAt: Number.isFinite(completedAtMs) ? new Date(completedAtMs).toISOString() : now,
            attempt: state.attempts, ...attemptScope(state), cli: 'codex', kind: action?.type ?? 'autoApprovalReview',
            command: action?.command ?? (action?.type === 'execve' ? JSON.stringify(action.argv) : null),
            reason: action?.reason ?? null, cwd: action?.cwd ?? null,
            decision: review.status === 'approved' ? 'accept' : 'decline', basis: review.rationale ?? null,
            layer: 'autoReview', reviewId: reviewId ?? null, review, decisionSource: decisionSource ?? null };
          addEscalation(entry);
          recordEscalation('escalation_decided', entry);
        },
        turn: { input: [{ type: 'text', text: input }], outputSchema: JSON.parse(readFileSync(schemaPath(state), 'utf8')),
          ...(value.effort ? { effort: value.effort } : {}) },
        emit: entry => { const line = Buffer.from(JSON.stringify(entry) + '\n'); writeAll(stdout, line); receive(line); },
        raw: (direction, line) => writeAll(rpc, JSON.stringify({ direction, line }) + '\n'),
        output: text => writeFileSync(join(dir, 'response.json'), text),
        complete: () => { child.stdin.end(); shutdownTimer ??= setTimeout(kill, 1000); }, fail,
      });
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      child.stdout.on('data', chunk => {
        try {
          if (session) { session.receive(chunk); return; }
          // 同期保存で次のチャンクを待たせ、未保存データを蓄積しない。
          writeAll(stdout, chunk);
          receive(chunk);
        } catch (error) { fail(error); }
      });
      child.stdout.on('error', error => { failure ??= error; stop(); });
      child.once('error', reject);
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') fail(error); });
      child.once('close', code => {
        reviews.abort();
        clearTimeout(shutdownTimer);
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        try { session?.end(); } catch (error) { failure ??= error; }
        if (interrupted) reject(new Error('実行が中断されました。対象の変更を確認してからretryしてください'));
        else if ((session && !session.finished) || (code !== 0 && !killed)) reject(new Error(`${value.cli} CLIが終了コード${code}で失敗しました。stderr.logを確認してください`));
        else resolve();
      });
      if (session) { try { session.start(); } catch (error) { fail(error); } }
      else child.stdin.end(input);
    });
  } catch (error) {
    failure ??= error;
  } finally {
    for (const handle of [stdout, stderr, rpc]) {
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
  writeFileSync(join(dir, 'invocation.json'), JSON.stringify({ ...metadata, activity: state.activity ?? null, escalations }, null, 2));
  if (failure) {
    const logs = [...(value.cli === 'claude' ? ['claude.jsonl'] : ['codex.jsonl', 'codex-rpc.jsonl']), 'stderr.log'].map(file => {
      try { return readFileSync(join(dir, file), 'utf8'); } catch { return ''; }
    }).join('\n');
    if (limitError(logs)) failure.limited = true;
    throw Object.assign(failure, { kind: 'process' });
  }
  return result;
}

export async function runAgent(state, dir, command, prefix = [], config = readConfig(), base = dataRoot) {
  let evidence;
  let before;
  let specBefore;
  if (['execute', 'prereview'].includes(state.stage)) {
    evidence = { attempt: state.attempts, stage: state.stage, before: join(dir, 'before.json'), after: join(dir, 'after.json'),
      log: join(dir, attemptAssignment(state).cli === 'claude' ? 'claude.jsonl' : 'codex.jsonl') };
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
  try { result = await invokeAgent(state, dir, command, prefix, config, base); }
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

function recordFailure(state, scope, error, value, attempt) {
  const previous = sameScope(state.failureStreak, scope) ? state.failureStreak : null;
  const evidence = attempt === null ? null : state.evidence?.findLast(entry => entry.attempt === attempt);
  const entry = { attempt, cli: value?.cli ?? null, model: value?.model ?? null,
    error: String(error.message).slice(0, 500), kind: error.kind,
    changedFiles: [...new Set([...(evidence?.changedFiles ?? []), ...(evidence?.openspec?.changedFiles ?? [])])] };
  state.failureStreak = { ...scope, count: (previous?.count ?? 0) + 1, entries: [...(previous?.entries ?? []), entry] };
  delete state.session;
}

async function prepare(state, base, check) {
  let report;
  try { report = await check(state); }
  catch (error) { report = { ok: false, error: error?.message ?? String(error) }; }
  if (report.execpolicyRules) state.execpolicyRules = report.execpolicyRules;
  if (report.executables) state.executables = { ...state.executables, ...report.executables };
  const dir = directory(state.id, base);
  const path = join(dir, `preflight-${Date.now()}-${process.hrtime.bigint()}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  event(state, 'preflight', { path, ...report }, base);
  if (!report.ok) {
    const error = Object.assign(new Error(report.error || '実行前確認に失敗しました'), { kind: 'preflight' });
    if (state.answers.at(-1)?.inquiry) {
      resolveInquiry(state, { outcome: 'error', summary: error.message });
    } else {
      state.status = 'failed';
      state.error = error.message;
      state.question = '';
      recordFailure(state, attemptScope(state), error, state.attemptAssignment, null);
    }
    event(state, state.status, error.message, base);
    save(state, base);
  }
  return report.ok;
}

export async function step(state, runner = runCodex, base = dataRoot, check = preflight, limits = rateLimits, validate = validatePrereview, review) {
  if (state.status !== 'ready') throw new Error(`実行できない状態です: ${state.status}`);
  delete state.attemptAssignment;
  if (!await prepare(state, base, check)) return state;
  return executeStep(state, runner, base, limits, validate, check, new Set(state.stage === 'execute' ? ['execute:codex'] : []), review);
}

// 回答を根拠とする変更だけを審査する。それ以外と審査の不調は承認待ちになる。
async function reviewAnswers(state, result, dir, review) {
  if (state.stage !== 'prereview' || result?.outcome !== 'ok' || !Array.isArray(result.approvals)) return {};
  const reviews = {};
  for (const [index, item] of result.approvals.entries()) {
    if (state.approval?.returned?.some(entry => entry.id === item?.replaces)) continue;
    const before = planItems(state).find(entry => entry.id === item?.replaces);
    const basis = state.answers[(item?.basisAnswer ?? 0) - 1];
    if (!before || !basis || basis.inquiry || item.gate !== 'plan') continue;
    try {
      const output = await review(answerReviewPrompt(state, before, item, basis.answer), dir, reviews);
      if (output?.decision === 'allow' && output.approvalId === before.id && ['low', 'medium', 'high'].includes(output.riskLevel)) reviews[index] = output;
    } catch {}
  }
  return reviews;
}

function defaultReview(state) {
  return (input, dir, reviews) => {
    const setting = readConfig().escalationReview;
    if (!setting) return null;
    return codexReview({ command: state.executables?.codex ?? resolveCodex(), cwd: state.target, setting, input,
      log: line => appendFileSync(join(dir, `review-${Object.keys(reviews).length + 1}.jsonl`), line) });
  };
}

async function executeStep(state, runner, base, limits, validate, check, checked, review = defaultReview(state)) {
  const inquiry = Boolean(state.answers.at(-1)?.inquiry);
  if (['granularity', 'architecture'].includes(state.stage)) {
    event(state, 'stage_migrated', { from: state.stage, to: 'plan' }, base);
    state.stage = 'plan';
  }
  let config;
  delete state.attemptAssignment;
  try { config = readConfig(); validateAssignments(state, config, { stored: true }); }
  catch (error) {
    state.status = 'failed'; state.error = error.message;
    event(state, 'failed', error.message, base); save(state, base); return state;
  }
  const normal = assignment(state, config);
  const fallback = fallbackAssignment(state, config);
  const scope = attemptScope(state);
  let value = normal;
  const normalResult = await limits(state, normal);
  let beforeLimits = normalResult.limits;
  const selection = { stage: state.stage, normal: { ...normal, rateLimits: beforeLimits }, fallback: fallback ? { ...fallback, rateLimits: null } : null,
    reason: beforeLimits ? '通常側の利用枠が十分' : '通常側の利用枠が未取得', selected: normal };
  if (normalResult.failure) selection.normal.rateLimitsFailure = normalResult.failure;
  if (insufficient(beforeLimits, config.limits[state.stage])) {
    const alternativeResult = fallback ? await limits(state, fallback) : null;
    const alternative = alternativeResult?.limits;
    if (alternativeResult?.failure) selection.fallback.rateLimitsFailure = alternativeResult.failure;
    if (fallback) selection.fallback.rateLimits = alternative;
    if (fallback && (alternative?.primary || alternative?.secondary) && !insufficient(alternative, config.limits[state.stage])) {
      value = fallback; beforeLimits = alternative;
      selection.reason = '通常側の利用枠不足により代替を選択'; selection.selected = fallback;
    } else {
      selection.reason = !fallback ? '通常側の利用枠不足・代替未指定' : !alternative?.primary && !alternative?.secondary ? '通常側の利用枠不足・代替の利用枠が未取得' : '通常側・代替とも利用枠不足';
      selection.selected = null;
    }
  }
  state.selection = selection;
  event(state, 'assignment_selected', selection, base);
  state.rateLimits = beforeLimits;
  if (!selection.selected) {
    state.status = 'limited';
    state.error = `${selection.reason}${rateLimitsFailures(selection) ? `（${rateLimitsFailures(selection)}）` : ''}。別モデルへの変更、またはリセット待ち後にretryしてください`;
    delete state.session;
    event(state, 'limited', { ...value, rateLimits: beforeLimits }, base);
    save(state, base);
    return state;
  }
  state.attemptAssignment = value;
  const checkKey = `${state.stage}:${value.cli}`;
  if ((value === fallback || state.stage === 'execute') && !checked.has(checkKey)) {
    if (!await prepare(state, base, check)) { delete state.attemptAssignment; save(state, base); return state; }
    checked.add(checkKey);
  }
  state.inputAt = new Date().toISOString();
  if (!resumeSession(state)) delete state.session;
  const resumed = Boolean(resumeSession(state));
  const metric = { attempt: state.attempts + 1, stage: state.stage, ...value, resumed,
    executeApprovalReviewer: state.stage === 'execute' && !inquiry ? config.executeApprovalReviewer : null,
    sessionId: state.session?.sessionId ?? null, beforeLimits, startedAt: state.inputAt,
    selection, externalEvidence: evidenceSelection(state, Date.parse(state.inputAt)) };
  const started = performance.now();
  state.attempts += 1;
  const dir = join(directory(state.id, base), `attempt-${String(state.attempts).padStart(4, '0')}`);
  mkdirSync(dir);
  state.status = 'running';
  state.work = { attempt: state.attempts, stage: state.stage, ...value,
    scope: (['execute', 'review'].includes(state.stage) ? targetTask(state)?.title : state.change)
      ?? state.requirement.split(/\r?\n/).find(line => line.trim())?.slice(0, 500) ?? '対象未記録',
    startedAt: state.inputAt };
  state.activity = null;
  writeFileSync(join(dir, 'invocation.json'), JSON.stringify({ ...value, work: state.work, activity: null }, null, 2));
  writeFileSync(join(dir, 'prompt.txt'), inputFor(state, config));
  save(state, base);
  event(state, 'started', { stage: state.stage, attempt: state.attempts }, base);
  let heartbeatError;
  let failure;
  const heartbeat = setInterval(() => {
    try { saveActivity(state, base); } catch (error) {
      heartbeatError = Object.assign(error, { kind: 'process' });
      clearInterval(heartbeat);
    }
  }, 10_000);
  try {
    let result = await (runner === runCodex ? runner(state, dir, undefined, [], config, base) : runner(state, dir));
    if (heartbeatError) throw heartbeatError;
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
    try { Object.assign(metric, JSON.parse(readFileSync(join(dir, 'invocation.json'), 'utf8'))); } catch {}
    if (!inquiry && state.stage === 'prereview') {
      const evidence = state.evidence?.findLast(entry => entry.attempt === state.attempts);
      let files;
      try { files = await validate(state, result, evidence?.changedFiles ?? [], undefined, evidence); }
      catch (error) { throw Object.assign(error, { kind: 'invalid' }); }
      if (files?.length) event(state, 'external_change', { attempt: state.attempts, files }, base);
    }
    if (result?.outcome === 'error' && limitError(result.summary)) {
      if (!inquiry) validateResult(result, state.stage, state);
      const error = new Error(result.summary);
      error.limited = true;
      throw error;
    }
    if (!inquiry && state.kind === 'change' && state.stage === 'acceptance' && result?.outcome === 'ok') {
      const problems = taskGate(state);
      if (problems.length) result = { ...result, outcome: 'revise', summary: `tasks.mdの確認に失敗しました:\n${problems.join('\n')}` };
    }
    if (inquiry) resolveInquiry(state, result);
    else advance(state, result, { reviews: await reviewAnswers(state, result, dir, review), log: (type, detail) => event(state, type, detail, base), base });
    if (state.status === 'failed') {
      failure = Object.assign(new Error(result.summary), { kind: `reported-${result.cause}` });
    }
    if (state.status !== 'waiting') delete state.session;
    if (state.status === 'waiting' && (inquiry || !['partial', 'replan'].includes(result.outcome)) && metric.sessionId) state.session = { stage: metric.stage, ...value, sessionId: metric.sessionId, externalEvidence: metric.externalEvidence };
    metric.outcome = result.outcome;
    event(state, state.status === 'completed' ? 'completed' : state.status === 'failed' ? 'failed' : 'finished', result, base);
  } catch (error) {
    const message = error?.message ?? String(error);
    state.status = error?.limited || limitError(message) ? 'limited' : 'failed';
    if (inquiry && state.status !== 'limited') {
      resolveInquiry(state, { outcome: 'error', summary: message });
      try { Object.assign(metric, JSON.parse(readFileSync(join(dir, 'invocation.json'), 'utf8'))); } catch {}
      if (metric.sessionId) state.session = { stage: metric.stage, ...value, sessionId: metric.sessionId, externalEvidence: metric.externalEvidence };
    } else {
      state.error = message;
      delete state.session;
      failure = { message, kind: error?.kind ?? 'process' };
    }
    metric.outcome = 'error';
    event(state, state.status, message, base);
  } finally {
    clearInterval(heartbeat);
    if (!inquiry) {
      if (state.status === 'failed') recordFailure(state, scope, failure, value, state.attempts);
      else if (state.status !== 'limited') delete state.failureStreak;
    }
    const invocationPath = join(dir, 'invocation.json');
    const invocation = JSON.parse(readFileSync(invocationPath, 'utf8'));
    writeFileSync(invocationPath, JSON.stringify({ ...invocation, activity: state.activity }, null, 2));
    metric.finishedAt = new Date().toISOString();
    metric.durationMs = performance.now() - started;
    try { Object.assign(metric, JSON.parse(readFileSync(join(dir, 'invocation.json'), 'utf8'))); } catch {}
    metric.afterLimits = (await limits(state, value)).limits;
    if (state.status === 'limited') state.rateLimits = metric.afterLimits ?? beforeLimits;
    metric.status = state.status;
    metric.error = ['failed', 'limited'].includes(state.status) ? state.error : null;
    Object.assign(metric, tokenMetrics(dir, value.cli));
    metric.escalationCounts = escalationCounts(metric.escalations);
    state.metrics ??= [];
    state.metrics.push(metric);
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metric, null, 2));
    writeFileSync(join(directory(state.id, base), 'performance.json'), JSON.stringify(performanceReport(state), null, 2));
    delete state.attemptAssignment;
    save(state, base);
  }
  const kind = state.failureStreak?.entries.at(-1)?.kind;
  if (metric.status === 'failed' && state.failureStreak.count === 1 && ['process', 'invalid', 'reported-transient'].includes(kind)) {
    event(state, 'failure_retry', { attempt: state.attempts, error: state.error, kind }, base);
    state.status = 'ready';
    delete state.error;
    save(state, base);
    return executeStep(state, runner, base, limits, validate, check, checked, review);
  }
  return state;
}

export async function run(state, runner = runCodex, base = dataRoot, onProgress = () => {}, check = preflight, limits = rateLimits, validate = validatePrereview) {
  if (state.status === 'closed') throw new Error('終了した案件は実行できません');
  if (state.status !== 'ready') return state;
  delete state.attemptAssignment;
  if (!await prepare(state, base, check)) { onProgress(state); return state; }
  const checked = new Set(state.stage === 'execute' ? ['execute:codex'] : []);
  while (state.status === 'ready') {
    await executeStep(state, runner, base, limits, validate, check, checked);
    onProgress(state);
  }
  return state;
}
