// 親の強制終了後も生存する子を、隔離テストの親が明示終了する。
process.send({ type: 'ready' });
process.on('disconnect', () => {});
setInterval(() => {}, 1000);
