## 1. 実行前レビューの読み取り範囲

- [ ] 1.1 `claudeArgs`の実行前レビューの許可ツールに`Bash(git status:*)`・`Bash(git diff:*)`・`Bash(git log:*)`・`Bash(git show:*)`・`Bash(ls:*)`を加え、`git`全体や`Bash`全体は許可しない。`test/routing.test.js`で、実行前レビューの引数にこれらが含まれ、`Bash(git:*)`と`Bash`単体が含まれないことを確認する
- [ ] 1.2 実行前レビューの指示に「作業ディレクトリは対象リポジトリなので移動しない。コマンドは連結せず1回に1つ実行する」を加え、プロンプトのテストでその文が含まれることを確認する

## 2. 許可の実効確認

- [ ] 2.1 実装工程のCLIを判定し、Codexなら既存の許可と今回のパスを`writable_roots`に入れた`codex sandbox -P :workspace`で各パスを`readdirSync`する確認、Claudeなら実行器のプロセスでの`readdirSync`を行う関数を追加する。`checkCommand`のタイムアウトを使い、出力を保存しない。注入した確認関数で成功と失敗を返すテストで確認する
- [ ] 2.2 `grant`で確認に失敗したら`grants`・`answer`・`granted`イベントを更新せず、`grant-rejected`イベントに対象パスと理由を記録してエラーを投げる（`grant`の非同期化に合わせて`src/cli.js`の呼び出しも直す）。`test/workflow.test.js`で、失敗時に状態がwaitingのまま`permission`が残り、成功時は従来どおり回答されて再開できることを確認する
- [ ] 2.3 失敗後に同じパスを再度`grant`して確認に合格すると許可が保存されることを、確認関数の結果を切り替えるテストで確認する

## 3. ルートセッションの手順

- [ ] 3.1 `skills/workflow-executor/SKILL.md`の手順3bに、`grant`がアクセス権の理由で失敗した場合は許可を繰り返さず、対象パスとOSのアクセス権の修正が必要であることをユーザーへ提示する手順を加え、`npm test`がすべて合格することを確認する
