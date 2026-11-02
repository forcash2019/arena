import { listTools, callTool } from './mcp-client.js';

const okUrl = (u) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(u || '');
const fail = (send, e) => send({ ok: false, error: String((e && e.message) || e) });

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg.type === 'MCP_LIST') {
    if (!okUrl(msg.url)) { send({ ok: false, error: 'only http://localhost or 127.0.0.1 URLs are allowed' }); return; }
    listTools(msg.url).then((tools) => send({ ok: true, tools })).catch((e) => fail(send, e));
    return true;
  }
  if (msg.type === 'MCP_CALL') {
    if (!okUrl(msg.url)) { send({ ok: false, error: 'only http://localhost or 127.0.0.1 URLs are allowed' }); return; }
    callTool(msg.url, msg.name, msg.args).then((r) => send({ ok: true, ...r })).catch((e) => fail(send, e));
    return true;
  }
});
