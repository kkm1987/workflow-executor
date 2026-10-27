import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { resolve } from 'node:path';

export function readEvidence(path, at = Date.now()) {
  const fd = openSync(path, 'r');
  let bytes;
  try {
    if (fstatSync(fd).size > 65536) throw new Error('証拠は64KiB以下にしてください');
    const buffer = Buffer.alloc(65537);
    let size = 0;
    let count;
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null))) size += count;
    if (size > 65536) throw new Error('証拠は64KiB以下にしてください');
    bytes = buffer.subarray(0, size);
  } finally { closeSync(fd); }
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const keys = ['name', 'subject', 'host', 'method', 'observedAt', 'expiresAt', 'content'];
  if (!value || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      !keys.every(key => typeof value[key] === 'string' && value[key].trim())) throw new Error('証拠の必須項目または未知項目が不正です');
  const timestamp = text => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) return false;
    const local = text.slice(0, 19);
    return new Date(local + 'Z').toISOString().slice(0, 19) === local;
  };
  if (!timestamp(value.observedAt) || !timestamp(value.expiresAt) ||
      Date.parse(value.observedAt) > at || Date.parse(value.observedAt) >= Date.parse(value.expiresAt) ||
      Date.parse(value.expiresAt) <= at) throw new Error('証拠の測定時刻または有効期限が不正です');
  return { ...value, source: resolve(path) };
}

export function currentEvidence(state, at = Date.now()) {
  const latest = new Map();
  for (const entry of state.externalEvidence ?? []) latest.set(entry.name, entry);
  return [...latest.values()].map(entry => ({ ...entry, valid: at < Date.parse(entry.expiresAt) }));
}

export const evidenceSelection = (state, at) => currentEvidence(state, at).map(({ id, valid }) => ({ id, valid }));

export function evidenceInput(state, at) {
  return currentEvidence(state, at).map(entry => entry.valid ? entry : {
    id: entry.id, name: entry.name, expiresAt: entry.expiresAt, valid: false, notice: '期限切れ・利用不可。再測定・再登録が必要です',
  });
}
