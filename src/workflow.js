import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, readdirSync, existsSync, openSync, closeSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const dataRoot = join(root, 'data');
const now = () => new Date().toISOString();
const stages = ['plan', 'execute', 'review', 'acceptance'];

export function validateResult(result, stage) {
  if (!stages.includes(stage)) throw new Error('工程が不正です');
  if (!result || !['ok', 'question', 'revise', 'error'].includes(result.outcome) ||
      typeof result.summary !== 'string' || !result.summary.trim() || typeof result.question !== 'string' ||
      !Array.isArray(result.tasks)) throw new Error('工程の応答形式が不正です');
  if (result.outcome === 'question' && !result.question.trim()) throw new Error('質問が空です');
  if (result.outcome === 'revise' && !['review', 'acceptance'].includes(stage)) throw new Error('この工程では差し戻せません');
  for (const task of result.tasks) {
    if (typeof task.title !== 'string' || !task.title.trim() ||
        typeof task.acceptance !== 'string' || !task.acceptance.trim()) throw new Error('タスクと受け入れ条件が必要です');
  }
  if (stage === 'plan' && result.outcome === 'ok' && !result.tasks.length) {
    throw new Error('計画には1件以上のタスクが必要です');
  }
  if (stage === 'plan' && result.outcome === 'ok' &&
      ['requirements', 'granularity', 'architecture'].some(key => typeof result.decisions?.[key] !== 'string' || !result.decisions[key].trim())) {
    throw new Error('計画には要求整理・粒度判定・設計判定の根拠が必要です');
  }
  return result;
}

export function advance(state, result) {
  validateResult(result, state.stage);
  state.lastResult = result.summary;
  if (result.outcome === 'error') {
    state.status = 'failed';
    state.error = result.summary;
    state.question = '';
    return;
  }
  if (result.outcome === 'question') {
    state.status = 'waiting';
    state.question = result.question;
    return;
  }
  if (result.outcome === 'revise') {
    state.revisions += 1;
    state.status = state.revisions > 3 ? 'blocked' : 'ready';
    state.stage = 'plan';
    return;
  }
  if (state.stage === 'plan') {
    const completed = state.tasks.filter(task => task.status === 'completed');
    state.tasks = [...completed, ...result.tasks.map(task => ({ ...task, status: 'pending' }))];
    state.decisions = result.decisions;
    state.stage = 'execute';
  } else if (state.stage === 'execute') {
    state.tasks.find(task => task.status !== 'completed').result = result.summary;
    state.stage = 'review';
  } else if (state.stage === 'review') {
    state.tasks.find(task => task.status !== 'completed').status = 'completed';
    state.stage = state.tasks.every(task => task.status === 'completed') ? 'acceptance' : 'execute';
  } else {
    state.status = 'completed';
    return;
  }
  state.status = 'ready';
}

export function directory(id, base = dataRoot) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('ワークフローIDが不正です');
  return join(base, id);
}

export function save(state, base = dataRoot) {
  const dir = directory(state.id, base);
  mkdirSync(dir, { recursive: true });
  state.updatedAt = now();
  const path = join(dir, 'state.json');
  writeFileSync(`${path}.new`, JSON.stringify(state, null, 2));
  renameSync(`${path}.new`, path);
  dashboard(base);
}

export function load(id, base = dataRoot) {
  return JSON.parse(readFileSync(join(directory(id, base), 'state.json'), 'utf8'));
}

export function list(base = dataRoot) {
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => join(base, entry.name, 'state.json')).filter(existsSync)
    .map(path => JSON.parse(readFileSync(path, 'utf8')));
}

