import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const stagesFor = kind => kind === 'change'
  ? ['prereview', 'execute', 'review', 'acceptance'] : ['plan', 'execute', 'review', 'acceptance'];

export const AUTO_APPROVAL_REVIEWER = 'auto_review';

export function codexApproval(state, config) {
  const execute = state.stage === 'execute' && !state.answers?.at(-1)?.inquiry;
  return {
    approvalPolicy: execute ? 'on-request' : 'never',
    approvalsReviewer: execute && (config ?? readConfig()).executeApprovalReviewer === 'auto-review' ? AUTO_APPROVAL_REVIEWER : 'user',
  };
}

export function validateModel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('モデルの指定が不正です');
  const { model = null, effort = null } = value;
  if (model !== null && (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model))) throw new Error('モデル名が不正です');
  const cli = model?.startsWith('claude-') ? 'claude' : 'codex';
  if (value.cli !== undefined && value.cli !== cli) throw new Error('CLIの指定が不正です');
  const efforts = cli === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  if (effort !== null && !efforts.includes(effort)) throw new Error('推論レベルが不正です');
  return { cli, model, effort };
}

export function readConfig(path = new URL('../workflow.config.json', import.meta.url)) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (config.executeApprovalReviewer === undefined) config.executeApprovalReviewer = 'auto-review';
  if (!['auto-review', 'executor'].includes(config.executeApprovalReviewer)) throw new Error('executeApprovalReviewerの指定が不正です');
  const disabled = config.codexDisabledSkills;
  if (disabled !== undefined && (!disabled || typeof disabled !== 'object' || Array.isArray(disabled) ||
    Object.entries(disabled).some(([stage, names]) => !['*', 'plan', ...stagesFor('change')].includes(stage) ||
      !Array.isArray(names) || names.some(name => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(name))))) {
    throw new Error('codexDisabledSkillsの指定が不正です');
  }
  const localPath = join(dirname(path instanceof URL ? fileURLToPath(path) : path), 'workflow.config.local.json');
  let local;
  try {
    local = JSON.parse(readFileSync(localPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`${localPath}: ${error.message}`, { cause: error });
  }
  if (local !== undefined) {
    if (!local || typeof local !== 'object' || Array.isArray(local) || Object.keys(local).some(key => key !== 'dashboardArtifact')) {
      throw new Error(`${localPath}: dashboardArtifactだけを指定してください`);
    }
    if (Object.hasOwn(local, 'dashboardArtifact')) config.dashboardArtifact = local.dashboardArtifact;
  }
  for (const kind of ['request', 'change']) {
    for (const stage of stagesFor(kind)) validateModel(config.models?.[kind]?.[stage]);
    validateExecuteAssignment({ kind }, config);
  }
  if (config.fallbacks !== undefined) {
    if (!config.fallbacks || typeof config.fallbacks !== 'object' || Array.isArray(config.fallbacks)) throw new Error('fallbacksの指定が不正です');
    for (const [kind, values] of Object.entries(config.fallbacks)) {
      if (!['request', 'change'].includes(kind)) throw new Error('工程が不正です');
      validateAssignments({ kind, fallbacks: values }, config);
    }
  }
  for (const stage of ['plan', ...stagesFor('change')]) {
    for (const window of ['primary', 'secondary']) {
      const value = config.limits?.[stage]?.[window];
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('利用枠の固定値が不正です');
    }
  }
  if (config.escalationReview === undefined) config.escalationReview = { model: 'gpt-6-luna', effort: 'medium' };
  if (config.escalationReview !== null) {
    const review = validateModel(config.escalationReview);
    if (review.cli !== 'codex' || !review.model) throw new Error('escalationReviewにはCodexモデルが必要です');
    config.escalationReview = review;
  }
  if (config.dashboardArtifact !== undefined) {
    const value = config.dashboardArtifact;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('dashboardArtifactの指定が不正です');
    if (value.url !== undefined && (typeof value.url !== 'string' || !/^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+$/.test(value.url))) {
      throw new Error('dashboardArtifactのURLが不正です');
    }
    const model = value.model ?? 'claude-haiku-5-5';
    if (validateModel({ model }).cli !== 'claude') throw new Error('dashboardArtifactにはClaudeモデルが必要です');
    for (const key of ['intervalSeconds', 'timeoutSeconds']) {
      if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] <= 0)) throw new Error(`dashboardArtifactの${key}が不正です`);
    }
    config.dashboardArtifact = { ...value, model, timeoutSeconds: value.timeoutSeconds ?? 120 };
  }
  return config;
}

export function assignment(state, config = readConfig()) {
  return validateModel(state.models?.[state.stage] ?? config.models[state.kind ?? 'request'][state.stage]);
}

export function fallbackAssignment(state, config = readConfig()) {
  if (state.stage === 'execute') return null;
  const values = state.fallbacks ?? {};
  const value = Object.hasOwn(values, state.stage) ? values[state.stage] : config.fallbacks?.[state.kind ?? 'request']?.[state.stage];
  if (value === undefined || value === null) return null;
  const result = validateModel(value);
  if (!result.model) throw new Error('代替モデル名が必要です');
  if (result.cli === assignment(state, config).cli) throw new Error('代替には別CLIのモデルが必要です');
  return result;
}

export function validateExecuteAssignment(state, config = readConfig()) {
  if (assignment({ ...state, stage: 'execute' }, config).cli !== 'codex') {
    const recovery = state.id ? `。model ${state.id} execute <Codexのモデル> で変更してください` : '';
    throw new Error(`executeにはCodexモデルが必要です${recovery}`);
  }
}

export function validateAssignments(state, config = readConfig(), { stored = false } = {}) {
  for (const values of [state.models, state.fallbacks]) {
    if (values === undefined) continue;
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('工程別設定が不正です');
    for (const stage of Object.keys(values)) if (!stagesFor(state.kind).includes(stage)) throw new Error('工程が不正です');
  }
  validateExecuteAssignment(state, config);
  if (!stored && Object.hasOwn(state.fallbacks ?? {}, 'execute')) throw new Error('executeに代替モデルは指定できません');
  for (const stage of stagesFor(state.kind)) {
    assignment({ ...state, stage }, config);
    fallbackAssignment({ ...state, stage }, config);
  }
}

export const attemptAssignment = state => state.attemptAssignment ?? assignment(state);
