# Workflow Executor

ローカルの開発対象で自由記述の要求またはOpenSpec changeを実行する。changeは選定・実行前レビュー→タスク群ごとのapply・独立レビュー→最終確認→同期・アーカイブ、自由記述は計画（要求整理・粒度判定・設計判定）から始める。工程間は別コンテキスト、質問への回答後は同じ工程のセッションを再開する。[docs/MVP.md](docs/MVP.md)を参照。

## 起動

Node.js 22以上と認証済みCodex CLI、Claudeを割り当てる場合は認証済みClaude Code CLIが必要。実行器はNode.js標準機能で動作する。OpenSpecは開発用依存関係として固定し、環境の再構築時は`npm ci`で導入する。開発対象のcwdで実行器同梱のOpenSpecを起動する。

この作業環境では、このリポジトリ内とCodex・Claude Codeのユーザー用skillディレクトリに登録済み。普段の開発対象を開いたチャットからskillを呼び、要求を伝える。

Windowsでは`./scripts/register-skill.ps1`でユーザー用skillディレクトリにリンクし、別のリポジトリ・worktreeからも使えるようにする。Codexでは`$workflow-executor`、Claude Codeでは`/workflow-executor`で呼ぶ。必要なら`-Client codex`または`-Client claude`で登録先を選べる。既存の同名skillは上書きしない。実行器を移動する場合は登録先のリンクを見直す。

skillは実行器との相対位置を使うため、コピーではなく元フォルダーへのリンクを使う。CodexでもClaude Codeでも同じ実行器を操作する。

手動操作の例（このリポジトリを作業ディレクトリとする）：

```powershell
node src/cli.js start C:\path\to\target agent-docs\request.md
node src/cli.js run <ID>
node src/cli.js status <ID>
node src/cli.js answer <ID> agent-docs\answer.md
node src/cli.js start-change C:\path\to\target [change名]
node src/cli.js start-change C:\path\to\target sample-change --model review gpt-6.1-sol high
node src/cli.js model <ID> execute gpt-6-luna high
node src/cli.js archive <ID>
```

普段は開発対象のチャットからskillを呼び、要求と質問への回答を普通の文章で伝える。CLI操作はskillが行う。`run`は回答待ち・利用枠不足・失敗・完了まで進め、`step`は調査用に1工程だけ実行する。`status`は要求全文や回答履歴を含めず、状態と必要な対応を返す。IDを省略すると保存済みワークフローを一覧で確認できる。

`workflow.config.json`に工程の既定モデル・推論レベルと利用枠の固定値を置く。changeの既定値はprereview=`claude-opus-5-5`/medium、execute=`gpt-6.1-sol`/low、review・acceptance=`gpt-6-luna`/high。requestは未指定でCLIの既存設定を使う。`model`または開始時の`--model`は`state.models`へ保存され、次の試行から既定値に優先する。モデル名が`claude-`で始まればClaude、それ以外はCodex。推論レベルはCLIごとに検証し、モデル固有の非対応値はCLIエラーになる。

WindowsのCodex実行ファイルは`%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`の更新日時が最新のもの、次に`PATH`の`codex`を探す。解決したパスをpreflight・本実行・利用枠取得で共有し、パスと版をpreflight記録へ残す。Claudeを使う工程があるときだけClaudeの起動・認証も確認する。

