import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { create, load, answer, grant, lock, list, summary, setModel, retry, registerEvidence, dashboard } from './workflow.js';
import { step, run } from './executor.js';
import { startChange, archive } from './changes.js';

const [command, ...args] = process.argv.slice(2);
const help = `Workflow Executor (Node.js 22+ / Codex CLI)
  工程: 計画（要求・粒度・設計）→ 実装 → 独立レビュー → 最終確認
  start <対象ディレクトリ> <要求ファイル>
  start-change <対象> [change名] [--model <工程> <モデル> [推論レベル]]...
  model <ID> <工程> <モデル> [推論レベル]
  archive <ID>                 completedのchangeを同期・アーカイブ
  step <ID>                     次の1工程を実行
  run <ID>                      回答待ち・失敗・完了まで工程を進める
  answer <ID> <回答ファイル>      チャットで受け取った回答を保存
  grant <ID> [--network] [--path <ディレクトリ>]...  権限要求を許可して再開
  retry <ID>                 失敗・中断後、変更確認を経て再開可能にする
  evidence <ID> <JSONファイル>  停止中の案件へ外部証拠を登録
  status [ID]                   状態と必要な対応を確認
要求・回答ファイル、一時ファイルはagent-docs/以下に置く。`;

let release;
try {
  if (!command || command === '--help') {
    console.log(help);
  } else {
    if (!['start', 'start-change', 'model', 'archive', 'step', 'run', 'answer', 'grant', 'retry', 'status', 'evidence'].includes(command)) throw new Error(help);
    const counts = { start: 2, step: 1, run: 1, answer: 2, retry: 1, archive: 1, evidence: 2 };
    if ((counts[command] && args.length !== counts[command]) || (command === 'status' && args.length > 1) ||
      (command === 'model' && ![3, 4].includes(args.length))) throw new Error(help);
    // Serialize state mutations and Codex runs; never allow two writers to a target.
    if (command !== 'status') release = lock();
    if (command === 'status') dashboard();
    let state;
    if (command === 'start') state = create(args[0], readFileSync(resolve(args[1]), 'utf8'));
    else if (command === 'start-change') {
      const target = args.shift();
      if (!target) throw new Error(help);
      const change = args[0] && args[0] !== '--model' ? args.shift() : undefined;
      const models = {};
      while (args.length) {
        if (args.shift() !== '--model' || args.length < 2) throw new Error(help);
        const stage = args.shift();
        const model = args.shift();
        const effort = args[0] && args[0] !== '--model' ? args.shift() : undefined;
        models[stage] = { model, effort };
      }
      state = await startChange(resolve(target), change, models);
    }
    else if (command === 'status' && !args.length) console.log(JSON.stringify(list().map(state => summary(state)), null, 2));
    else {
      state = load(args[0]);
      if (command === 'step') await step(state);
      else if (command === 'run') await run(state, undefined, undefined, current => {
        console.log(JSON.stringify(summary(current)));
      });
      else if (command === 'answer') answer(state, readFileSync(resolve(args[1]), 'utf8'));
      else if (command === 'grant') {
        const options = { network: false, paths: [] };
        for (let i = 1; i < args.length; i++) {
          if (args[i] === '--network') options.network = true;
          else if (args[i] === '--path' && args[i + 1]) options.paths.push(args[++i]);
          else throw new Error(help);
        }
        grant(state, options);
      }
      else if (command === 'retry') retry(state);
      else if (command === 'evidence') registerEvidence(state, args[1]);
      else if (command === 'model') setModel(state, args[1], args[2], args[3]);
      else if (command === 'archive') console.log(await archive(state));
    }
    if (state) console.log(JSON.stringify(summary(state), null, 2));
    if (state && ['failed', 'blocked', 'limited'].includes(state.status)) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  release?.();
}
