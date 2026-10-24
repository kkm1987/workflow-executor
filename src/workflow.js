import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, readdirSync, existsSync, openSync, closeSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { resolve, join, dirname, relative, parse, sep, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateModel, stagesFor } from './config.js';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const dataRoot = join(root, 'data');
const now = () => new Date().toISOString();
const stages = ['plan', 'prereview', 'execute', 'review', 'acceptance'];
const MAX_PARTIALS = 10;

export function validateResult(result, stage) {
  if (!stages.includes(stage)) throw new Error('工程が不正です');
  if (!result || !['ok', 'question', 'revise', 'error', 'partial', 'permission'].includes(result.outcome) ||
      typeof result.summary !== 'string' || !result.summary.trim() || typeof result.question !== 'string' ||
      !Array.isArray(result.tasks)) throw new Error('工程の応答形式が不正です');
  if (['question', 'permission'].includes(result.outcome) && !result.question.trim()) throw new Error('質問が空です');
  if (['partial', 'permission'].includes(result.outcome) && stage !== 'execute') throw new Error('この工程では使えない結果です');
  if (result.outcome === 'permission' && !result.permission?.network && !result.permission?.paths?.length) {
    throw new Error('権限要求にはネットワークまたはパスが必要です');
  }
  if (result.outcome === 'revise' && !['review', 'acceptance'].includes(stage)) throw new Error('この工程では差し戻せません');
  for (const task of result.tasks) {
    if (typeof task.title !== 'string' || !task.title.trim() ||
        typeof task.acceptance !== 'string' || !task.acceptance.trim()) throw new Error('タスクと受け入れ条件が必要です');
  }
  if (['plan', 'prereview'].includes(stage) && result.outcome === 'ok' && !result.tasks.length) {
    throw new Error('計画には1件以上のタスクが必要です');
  }
  if (stage === 'prereview' && result.outcome === 'ok' &&
      (!validChangeName(result.change) || ['selection', 'applicability', 'updates'].some(key =>
        typeof result.decisions?.[key] !== 'string' || !result.decisions[key].trim()))) {
    throw new Error('実行前レビューにはchangeと選定・実行可否・更新の根拠が必要です');
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
  if (['question', 'permission'].includes(result.outcome)) {
    state.status = 'waiting';
    state.question = result.question;
    if (result.outcome === 'permission') state.permission = { network: Boolean(result.permission.network), paths: result.permission.paths ?? [] };
    return;
  }
  delete state.session;
  if (result.outcome === 'partial') {
    // 大きなタスク群の途中終了は正常系。tasks.mdの進捗を引き継ぎ、新しいコンテキストで続行する。
    state.partials = (state.partials ?? 0) + 1;
    state.status = state.partials > MAX_PARTIALS ? 'blocked' : 'ready';
    return;
  }
  delete state.partials;
  if (result.outcome === 'revise') {
    state.revisions += 1;
    state.status = state.revisions > 3 ? 'blocked' : 'ready';
    state.stage = state.kind === 'change' ? 'prereview' : 'plan';
    return;
  }
  if (['plan', 'prereview'].includes(state.stage)) {
    if (state.stage === 'prereview') state.change = result.change;
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
  const state = JSON.parse(readFileSync(join(directory(id, base), 'state.json'), 'utf8'));
  state.kind ??= 'request';
  state.models ??= {};
  return state;
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
    limited: '別モデルへの変更、または利用枠のリセット待ち後にretryが必要です',
  }[state.status];
  const result = {
    id: state.id, target: state.target, status: state.status, stage: state.stage,
    kind: state.kind ?? 'request', change: state.change ?? null,
    name: state.requirement.split(/\r?\n/).find(line => line.trim())?.replace(/^#+\s*/, '').trim().slice(0, 32) || '案件',
    statusLabel: { ready: '実行待ち', running: '実行中', waiting: '回答待ち', failed: '技術的失敗', blocked: '手戻り上限', completed: '成果確認可能', limited: '利用枠不足' }[state.status],
    stageLabel: { plan: '計画', prereview: '実行前レビュー', granularity: '旧粒度確認', architecture: '旧設計確認', execute: '実装', review: '独立レビュー', acceptance: '最終確認' }[state.stage],
    owner: ['waiting', 'limited'].includes(state.status) ? 'クライアント' : state.status === 'completed' ? 'クライアント（任意）' : '開発主体',
    completed: state.tasks.filter(task => task.status === 'completed').length,
    total: state.tasks.length, nextAction, updatedAt: state.updatedAt,
  };
  if (state.status === 'waiting') {
    result.question = state.question;
    if (state.permission) result.permission = state.permission;
  }
  if (state.status === 'failed') result.error = state.error;
  if (state.status === 'limited') { result.error = state.error; result.rateLimits = state.rateLimits; }
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
  const groups = [['回答待ち', ['waiting']], ['利用枠不足', ['limited']], ['開発主体の復旧・再計画待ち', ['failed', 'blocked']], ['成果確認可能', ['completed']], ['進行中', ['ready', 'running']]];
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
      if (state.kind === 'change') lines.push('', `change: ${cell(state.change ?? '選定待ち')}`);
      if (state.status === 'limited') lines.push('', `利用枠: ${cell(JSON.stringify(state.rateLimits))}`, '', cell(view.nextAction));
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
    kind: 'request', models: {}, status: 'ready', stage: 'plan', tasks: [], answers: [], lastResult: '', question: '', revisions: 0, attempts: 0 };
  save(state, base);
  event(state, 'created', target, base);
  return state;
}

export function answer(state, text, base = dataRoot) {
  if (state.status !== 'waiting') throw new Error('回答待ちではありません');
  if (!text.trim()) throw new Error('回答が空です');
  state.answers.push({ stage: state.stage, question: state.question, answer: text });
  state.question = '';
  delete state.permission;
  state.status = 'ready';
  event(state, 'answered', state.answers.at(-1), base);
  save(state, base);
}

const secretDirs = ['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker'];

// 権限要求の許可。保存した許可は以後の全工程の実行で有効になり、回答として同じセッションへ伝える。
export function grant(state, { network = false, paths = [] }, base = dataRoot) {
  if (state.status !== 'waiting' || !state.permission) throw new Error('権限要求の回答待ちではありません');
  if (!network && !paths.length) throw new Error('許可するネットワークまたはパスを指定してください');
  const home = realpathSync(homedir());
  const resolved = paths.map(path => {
    const real = realpathSync(resolve(path));
    // 別ドライブでは相対パスが絶対パスになるため、包含判定から除く。
    const inside = (parent, child) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
    if (!statSync(real).isDirectory()) throw new Error(`ディレクトリではありません: ${path}`);
    if (real === parse(real).root || inside(real, home) ||
        (inside(home, real) && secretDirs.includes(relative(home, real).split(sep)[0]))) throw new Error(`許可できないパスです: ${path}`);
    return real;
  });
  state.grants ??= { network: false, paths: [] };
  state.grants.network ||= network;
  state.grants.paths = [...new Set([...state.grants.paths, ...resolved])];
  const text = `許可しました: ${[network && 'ネットワーク', ...resolved].filter(Boolean).join(', ')}`;
  event(state, 'granted', { network, paths: resolved }, base);
  answer(state, text, base);
}

export const validChangeName = name => typeof name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);

