# Workflow Executor

ローカルの開発対象で自由記述の要求またはOpenSpec changeを実行する。changeは選定・実行前レビュー→タスク群ごとのapply・独立レビュー→最終確認→同期・アーカイブ、自由記述は計画（要求整理・粒度判定・設計判定）から始める。工程間は別コンテキスト、質問への回答後は同じ工程のセッションを再開する。[docs/MVP.md](docs/MVP.md)を参照。

## 起動

Node.js 22以上と認証済みCodex CLI、Claudeを割り当てる場合は認証済みClaude Code CLIが必要。実行器はNode.js標準機能で動作する。OpenSpecは開発用依存関係として固定し、環境の再構築時は`npm ci`で導入する。開発対象のcwdで実行器同梱のOpenSpecを起動する。

### クローン後のセットアップ

```powershell
git clone <リポジトリURL>
cd workflow-executor
npm ci
```

Node.js 22以上を用意し、Codex CLIへログインする。Claudeを割り当てる場合はClaude Code CLIにもログインする。Windowsで別のリポジトリやworktreeから使う場合は、ユーザー用skillを登録する。

```powershell
.\scripts\register-skill.ps1
```

登録後はCodexで`$workflow-executor`、Claude Codeで`/workflow-executor`を呼び出す。skillを使わずCLIから開始する場合は、実行器のルートで次のように実行する（`<対象リポジトリ>`は開発対象の絶対パス）。

```powershell
node src/cli.js start <対象リポジトリ> agent-docs\request.md
node src/cli.js run <ID>
```

OpenSpec changeを指定して開始する場合は`start-change <対象リポジトリ> [change名] [--store <id>]`を使う。storeを省略すると、OpenSpecが対象から最寄りの`openspec/`、その`store:`宣言、グローバルの既定storeの順で解決する。開始時のルートとstoreを保存し、以降の検証・アーカイブでも固定して使う。ルートはGitの作業ツリーである必要がある。以降のCLI操作例は下記を参照。

この作業環境では、このリポジトリ内とCodex・Claude Codeのユーザー用skillディレクトリに登録済み。普段の開発対象を開いたチャットからskillを引数なしで呼ぶと、OpenSpecの次に実行すべきchangeの選定から開始する。change名や自由記述の要求を指定して開始することもできる。

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

普段は開発対象のチャットからskillを呼び、要求と質問への回答を普通の文章で伝える。CLI操作はskillが行う。`run`は回答待ち・利用枠不足・失敗・完了まで進め、`step`は調査用に1工程だけ実行する。`status`は状態・必要な対応・現在の試行・最新活動・直近の工程報告の短い要約を返す。試行別履歴や外部証拠の詳細は`status <ID> --detail`で取得する。IDを省略すると保存済みワークフローを一覧で確認できる。

`workflow.config.json`に工程の既定モデル・推論レベルと利用枠の固定値を置く。changeの既定値はprereview=`claude-opus-5-5`/medium、execute=`gpt-6.1-sol`/low、review・acceptance=`gpt-6-luna`/high。requestは未指定でCLIの既存設定を使う。`model`または開始時の`--model`は`state.models`へ保存され、次の試行から既定値に優先する。モデル名が`claude-`で始まればClaude、それ以外はCodex。推論レベルはCLIごとに検証し、モデル固有の非対応値はCLIエラーになる。

WindowsのCodex実行ファイルは`%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`の更新日時が最新のもの、次に`PATH`の`codex`を探す。解決したパスをpreflight・本実行・利用枠取得で共有し、パスと版をpreflight記録へ残す。Claudeを使う工程があるときだけClaudeの起動・認証も確認する。

