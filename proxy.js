#!/usr/bin/env node
/**
 * DeepVCode → Claude Code 反向代理
 * 将 Claude Code 的 Anthropic 格式请求转换为 GenAI 格式，转发给 DeepVCode 后端
 *
 * 用法：node proxy.js [port]
 * 默认端口：3456
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.argv[2] || process.env.PORT || '3456');
const DEEPVCODE_URL = 'https://api-code.deepvlab.ai/v1/chat/messages';

// ── Token ─────────────────────────────────────────────────────────────────────

function getToken() {
  const f = path.join(os.homedir(), '.deepv', 'jwt-token.json');
  if (!fs.existsSync(f)) throw new Error('未找到 ~/.deepv/jwt-token.json，请先在 VSCode 中安装并登录 DeepVCode 插件');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!d.accessToken) throw new Error('token 文件无效，请重新登录 DeepVCode');
  if (d.expiresAt && Date.now() >= d.expiresAt) throw new Error('token 已过期，请在 DeepVCode 中重新登录');
  return d.accessToken;
}

// ── 格式转换：Anthropic → GenAI ───────────────────────────────────────────────

function cleanSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (['$schema', '$id', 'title', 'examples', 'default', 'definitions', '$defs'].includes(k)) continue;
    if (k === 'type') {
      const t = Array.isArray(v) ? (v.find(x => x !== 'null') || 'string') : v;
      out.type = t.toUpperCase();
    } else if (k === 'properties') {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, cleanSchema(pv)]));
    } else if (k === 'items') {
      out.items = cleanSchema(v);
    } else if (k === 'anyOf' || k === 'oneOf') {
      const nn = v.find(x => x.type !== 'null');
      if (nn) Object.assign(out, cleanSchema(nn));
    } else {
      out[k] = v;
    }
  }
  return out;
}

function contentToParts(content) {
  if (typeof content === 'string') return content.trim() ? [{ text: content }] : [];
  return (content || []).flatMap(b => {
    if (b.type === 'text') return b.text?.trim() ? [{ text: b.text }] : [];
    if (b.type === 'tool_use') return [{ functionCall: { name: b.name, args: b.input || {} } }];
    if (b.type === 'tool_result') {
      const txt = Array.isArray(b.content)
        ? b.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
        : (b.content || '');
      return [{ functionResponse: { name: b.tool_use_id, response: { output: txt } } }];
    }
    if (b.type === 'image' && b.source?.type === 'base64')
      return [{ inlineData: { mimeType: b.source.media_type, data: b.source.data } }];
    return [];
  });
}

function toGenAI(body) {
  const contents = [];

  if (body.system) {
    const txt = Array.isArray(body.system)
      ? body.system.map(b => b.text || '').join('\n')
      : String(body.system);
    if (txt.trim()) {
      contents.push({ role: 'user', parts: [{ text: txt }] });
      contents.push({ role: 'model', parts: [{ text: 'Understood.' }] });
    }
  }

  for (const m of body.messages || []) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = contentToParts(m.content);
    if (!parts.length) continue;
    if (contents.length && contents[contents.length - 1].role === role)
      contents[contents.length - 1].parts.push(...parts);
    else
      contents.push({ role, parts });
  }

  if (contents.length && contents[0].role !== 'user')
    contents.unshift({ role: 'user', parts: [{ text: '.' }] });

  const tools = body.tools?.length
    ? [{ functionDeclarations: body.tools.map(t => ({
        name: t.name,
        description: t.description || '',
        ...(t.input_schema ? { parameters: cleanSchema(t.input_schema) } : {})
      })) }]
    : undefined;

  return {
    model: body.model || 'auto',
    contents,
    ...(tools ? { tools } : {}),
    config: {
      ...(body.max_tokens ? { maxOutputTokens: body.max_tokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
      ...(body.stop_sequences?.length ? { stopSequences: body.stop_sequences } : {}),
    }
  };
}

// ── 格式转换：GenAI → Anthropic ───────────────────────────────────────────────

let _n = 0;
const uid = () => Date.now().toString(36) + (++_n).toString(36).padStart(4, '0');
const FINISH_MAP = { STOP: 'end_turn', MAX_TOKENS: 'max_tokens', TOOL_CALL: 'tool_use', FUNCTION_CALL: 'tool_use' };
const toStop = r => FINISH_MAP[r] || 'end_turn';

function genAIToAnthropic(data, model) {
  const parts = data.candidates?.[0]?.content?.parts || [];
  const content = parts.flatMap(p => {
    if (p.text) return [{ type: 'text', text: p.text }];
    if (p.functionCall) return [{ type: 'tool_use', id: 'toolu_' + uid(), name: p.functionCall.name, input: p.functionCall.args || {} }];
    return [];
  });
  if (!content.length) content.push({ type: 'text', text: '' });
  const u = data.usageMetadata || {};
  return {
    id: 'msg_' + uid(), type: 'message', role: 'assistant', content,
    model: model || 'auto',
    stop_reason: toStop(data.candidates?.[0]?.finishReason),
    stop_sequence: null,
    usage: { input_tokens: u.promptTokenCount || 0, output_tokens: u.candidatesTokenCount || 0 }
  };
}

// ── 流式转换 ───────────────────────────────────────────────────────────────────

function streamTransform(res, model, clientRes) {
  clientRes.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const msgId = 'msg_' + uid();
  const send = obj => clientRes.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);

  // DeepVCode 返回普通 JSON（非 SSE），收集完整响应后再转换
  let buf = '';
  res.on('data', chunk => { buf += chunk.toString('utf8'); });

  res.on('end', () => {
    try {
      let d;
      try { d = JSON.parse(buf); } catch { d = null; }

      send({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });

      if (d && d.candidates) {
        const usage = d.usageMetadata || {};
        const cand = d.candidates[0];
        const stopReason = toStop(cand?.finishReason);
        let textIdx = -1, toolCount = 0;

        for (const p of cand?.content?.parts || []) {
          if (p.text !== undefined) {
            if (textIdx < 0) {
              textIdx = 0;
              send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            }
            send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p.text } });
          } else if (p.functionCall) {
            const idx = (textIdx >= 0 ? 1 : 0) + toolCount++;
            const id = 'toolu_' + uid();
            send({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id, name: p.functionCall.name, input: {} } });
            send({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(p.functionCall.args || {}) } });
            send({ type: 'content_block_stop', index: idx });
          }
        }

        if (textIdx >= 0) send({ type: 'content_block_stop', index: 0 });
        send({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.candidatesTokenCount || 0 } });
      } else {
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send({ type: 'content_block_stop', index: 0 });
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } });
      }

      send({ type: 'message_stop' });
    } catch (err) {
      console.error('[proxy] stream parse error:', err.message);
    }
    clientRes.end();
  });

  res.on('error', err => {
    console.error('[proxy] stream error:', err.message);
    clientRes.end();
  });
}

// ── 代理请求 ───────────────────────────────────────────────────────────────────

function proxyRequest(anthropicBody, clientRes) {
  let token;
  try { token = getToken(); } catch (e) {
    clientRes.writeHead(401, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: { type: 'authentication_error', message: e.message } }));
    return;
  }

  const isStream = !!anthropicBody.stream;
  const model = anthropicBody.model || 'auto';
  const genAIBody = toGenAI(anthropicBody);
  const bodyStr = JSON.stringify(genAIBody);

  const url = new URL(DEEPVCODE_URL);
  const options = {
    hostname: url.hostname,
    port: 443,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'User-Agent': 'DeepVCode-Proxy/1.0',
    }
  };

  const req = https.request(options, res => {
    if (res.statusCode !== 200) {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        console.error(`[proxy] DeepVCode error ${res.statusCode}:`, body.slice(0, 300));
        clientRes.writeHead(res.statusCode, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: { type: 'api_error', message: `DeepVCode ${res.statusCode}: ${body}` } }));
      });
      return;
    }

    if (isStream) {
      streamTransform(res, model, clientRes);
    } else {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const anthropic = genAIToAnthropic(JSON.parse(body), model);
          clientRes.writeHead(200, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify(anthropic));
        } catch (e) {
          clientRes.writeHead(500, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({ error: { type: 'api_error', message: e.message } }));
        }
      });
    }
  });

  req.on('error', e => {
    console.error('[proxy] request error:', e.message);
    clientRes.writeHead(500, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: { type: 'api_error', message: e.message } }));
  });

  req.write(bodyStr);
  req.end();
}

// ── HTTP 服务器 ────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method === 'POST' && (req.url === '/v1/messages' || req.url?.startsWith('/v1/messages?'))) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        proxyRequest(JSON.parse(body), res);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: e.message } }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[DeepVCode Proxy] 运行中 → http://127.0.0.1:${PORT}`);
  console.log(`[DeepVCode Proxy] 转发至 → ${DEEPVCODE_URL}`);
  try {
    const exp = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.deepv', 'jwt-token.json'), 'utf8')).expiresAt;
    const days = exp ? Math.floor((exp - Date.now()) / 86400000) : '?';
    console.log(`[DeepVCode Proxy] Token 有效，剩余 ${days} 天`);
  } catch (e) {
    console.warn(`[DeepVCode Proxy] ⚠ ${e.message}`);
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[DeepVCode Proxy] 端口 ${PORT} 已被占用，尝试其他端口：node proxy.js 3457`);
  } else {
    console.error('[DeepVCode Proxy] 启动失败:', e.message);
  }
  process.exit(1);
});
