import { readFileSync } from 'node:fs';

function publicText(state) {
  const privateText = [state.target, ...(state.externalEvidence ?? []).flatMap(entry => [entry.content, entry.source])]
    .filter(value => typeof value === 'string' && value.length);
  return (value, limit = 500) => {
    let result = String(value ?? '');
    for (const secret of privateText) result = result.split(secret).join('［非公開］');
    result = result.replace(/```[\s\S]*?(?:```|$)/g, '［コード省略］')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`[^`]*`/g, '［参照省略］')
      .replace(/(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/]|\/(?!\/))[\w\p{L}.@%+~:/\\-]+/gu, '［パス省略］')
      .replace(/\b(?:[\w.-]+[\\/])+[\w.-]+\b/g, '［参照省略］')
      .replace(/\b[\w.-]+\.(?:jsonl?|log)\b/gi, '［参照省略］')
      .replace(/^.*(?:内部思考|ツール出力|コマンド[：:]|(?:^|\s)(?:npm|node|python|git|claude|codex|powershell|bash)\s+).*/gm, '［実行情報省略］');
    const chars = Array.from(result.trim());
    return chars.slice(0, limit).join('') + (chars.length > limit ? '…' : '');
  };
}

export function artifactActivity(state) {
  return { activity: state.activity?.kind === 'report' ? publicText(state)(state.activity.text)
    : state.activity ? 'ツールの実行状況を更新' : '報告未取得', activityAt: state.activity?.at ?? null };
}

export function artifactCase(view, state) {
  const text = publicText(state);
  const result = { id: view.id, name: text(view.name, 80), status: view.status, statusLabel: view.statusLabel,
    stage: view.stage, stageLabel: view.stageLabel, completed: view.completed, total: view.total,
    owner: view.owner, nextAction: view.nextAction, updatedAt: view.updatedAt,
    attempt: state.attempts ?? 0, ...artifactActivity({ ...state, activity: view.activity }) };
  if (view.question) result.question = text(view.question);
  if (['waiting', 'failed', 'blocked', 'limited'].includes(view.status)) result.reason = text(view.error ?? view.result ?? state.lastResult);
  if (view.status === 'completed') result.result = text(view.result);
  if (view.latestReport) {
    const report = view.latestReport.report;
    result.report = { scope: text(report.scope, 300), decisions: text((report.decisions ?? []).join(' / '), 500),
      verification: text(report.verification, 300), remaining: text(report.remaining, 300) };
  }
  return result;
}

export function renderArtifact(snapshot) {
  const data = JSON.stringify(snapshot).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return readFileSync(new URL('../docs/dashboard-artifact.html', import.meta.url), 'utf8')
    .replace('{"generatedAt":null,"counts":{},"groups":[]}', data);
}
