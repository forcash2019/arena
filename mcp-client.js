// Minimal MCP client for the legacy HTTP+SSE transport (spec 2024-11-05).
// GET <url> -> SSE stream; first event "endpoint" gives the URL for POSTing JSON-RPC;
// responses come back as "message" events on the same stream.

export async function withSession(baseUrl, fn, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const pending = new Map();
  let nextId = 1;
  let postUrl = null;
  let endpointResolve, endpointReject;
  const endpointP = new Promise((res, rej) => { endpointResolve = res; endpointReject = rej; });

  const rejectAll = (err) => {
    endpointReject(err);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  try {
    let res;
    try {
      res = await fetch(baseUrl, { headers: { Accept: 'text/event-stream' }, signal: ctrl.signal });
    } catch (e) {
      throw new Error(ctrl.signal.aborted ? 'timeout connecting to ' + baseUrl : 'cannot reach ' + baseUrl + ' (is the server running?)');
    }
    if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + baseUrl);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    (async () => {
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let m;
          while ((m = buf.match(/\r?\n\r?\n/))) {
            const block = buf.slice(0, m.index);
            buf = buf.slice(m.index + m[0].length);
            let event = 'message';
            const data = [];
            for (const line of block.split(/\r?\n/)) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
            const payload = data.join('\n');
            if (event === 'endpoint') {
              postUrl = new URL(payload.trim(), baseUrl).href;
              endpointResolve(postUrl);
            } else if (event === 'message' && payload) {
              let msg;
              try { msg = JSON.parse(payload); } catch { continue; }
              const p = msg && pending.get(msg.id);
              if (p) {
                pending.delete(msg.id);
                if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                else p.resolve(msg.result);
              }
            }
          }
        }
        rejectAll(new Error('SSE stream closed by server'));
      } catch (e) {
        rejectAll(ctrl.signal.aborted ? new Error('timeout') : e);
      }
    })();

    await endpointP;

    const post = async (body) => {
      const r = await fetch(postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!r.ok && r.status !== 202) throw new Error('POST failed: HTTP ' + r.status);
    };
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      post({ jsonrpc: '2.0', id, method, params }).catch((e) => { pending.delete(id); reject(e); });
    });
    const notify = (method, params) => post({ jsonrpc: '2.0', method, params });

    await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'arena-mcp-bridge', version: '0.2.0' },
    });
    await notify('notifications/initialized');
    return await fn({ request });
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

export function listTools(url) {
  return withSession(url, async ({ request }) => {
    const tools = [];
    let cursor;
    do {
      const r = await request('tools/list', cursor ? { cursor } : {});
      tools.push(...(r.tools || []));
      cursor = r.nextCursor;
    } while (cursor);
    return tools;
  });
}

export function callTool(url, name, args) {
  return withSession(url, async ({ request }) => {
    const r = await request('tools/call', { name, arguments: args || {} });
    const parts = (r.content || []).map((c) =>
      c.type === 'text' ? c.text : c.type === 'image' ? '[image ' + (c.mimeType || '') + ']' : JSON.stringify(c));
    return { text: parts.join('\n') || (r.structuredContent ? JSON.stringify(r.structuredContent) : ''), isError: !!r.isError };
  }, 120000);
}
