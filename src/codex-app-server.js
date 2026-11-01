import { StringDecoder } from 'node:string_decoder';

// 活動表示と旧試行の読み手に合わせ、既知のitemだけをexec形式へ写す。
export function execItem(item) {
  const common = { id: item.id };
  const status = item.status === 'inProgress' ? 'in_progress' : item.status;
  switch (item.type) {
    case 'agentMessage': return { ...common, type: 'agent_message', text: item.text };
    case 'reasoning': return { ...common, type: 'reasoning', text: [...(item.summary ?? []), ...(item.content ?? [])].join('\n') };
    case 'commandExecution': return { ...common, type: 'command_execution', command: item.command,
      aggregated_output: item.aggregatedOutput ?? '', exit_code: item.exitCode ?? null, status };
    case 'mcpToolCall': return { ...common, type: 'mcp_tool_call', server: item.server, tool: item.tool,
      arguments: item.arguments, result: item.result, error: item.error, status };
    case 'webSearch': return { ...common, type: 'web_search', query: item.query, action: item.action };
    case 'fileChange': return { ...common, type: 'file_change', status,
      changes: item.changes.map(change => ({ path: change.path, kind: { add: 'add', delete: 'delete', update: 'update' }[change.kind.type] })) };
    default: return null;
  }
}

export function codexSession(child, { thread, turn, emit, raw, output, complete, fail }) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let threadId;
  let turnId;
  let tokenUsage;
  let finalMessage;
  let finished = false;
  let interrupted = false;
  const send = message => {
    const line = JSON.stringify(message) + '\n';
    raw('send', line);
    child.stdin.write(line);
  };
  const interrupt = () => {
    interrupted = true;
    if (threadId && turnId && !finished) send({ id: 4, method: 'turn/interrupt', params: { threadId, turnId } });
  };
  const receive = chunk => {
    pending += decoder.write(chunk);
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      raw('receive', line + '\n');
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (!message || typeof message !== 'object' || finished) continue;
      const { id, method, params = {} } = message;
      if (id !== undefined && method) {
        if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) send({ id, result: { decision: 'decline' } });
        else send({ id, error: { code: -32601, message: 'Unsupported server request' } });
      } else if (id !== undefined) {
        if (message.error) { fail(new Error(JSON.stringify(message.error))); return; }
        if (id === 1 && !interrupted) {
          send({ method: 'initialized', params: {} });
          send({ id: 2, method: thread.threadId ? 'thread/resume' : 'thread/start', params: thread });
        } else if (id === 2) {
          threadId = message.result.thread.id;
          emit({ type: 'thread.started', thread_id: threadId });
          if (!interrupted) send({ id: 3, method: 'turn/start', params: { ...turn, threadId } });
        } else if (id === 3) {
          turnId = message.result.turn.id;
          if (interrupted) interrupt();
        }
      } else if (method === 'turn/started') {
        turnId = params.turn.id;
        emit({ type: 'turn.started' });
        if (interrupted) interrupt();
      } else if (method === 'thread/tokenUsage/updated') {
        tokenUsage = params.tokenUsage.total;
      } else if (method === 'item/started' || method === 'item/completed') {
        const item = execItem(params.item);
        if (item) emit({ type: method === 'item/started' ? 'item.started' : 'item.completed', item });
        if (method === 'item/completed' && params.item.type === 'agentMessage') finalMessage = params.item.text;
      } else if (method === 'error') {
        // 自動再試行される途中のエラーはexecでも最終失敗として扱わない。
        if (!params.willRetry) emit({ type: 'error', ...params });
      } else if (method === 'turn/completed') {
        finished = true;
        if (params.turn.status === 'completed') {
          emit({ type: 'turn.completed', usage: tokenUsage ? {
            input_tokens: tokenUsage.inputTokens, cached_input_tokens: tokenUsage.cachedInputTokens, output_tokens: tokenUsage.outputTokens,
          } : undefined });
          if (finalMessage === undefined) fail(new Error('Codexの構造化出力がありません'));
          else { output(finalMessage); complete(); }
        } else {
          emit({ type: 'turn.failed', error: params.turn.error ?? { message: params.turn.status } });
          complete();
        }
      }
    }
  };
  return {
    start: () => send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'workflow-executor', version: '1.0' } } }),
    receive, interrupt,
    end: () => { if (pending) { raw('receive', pending); pending = ''; } },
    get finished() { return finished; },
  };
}