Windowsでは実行時に`features.prefer_mxc=true`を指定し、互換性と管理ポリシーが許す場合にMXCを優先する。未対応端末ではCLIの従来方式へ戻る。[Windowsサンドボックスの公式仕様](https://learn.chatgpt.com/docs/windows/windows-sandbox)に従い、ユーザーの設定ファイルは変更しない。環境・ツールのエラーは仕様の質問と分けて失敗として扱う。

`run/step`はモデル呼び出し前に、対象ディレクトリ、Git作業ツリー、CLI起動・認証、読み取り用・書き込み用サンドボックスの起動を確認する。各コマンドの制限時間は15秒。対象コードは実行・変更せず、認証コマンドの出力も保存しない。同じ`run`内では1回、別の再開操作では再確認する。結果は`data/<ID>/preflight-*.json`に残り、失敗時はモデルを呼ばず`failed`になる。Windowsでチャットの制限内から別のサンドボックスを起動できない場合は、開発主体が実行環境を確認する。実行器は自動昇格しない。

## 状態と復旧

状態確認・質問・完了報告は、skillを呼び出したチャットで受け取る。`data/dashboard.md`には短い案件名、日本語の状態・工程、進捗、対応者、必要な対応を表示する。回答待ち、利用枠不足、開発主体の復旧・再計画待ち、成果確認可能、進行中の順にまとめ、詳細にフルID・対象・change・停止理由・質問・成果と検証へのリンクを置く。完了はクライアントの承認を意味しない。実行中は10秒ごとに更新されるが、閲覧中のエディターが自動再読み込みしない場合は再度開く。

`data/<ID>/state.json`が再開用状態、`events.jsonl`が工程ログ。`attempt-XXXX/`に入力、CodexイベントまたはClaude応答、標準エラー、構造化応答を保存する。実装と実行前レビューではGitの差分と管理対象・未追跡ファイルのハッシュを`before.json`・`after.json`に記録する。Gitで無視されたファイルは記録の対象外。要求やログに機密情報を含み得るため`data/`はGit対象外。prereviewの編集は選定したchange内だけに許可し、範囲外変更またはOpenSpec検証不合格はfailedにする。plan・review・acceptanceは読み取り専用。

Codexは`--ephemeral`を使わず、履歴はCodex標準の`$CODEX_HOME/sessions/`（未指定なら`~/.codex/sessions/`）へ保存する。開発対象には保存しない。直近の質問の工程・CLI・モデル・推論レベル・セッションIDだけを状態に保持し、一致する場合は回答だけを渡して再開する。不一致・再開失敗・retryは回答を含む新規コンテキストに戻し、工程が進めばセッションを捨てる。`kind`のない旧状態はrequestとして読み、completedの記録は書き換えない。

各工程の開始前にCodexの`account/rateLimits/read`またはClaudeの`/usage`から残りを取得する。初期固定値はplan・prereview・executeがセッション20%／週10%、review・acceptanceが10%／5%。不足時はモデルを呼ばず`limited`で止まり、別モデルへの変更またはリセット待ちを示す。実行中の上限到達もlimitedとし、`model`または`retry`で新規再開する。取得不能なら未取得として実行し、自動切り替えはしない。固定値は計測の根拠がない初期値であり、実績から見直す。

実行エラー・Ctrl+Cでは`failed`になる。対象の差分とログを確認して原因を解消し、`node src/cli.js retry <ID>`を実行する。同じ工程を新しいコンテキストで再実行するため、途中の変更を確認すること。自動ロールバックは行わない。

強制終了で`data/executor.lock`が残った場合、記載されたPIDと子プロセスが終了し、他の実行器も動作していないことを確認してから、このファイルだけを削除する。`running`のワークフローは変更確認後に`retry`で復旧する。生存中のロックは削除しない。

レビュー差し戻しはワークフロー全体で3回まで。4回目には`blocked`となる。原因と要求を見直し、新たなワークフローを開始する。完了済みタスクは再定義の対象に含めない。

差し戻し時はrequestなら`plan`、changeなら`prereview`で未完了分を再定義する。旧`granularity/architecture`で停止した案件も、次の実行前確認が通った後に`plan`へ戻し、移行をイベントに残す。完了タスク・回答・証拠・試行番号・手戻り回数を保持し、完了済み案件の保存状態やログは変更しない。

## 検証

`npm test`で、状態遷移、差し戻し、質問・回答、失敗、保存、排他制御を確認する。テストの一時データは`agent-docs/`に作成する。実際のCodex実行にはログイン・通信・利用枠が必要であり、単体テストでは代替の実行関数を用いる。

`npm run test:e2e`は実際のCodexで質問・回答・実装・レビュー・完了を確認する。利用枠を消費するため通常のテストには含めない。隔離した開発対象と実行器データを`agent-docs/`に作成し、検証後も結果を残す。テスト用クライアントの回答は固定した試験仕様であり、実際のユーザーへの質問を自動回答する機能ではない。

各試行の`metrics.json`に時間・成否・トークン・CLI・モデル・推論レベル・セッション・新規／再開・前後の利用枠を、ワークフロー直下の`performance.json`に試行一覧と集計を保存する。未取得値は`null`、集計の`complete: false`は欠落を含む。計測導入前の試行もある案件では、`activeComplete: false`として稼働時間の合計も部分値と示す。キャッシュ入力は入力の内訳であり加算しない。Claudeの入力は通常・キャッシュ読取・キャッシュ作成の合計とする。工程稼働時間と、質問・復旧待ちを含む開始から最終試行までの経過時間を分ける。

経費集計の比較試験は`node scripts/benchmark.mjs control`または`improved`で各3回実行する（利用枠を消費する）。`control`は計画統合前、`improved`は統合後のコードで実行する。要求と独立検証は`test/fixtures/expenses/`、測定条件と各回の結果は`agent-docs/benchmark-*/`へ保存する。`node scripts/compare-benchmarks.mjs <対照ディレクトリ> <改善版ディレクトリ>`で各回・中央値・悪化項目を含む比較Markdownを生成する。同じモデル・推論設定・環境・要求であることを確認し、共有キャッシュの揺らぎと失敗を記録する。
