// Pure helpers shared by the content script (and unit-tested in node).
const MCPLib = (() => {
  // "/c http://localhost:3000/sse", "/c npx -y mcp-remote http://localhost:3000/sse --transport sse-only",
  // "/tools", or a bare localhost URL.
  function parseCommand(text) {
    const t = (text || '').trim();
    if (!t) return null;
    let m = t.match(/^\/c(?:\s+([\s\S]*))?$/i);
    if (m) {
      const arg = (m[1] || '').trim();
      const u = arg.match(/https?:\/\/[^\s"']+/);
      return { cmd: 'connect', url: u ? u[0] : null, raw: arg };
    }
    if (/^\/tools\s*$/i.test(t)) return { cmd: 'tools' };
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\S*$/i.test(t)) return { cmd: 'connect', url: t, raw: t };
    return null;
  }

  function parseFunctionCalls(text) {
    const out = [];
    const blockRe = /<function_calls>([\s\S]*?)<\/function_calls>/g;
    let b;
    while ((b = blockRe.exec(text || ''))) {
      const invRe = /<invoke\s+name="([^"]+)"(?:\s+call_id="([^"]*)")?\s*>([\s\S]*?)<\/invoke>/g;
      let i;
      while ((i = invRe.exec(b[1]))) {
        const rawParams = {};
        const pRe = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g;
        let p;
        while ((p = pRe.exec(i[3]))) rawParams[p[1]] = p[2].replace(/^\n|\n$/g, '');
        out.push({ name: i[1], callId: i[2] || '1', rawParams, block: b[0] });
      }
    }
    return out;
  }

  function coerceArgs(rawParams, schema) {
    const props = (schema && schema.properties) || {};
    const args = {};
    for (const [k, v] of Object.entries(rawParams)) {
      const t = props[k] && props[k].type;
      if (t && t !== 'string') { try { args[k] = JSON.parse(v); continue; } catch { /* keep string */ } }
      args[k] = v;
    }
    return args;
  }

  function buildPrompt(tools) {
    if (!tools.length) return '';
    let s = '[MCP TOOLS]\n' +
      '⚠️ CRITICAL FORMATTING RULE ⚠️\n' +
      'Every tool call MUST be wrapped in a ```xml code fence - no exceptions, ever.\n' +
      'If you output <function_calls> as plain text WITHOUT the ```xml fence around it, ' +
      'the page will corrupt and swallow your tags, and the call will silently fail and be lost. ' +
      'This has happened before - do not repeat this mistake.\n\n' +
      'Correct format (copy this structure exactly, starting with ```xml on its own line and ending with ``` on its own line):\n\n' +
      '```xml\n<function_calls>\n<invoke name="TOOL_NAME" call_id="1">\n<parameter name="PARAM_NAME">VALUE</parameter>\n</invoke>\n</function_calls>\n```\n\n' +
      'Checklist before you answer:\n' +
      '1. Did I start with ```xml on its own line? \n' +
      '2. Did I end with ``` on its own line?\n' +
      '3. Is <function_calls> only INSIDE that fence, never outside it?\n\n' +
      'Objects/arrays must be valid JSON. The result will come back in my next message as <function_results>.\n\n' +
      'Available tools:\n';
    for (const t of tools) {
      s += '\n- ' + t.name + (t.description ? ': ' + String(t.description).split('\n')[0] : '') + '\n';
      const props = (t.inputSchema && t.inputSchema.properties) || {};
      const req = (t.inputSchema && t.inputSchema.required) || [];
      for (const [k, v] of Object.entries(props)) {
        s += '    * ' + k + ' (' + (v.type || 'any') + (req.includes(k) ? ', required' : '') + ')' + (v.description ? ' - ' + v.description : '') + '\n';
      }
    }
    return s;
  }

  function formatResult(callId, name, text, isError) {
    return '<function_results>\n<result call_id="' + callId + '" name="' + name + '"' + (isError ? ' error="true"' : '') + '>\n' + text + '\n</result>\n</function_results>';
  }

  const api = { parseCommand, parseFunctionCalls, coerceArgs, buildPrompt, formatResult };
  if (typeof module !== 'undefined') module.exports = api;
  return api;
})();