Windowsでは新規実行・resume・両プロファイルの実行前確認・grant確認に`features.prefer_mxc=false`と`windows.sandbox=elevated`を指定する。ユーザー設定は変更せず、既存の読み書き・ネットワーク制限と管理ポリシーを維持する。grant確認は呼び出し単位の`workflow-grant`プロファイルで`:workspace`を継承し、追加パスと別ストアの対象changeをworkspace_rootsへ反映する。管理ポリシーで許可プロファイルを限定している場合は、端末管理者による同プロファイルの許可が必要。端末管理者が事前にelevatedの初期セットアップと対象・追加パス・別OpenSpecストアのアクセス権を準備し、失敗時のセットアップ・ACL・管理ポリシーも復旧する。自動昇格や別方式への自動切り替えは行わない。preflightの`requestedWindowsSandbox: "elevated"`は要求値であり、適用確認済みを意味しない。

MXC利用時の停止中案件を移行する際は、実行器と子プロセスの停止および対象の途中の差分を確認する。`failed`／中断済み`running`／`limited`は`node src/cli.js retry <ID>`で旧セッションを破棄する。`waiting`／`ready`は`status`で現在の工程・有効なモデル・推論レベルを確認し、`node src/cli.js model <ID> <現在の工程> <同じモデル> [同じ推論レベル]`で同値を再設定する。同値でも当該工程のセッションを破棄し、質問・許可要求・承認待ちは保持する。必要な`answer`／`grant`／`approve`後に`run`で実行前確認をやり直す。状態JSONや完了済み履歴は直接変更しない。移行前に通常ホストの隔離fixtureで起動・権限境界・編集ツールとシェルの書き込み・回答後のresumeを実測し、成功を確認する。失敗時は運用を停止して原因を復旧する。限定した実測の成功は長期安定性を保証しない。

`run/step`はモデル呼び出し前に、対象ディレクトリ、Git作業ツリー、CLI起動・認証、読み取り用・書き込み用サンドボックスの起動を確認する。各コマンドの制限時間は15秒。対象コードは実行・変更せず、認証コマンドの出力も保存しない。同じ`run`内では1回、別の再開操作では再確認する。結果は`data/<ID>/preflight-*.json`に残り、失敗時はモデルを呼ばず`failed`になる。Windowsでチャットの制限内から別のサンドボックスを起動できない場合は、開発主体が実行環境を確認する。実行器は自動昇格しない。

## 状態と復旧

`run`の終了を待ち、決まった間隔で状態を読まない。進捗を尋ねられたときだけ`status <ID>`を1回読む。回答待ちの確認質問には記録を調べて根拠ファイルを示し、回答は全項目がそろってから1回で保存する。記録にない実行エージェントの判断理由だけ`answer <ID> <ファイル> --inquiry`で転送して`run`する。これは回答や許可として扱わず、元の質問・権限要求を保って説明を返す。承認待ちでは利用できない。

`close <ID> [理由ファイル]`は実行中以外の案件を`closed`（終了）にする。理由ファイルはUTF-8で`agent-docs/`以下に置く。理由・前状態・時刻と履歴を保持し、再開や変更はできない。対象リポジトリの途中の変更には触れない。中断した`running`は実行器の停止と差分を確認して`retry`してから閉じる。アーカイブ成功時も理由`archived`で自動的に閉じ、失敗時は`completed`を保つ。終了した案件はダッシュボード・公開用要約・既定の`status`一覧から除外し、`status --all`または`status <ID>`で終了理由と前状態を確認できる。

changeの実行前レビューは、未完了タスク全体の承認計画（対象タスク・操作・上限・停止条件）を作る。新しい計画があれば`waiting`で停止し、`status`に各項目、ダッシュボードの待機行に件数を表示する。`node src/cli.js approve <ID> [条件ファイル]`で計画・条件・承認時刻を保存して実装へ進む。条件ファイルはUTF-8で`agent-docs/`以下に置く。修正や拒否は`answer <ID> <回答ファイル>`で伝え、実行前レビューへ差し戻す。承認済みの計画と条件はretry・partial・差し戻し・証拠登録でも保持し、同じ計画には再承認を求めない。実装が`outcome=approval`を返すと、完了タスクを保持して残り全体の計画を出し直す。この戻りも手戻り回数に数える。

