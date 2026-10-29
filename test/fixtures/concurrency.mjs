import { reserve, withSharedLock } from '../../src/locking.js';
import { load, save, dashboard } from '../../src/workflow.js';
import { run } from '../../src/executor.js';
import { fork } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const next = () => new Promise(resolve => process.once('message', resolve));
process.send({ type: 'ready' });
const { mode, base, id, paths } = await next();
let release;
try {
  if (mode === 'shared') withSharedLock(base, () => { throw new Error('共有内例外'); });
  else if (mode === 'shared-loop') {
    for (let i = 0; i < 1000; i++) withSharedLock(base, () => {
      const path = join(base, 'counter');
      writeFileSync(path, String(Number(readFileSync(path, 'utf8')) + 1));
    });
    process.send({ type: 'counted' });
  }
  else if (mode === 'save') {
    const start = performance.now();
    for (let i = 0; i < 12; i++) {
      const state = load(id, base);
      state.lastResult = `保存${i}`;
      save(state, base);
      dashboard(base, { config: {} });
    }
    process.send({ type: 'saved', elapsed: performance.now() - start });
  } else {
    release = reserve(base, () => ({ id, paths }));
    process.send({ type: 'acquired' });
    if (mode === 'orphan') {
      const child = fork(new URL('./concurrency-child.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, detached: true });
      await new Promise(resolve => child.once('message', resolve));
      process.send({ type: 'child', pid: child.pid });
    }
    await next();
    if (mode === 'run') {
      await run(load(id, base), async state => {
        process.send({ type: 'stage', stage: state.stage });
        const response = await next();
        if (response.fail) throw new Error('試験例外');
        return { outcome: 'ok', summary: '確認済み', question: '',
          report: { scope: '試験', decisions: [], verification: '合図確認', remaining: 'なし' },
          tasks: [{ title: '試験', acceptance: '合図' }],
          decisions: { requirements: '試験', granularity: '試験', architecture: '試験' } };
      }, base, () => {}, async () => ({ ok: true }), async () => null);
    }
  }
} catch (error) { process.send({ type: 'error', message: error.message }); }
finally {
  release?.();
  process.send({ type: 'done' });
  process.disconnect();
}
