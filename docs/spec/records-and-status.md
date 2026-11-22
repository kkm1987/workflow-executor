# 記録・状態表示・計測

## 保存場所

ワークフローの情報は実行器の`data/`に保存し、開発対象には保存しない。要求やログに機密情報を含み得るため`data/`はGit管理外。要求・回答・条件・理由・証拠などの入力ファイルと一時ファイルは`agent-docs/`以下（Git管理外）に置く。

| パス | 内容 |
|---|---|
| `data/<ID>/state.json` | 再開用の状態。`evidence`に変更ファイルと昇格の詳細を全件保存する |
| `data/<ID>/events.jsonl` | 工程ログ。Claudeの実行前レビューで観測した書き込み許可外の差分は`external_change`に`attempt`と`files`を記録する。一時領域の削除失敗は`tmp_cleanup_failed`に記録する |
| `data/<ID>/preflight-*.json` | 実行前確認の結果 |
| `data/<ID>/performance.json` | 試行一覧と集計 |
| `data/<ID>/attempt-XXXX/invocation.json` | 担当・対象・最終活動・昇格の詳細 |
| `attempt-XXXX/result.json` | 工程報告 |
| `attempt-XXXX/metrics.json` | 成否・エラーと計測 |
| `attempt-XXXX/codex.jsonl` | Codexの通知（従来のexec形式へ変換） |
| `attempt-XXXX/codex-rpc.jsonl` | app-serverとのRPC送受信の全行（方向付き） |
| `attempt-XXXX/response.json` | Codexの最後のagentMessage |
| `attempt-XXXX/claude.jsonl`・`claude.json` | Claudeの元ストリームと最終result |
| `attempt-XXXX/stderr.log` | 標準エラー |
| `attempt-XXXX/before.json`・`after.json` | 実装・実行前レビューの前後のGit差分と、管理対象・未追跡ファイルのハッシュ |
| `data/dashboard.md` | ローカルの詳細一覧 |
| `data/dashboard.json` | 表示用の要約（外部公開用） |
| `data/dashboard-publish.json` | Artifact公開の結果 |
| `data/reservations/`・`data/shared-update.lock` | 並行実行の予約と共有更新ロック |

- OpenSpecのルートが対象の外にある場合は、証拠の`openspec`にルート・storeと`openspec/`配下の前後記録・変更ファイルを別に保存する。Gitで無視されたファイルは記録の対象外。

## status

- `status`（ID省略）は保存済みワークフローの一覧。終了した案件は除外し、`--all`で全件。
- `status <ID>`は状態・必要な対応・現在の試行（対象タスク・担当CLIとモデル）・最新活動と受信時刻・直近の工程報告の短い要約を返す。
- `status <ID> --detail`は試行別履歴・回答（`answers`）・外部証拠・昇格履歴などの詳細を返す。
- `status`はダッシュボードも更新する。更新できないときは標準エラーに理由を表示し、保存済みの案件状態を標準出力に表示する。

### 活動と工程報告

- 活動は「報告」と「ツール観測」を区別する。500文字を超える報告は切り詰めて元ログへ誘導する。無報告は「報告未取得」とする。内部思考・コマンド全文・ツール出力は表示しない。ツールの成功はレビュー合格を意味しない。
- 工程報告の`report`には対象、判断と理由、検証結果、残件を記録する。判断なしは空配列とし、未検証と残件なしは明記する。
- 履歴の担当・対象は次タスクやモデル変更後も保持する。失敗時は報告を補わずログを参照する。旧履歴はsummaryを表示し、追加項目は未記録とする。

## ダッシュボード

- 回答待ち、利用枠不足、復旧・再計画待ち、成果確認可能、進行中の順にまとめ、詳細に停止理由・質問・成果と検証へのリンクを置く。登録証拠の名前・有効性・期限、対象・ホスト・測定時刻・出典・保存内容への参照も表示する（本文は出さない）。
- 状態ファイルと表示用要約の活動は実行中に10秒ごとに更新する。Markdownは工程境界と`status`で作り直し、詳細は最新3試行と全記録へのリンクを表示する。閲覧中のエディターが自動再読み込みしない場合は開き直す。
- 外部（claude.ai Artifact）への公開は[dashboard-artifact.md](dashboard-artifact.md)を参照。

## 性能の記録

- 各試行の`metrics.json`に時間・成否・トークン・CLI・モデル・推論レベル・セッション・新規／再開・前後の利用枠と、登録証拠の識別子・有効性を保存する。`performance.json`に試行一覧と集計を保存する。
- 未取得値は`null`、集計の`complete: false`は欠落を含むことを示す。計測導入前の試行を含む案件では`activeComplete: false`として稼働時間の合計も部分値と示す。
- キャッシュ入力は入力の内訳であり加算しない。Claudeの入力は通常・キャッシュ読取・キャッシュ作成の合計とする。
- 工程稼働時間と、質問・復旧待ちを含む開始から最終試行までの経過時間を分ける。
- Codexの`usage`には、セッションを再開した場合もその試行で使ったトークンだけを記録する。`threadUsage`は取得できた試行終了時点のスレッド累計で、トークン合計から除外する。2026-11-07の修正前の再開試行は再開前の分が重複して過大になっているため、比較にはRPCログから再計算した値か修正後の測定値を使う。

集計スクリプトは[development.md](../development.md#計測と比較)を参照。