状態確認・質問・完了報告は、skillを呼び出したチャットで受け取る。`status <ID>`で現在の試行・対象タスク・担当CLIとモデル、最新活動と受信時刻、直近の工程報告を確認できる。試行別履歴は`status <ID> --detail`と`data/dashboard.md`で確認する。活動は「報告」と「ツール観測」を区別し、500文字を超える報告は切り詰めて元ログへ誘導する。無報告は「報告未取得」とし、10秒ごとの状態更新では活動時刻を更新しない。内部思考・コマンド全文・ツール出力は表示しない。ツール成功はレビュー合格を意味しない。

ダッシュボードは回答待ち、利用枠不足、復旧・再計画待ち、成果確認可能、進行中の順にまとめ、詳細に停止理由・質問・成果と検証へのリンクを置く。工程報告の`report`には対象、判断と理由、検証結果、残件を記録する。判断なしは空配列、未検証と残件なしは明記する。履歴の担当・対象は次タスクやモデル変更後も保持し、失敗時は報告を補わずログを参照する。旧履歴はsummaryを表示し、追加項目は未記録とする。完了はクライアントの承認を意味しない。実行中は10秒ごとと工程境界で更新される。閲覧中のエディターが自動再読み込みしない場合は再度開く。

`data/<ID>/state.json`が再開用状態、`events.jsonl`が工程ログ。`attempt-XXXX/`の`invocation.json`に担当・対象・最終活動、`result.json`に工程報告、`metrics.json`に成否・エラーと計測を保存する。元ストリームは`codex.jsonl`または`claude.jsonl`、Claudeの最終resultは従来どおり`claude.json`に残し、標準エラーは`stderr.log`で確認する。実装と実行前レビューではGitの差分と管理対象・未追跡ファイルのハッシュを`before.json`・`after.json`に記録する。OpenSpecのルートが別の場所にある場合は、証拠の`openspec`にルート・storeと`openspec/`配下の前後記録・変更ファイルを別に保存する。Gitで無視されたファイルは記録の対象外。要求やログに機密情報を含み得るため`data/`はGit対象外。prereviewの編集は選定したchange内だけに許可し、範囲外変更またはOpenSpec検証不合格はfailedにする。plan・review・acceptanceは読み取り専用。

Codexは`--ephemeral`を使わず、履歴はCodex標準の`$CODEX_HOME/sessions/`（未指定なら`~/.codex/sessions/`）へ保存する。開発対象には保存しない。直近の質問の工程・CLI・モデル・推論レベル・セッションIDだけを状態に保持し、一致する場合は回答だけを渡して再開する。不一致・再開失敗・retryは回答を含む新規コンテキストに戻し、工程が進めばセッションを捨てる。`kind`のない旧状態はrequestとして読み、completedの記録は書き換えない。

各試行前に通常側のCodexの`account/rateLimits/read`またはClaudeの`/usage`から残りを取得する。初期固定値はplan・prereview・executeがセッション20%／週10%、review・acceptanceが10%／5%。通常側が閾値未満なら指定済みの代替を確認する。通常側の失敗で代替へ切り替えた工程・タスクでは、通常側の残枠によらず代替を評価する。代替は取得できた窓が1つ以上あり、そのすべてが同じ閾値以上なら使用する（閾値一致は可）。通常側が全窓取得不能なら通常側で実行する。代替未指定・代替不足・代替の全窓取得不能ではモデルを呼ばず`limited`で停止する。枠はCLI単位で、モデル固有の残枠を保証しない。固定値は計測の根拠がない初期値であり、実績から見直す。

代替は任意の`fallbacks.request/change.<工程>`に1組の`{ "model": "...", "effort": "..." }`を指定する。例えば通常側がCodexのexecuteなら、`workflow.config.json`へ次のトップレベル項目を追加できる。通常・代替が同じCLIになる設定は拒否する。既定の代替は用意しない。