export function summary(state, base = dataRoot) {
  const nextAction = {
    ready: 'エージェントが次の工程へ進めます',
    running: '実行中です。いま回答や判断は必要ありません',
    waiting: '質問への回答が必要です。回答するまでこのワークフローは停止します',
    failed: 'エラーと途中の変更を確認し、再開方法を判断する必要があります',
    blocked: 'レビューの手戻り上限に達しました。要求や進め方の見直しが必要です',
    completed: '成果と検証結果を確認できます',
  }[state.status];
  const result = {
    id: state.id, target: state.target, status: state.status, stage: state.stage,
    name: state.requirement.split(/\r?\n/).find(line => line.trim())?.replace(/^#+\s*/, '').trim().slice(0, 32) || '案件',
    statusLabel: { ready: '実行待ち', running: '実行中', waiting: '回答待ち', failed: '技術的失敗', blocked: '手戻り上限', completed: '成果確認可能' }[state.status],
    stageLabel: { plan: '計画', granularity: '旧粒度確認', architecture: '旧設計確認', execute: '実装', review: '独立レビュー', acceptance: '最終確認' }[state.stage],
    owner: state.status === 'waiting' ? 'クライアント' : state.status === 'completed' ? 'クライアント（任意）' : '開発主体',
    completed: state.tasks.filter(task => task.status === 'completed').length,
    total: state.tasks.length, nextAction, updatedAt: state.updatedAt,
  };
  if (state.status === 'waiting') result.question = state.question;
  if (state.status === 'failed') result.error = state.error;
  if (['completed', 'blocked'].includes(state.status)) result.result = state.lastResult;
  if (state.status === 'completed') {
    result.artifact = state.target;
    result.verification = join(directory(state.id, base), `attempt-${String(state.attempts).padStart(4, '0')}`, 'result.json');
  }
  return result;
}

export function dashboard(base = dataRoot) {
  mkdirSync(base, { recursive: true });
  const states = list(base);
  const cell = value => String(value ?? '').replace(/[\r\n]/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\|`*_[\]])/g, '\\$1');
  const url = path => encodeURI(path.replace(/\\/g, '/')).replace(/[()#]/g, char => `%${char.charCodeAt(0).toString(16)}`);
  const lines = ['# Workflow Executor', '', `更新: ${now()}`, '', '成果・検証結果はチャットでも確認できます。完了はクライアントの承認を意味しません。'];
  const groups = [['回答待ち', ['waiting']], ['開発主体の復旧・再計画待ち', ['failed', 'blocked']], ['成果確認可能', ['completed']], ['進行中', ['ready', 'running']]];
  for (const [label, statuses] of groups) {
    const selected = states.filter(state => statuses.includes(state.status));
    if (!selected.length) continue;
    lines.push('', `## ${label}`, '', '| 案件 | 状態 | 工程 | 完了 | 対応者 | 必要な対応 | 最終更新 |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const state of selected) {
      const view = summary(state, base);
      lines.push(`| [${cell(view.name)}](${state.id}/state.json) | ${view.statusLabel} | ${view.stageLabel} | ${view.completed}/${view.total} | ${view.owner} | ${cell(view.nextAction)} | ${cell(view.updatedAt)} |`);
    }
    for (const state of selected) {
      const view = summary(state, base);
      lines.push('', '<details>', `<summary>${cell(view.name)}の詳細</summary>`, '', `ID: ${cell(state.id)}`, '', `開発対象: ${cell(state.target)}`);
      if (state.status === 'waiting') lines.push('', `停止理由: ${cell(state.lastResult)}`, '', `質問: ${cell(state.question)}`);
      if (state.status === 'failed') lines.push('', `停止理由: ${cell(state.error)}`);
      if (state.status === 'blocked') lines.push('', `差し戻し理由: ${cell(state.lastResult)}`);
      if (state.status === 'completed') lines.push('', `[成果](${url(state.target)}/) · [検証結果](${state.id}/attempt-${String(state.attempts).padStart(4, '0')}/result.json)`, '', `結果: ${cell(state.lastResult)}`);
      lines.push('', '</details>');
    }
  }
  writeFileSync(join(base, 'dashboard.md.new'), `${lines.join('\n')}\n`);
  renameSync(join(base, 'dashboard.md.new'), join(base, 'dashboard.md'));
}

