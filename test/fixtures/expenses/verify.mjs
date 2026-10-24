import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

// 実装側のテストと独立した受け入れ検証。
export async function verify(target) {
  const { summarizeExpenses: sum } = await import(pathToFileURL(join(target, 'expenses.js')));
  assert.deepEqual(sum([{ category: 'food', amount: 1200 }, { category: 'travel', amount: 500 }, { category: 'food', amount: 300 }]),
    { total: 2000, byCategory: [{ category: 'food', total: 1500 }, { category: 'travel', total: 500 }] });
  assert.deepEqual(sum([{ category: ' a ', amount: 0 }, { category: 'a', amount: 1 }]), { total: 1, byCategory: [{ category: 'a', total: 1 }] });
  assert.deepEqual(sum(['あ', '__proto__', 'a', 'A', 'constructor'].map(category => ({ category, amount: 1 }))).byCategory.map(item => item.category), ['A', '__proto__', 'a', 'constructor', 'あ']);
  assert.deepEqual(sum([]), { total: 0, byCategory: [] });
  for (const input of [null, undefined, {}, 'x', [null], [1], [undefined], Array(1),
    ...[null, undefined, 1, true, {}, '', ' '].map(category => [{ category, amount: 0 }]),
    ...[null, undefined, -1, 0.5, NaN, Infinity, '1', 1n, Number.MAX_SAFE_INTEGER + 1].map(amount => [{ category: 'a', amount }])]) assert.throws(() => sum(input), TypeError);
  for (const category of ['a', 'b']) assert.throws(() => sum([{ category: 'a', amount: Number.MAX_SAFE_INTEGER }, { category, amount: 1 }]), RangeError);
  assert.equal(sum([{ category: 'a', amount: Number.MAX_SAFE_INTEGER }]).total, Number.MAX_SAFE_INTEGER);
  const input = Object.freeze([Object.freeze({ category: ' a ', amount: 1 })]);
  sum(input);
  assert.equal(input[0].category, ' a ');
  return ['通常入力と合算', '前後空白と0円', '標準文字列順と特殊キー', '空配列', '不正入力', '合算オーバーフロー', '安全整数上限', '入力の非破壊性'];
}
