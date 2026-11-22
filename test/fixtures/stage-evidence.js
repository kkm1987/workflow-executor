import { join } from 'node:path';

export function largeStageEvidence() {
  return Array.from({ length: 20 }, (_, index) => {
    const attempt = index + 1;
    const dir = join('C:/work/workflow-executor/data', '0f26a283-d660-49c2-bead-fe7480b73700',
      `attempt-${String(attempt).padStart(4, '0')}`);
    return {
      attempt, stage: 'execute', before: join(dir, 'before.json'), after: join(dir, 'after.json'), log: join(dir, 'codex.jsonl'),
      changedFiles: Array.from({ length: 3000 }, (_, file) => `src/generated/attempt-${attempt}/generated-file-${file}.js`),
      escalations: Array.from({ length: 40 }, (_, entry) => ({
        decision: entry < 31 ? 'accept' : 'decline', command: '検証コマンドとその引数 '.repeat(10), reason: '昇格が必要な理由 '.repeat(10),
      })),
    };
  });
}