export function event(state, type, detail, base = dataRoot) {
  appendFileSync(join(directory(state.id, base), 'events.jsonl'), JSON.stringify({ time: now(), type, detail }) + '\n');
}

export function create(target, requirement, base = dataRoot) {
  target = realpathSync(resolve(target));
  if (!statSync(target).isDirectory()) throw new Error('開発対象はディレクトリを指定してください');
  if (!requirement.trim()) throw new Error('要求が空です');
  const state = { id: randomUUID(), target, requirement, createdAt: now(), updatedAt: now(),
    status: 'ready', stage: 'plan', tasks: [], answers: [], lastResult: '', question: '', revisions: 0, attempts: 0 };
  save(state, base);
  event(state, 'created', target, base);
  return state;
}

export function answer(state, text, base = dataRoot) {
  if (state.status !== 'waiting') throw new Error('回答待ちではありません');
  if (!text.trim()) throw new Error('回答が空です');
  state.answers.push({ stage: state.stage, question: state.question, answer: text });
  state.question = '';
  state.status = 'ready';
  event(state, 'answered', state.answers.at(-1), base);
  save(state, base);
}

export function lock(base = dataRoot) {
  mkdirSync(base, { recursive: true });
  const path = join(base, 'executor.lock');
  let handle;
  try { handle = openSync(path, 'wx'); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('別の操作が実行中です。中断後の復旧方法はREADMEを参照してください');
    throw error;
  }
  writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: now() }));
  return () => { closeSync(handle); unlinkSync(path); };
}

export function prompt(state) {
  const planning = state.stage === 'plan';
  const instruction = {
    plan: '要求整理→粒度判定→設計判定の順に行う。decisions.requirementsに要求と受け入れ条件の判断根拠、decisions.granularityに未完了タスクの粒度と順序の根拠、decisions.architectureに既存構成に基づく最も単純な設計の根拠を記す。差し戻し理由を反映し、検証可能な受け入れ条件を持つ未完了タスクを定義する。',
    execute: '最初の未完了タスクだけを実装し、必要な検証を行う。summaryに変更ファイル、検証結果、残る問題を書く。',
    review: '最初の未完了タスクの実装を独立してレビューする。evidenceの実装前後の記録とchangedFilesを使い、既存の変更と今回の変更を区別する。実際のファイルと検証証拠を確認し、受け入れ条件を満たす場合のみok。問題があればreviseで具体的な修正を記す。',
    acceptance: '要求全体と実装・検証結果を照合する。evidenceの記録で既存の無関係なファイルが変更されていないか確認する。不足があればreviseで記す。全て満たす場合のみok。',
  }[state.stage];
  return `Workflow Executorの${state.stage}工程。${instruction}\n` +
    '対象のAGENTS.mdを守る。既存の無関係な変更を保持する。コミット、push、公開、外部への送信はしない。計画・レビュー工程ではファイルを編集しない。\n' +
    'クライアントの判断が必要なら推測で進めずoutcome=questionとしてquestionに質問を書く。\n' +
    '実行環境やツールのエラーで作業できない場合はoutcome=error、question=""とし、summaryに具体的なエラーを書く。環境エラーをクライアントへの仕様質問にしない。\n' +
    '実行器のデータやログを対象に作らない。応答は指定JSONスキーマのみ。summaryは必要な根拠を簡潔に記す。\n' +
    (planning
      ? 'この工程のoutcome=okでは、tasksに未完了タスクの完全な順序付き一覧を必ず返す。変更不要でも既存の未完了タスクを返し、空配列にしない。完了タスクは再掲しない。\n'
      : 'この工程ではtasks=[]、decisionsの各値は空文字列とする。\n') +
    JSON.stringify({ requirement: state.requirement, tasks: state.tasks, decisions: state.decisions, answers: state.answers, previous: state.lastResult, evidence: state.evidence ?? [] });
}
