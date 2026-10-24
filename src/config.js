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
  return config;
}

export function assignment(state, config = readConfig()) {
  return validateModel(state.models?.[state.stage] ?? config.models[state.kind ?? 'request'][state.stage]);
}
