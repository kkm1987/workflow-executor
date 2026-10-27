## Why

案件の工程と稼働状態だけでは、各エージェントが何を確認し、何を決め、何が残っているか分からない。保存済みの作業報告・実行イベント・工程結果を利用者に示し、進行中から失敗後まで追跡できるようにする。

## What Changes

- Codex・Claudeの途中出力を保存し、実行中の対象タスク、担当CLI・モデル、最新の活動と報告時刻をstatusとMarkdownダッシュボードに表示する。
- 試行ごとに、作業対象・判断と理由・検証結果・残件を工程結果へ記録し、レビューの対象と結論を確認可能にする。
- 活動の観測とエージェントの報告を区別し、無報告・失敗・再試行を正しく示す。内部思考やコマンド全文は一覧へ出さない。
- 既存の工程遷移・権限・利用枠・性能計測を維持し、古いログは読み取り互換にする。

## Capabilities

### New Capabilities

なし。

### Modified Capabilities

- `workflow-observability`: 実行中の活動と試行ごとの作業・判断・レビュー結果を表示する。

## Impact

- `src/executor.js`: 途中出力の取得、Claudeのstream-json対応と最終応答の保存。
- `src/workflow.js`、応答スキーマ: 活動表示、工程報告、prompt。
- `src/metrics.js`: Claudeの既存計測互換。
- `src/cli.js`、`skills/workflow-executor/SKILL.md`、README、関連テスト。
- 追加依存なし。register-workflow-evidenceとは独立して実装可能。未アーカイブのモデル振り分けchangeの実装を前提に、同期時は先行仕様を確認する。
