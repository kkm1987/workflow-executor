import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { reserve } from './locking.js';
import { resolve } from 'node:path';
import { create, load, close, answer, approve, grant, dataRoot, list, summary, brief, setModel, setFallback, retry, registerEvidence, dashboard } from './workflow.js';
import { step, run } from './executor.js';
import { startChange, archive } from './changes.js';

const [command, ...args] = process.argv.slice(2);
const help = `Workflow Executor (Node.js 22+ / Codex CLI)
  工程: 計画（要求・粒度・設計）→ 実装 → 独立レビュー → 最終確認
  start <対象ディレクトリ> <要求ファイル> [--model <工程> <モデル> [推論レベル]]... [--fallback <工程> <モデル> [推論レベル]]...
  start-change <対象> [change名] [--store <id>] [--model <工程> <モデル> [推論レベル]]... [--fallback <工程> <モデル> [推論レベル]]...
  model <ID> <工程> <モデル> [推論レベル]
  fallback <ID> <工程> <モデル> [推論レベル]
  fallback <ID> <工程> --disable
  archive <ID>                 completedのchangeを同期・アーカイブ
  close <ID> [理由ファイル]       実行中以外の案件を終了
  step <ID>                     次の1工程を実行
  run <ID>                      回答待ち・失敗・完了まで工程を進める
  answer <ID> <回答ファイル> [--inquiry]  回答を保存（--inquiryは確認の質問）
  approve <ID> [条件ファイル]    承認計画を承認し、条件を保存
  grant <ID> [--network] [--path <ディレクトリ>]...  権限要求を許可して再開
  retry <ID>                 失敗・中断後、変更確認を経て再開可能にする
  evidence <ID> <JSONファイル>  停止中の案件へ外部証拠を登録
  status [ID | --all]            状態を確認（一覧は終了を除外、--allで全件）
  status <ID> --detail           履歴・外部証拠を含む詳細を確認
要求・回答ファイル、一時ファイルはagent-docs/以下に置く。`;

let release;
try {
  if (!command || command === '--help') {
    console.log(help);
  } else {
    if (!['start', 'start-change', 'model', 'fallback', 'archive', 'close', 'step', 'run', 'answer', 'approve', 'grant', 'retry', 'status', 'evidence'].includes(command)) throw new Error(help);
    const counts = { step: 1, run: 1, retry: 1, archive: 1, evidence: 2 };
    if ((counts[command] && args.length !== counts[command]) ||
      (command === 'answer' && !(args.length === 2 || (args.length === 3 && args[2] === '--inquiry'))) ||
      (command === 'status' && !(args.length <= 1 || (args.length === 2 && args[0] !== '--all' && !args[0].startsWith('--') && args[1] === '--detail'))) ||
      (command === 'model' && ![3, 4].includes(args.length)) ||
      (command === 'fallback' && (![3, 4].includes(args.length) || (args[2] === '--disable' && args.length !== 3))) ||
      (['approve', 'close'].includes(command) && ![1, 2].includes(args.length))) throw new Error(help);
    if (command === 'status') dashboard();
    let state;
    if (['start', 'start-change'].includes(command)) {
      const target = args.shift();
      if (!target) throw new Error(help);
      const request = command === 'start' ? args.shift() : undefined;
      if (command === 'start' && (!request || request.startsWith('--'))) throw new Error(help);
      const change = command === 'start-change' && args[0] && !args[0].startsWith('--') ? args.shift() : undefined;
      const models = {};
      const fallbacks = {};
      let store;
      while (args.length) {
        const option = args.shift();
        if (option === '--store' && command === 'start-change') {
          if (store || !args[0] || args[0].startsWith('--')) throw new Error(help);
          store = args.shift();
          continue;
        }
        if (!['--model', '--fallback'].includes(option) || args.length < 2) throw new Error(help);
        const stage = args.shift();
        const model = args.shift();
        const effort = args[0] && !args[0].startsWith('--') ? args.shift() : undefined;
        (option === '--model' ? models : fallbacks)[stage] = { model, effort };
      }
      if (command === 'start-change') state = await startChange(resolve(target), change, models, undefined, undefined, store, fallbacks);
      else {
        const id = randomUUID();
        release = reserve(dataRoot, () => ({ id, paths: [target] }));
        state = create(target, readFileSync(resolve(request), 'utf8'), dataRoot, id, { models, fallbacks });
      }
    }
    else if (command === 'status' && (!args.length || args[0] === '--all')) console.log(JSON.stringify(list().filter(state => args[0] === '--all' || state.status !== 'closed').map(state => brief(summary(state))), null, 2));
    else {
      if (command !== 'status') release = reserve(dataRoot, () => {
        const current = load(args[0]);
        const paths = [current.target, ...(current.grants?.paths ?? [])];
        if (current.kind === 'change') paths.push(current.openspec?.root ?? current.target);
        if (command === 'grant') for (let i = 1; i < args.length; i++) {
          if (args[i] === '--path' && args[i + 1]) paths.push(args[++i]);
        }
        return { id: current.id, paths };
      });
      state = load(args[0]);
      if (command === 'step') await step(state);
      else if (command === 'run') await run(state, undefined, undefined, current => {
        console.log(JSON.stringify(brief(summary(current))));
      });
      else if (command === 'answer') answer(state, readFileSync(resolve(args[1]), 'utf8'), dataRoot, args[2] === '--inquiry');
      else if (command === 'approve') approve(state, args[1] ? readFileSync(resolve(args[1]), 'utf8') : '');
      else if (command === 'close') close(state, args[1] ? readFileSync(resolve(args[1]), 'utf8') : '');
      else if (command === 'grant') {
        const options = { network: false, paths: [] };
        for (let i = 1; i < args.length; i++) {
          if (args[i] === '--network') options.network = true;
          else if (args[i] === '--path' && args[i + 1]) options.paths.push(args[++i]);
          else throw new Error(help);
        }
        await grant(state, options);
      }
      else if (command === 'retry') retry(state);
      else if (command === 'evidence') registerEvidence(state, args[1]);
      else if (command === 'model') setModel(state, args[1], args[2], args[3]);
      else if (command === 'fallback') setFallback(state, args[1], args[2] === '--disable' ? null : args[2], args[3]);
      else if (command === 'archive') console.log(await archive(state));
    }
    if (state) console.log(JSON.stringify(command === 'status' && args[1] === '--detail'
      ? summary(state, undefined, true)
      : brief(summary(state)), null, 2));
    if (state && ['failed', 'blocked', 'limited'].includes(state.status)) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  release?.();
}
