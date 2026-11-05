import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attemptAssignment } from './config.js';
import { commandDecision, codexReview, inside, reviewCommand } from './escalation.js';

export const PROBE_MARKER = 'workflow-gate-probe';
const ESCALATE = /^#\s*workflow-escalate:\s*(.*)\r?\n/;
const script = fileURLToPath(import.meta.url);

const hookCommand = argument => `'${process.execPath.replaceAll('\\', '/')}' '${script.replaceAll('\\', '/')}' '${argument.replaceAll('\\', '/')}'`;

export const gateRequired = state => state.stage === 'execute' && !state.answers.at(-1)?.inquiry && attemptAssignment(state).cli === 'claude';

// 既存のBashと同じくフックが失敗したら実行しない。
export const gateSettings = context => JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Edit|Write',
  hooks: [{ type: 'command', command: hookCommand(context), timeout: 300, onFailure: 'block' }] }] } });

export const probeSettings = () => JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCommand('--probe') }] }] } });

const deny = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const allow = updatedInput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', ...(updatedInput ? { updatedInput } : {}) } });

// 未作成のファイルも判定できるよう、存在する親までを実パスにする。
function realTarget(path) {
  let current = path;
  const rest = [];
  while (!existsSync(current) && dirname(current) !== current) { rest.unshift(basename(current)); current = dirname(current); }
  return join(realpathSync(current), ...rest);
}

function writeAllowed(path, context) {
  const real = realTarget(path);
  const same = process.platform === 'win32' ? value => value.toLowerCase() : value => value;
  const roots = context.writable.filter(existsSync).map(root => realpathSync(root));
  const root = roots.find(entry => inside(same(entry), same(real)));
  if (!root) return false;
  // `.git`などはsandboxが保護する。Edit・Writeで書けると安全なgit読み取りの前提が崩れる。
  return context.state.grants?.paths?.some(path => /[\\/]\.git(?:[\\/]|$)/.test(path)) ||
    !real.slice(root.length).split(sep).some(part => ['.git', '.codex', '.agents'].includes(part.toLowerCase()));
}

export async function decide(input, context) {
  const log = entry => appendFileSync(join(context.dir, 'gate.jsonl'), JSON.stringify(entry) + '\n');
  const record = (kind, command, reason, cwd, final) => log({ time: new Date().toISOString(), attempt: context.attempt, ...context.scope, cli: 'claude', kind,
    command, commandActions: command ? [{ type: 'unknown', command }] : [], reason, cwd, decidedAt: new Date().toISOString(),
    decision: final.decision, basis: final.basis, layer: final.layer, ...(final.review ? { review: final.review } : {}) });
  const { tool_name: tool, tool_input: value = {}, cwd = context.state.target } = input;
  if (tool === 'Edit' || tool === 'Write') {
    if (typeof value.file_path !== 'string') return deny('対象のパスを取得できません');
    const path = isAbsolute(value.file_path) ? value.file_path : resolve(cwd, value.file_path);
    if (writeAllowed(path, context)) return allow();
    record(`claude/${tool}`, null, null, cwd, { decision: 'decline', basis: `許可された範囲の外への書き込み: ${path}`, layer: 1 });
    return deny('許可された範囲の外には書き込めません。必要ならoutcome=permissionで要求してください');
  }
  if (tool !== 'Bash' || typeof value.command !== 'string') return deny('判断できないツールです');
  const marker = value.command.match(ESCALATE);
  if (marker) {
    const command = value.command.slice(marker[0].length).trim();
    const run = context.review && (input => codexReview({ ...context.codex, cwd: context.state.target, setting: context.review, input,
      log: line => appendFileSync(join(context.dir, `review-gate-${process.pid}.jsonl`), line) }));
    const final = await reviewCommand(context.state, commandDecision(context.state, command, cwd), run, marker[1] || null);
    record('claude/Bash', command, marker[1] || null, cwd, final);
    return final.decision === 'accept' ? allow({ ...value, command })
      : deny(`昇格を拒否しました（${final.basis}）。推測で回避せず、outcome=permissionのpermission.commandsに完全なコマンドを書いて返してください`);
  }
  return allow({ ...value, command: `${context.sandbox} '${value.command.replaceAll("'", "'\\''")}'` });
}

async function main() {
  if (process.argv[2] === '--probe') { console.log(JSON.stringify({ decision: 'block', reason: PROBE_MARKER })); return; }
  let output;
  try {
    const context = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    output = await decide(JSON.parse(readFileSync(0, 'utf8')), context);
  } catch (error) { output = deny(`判断の仕組みが失敗しました: ${error.message}`); }
  console.log(JSON.stringify(output));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(script)) await main();
