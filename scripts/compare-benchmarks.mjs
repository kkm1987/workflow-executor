import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [controlDir, improvedDir] = process.argv.slice(2);
assert.ok(controlDir && improvedDir, '対照と改善版の測定ディレクトリを指定する');
const groups = [controlDir, improvedDir].map(dir => JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')));
assert.equal(groups[0].label, 'control');
assert.equal(groups[1].label, 'improved');
assert.deepEqual(groups[0].conditions, groups[1].conditions, '測定条件を一致させる');
const median = values => [...values].sort((a, b) => a - b)[1];
const fields = {
  '工程稼働ms': p => p.activeMs,
  '停止を含む経過ms': p => p.elapsedMs,
  '入力トークン': p => p.tokens.input_tokens.complete ? p.tokens.input_tokens.value : null,
  'キャッシュ入力（入力の内訳）': p => p.tokens.cached_input_tokens.complete ? p.tokens.cached_input_tokens.value : null,
  '非キャッシュ入力': p => p.tokens.input_tokens.complete && p.tokens.cached_input_tokens.complete ? p.tokens.input_tokens.value - p.tokens.cached_input_tokens.value : null,
  '出力トークン': p => p.tokens.output_tokens.complete ? p.tokens.output_tokens.value : null,
};
const lines = ['# 経費集計の比較評価', '', `モデル: ${groups[0].conditions.model}、推論: ${groups[0].conditions.reasoning}`, '',
  groups[0].conditions.cache, '', 'キャッシュ入力は入力に含まれる。このチャットのトークン・金額は集計しない。', '',
  '| 測定 | 回 | コンテキスト | 工程稼働ms | 経過ms | 入力 | キャッシュ入力 | 出力 | 失敗 / 質問 / 差戻し |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
for (const group of groups) {
  assert.equal(group.results.length, 3);
  for (const run of group.results) {
    assert.equal(run.performance.status, 'completed');
    const p = run.performance;
    const token = key => p.tokens[key].complete ? p.tokens[key].value : `未取得あり（取得済み${p.tokens[key].value}）`;
    const stops = ['error', 'question', 'revise'].map(outcome => p.attempts.filter(attempt => attempt.outcome === outcome).length).join(' / ');
    lines.push(`| ${group.label} | ${run.run} | ${run.sessions.length} | ${p.activeMs.toFixed(1)} | ${p.elapsedMs} | ${token('input_tokens')} | ${token('cached_input_tokens')} | ${token('output_tokens')} | ${stops} |`);
  }
}
lines.push('', '## 中央値', '', '| 項目 | 対照 | 改善版 | 変化 |', '| --- | --- | --- | --- |');
for (const [name, extract] of Object.entries(fields)) {
  const values = groups.map(group => group.results.map(run => extract(run.performance)));
  if (values.flat().some(value => value === null)) { lines.push(`| ${name} | 未取得あり | 未取得あり | 比較不可 |`); continue; }
  const [before, after] = values.map(median);
  lines.push(`| ${name} | ${before.toFixed(1)} | ${after.toFixed(1)} | ${after > before ? '増加' : after < before ? '減少' : '同値'} ${Math.abs(after - before).toFixed(1)} |`);
}
lines.push('', '## 品質と条件', '',
  '各回で独立した成果検証、生成テスト、既存3ファイルの保持、変更範囲2ファイル、異なるコンテキストを検証した。失敗・差し戻しが発生した回は正常1タスクの比較条件を満たさず、測定スクリプトが停止する。保存された試行ログは削除しない。', '',
  '同条件でも通信・モデル・共有キャッシュの揺らぎがある。各3回の測定結果であり、一般的な削減率を保証しない。', '',
  `対照データ: ${controlDir}`, `改善版データ: ${improvedDir}`);
writeFileSync(join(improvedDir, 'comparison.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
