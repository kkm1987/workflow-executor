## Why

現在のダッシュボード`data/dashboard.md`は9列表・`<details>`・ローカル相対リンクで構成され、ルートエージェント(Codex)の外、特にAndroidからは読みにくい。閲覧者は開発主体本人だけで、ClaudeのAndroidアプリまたはブラウザでの閲覧を許容するため、Claude Artifactの同じURLへ要約ページを再公開し、最新状態へ追従させる。DB方式は非対話書き込みの制約により、計画済みの代替案へ切り替えた。

## What Changes

- 実行器が状態保存時に、表示用の要約`data/dashboard.json`を決定的に生成する。外部へ出してよい項目だけを含め、ローカルパス・元ログ・外部証拠本文は含めない。
- 要約の内容が変わった時だけ、状態遷移(回答待ち・利用枠不足・失敗・差し戻し・完了)と工程境界では即時、それ以外は間引き間隔を空けて、安価なClaudeエージェント(`claude -p`)を切り離して起動し、生成済みHTMLを公開先Artifactの同じURLへ再公開する。
- 公開処理は実行器の`run`・`answer`等を待たせず、ロックを取らず、失敗してもワークフローの状態を変えない。結果は実行器データ配下の記録で確認できる。
- 公開先Artifact URL・モデル・間引き間隔を`workflow.config.json`で設定する。未設定なら公開しない(既存動作のまま)。
- モバイル向けArtifactページの初回公開と、そのURLを設定する手順を用意する。
- 既存の`data/dashboard.md`と`status`は変更しない。

## Capabilities

### New Capabilities
- `dashboard-artifact-publishing`: 表示用要約の生成、Claude Artifact DBへの非同期公開、公開の起動条件・間引き・失敗時の扱い、閲覧ページの表示内容

### Modified Capabilities

## Impact

- `src/workflow.js`: `dashboard()`での要約生成と公開起動
- 新規モジュール(公開の起動・間引き・記録)、`src/config.js`と`workflow.config.json`の設定項目
- 閲覧ページのHTMLとその公開手順(README)
- 依存: 認証済みClaude Code CLI(claude.aiアカウントでのログイン、Artifact・Readツールが使えること)。新規npm依存なし
- 要約データがclaude.ai上に保存される(公開先Artifactは非共有の前提)
