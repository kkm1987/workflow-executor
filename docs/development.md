# 開発とテスト

## 仕様の管理

仕様の変更はOpenSpecのchangeとして提案・実装・アーカイブする。`openspec/`（要件とシナリオ、アーカイブ済みのchange）はこの作業環境のローカルにあり、Git管理外。人が読む現行仕様の要約は[spec/](spec/)に置き、changeをアーカイブしたら該当する文書も更新する。

## テスト

```powershell
npm test
```

状態遷移、差し戻し、質問・回答、失敗、保存、排他制御などを確認する。実装とテストを`agent-docs/`へコピーし、固定の`test/fixtures/workflow.config.json`で実行するため、運用中の共有・ローカル設定には依存しない。一時データは終了時に削除する。単体テストではCLIの代わりに代替の実行関数を使う。

```powershell
npm run test:e2e
```

実際のCodexで質問・回答・実装・レビュー・完了を確認する。ログイン・通信・利用枠が必要で、利用枠を消費するため通常のテストには含めない。隔離した開発対象と実行器データを`agent-docs/`に作成し、検証後も結果を残す。テスト用クライアントの回答は固定した試験仕様であり、実際のユーザーへの質問を自動回答する機能ではない。

## 計測と比較

- `node scripts/summarize-attempts.mjs [--from <ISO日時>] [--to <ISO日時>]`: 工程・CLI・判断者別に、結果の割合、所要時間の中央値、回答待ちの回数を集計する。期間は開始を含み終了を含まない。
- `node scripts/benchmark.mjs control|improved`: 経費集計の比較試験を各3回実行する（利用枠を消費する）。`control`は計画統合前、`improved`は統合後のコード。要求と独立検証は`test/fixtures/expenses/`、測定条件と結果は`agent-docs/benchmark-*/`へ保存する。
- `node scripts/compare-benchmarks.mjs <対照ディレクトリ> <改善版ディレクトリ>`: 各回・中央値・悪化項目を含む比較Markdownを生成する。同じモデル・推論設定・環境・要求であることを確認し、共有キャッシュの揺らぎと失敗を記録する。

記録の項目は[spec/records-and-status.md](spec/records-and-status.md#性能の記録)を参照。
