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

export const normalizeCommand = command => command.trim().replace(/\s+/g, ' ');

export function escalationDecision(state, method, params) {
  if (method === 'mcpServer/elicitation/request') return { decision: 'cancel', basis: '対話入力は取り消し', result: { action: 'cancel' } };
  if (method === 'item/tool/requestUserInput') return { decision: 'cancel', basis: '対話入力は取り消し', result: { answers: {} } };
  if (method === 'item/permissions/requestApproval') return { decision: 'decline', basis: '追加権限は既存のgrantで管理', result: { permissions: {}, scope: 'turn' } };
  if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) return null;
  let basis = 'execute以外の工程では拒否';
  let decision = 'decline';
  if (state.stage === 'execute' && !state.answers?.at(-1)?.inquiry && method === 'item/commandExecution/requestApproval') {
    if (params.networkApprovalContext != null) {
      decision = state.grants?.network ? 'accept' : 'decline';
      basis = state.grants?.network ? 'grants.network' : 'ネットワークの許可なし';
    } else {
      const actions = params.commandActions;
      const command = actions?.length === 1 ? actions[0]?.command : null;
      // shortcut: 引用符内の区切りも拒否する。必要になった場合だけシェル解析を検討する。
      if (typeof command !== 'string' || !command.trim()) basis = '単一のコマンドを取得できない';
      else if (/;|&&|[\r\n]/.test(command)) basis = '連結・改行を含むコマンドは拒否';
      else {
        const matched = (state.grants?.commands ?? []).find(grant => normalizeCommand(grant) === normalizeCommand(command));
        decision = matched ? 'accept' : 'decline';
        basis = matched ? `grants.commands: ${matched}` : '完全一致する許可なし';
      }
    }
  } else if (method === 'item/fileChange/requestApproval') basis = 'ファイル変更は既存の書き込みパスで管理';
  return { decision, basis, result: { decision } };
}

export function codexSession(child, { thread, turn, emit, raw, output, complete, fail, approval = () => null }) {
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
        const result = approval(method, params);
        if (result) send({ id, result });
        else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) send({ id, result: { decision: 'decline' } });
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
