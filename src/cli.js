import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { create, load, save, answer, lock, event, list, summary } from './workflow.js';
import { step, run } from './executor.js';

const [command, ...args] = process.argv.slice(2);
const help = `Workflow Executor (Node.js 22+ / Codex CLI)
  工程: 計画（要求・粒度・設計）→ 実装 → 独立レビュー → 最終確認
  start <対象ディレクトリ> <要求ファイル>
  step <ID>                     次の1工程を実行
  run <ID>                      回答待ち・失敗・完了まで工程を進める
  answer <ID> <回答ファイル>      チャットで受け取った回答を保存
  retry <ID>                    失敗・中断後、変更確認を経て再開可能にする
  status [ID]                   状態と必要な対応を確認
要求・回答ファイル、一時ファイルはagent-docs/以下に置く。`;

let release;
try {
  if (!command || command === '--help') {
    console.log(help);
  } else {
    if (!['start', 'step', 'run', 'answer', 'retry', 'status'].includes(command)) throw new Error(help);
    const counts = { start: 2, step: 1, run: 1, answer: 2, retry: 1 };
    if ((command !== 'status' && args.length !== counts[command]) || (command === 'status' && args.length > 1)) throw new Error(help);
    // Serialize state mutations and Codex runs; never allow two writers to a target.
    if (command !== 'status') release = lock();
    let state;
    if (command === 'start') state = create(args[0], readFileSync(resolve(args[1]), 'utf8'));
    else if (command === 'status' && !args.length) console.log(JSON.stringify(list().map(state => summary(state)), null, 2));
    else {
      state = load(args[0]);
      if (command === 'step') await step(state);
      else if (command === 'run') await run(state, undefined, undefined, current => {
        console.log(JSON.stringify(summary(current)));
      });
      else if (command === 'answer') answer(state, readFileSync(resolve(args[1]), 'utf8'));
      else if (command === 'retry') {
        if (!['failed', 'running'].includes(state.status)) throw new Error('失敗・中断状態だけ再開できます');
        state.status = 'ready';
        delete state.error;
        event(state, 'retry_requested', state.stage);
        save(state);
      }
    }
    if (state) console.log(JSON.stringify(summary(state), null, 2));
    if (state && ['failed', 'blocked'].includes(state.status)) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  release?.();
}
