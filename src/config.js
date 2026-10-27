import { readFileSync } from 'node:fs';

export const stagesFor = kind => kind === 'change'
  ? ['prereview', 'execute', 'review', 'acceptance'] : ['plan', 'execute', 'review', 'acceptance'];

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
  for (const kind of ['request', 'change']) {
    for (const stage of stagesFor(kind)) validateModel(config.models?.[kind]?.[stage]);
  }
  for (const stage of ['plan', ...stagesFor('change')]) {
    for (const window of ['primary', 'secondary']) {
      const value = config.limits?.[stage]?.[window];
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('利用枠の固定値が不正です');
    }
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
    config.dashboardArtifact = { ...value, model, intervalSeconds: value.intervalSeconds ?? 300, timeoutSeconds: value.timeoutSeconds ?? 120 };
  }
  return config;
}

export function assignment(state, config = readConfig()) {
  return validateModel(state.models?.[state.stage] ?? config.models[state.kind ?? 'request'][state.stage]);
}
