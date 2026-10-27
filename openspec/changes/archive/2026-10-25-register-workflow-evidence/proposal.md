## Why

ルートが取得した測定記録は任意ファイルに置くだけでは実装エージェントへ渡らず、retryでは新しいコンテキストになる。同じ制限付き測定を繰り返さずに済むよう、登録した証拠を明示的に引き継ぐ経路が必要である。

## What Changes

- 停止中の案件に対して証拠JSONを登録するCLIを追加し、内容と出典・測定対象・ホスト・方法・測定時刻・有効期限を保存する。
- 同一名の最新登録だけを現行とし、試行開始時に有効な証拠の内容をpromptへ渡す。期限切れは利用不可と示し、古い版へ戻らない。
- 証拠登録は状態の再開や権限付与を行わず、既存セッションを破棄して次の入力への反映を保証する。
- statusとダッシュボードで登録内容の概要・期限・次の対応を確認できるようにする。
- ルートの再測定・登録・retryの手順を定める。OSの自動測定、任意ファイルの走査、サンドボックス権限の拡張は含めない。

## Capabilities

### New Capabilities

なし。

### Modified Capabilities

- `workflow-runtime`: 外部証拠の登録・有効性確認・入力への引き継ぎ。
- `workflow-observability`: 登録証拠の概要と期限の表示。

## Impact

- `src/cli.js`、`src/workflow.js`、`src/executor.js`: 登録、保存、排他、promptと再開。
- `skills/workflow-executor/SKILL.md`、README、関連テスト。
- 既存の実装前後evidenceは維持する。追加依存なし。可視化changeやverify-agent-access-grantsに依存せず実装可能。対象案件の再開・pilot実行は本changeの実装に含まない。