```json
"fallbacks": {
  "request": { "execute": { "model": "claude-opus-5-5", "effort": "medium" } },
  "change": { "execute": { "model": "claude-opus-5-5", "effort": "medium" } }
}
```

案件指定は既定値に優先して`state.fallbacks`へ保存する。開始時は`--fallback`を繰り返せる。通常側の`--model`もstart・start-changeで使用でき、すべての指定を組み合わせて検証する。

```text
node src/cli.js start C:\path\to\target agent-docs\request.md --fallback execute claude-opus-5-5 medium
node src/cli.js start-change C:\path\to\target sample-change --fallback prereview gpt-6-luna high --fallback execute claude-opus-5-5 medium
node src/cli.js fallback <ID> execute claude-opus-5-5 medium
node src/cli.js fallback <ID> execute --disable
node src/cli.js retry <ID>
node src/cli.js run <ID>
```

停止中の`fallback`は設定だけを変更し、質問や停止状態を保持する。`--disable`は案件に`null`を保存して既定の代替も無効化する。`limited`は枠の回復・指定変更後に`retry`、`waiting`は必要な回答・承認後に`run`する。通常側を変更する`model`でも代替との整合性を検証し、不正操作は保存しない。

選択した代替CLIの起動・認証・必要なアクセス確認に失敗した場合は、モデルを起動せず`failed`で止まる。未選択の代替CLIは必須確認に含めない。承認・許可・工程の編集制限は切替後も維持する。通常設定は変更せず、失敗で選んだ代替は同じ工程・タスクの間使い続け、工程またはタスクが変われば通常側から再判定する。担当が変われば要求・回答・承認・証拠を含む完全入力を使い、同じ担当で条件を満たす回答後はセッションを再開する。実行中の上限到達は途中の記録を保存して`limited`で止まり、自動切替・自動再試行はしない。変更を確認して`retry`する。候補別の枠と選択理由はイベント・status・ダッシュボード、実担当は試行履歴・invocation・metricsで確認できる。

失敗後はセッションを破棄する。通常側の失敗は別CLIの代替があれば自動で一度切り替え、代替がなく再開セッションの最初の失敗なら新規コンテキストで一度続ける。それ以外は`failed`で止まる。同じ工程・対象タスクの連続失敗回数と直近3件の試行・CLI・モデル・エラー要約（各500文字まで）を保存し、次の入力へ渡す。失敗以外の結果で記録を消し、retryでは保持する。2回以上なら人の判断が必要と表示する。ルートはエラーと試した対応を示して止まる。`retry`は、途中の差分とログを確認し、許可範囲内で原因に手を打った場合かユーザーの指示がある場合だけ実行する。自動ロールバックは行わない。

executeのpartialで対象とOpenSpecルートの変更がどちらもない状態が2回続くと`waiting`で止まる。ルートは最新の報告・続行／計画見直し／closeの選択肢と影響を含む質問をそのまま提示する。回答で進捗なし回数を0に戻し、同じタスクを新規コンテキストで再開する。変更ありpartialで連続回数をリセットし、partial以外では消す。partialの通算上限10回は維持する。

同じdataルートでは、別IDかつ対象ディレクトリ群が独立した案件を同時実行できる。同じIDのrun／step二重起動は禁止する。開発対象、追加の書き込み許可先（grantの追加予定先も含む）、changeのOpenSpecルート全体を操作終了まで予約する。同一・親子・symlink／junctionによる別名、Windowsの大小文字違いは競合として即時拒否する。別対象でも共有ストアを使うchangeは競合する。statusは実行中も利用できる。状態・表示・公開記録の共有更新だけを短く直列化し、取得待ちは5秒を上限とする。モデル実行・公開通信は共有ロック外で行う。

新旧実行器の混在と複数dataルートをまたぐ排他はサポートしない。切替前に全実行器・子プロセス・公開者を停止し、同じ実行器を使う全チャットを更新する。旧`data/executor.lock`が残る間は更新操作を拒否する。既存state・回答・承認・証拠・試行は移行せず再利用する。

