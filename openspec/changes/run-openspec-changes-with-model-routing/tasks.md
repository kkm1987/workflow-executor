## 1. 工程の割り当てと設定

- [x] 1.1 `workflow.config.json`に工程ごとの既定の割り当て（change種別：prereview `claude-opus-5-5`/medium、execute `gpt-6.1-sol`/low、review・acceptance `gpt-6-luna`/high、request種別：未指定）と利用枠の固定値を置き、読み込みと検証（モデル名からのCLI判定、CLIごとの推論レベル）を実装する。不正な値を拒否するテストで確認する。
- [x] 1.2 `state.models`による上書き、`model <ID> <工程> <モデル> [推論レベル]`、`start-change`での指定を実装する。上書きが既定値より優先され、次の試行から反映されることをテストで確認する。
- [x] 1.3 `kind`・`models`・`session`のない保存済み状態をrequest種別・既定の割り当てとして読み、completedの記録を変えないことをテストで確認する。

## 2. CLIの起動と再開

- [x] 2.1 Codex実行ファイルを、同梱版の最新、`PATH`の`codex`の順で探索し、preflight・本実行・利用枠取得で同じパスを使う。探索順と、どちらもない場合のfailedをテストで確認する。
- [x] 2.2 Codexの起動に`-m`・`model_reasoning_effort`を渡し、`--ephemeral`を外して`thread.started`の`thread_id`を記録する。`exec resume`での再開（`-c sandbox_mode`）を実装し、生成される引数をテストで確認する。
- [x] 2.3 Claudeの起動（`--model`・`--effort`・`--json-schema`・`--session-id`・`--resume`・`dontAsk`と許可ツール）と、結果JSONからの構造化出力・usageの取り出しを実装する。代替の実行関数で応答の解釈と不正応答のfailedをテストで確認する。
- [x] 2.4 実機で、Claudeの`--json-schema`の出力位置、`dontAsk`の許可パターンで対象changeのディレクトリ外への書き込みが拒否されること、Codexの再開で読み取り専用の工程の書き込みが拒否されることを確かめ、結果を`agent-docs/`に記録する。
- [x] 2.5 preflightで、ワークフローが使うCLI（Codex、必要ならClaude）の起動・認証と、解決したパス・版を記録する。Claudeを使う工程があるときだけClaudeを確認することをテストで確認する。

## 3. 回答後の再開と利用枠

- [x] 3.1 `question`の試行の`state.session`を保存し、回答後は割り当てが一致すれば回答だけを渡して再開する。不一致・再開エラー・retry・工程の進行では新規コンテキストに戻すことをテストで確認する。
- [x] 3.2 Codexの`account/rateLimits/read`とClaudeの`/usage`から使用率を取得する処理を実装する。取得例の文字列とJSONで解析をテストし、読めない場合は未取得になることを確認する。
- [x] 3.3 工程の開始前に固定値と比較して`limited`で停止し、実行中の上限到達も`limited`に分類する。`limited`から`model`または`retry`で新規コンテキストへ戻れること、モデル呼び出しが0回であることをテストで確認する。
- [x] 3.4 `metrics.json`・`performance.json`に、CLI・モデル・推論レベル・セッション・新規か再開か・試行前後の利用枠を記録し、CodexとClaudeの試行が混在しても集計されることをテストで確認する。

## 4. changeのワークフロー

- [x] 4.1 `start-change <対象> [change名]`で、`openspec list --json`から未完了の候補を列挙し、候補なし・指定changeなしはモデルを呼ばずに開始を拒否する。テスト用の開発対象で確認する。
- [x] 4.2 `prereview`工程と専用の結果スキーマ（`change`、選定・実行可否・更新の根拠、タスク群）を追加し、`prereview → execute → review → acceptance`の遷移と、差し戻し先を`prereview`にすることを実装する。遷移と手戻り上限をテストで確認する。
- [x] 4.3 `prereview`の変更ファイルが対象changeのディレクトリ外にあればfailedにし、`ok`後に`openspec validate <change>`が不合格ならfailedにする。両方をテストで確認する。
- [x] 4.4 各工程のプロンプトを作る（prereviewの調査・決定と業務判断の質問、executeのタスク群の実装と`tasks.md`の更新、reviewの独立確認、acceptanceの仕様差分・全タスクとの照合）。acceptanceがタスク群1件でも実行されることをテストで確認する。
- [x] 4.5 `archive <ID>`を追加し、completedのchangeワークフローだけで`openspec archive <change> -y --json`を実行して結果をイベントに記録する。未完了での拒否と、失敗時にcompletedを保つことをテストで確認する。

## 5. 状態表示・skill・文書

- [x] 5.1 `summary`とダッシュボードに、change名、`prereview`と`limited`の日本語表示、利用枠不足時の必要な対応（別モデルへの変更またはリセット待ち）を追加し、表示をテストで確認する。
- [x] 5.2 skillに、changeの実行依頼の手順（開始、質問と回答をそのまま受け渡す、モデル・推論レベルの会話指定と実行前の復唱、`limited`での別モデルの提案、completed後の`archive`と報告）を追加し、skillの形式検証を通す。
- [x] 5.3 README・MVPに、工程の割り当て、設定ファイル、Codex実行ファイルの探索、Claude CLIの要件、Codexのセッション履歴の保存先、再開の方針を反映する。

## 6. 統合確認

- [x] 6.1 `npm test`がすべて成功することを確認する。
- [x] 6.2 テスト用の開発対象に小さなchangeを用意し、実機で選定・実行前レビュー（Claude）→ apply（Codex）→ 独立レビュー → 最終確認 → アーカイブまで完了することを確認する。質問1回の回答後の再開と、試行ごとのモデル・usage・利用枠の記録も確かめ、結果を`agent-docs/`に保存する（利用枠を消費する）。
