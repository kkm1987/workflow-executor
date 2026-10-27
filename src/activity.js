import { StringDecoder } from 'node:string_decoder';

export function activity(entry, cli, at = new Date().toISOString(), tools = new Map()) {
  const report = text => {
    if (typeof text !== 'string' || !text.trim()) return null;
    try { JSON.parse(text); return null; } catch {}
    const chars = Array.from(text.trim());
    return { kind: 'report', text: chars.slice(0, 500).join(''), truncated: chars.length > 500, at };
  };
  if (cli === 'codex') {
    const item = entry.item;
    if (entry.type === 'item.completed' && item?.type === 'agent_message') return report(item.text);
    if (['item.started', 'item.completed'].includes(entry.type) &&
        ['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(item?.type)) {
      return { kind: 'tool', tool: item.type, status: item.status ?? (entry.type === 'item.started' ? 'in_progress' : 'completed'), at };
    }
  } else if (entry.type === 'assistant') {
    let latest = null;
    for (const block of entry.message?.content ?? []) {
      if (block.type === 'text') latest = report(block.text) ?? latest;
      if (block.type === 'tool_use') {
        tools.set(block.id, block.name);
        latest = { kind: 'tool', tool: block.name, status: 'in_progress', at };
      }
    }
    return latest;
  } else if (entry.type === 'user') {
    const block = Array.isArray(entry.message?.content) ? entry.message.content.findLast(block => block.type === 'tool_result') : null;
    if (block) {
      const tool = tools.get(block.tool_use_id) ?? 'tool_result';
      tools.delete(block.tool_use_id);
      return { kind: 'tool', tool, status: block.is_error ? 'failed' : 'completed', at };
    }
  }
  return null;
}

export function eventStream(onEvent) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return chunk => {
    pending += decoder.write(chunk);
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry && typeof entry === 'object' && typeof entry.type === 'string') onEvent(entry);
    }
  };
}