強制終了後は`data/reservations/<所有者トークン>.json`（ID・PID・開始時刻・対象群）、`data/shared-update.lock`（PID・所有者トークン・開始時刻）、旧`data/executor.lock`を確認する。壊れた記録や解決不能な対象も無視せず停止する。経過時間やPID不在だけでは削除せず、所有者・その子プロセスの終了と対象差分を確認し、該当ファイルだけを手動削除する。他所有者の予約は削除しない。`running`は変更確認後に既存の`retry`で復旧する。生存中のロックは削除しない。ロールバック時も全新プロセスと子・公開者を停止し、差分と残存予約を整理してから旧版へ戻す。

レビュー差し戻しはワークフロー全体で3回まで。4回目には`blocked`となる。原因と要求を見直し、新たなワークフローを開始する。完了済みタスクは再定義の対象に含めない。

差し戻し時はrequestなら`plan`、changeなら`prereview`で未完了分を再定義する。旧`granularity/architecture`で停止した案件も、次の実行前確認が通った後に`plan`へ戻し、移行をイベントに残す。完了タスク・回答・証拠・試行番号・手戻り回数を保持し、完了済み案件の保存状態やログは変更しない。

## Androidからダッシュボードを読む

`data/dashboard.json`は表示用の要約、`data/dashboard.md`はローカルの詳細一覧。要約はローカルパス・ログ参照・外部証拠本文を除き、工程報告を切り詰める。非共有のClaude Artifactへ要約を埋め込んだHTMLを再公開すると、Androidアプリでも開いたまま更新を読める。閲覧専用で、回答・再開はチャットから行う。

1. claude.aiにログイン済みのClaude Code CLIを用意する。APIキー認証ではArtifactを公開できない。
2. `CLAUDE_CODE_ARTIFACT=1`を指定し、Claudeに`docs/dashboard-artifact.html`を編集せず、capabilitiesなしのplain pageとして非共有で公開するよう依頼する。`-p`を使う場合は`--tools Artifact,Read --allowedTools Artifact,Read --permission-mode dontAsk`を指定する。共有メニューは変更しない。
3. `workflow.config.json`と同じディレクトリに、次の`workflow.config.local.json`を作成して発行されたURLを設定する。このファイルはgit管理外なので、実行器の更新でも設定が残る。

```json
{
  "dashboardArtifact": {
    "url": "https://claude.ai/artifact/発行されたID",
    "model": "claude-haiku-5-5",
    "intervalSeconds": 300,
    "timeoutSeconds": 120
  }
}
```

URL以外は省略でき、上記が既定値。ローカル設定は`dashboardArtifact`だけを受け付け、同キーがあれば共有設定を丸ごと置き換える。共有設定の既存値も引き続き有効だが、URLはローカル設定へ移して共有側から削除する。URL未設定ではClaudeを起動しない。URLは`https://claude.ai/artifact/<ID>`または`https://claude.ai/code/artifact/<ID>`、間隔と打ち切りは正の整数秒とする。公開先を開くには所有者のアカウントでログインする。

要約が変わった時だけ公開し、状態・工程・案件数の変化は即時、それ以外は前回の起動から間隔経過後の保存時に公開する。状態保存は公開の終了を待たない。公開中の更新も終了後に拾い、失敗はワークフローへ伝えない。`data/dashboard-publish.json`とMarkdown末尾に最終成功・新しい失敗を記録する。通信・利用枠・CLIの機能変更で公開できない場合は、認証とネットワークを確認し、次の保存または`status`で再試行する。

**要約はclaude.ai上に保存される。** 案件名・質問・報告等の表示文が外部保存に適することを確認し、Artifactは非共有のまま運用する。公開用一時HTMLは`agent-docs/`に作成して終了時に削除する。公開を停止するにはローカル設定の`dashboardArtifact`を`{}`にしてURLを未設定にし、既に起動した公開処理の終了を待つ。保存済みのArtifact自体は残る。

