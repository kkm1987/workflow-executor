## Context

実行前レビューはClaude CLIで`Read`・`Glob`・`Grep`と`openspec`の一部のBashだけを許可している（`claudeArgs`）。実装工程はCodexの`workspace-write`サンドボックスで動き、許可したパスは`sandbox_workspace_write.writable_roots`として渡る。`grant`はパスの実在・ディレクトリであること・禁止範囲でないことだけを確認し、そのまま回答としてセッションを再開させる。

ワークフロー 6a16db5b の対象ディレクトリは、継承を切ったACLで、所有者本人も一覧を拒否される状態だった。この場合、Codexの設定をどう変えても読めない。兄弟ディレクトリも継承なしのACLで`CodexSandboxUsers`の許可がなく、所有者は読めてもサンドボックスからは読めない可能性がある。

## Goals / Non-Goals

**Goals:**
- 実行前レビューが作業ツリーの状態をコマンドで確認できる。
- 実効にならない許可で、エージェントに同じ権限要求を繰り返させない。

**Non-Goals:**
- 実行器がOSのACLを変更すること。ACLの修正は所有者が行う。
- ネットワーク許可の実効確認。今回の不具合はパスだけで、ネットワークは確認方法が別になる。
- 実行前レビューをCodexで動かす場合の権限調整。現在の既定はClaudeで、Codexの`workspace-write`はすでに作業ツリー全体を読める。

## Decisions

### D1. 実行前レビューの許可は前方一致のBashルールで足す
`Bash(git status:*)`、`Bash(git diff:*)`、`Bash(git log:*)`、`Bash(git show:*)`、`Bash(ls:*)`を許可ツールへ加える。`git`全体を許可すると`git checkout`や`git commit`も通るため、サブコマンド単位にする。`Bash`全体を許可する案は、書き込み範囲を対象changeに限る既存要件と両立しないので採らない。

前方一致のルールは`cd …; git diff`のような連結コマンドに一致しない。指示に「作業ディレクトリは対象リポジトリなので移動しない。1回に1コマンド」と加えて合わせる。

### D2. 実効確認は実装工程のCLIで、実装工程と同じ設定で行う
- 実装工程がCodexの場合: preflightと同じ`codex sandbox -P :workspace -C <target>`に、`features.prefer_mxc`と、既存の許可に今回のパスを加えた`sandbox_workspace_write.writable_roots`を付ける。`node -e`で各パスを`readdirSync`し、終了コードだけを見る。サンドボックスでの起動を確認する既存のpreflightと同じ`checkCommand`を使い、出力は保存しない。
- 実装工程がClaudeの場合: Claudeは実行ユーザーとして動くので、実行器のプロセスで`readdirSync`を試す。

実装工程のCLIは`assignment({ ...state, stage: 'execute' })`で決める。権限要求は実装工程からしか出ない（`validateResult`が制限している）ため、確認の対象はいつも実装工程の実行条件になる。

代替案として、許可後に実装工程を再実行して失敗を待つ案がある。モデル呼び出しと利用枠を消費し、今回のように同じ質問を繰り返すので採らない。

### D3. 失敗時は状態を変えずにエラーを投げる
確認に失敗したら、`state.grants`の更新・`answer`・イベント`granted`のどれも行わず、`grant-rejected`イベントに対象パスと「OSのアクセス権で読み取れない」理由だけを記録してエラーを投げる。状態は`waiting`のまま`permission`も残るので、ACLの修正後に同じ`grant`をもう一度実行できる。CLIは既存のエラー表示で理由を返す。

### D4. ルートセッションの手順を補う
SKILL.mdの手順3bに、`grant`がアクセス権の理由で失敗したら許可を繰り返さず、対象パスとOSのACLの修正が必要であることをユーザーへ提示する、と書き足す。

## Risks / Trade-offs

- [`codex sandbox`の起動はWindowsで数秒かかる] → 許可の操作は人の判断の後に一度だけ行われ、preflightと同じタイムアウトで打ち切る。
- [サンドボックスの確認は読み取りだけで、書き込みは確認しない] → 今回の不具合は読み取りであり、書き込みの拒否は実装工程が権限要求として報告できる。
- [前方一致のルールで`git diff --output=<file>`のような書き込みを伴うオプションが通る] → 実行前レビューは指示で編集範囲を限っており、範囲外の変更は実行前レビューの前後の証拠比較で検出される。必要になったらオプション単位で拒否ルールを足す。
