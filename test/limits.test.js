import test from 'node:test';
import assert from 'node:assert/strict';
import { rateLimits, parseClaudeLimits } from '../src/limits.js';

const output = JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
  result: 'Current session: 3% used\nResets in 4h\nCurrent week (all models): 12% used\nResets Nov 6',
  num_turns: 0, total_cost_usd: 0 });
const state = { target: '.', executables: { claude: 'claude', codex: 'codex' } };

test('Claudeはsafe-modeと30秒で取得し、sessionとweekの出力を解析する', async () => {
  const result = await rateLimits(state, { cli: 'claude' }, async (...args) => {
    assert.deepEqual(args, ['claude', ['-p', '/usage', '--output-format', 'json', '--safe-mode'], '.', 30000]);
    return output;
  });
  assert.equal(result.failure, null);
  assert.deepEqual(result.limits, parseClaudeLimits(output));
  assert.equal(result.limits.primary.usedPercent, 3);
  assert.equal(result.limits.secondary.usedPercent, 12);
});

for (const cli of ['claude', 'codex']) {
  for (const [reason, error] of [
    ['timeout', cli === 'claude' ? Object.assign(new Error('timeout'), { killed: true }) : new Error('利用枠取得タイムアウト')],
    ['exit', Object.assign(new Error('exit'), { code: 1, stderr: '異常'.repeat(200) })],
    ['spawn', Object.assign(new Error('起動失敗'), { code: 'ENOENT' })],
    ['parse', null],
  ]) test(`${cli}の${reason}を所要時間と200文字以内の詳細で返す`, async () => {
    const read = async () => { if (error) throw error; return cli === 'claude' ? '{}' : null; };
    const result = await rateLimits(state, { cli }, read, read);
    assert.equal(result.limits, null);
    assert.equal(result.failure.reason, reason);
    assert.ok(result.failure.elapsedMs >= 0);
    assert.ok(result.failure.detail.length <= 200);
    if (reason === 'exit') assert.equal(result.failure.detail.length, 200);
  });
}