export function setModel(state, stage, model, effort, base = dataRoot) {
  if (!stagesFor(state.kind).includes(stage)) throw new Error('工程が不正です');
  const value = validateModel({ model, effort });
  state.models ??= {};
  state.models[stage] = value;
  if (stage === state.stage) {
    delete state.session;
    if (state.status === 'limited') state.status = 'ready';
  }
  event(state, 'model_changed', { stage, ...value }, base);
  save(state, base);
}

export function retry(state, base = dataRoot) {
  if (!['failed', 'running', 'limited'].includes(state.status)) throw new Error('失敗・中断・利用枠不足状態だけ再開できます');
  state.status = 'ready';
  delete state.error;
  delete state.session;
  event(state, 'retry_requested', state.stage, base);
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
  const planning = ['plan', 'prereview'].includes(state.stage);
  const instruction = {
    plan: '要求整理→粒度判定→設計判定の順に行う。decisions.requirementsに要求と受け入れ条件の判断根拠、decisions.granularityに未完了タスクの粒度と順序の根拠、decisions.architectureに既存構成に基づく最も単純な設計の根拠を記す。差し戻し理由を反映し、検証可能な受け入れ条件を持つ未完了タスクを定義する。',
    prereview: '候補から次のchangeを選定し、現在のコード・既存仕様・他のchange・実行環境と照合して実行可否を判断する。必要な調査と技術的決定は自ら行い、業務判断だけ質問する。指定changeがあればそれを使う。changeに名前、decisions.selection・applicability・updatesに各根拠を書く。現状と合わない場合だけ対象changeのディレクトリ内を更新する。順序付きタスク群と受け入れ条件を返す。',
    execute: '最初の未完了タスクだけを実装し、必要な検証を行う。summaryに変更ファイル、検証結果、残る問題を書く。タスク群が大きく1回で終わらない場合は、完了した分のtasks.mdを更新してからoutcome=partialとし、summaryに進捗と残りを書く（未完了のままok・reviewへ進めない）。サンドボックスのネットワーク遮断やワーキングディレクトリ外アクセスの拒否で止まった場合は、outcome=permissionとし、questionに理由、permission.networkとpermission.pathsに必要な最小限の許可を書く。許可されるまで推測で回避しない。',
    review: '最初の未完了タスクの実装を独立してレビューする。evidenceの実装前後の記録とchangedFilesを使い、既存の変更と今回の変更を区別する。evidence.logのCLI実行ログでテストの実行出力・終了コードも確認する。実際のファイルと検証証拠を確認し、受け入れ条件を満たす場合のみok。問題があればreviseで具体的な修正を記す。',
    acceptance: '要求全体と実装・検証結果を照合する。evidenceの記録で既存の無関係なファイルが変更されていないか確認する。不足があればreviseで記す。全て満たす場合のみok。',
  }[state.stage];
  return `Workflow Executorの${state.stage}工程。${instruction}\n` +
    '対象のAGENTS.mdを守る。既存の無関係な変更を保持する。コミット、push、公開、外部への送信はしない。plan・review・acceptance工程ではファイルを編集しない。prereviewは選定したopenspec/changes/<change>/内だけ編集可能。\n' +
    (state.kind === 'change' ? '対象changeのproposal・仕様の差分・design・全tasksを読む。executeは最初の未完了タスク群だけをapplyし、該当tasks.mdの完了状態を更新する。reviewはその実装を独立確認する。acceptanceはタスク群1件でも必ず全仕様の差分・全タスクと実装・検証結果を照合し、工程間の不整合と無関係な変更を確認する。\n' : '') +
    'クライアントの判断が必要なら推測で進めずoutcome=questionとしてquestionに質問を書く。\n' +
    '実行環境やツールのエラーで作業できない場合はoutcome=error、question=""とし、summaryに具体的なエラーを書く。環境エラーをクライアントへの仕様質問にしない。\n' +
    '実行器のデータやログを対象に作らない。応答は指定JSONスキーマのみ。summaryは必要な根拠を簡潔に記す。\n' +
    (planning
      ? 'この工程のoutcome=okでは、tasksに未完了タスクの完全な順序付き一覧を必ず返す。変更不要でも既存の未完了タスクを返し、空配列にしない。完了タスクは再掲しない。\n'
      : 'この工程ではtasks=[]、decisionsの各値は空文字列とする。\n') +
    'permissionはoutcome=permission以外ではnetwork=false、paths=[]とする。\n' +
    JSON.stringify({ requirement: state.requirement, change: state.change, candidates: state.candidates, tasks: state.tasks, decisions: state.decisions, answers: state.answers, previous: state.lastResult, evidence: state.evidence ?? [] });
}
