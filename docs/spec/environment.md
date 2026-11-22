# 実行環境と実行前確認

## 必要なもの

- Node.js 22以上。実行器はNode.js標準機能だけで動作し、外部ライブラリ・DB・常駐サーバーを使わない。
- 認証済みのCodex CLI。Claudeを割り当てる工程があれば認証済みのClaude Code CLI。
- OpenSpecは開発用依存関係（`@fission-ai/openspec`、版を固定）として`npm ci`で導入する。

## CLIの起動

- Codexの新規実行・セッション再開は`codex app-server`のstdio JSON-RPCを使う。承認方針はexecuteだけ`on-request`、他の工程と確認の質問は`never`とする（昇格の判断者は[permissions.md](permissions.md)）。
- WindowsのCodex実行ファイルは、`%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`のうち更新日時が最新のもの、次に`PATH`の`codex`を探す。解決したパスを実行前確認・本実行・利用枠取得で共有し、パスと版を実行前確認の記録へ残す。
- Codexの各工程を起動する前に、実行器が`data/<ID>/tmp/`と`data/cache/go-build`を作る。子プロセスの`TMP`・`TEMP`・`GOTMPDIR`には案件の一時領域、`GOCACHE`には案件間で共有するGoキャッシュを渡す。書き込み可能なCodex工程では両方をsandboxの書き込み先に加える。

## Windowsのサンドボックス

- 新規実行・resume・読み取り用と書き込み用の実行前確認・grant確認に`features.prefer_mxc=false`と`windows.sandbox=elevated`を指定する。ユーザー設定は変更せず、既存の読み書き・ネットワーク制限と管理ポリシーを維持する。
- grant確認は呼び出し単位の`workflow-grant`プロファイルで`:workspace`を継承し、追加パスと別ストアの対象changeを`workspace_roots`へ反映する。管理ポリシーで許可プロファイルを限定している場合は、端末管理者による同プロファイルの許可が必要。
- 端末管理者が事前にelevatedの初期セットアップと、対象・追加パス・別OpenSpecストアのアクセス権を準備する。失敗時のセットアップ・ACL・管理ポリシーの復旧も端末管理者が行う。実行器は自動昇格や別方式への自動切り替えを行わない。
- 実行前確認の記録の`requestedWindowsSandbox: "elevated"`は要求値であり、適用の確認済みを意味しない。
- 起動時に`CODEX_WINDOWS_REGISTERED_CORE`と`CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY`を除去し、Codexアプリ専用の起動環境を子プロセスへ継承しない。`registered Core`の失敗はこの起動環境の継承が原因であり、管理者による初期セットアップでは解決しない。調査手順は[operations.md](../operations.md#実行前確認の失敗)を参照。

## 実行前確認（preflight）

`run`・`step`はモデルを呼ぶ前に次を確認する。

- 対象ディレクトリとGit作業ツリー（changeではOpenSpecルートのGit作業ツリーも）
- 担当CLIの起動・認証（Claudeを使う工程があるときだけClaudeも。代替は選択された場合だけ）
- 読み取り用・書き込み用サンドボックスの起動、追加パスへのアクセス
- executeの開始前は、判断者設定をapp-serverが受け付けること（モデルは呼ばない）

制限時間はサンドボックスを起動する確認が120秒、それ以外が15秒。対象コードは実行・変更せず、認証コマンドの出力も保存しない。同じ`run`内では確認済みの担当を再利用し、別の再開操作では再確認する。

結果は`data/<ID>/preflight-*.json`に残し、失敗時はモデルを呼ばず`failed`にする。Windowsでチャットの制限内から別のサンドボックスを起動できない場合は、開発主体が実行環境を確認する。

### execpolicyの規則の記録

実行前確認の`execpolicyRules`は、`$CODEX_HOME/rules`（未指定なら`~/.codex/rules`）と対象の`.codex/rules`にある`decision="allow"`の行を`path`・`count`で記録する。読み取り失敗は`error`に残し、規則の存在・読み取り失敗だけでは実行を止めない。最新の記録は`status <ID> --detail`で確認できる。規則は変更しない。この記録は規則による承認省略の有無を保証せず、承認要求なしの実行に影響し得る設定を所有者が確認する手掛かりである。
