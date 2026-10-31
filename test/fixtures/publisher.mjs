import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const [mode, base, ...args] = process.argv.slice(2);
assert.equal(args[args.indexOf('--tools') + 1], 'Artifact,Read');
assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
assert.equal(process.env.CLAUDE_CODE_ARTIFACT, '1');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { file_path: file, url } = JSON.parse(input.split('\n')[1]);
const countFile = join(base, 'fake-count');
const count = (existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0) + 1;
writeFileSync(countFile, String(count));
writeFileSync(join(base, `published-${count}.html`), readFileSync(file));
if (mode === 'change-fail') {
  const path = join(base, 'dashboard.json');
  const snapshot = JSON.parse(readFileSync(path, 'utf8'));
  snapshot.groups[0].cases[0].stage = `失敗中の工程${count}`;
  writeFileSync(path, JSON.stringify(snapshot));
  process.exit(2);
}
if (mode === 'transient' && count === 1) process.exit(2);
if (mode === 'fail') process.exit(2);
if (mode === 'mutate') writeFileSync(file, '変更されたHTML');
if (mode === 'timeout') await new Promise(() => { setInterval(() => {}, 1000); });
if (mode === 'hold' || mode === 'hold-fail') {
  writeFileSync(join(base, 'fake-started'), 'ready');
  while (!existsSync(join(base, 'fake-release'))) await new Promise(resolve => setTimeout(resolve, 20));
  if (mode === 'hold-fail') process.exit(2);
}
if (mode === 'change' && count === 1) {
  const path = join(base, 'dashboard.json');
  const snapshot = JSON.parse(readFileSync(path, 'utf8'));
  snapshot.groups[0].cases[0].activity = '公開中に届いた新しい活動';
  snapshot.groups[0].cases[0].question = '質問2';
  snapshot.groups[0].cases[0].attempt++;
  writeFileSync(path, JSON.stringify(snapshot));
}
const emit = event => console.log(JSON.stringify(event));
if (mode !== 'no-proof') {
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'publish-1', name: 'Artifact', input: { action: 'publish', file_path: file, url } }] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'publish-1', content: `Published ${file} at ${mode === 'wrong-url' ? url + '-wrong' : url} (Version ${count})` }] } });
}
emit({ type: 'result', is_error: false, permission_denials: [] });
