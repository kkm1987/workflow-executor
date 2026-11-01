import { writeFileSync } from 'node:fs';

export function fakeCodex(path, onTurn) {
  writeFileSync(path, `
    const fs = require('node:fs');
    const send = value => console.log(JSON.stringify(value));
    const notify = (method, params) => send({ method, params });
    const finish = result => {
      if (result !== undefined) notify('item/completed', { item: { type: 'agentMessage', id: 'final', text: JSON.stringify(result) } });
      notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    };
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') send({ id: message.id, result: {} });
      if (['thread/start', 'thread/resume'].includes(message.method)) send({ id: message.id, result: { thread: { id: message.params.threadId ?? 'fake' } } });
      if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn' } } });
        notify('turn/started', { turn: { id: 'turn' } });
        const input = message.params.input[0].text;
        ${onTurn}
      }
      if (message.method === 'turn/interrupt') {
        send({ id: message.id, result: {} });
        notify('turn/completed', { turn: { id: 'turn', status: 'interrupted' } });
      }
    });
  `);
}