## 検証

`npm test`で、状態遷移、差し戻し、質問・回答、失敗、保存、排他制御を確認する。実装とテストを`agent-docs/`へコピーし、固定の`test/fixtures/workflow.config.json`で実行するため、運用中の共有・ローカル設定には依存しない。一時データは終了時に削除する。実際のCodex実行にはログイン・通信・利用枠が必要であり、単体テストでは代替の実行関数を用いる。

`npm run test:e2e`は実際のCodexで質問・回答・実装・レビュー・完了を確認する。利用枠を消費するため通常のテストには含めない。隔離した開発対象と実行器データを`agent-docs/`に作成し、検証後も結果を残す。テスト用クライアントの回答は固定した試験仕様であり、実際のユーザーへの質問を自動回答する機能ではない。

各試行の`metrics.json`に時間・成否・トークン・CLI・モデル・推論レベル・セッション・新規／再開・前後の利用枠を、ワークフロー直下の`performance.json`に試行一覧と集計を保存する。未取得値は`null`、集計の`complete: false`は欠落を含む。計測導入前の試行もある案件では、`activeComplete: false`として稼働時間の合計も部分値と示す。キャッシュ入力は入力の内訳であり加算しない。Claudeの入力は通常・キャッシュ読取・キャッシュ作成の合計とする。工程稼働時間と、質問・復旧待ちを含む開始から最終試行までの経過時間を分ける。

経費集計の比較試験は`node scripts/benchmark.mjs control`または`improved`で各3回実行する（利用枠を消費する）。`control`は計画統合前、`improved`は統合後のコードで実行する。要求と独立検証は`test/fixtures/expenses/`、測定条件と各回の結果は`agent-docs/benchmark-*/`へ保存する。`node scripts/compare-benchmarks.mjs <対照ディレクトリ> <改善版ディレクトリ>`で各回・中央値・悪化項目を含む比較Markdownを生成する。同じモデル・推論設定・環境・要求であることを確認し、共有キャッシュの揺らぎと失敗を記録する。

## 外部証拠による復旧

容量不足等の環境失敗では、ルートがログと途中の変更を調査し、既存の許可範囲で測定する。測定の許可は既存規則に従い、登録機能は昇格しない。用途に合う有効期限を決め、agent-docs/measurement.jsonへUTF-8 JSONを保存する（64KiB以下、未知項目不可）。

必須項目の例（日時・内容は実測値に置き換える）:

```json
{"name":"pilot-memory","subject":"pilot直前の空きメモリ確認","host":"対象ホスト名","method":"実際の測定方法","observedAt":"2026-10-25T10:00:00Z","expiresAt":"2026-10-25T10:05:00Z","content":"空きメモリ 8 GiB"}
```

node src/cli.js evidence <ID> agent-docs/measurement.json で登録する。ready・waiting・failed・limited・blockedで登録でき、状態・質問・回答・エラー・権限・試行数を保ち、sessionだけを無効にする。failed・limitedは変更確認後にretry <ID>、waitingはanswerまたは既存規則に沿ったgrant、readyはrunで続行する。blockedの復旧条件は変わらない。

内容は元ファイルと独立して保存され、名前ごとの最新版だけを試行開始時に評価し、有効な本文を入力へ直接渡す。失効は利用不可と示し、旧版へ戻さない。回答時に変更・失効があれば完全入力へ戻る。statusはダッシュボードも更新し、現行証拠の名前・有効性・期限を表示する。`status <ID> --detail`とダッシュボードで対象・ホスト・測定時刻・出典・保存内容への参照も確認できる。本文は一覧に出さず、試行のmetrics.jsonへ登録識別子と有効性を残す。失効時は再測定して同じnameで再登録し、旧値の日時だけを書き換えない。証拠は観測データであり命令や実行許可ではない。実行器はOS測定や権限拡張を行わない。
