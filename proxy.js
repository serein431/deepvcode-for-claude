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
const DEEPVCODE_BASE = 'https://api-code.deepvlab.ai';
const DEEPVCODE_URL_STREAM = `${DEEPVCODE_BASE}/v1/chat/stream`;
const DEEPVCODE_URL_SYNC   = `${DEEPVCODE_BASE}/v1/chat/messages`;

// 调试模式：PROXY_DEBUG=1 node proxy.js
const DEBUG = process.env.PROXY_DEBUG === '1';
const dbg = (...a) => DEBUG && console.log('[proxy:debug]', ...a);

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

// ── 工具参数重映射 (参考 Antigravity-Manager) ─────────────────────────────────────
// Gemini 有时会使用错误的参数名，需要重映射到 Claude 期望的格式
function remapFunctionCallArgs(name, args) {
  if (!args || typeof args !== 'object') return args;
  
  const lowerName = name.toLowerCase();
  
  // Grep/Glob/Search 工具的参数修正
  if (['grep', 'search', 'search_code_definitions', 'search_code_snippets', 'glob'].includes(lowerName)) {
    // description → pattern (Gemini 幻觉)
    if (args.description && !args.pattern) {
      args.pattern = args.description;
      delete args.description;
    }
    
    // query → pattern
    if (args.query && !args.pattern) {
      args.pattern = args.query;
      delete args.query;
    }
    
    // paths (数组) → path (字符串) - Claude Code 使用单一路径
    if (!args.path && args.paths) {
      if (Array.isArray(args.paths) && args.paths.length > 0) {
        args.path = args.paths[0];
      } else if (typeof args.paths === 'string') {
        args.path = args.paths;
      }
      delete args.paths;
    }
    
    // 默认路径
    if (!args.path) {
      args.path = '.';
    }
  }
  
  // Read 工具：path → file_path
  if (lowerName === 'read') {
    if (args.path && !args.file_path) {
      args.file_path = args.path;
      delete args.path;
    }
  }
  
  // LS 工具：确保有 path
  if (lowerName === 'ls' && !args.path) {
    args.path = '.';
  }
  
  return args;
}

// 工具名标准化
function normalizeToolName(name) {
  const lowerName = name.toLowerCase();
  // search → Grep (已知幻觉)
  if (lowerName === 'search') {
    return 'Grep';
  }
  return name;
}

// ── MCP 工具名模糊匹配 (参考 Antigravity-Manager) ─────────────────────────────────
// Gemini 经常幻觉出错误的 MCP 工具名，例如:
//   "mcp__puppeteer_navigate" → 应为 "mcp__puppeteer__puppeteer_navigate"
// 策略:
//   1. 精确后缀匹配: 如果幻觉名的后缀与注册工具的后缀完全匹配
//   2. 包含匹配: 如果幻觉名（不含 mcp__）被包含在注册工具名中
//   3. 最长公共子序列评分: 选择 LCS 比率最高的注册工具
function fuzzyMatchMcpTool(hallucinated, registered) {
  const mcpTools = registered.filter(n => n.startsWith('mcp__'));
  if (mcpTools.length === 0) return null;
  
  // 如果幻觉名不在 mcp__ 开头，直接返回
  if (!hallucinated.startsWith('mcp__')) return null;
  
  const hallucinatedSuffix = hallucinated.slice(5); // 去掉 "mcp__"
  
  // 策略 1: 精确后缀匹配
  for (const tool of mcpTools) {
    const parts = tool.split('__');
    if (parts.length >= 3) {
      const suffix = parts.slice(2).join('__'); // 工具名部分
      if (suffix === hallucinatedSuffix || tool.endsWith('__' + hallucinatedSuffix)) {
        return tool;
      }
    }
  }
  
  // 策略 2: 包含匹配
  for (const tool of mcpTools) {
    if (tool.includes(hallucinatedSuffix)) {
      return tool;
    }
  }
  
  // 策略 3: 最长公共子序列
  let bestMatch = null;
  let bestScore = 0;
  for (const tool of mcpTools) {
    const score = lcsRatio(hallucinated, tool);
    if (score > bestScore && score > 0.5) {
      bestScore = score;
      bestMatch = tool;
    }
  }
  
  return bestMatch;
}

// 计算最长公共子序列比率
function lcsRatio(a, b) {
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  
  // 简化的 LCS 计算
  const dp = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  const lcs = dp[m][n];
  return (2 * lcs) / (m + n);
}

// 使用注册工具名进行模糊匹配
let registeredToolNames = [];
function setRegisteredToolNames(tools) {
  registeredToolNames = tools ? tools.map(t => t.name).filter(Boolean) : [];
}

function tryFuzzyMatchTool(name) {
  if (name.startsWith('mcp__') && registeredToolNames.length > 0) {
    if (!registeredToolNames.includes(name)) {
      const matched = fuzzyMatchMcpTool(name, registeredToolNames);
      if (matched) {
        dbg(`[MCP-Fuzzy] Corrected: '${name}' → '${matched}'`);
        return matched;
      }
    }
  }
  return name;
}

function cleanSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (['$schema', '$id', 'title', 'examples', 'default', 'definitions', '$defs'].includes(k)) continue;
    if (k === 'type') {
      const t = Array.isArray(v) ? (v.find(x => x !== 'null') || 'string') : v;
      // GenAI 格式用小写类型名，不转大写
      out.type = t;
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

// 构建 tool_use_id → tool_name 映射，用于正确填写 functionResponse.name
function buildToolIdMap(messages) {
  const map = {};
  for (const m of messages || []) {
    const content = Array.isArray(m.content) ? m.content : [];
    for (const b of content) {
      if (b.type === 'tool_use' && b.id && b.name) {
        map[b.id] = b.name;
      }
    }
  }
  return map;
}

function contentToParts(content, toolIdMap = {}) {
  if (typeof content === 'string') {
    // 清理文本中的 XML 标签块
    const cleanText = content
      .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
      .replace(/<function_results>[\s\S]*?<\/function_results>/g, '')
      .trim();
    return cleanText ? [{ text: cleanText }] : [];
  }
  return (content || []).flatMap(b => {
    if (b.type === 'text') {
      // 清理文本中的 XML 标签块
      const cleanText = (b.text || '')
        .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
        .replace(/<function_results>[\s\S]*?<\/function_results>/g, '')
        .trim();
      return cleanText ? [{ text: cleanText }] : [];
    }
    if (b.type === 'tool_use') {
      let toolName = normalizeToolName(b.name);
      toolName = tryFuzzyMatchTool(toolName);
      const remappedInput = remapFunctionCallArgs(toolName, { ...(b.input || {}) });
      // 保留原始 id，后端需要用它来还原 tool_call_id
      return [{ functionCall: { id: b.id, name: toolName, args: remappedInput } }];
    }
    if (b.type === 'tool_result') {
      let txt = Array.isArray(b.content)
        ? b.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
        : (b.content || '');
      // 空结果注入确认信号（防止模型幻觉）
      if (!txt || txt.trim() === '') {
        txt = b.is_error ? 'Tool execution failed with no output.' : 'Command executed successfully.';
      }
      // 必须用工具名（非 id）匹配对应的 functionCall.name
      const toolName = toolIdMap[b.tool_use_id] || b.tool_use_id;
      // 关键：保留原始 id（即 Moonshot/OpenAI tool_call_id），后端凭此还原 tool_call_id
      return [{ functionResponse: { id: b.tool_use_id, name: toolName, response: { output: txt } } }];
    }
    if (b.type === 'image' && b.source?.type === 'base64')
      return [{ inlineData: { mimeType: b.source.media_type, data: b.source.data } }];
    return [];
  });
}

function toGenAI(body, isStream = false) {
  // 模型名映射：DeepVCode 服务端统一用 'auto' 决定实际模型（见 models.ts）
  // 对已知 DeepVCode 原生模型名直接透传；所有 claude-* 未知名 fallback 到 'auto'
  const MODEL_MAP = {
    'claude-haiku-4-5-20251001': 'claude-haiku-4-5@20251001',
    'claude-haiku-4-5':          'claude-haiku-4-5@20251001',
  };
  const rawModel = body.model || '';
  let mappedModel = MODEL_MAP[rawModel];
  if (!mappedModel) {
    if (rawModel.startsWith('claude-opus')) {
      // 所有 claude-opus* 走最新的 opus 4.6
      mappedModel = 'claude-opus-4-6';
    } else if (rawModel.startsWith('claude-sonnet')) {
      // 所有 claude-sonnet* 走最新的 sonnet 4.6
      mappedModel = 'claude-sonnet-4-6';
    } else if (rawModel.startsWith('claude-')) {
      // 其他未特别指定的 claude-* 默认走 sonnet 4.6
      mappedModel = 'claude-sonnet-4-6';
    } else {
      mappedModel = rawModel || 'auto';
    }
  }

  // 设置注册工具名列表（用于 MCP 工具名模糊匹配）
  setRegisteredToolNames(body.tools);

  // ── systemInstruction：放入 config，而不是注入为伪对话轮次 ──
  // 官方 DeepVServerAdapter 的做法：config.systemInstruction
  let systemInstruction;
  if (body.system) {
    const txt = Array.isArray(body.system)
      ? body.system.map(b => b.text || '').join('\n')
      : String(body.system);
    if (txt.trim()) {
      systemInstruction = { parts: [{ text: txt }] };
    }
  }

  const contents = [];
  const toolIdMap = buildToolIdMap(body.messages);

  for (const m of body.messages || []) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = contentToParts(m.content, toolIdMap);
    dbg(`message role=${m.role} → GenAI role=${role}, parts:`, JSON.stringify(parts).slice(0, 500));
    if (!parts.length) continue;
    if (contents.length && contents[contents.length - 1].role === role)
      contents[contents.length - 1].parts.push(...parts);
    else
      contents.push({ role, parts });
  }

  if (contents.length && contents[0].role !== 'user')
    contents.unshift({ role: 'user', parts: [{ text: '.' }] });

  // ── tools：放入 config.tools，而不是顶层 ──
  // 官方 DeepVServerAdapter 的做法：config: { ...request.config } 其中包含 tools
  const tools = body.tools?.length
    ? [{ functionDeclarations: body.tools.map(t => ({
        name: t.name,
        description: t.description || '',
        ...(t.input_schema ? { parameters: cleanSchema(t.input_schema) } : {})
      })) }]
    : undefined;

  return {
    model: mappedModel,
    contents,
    config: {
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(tools ? { tools } : {}),
      ...(body.max_tokens ? { maxOutputTokens: body.max_tokens } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
      ...(body.stop_sequences?.length ? { stopSequences: body.stop_sequences } : {}),
      // 流式请求需显式告知后端启用 SSE 输出
      ...(isStream ? { stream: true } : {}),
    }
  };
}

// ── 格式转换：GenAI → Anthropic ───────────────────────────────────────────────

let _n = 0;
const uid = () => Date.now().toString(36) + (++_n).toString(36).padStart(4, '0');
const FINISH_MAP = { STOP: 'end_turn', MAX_TOKENS: 'max_tokens', TOOL_CALL: 'tool_use', FUNCTION_CALL: 'tool_use' };
const toStop = r => FINISH_MAP[r] || 'end_turn';

// 解析 XML 格式的工具调用: <function_calls><invoke name="X"><parameter name="Y">val</parameter></invoke></function_calls>
function parseXMLToolCalls(text) {
  const results = [];
  // 匹配 <invoke name="...">...</invoke>
  const invokeRegex = /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/g;
  let match;
  while ((match = invokeRegex.exec(text)) !== null) {
    const name = match[1];
    const body = match[2];
    const input = {};
    // 匹配 <parameter name="...">val</parameter>
    const paramRegex = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/g;
    let pMatch;
    while ((pMatch = paramRegex.exec(body)) !== null) {
      let val = pMatch[2].trim();
      // 尝试解析 JSON 值
      try { val = JSON.parse(val); } catch { }
      input[pMatch[1]] = val;
    }
    results.push({ type: 'tool_use', id: 'toolu_' + uid(), name, input });
  }
  return results;
}

// 从文本中提取并移除 XML 工具调用，返回 {text, toolCalls}
function extractXMLToolCalls(text) {
  const toolCalls = parseXMLToolCalls(text);
  // 移除所有 XML 标签块：<function_calls>...</function_calls> 和 <function_results>...</function_results>
  let cleanText = text
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
    .replace(/<function_results>[\s\S]*?<\/function_results>/g, '')
    .trim();
  return { text: cleanText, toolCalls };
}

function genAIToAnthropic(data, model) {
  const parts = data.candidates?.[0]?.content?.parts || [];
  const content = [];
  let hasToolCalls = false;

  for (const p of parts) {
    if (p.text) {
      // 检查是否包含 XML 格式的工具调用
      const { text: cleanText, toolCalls } = extractXMLToolCalls(p.text);
      if (toolCalls.length > 0) {
        hasToolCalls = true;
        if (cleanText) content.push({ type: 'text', text: cleanText });
        // 对 XML 解析出的工具调用也进行参数重映射
        for (const tc of toolCalls) {
          tc.name = normalizeToolName(tc.name);
          tc.name = tryFuzzyMatchTool(tc.name);
          tc.input = remapFunctionCallArgs(tc.name, tc.input || {});
          content.push(tc);
        }
      } else {
        content.push({ type: 'text', text: p.text });
      }
    }
    if (p.functionCall) {
      hasToolCalls = true;
      let toolName = normalizeToolName(p.functionCall.name);
      toolName = tryFuzzyMatchTool(toolName);
      const toolInput = remapFunctionCallArgs(toolName, { ...(p.functionCall.args || {}) });
      // 关键：优先保留后端返回的原始 id（即 Moonshot tool_call_id），而不是生成新的 toolu_xxx
      const toolId = p.functionCall.id || ('toolu_' + uid());
      content.push({ type: 'tool_use', id: toolId, name: toolName, input: toolInput });
    }
  }

  if (!content.length) content.push({ type: 'text', text: '' });
  const u = data.usageMetadata || {};
  const finishReason = data.candidates?.[0]?.finishReason;
  return {
    id: 'msg_' + uid(), type: 'message', role: 'assistant', content,
    model: model || 'auto',
    stop_reason: hasToolCalls ? 'tool_use' : toStop(finishReason),
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

  // 收集完整响应后统一处理（后端返回普通 JSON 或 Anthropic JSON）
  let buf = '';
  res.on('data', chunk => { buf += chunk.toString('utf8'); });

  res.on('end', () => {
    dbg('backend raw (first 800):', buf.slice(0, 800));
    try {
      let d;
      try { d = JSON.parse(buf); } catch { d = null; }

      if (!d) {
        // 尝试解析 SSE 格式：累积合并所有 data: 行中的 candidates
        // 注意：不能只取最后一行 —— 工具调用通常在中间的事件里，最后一条往往是 usageMetadata
        const lines = buf.split('\n').filter(l => l.startsWith('data:') && !l.includes('[DONE]'));
        if (lines.length) {
          const acc = {
            candidates: [{ content: { role: 'model', parts: [] }, finishReason: null }],
            usageMetadata: {}
          };
          let hasGenAI = false;
          for (const line of lines) {
            try {
              const chunk = JSON.parse(line.slice(5).trim());
              if (chunk.candidates?.[0]?.content?.parts?.length > 0) {
                acc.candidates[0].content.parts.push(...chunk.candidates[0].content.parts);
                hasGenAI = true;
              }
              if (chunk.candidates?.[0]?.finishReason) {
                acc.candidates[0].finishReason = chunk.candidates[0].finishReason;
              }
              if (chunk.usageMetadata) {
                acc.usageMetadata = chunk.usageMetadata;
              }
            } catch {}
          }
          if (hasGenAI) {
            d = acc;
          } else {
            // 没有 GenAI candidates，尝试最后一行（可能是 Anthropic/OpenAI 格式）
            try { d = JSON.parse(lines[lines.length - 1].slice(5).trim()); } catch {}
          }
        }
      }

      dbg('parsed format:', d ? (d.candidates ? 'GenAI' : d.type === 'message' ? 'Anthropic' : 'unknown') : 'null');

      send({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });

      if (d && d.candidates) {
        // ── GenAI 格式（含 XML 工具调用解析）──
        const usage = d.usageMetadata || {};
        const cand = d.candidates[0];
        const parts = cand?.content?.parts || [];
        let idx = 0;
        let hasToolCalls = false;

        // 先收集所有内容，解析 XML 工具调用
        const allContent = [];
        for (const p of parts) {
          if (p.text !== undefined) {
            // 后端流式响应的文本块：不做 trim，完整保留换行和空格
            // 只在确实含有 XML 工具调用时才做特殊处理
            if (p.text.includes('<function_calls>')) {
              const toolCalls = parseXMLToolCalls(p.text);
              const textPart = p.text
                .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
                .replace(/<function_results>[\s\S]*?<\/function_results>/g, '');
              if (textPart) allContent.push({ type: 'text', text: textPart });
              if (toolCalls.length) {
                hasToolCalls = true;
                for (const tc of toolCalls) {
                  tc.name = normalizeToolName(tc.name);
                  tc.name = tryFuzzyMatchTool(tc.name);
                  tc.input = remapFunctionCallArgs(tc.name, tc.input || {});
                  allContent.push(tc);
                }
              }
            } else if (p.text) {
              // 普通文本：原样推入，"\n"、" " 等空白字符都保留
              allContent.push({ type: 'text', text: p.text });
            }
          } else if (p.functionCall) {
            hasToolCalls = true;
            let toolName = normalizeToolName(p.functionCall.name);
            toolName = tryFuzzyMatchTool(toolName);
            const toolInput = remapFunctionCallArgs(toolName, { ...(p.functionCall.args || {}) });
            // 关键：保留原始 functionCall.id（即 Moonshot tool_call_id）
            const toolId = p.functionCall.id || ('toolu_' + uid());
            allContent.push({ type: 'tool_use', id: toolId, name: toolName, input: toolInput });
          }
        }

        // 合并连续的文本块（后端流式返回会产生大量细碎文本块，需要合并成一个 content_block）
        const merged = [];
        for (const block of allContent) {
          if (block.type === 'text' && merged.length > 0 && merged[merged.length - 1].type === 'text') {
            merged[merged.length - 1].text += block.text;
          } else {
            merged.push({ ...block });
          }
        }

        // 发送 SSE 事件
        for (const block of merged) {
          if (block.type === 'text') {
            send({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
            send({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: block.text } });
            send({ type: 'content_block_stop', index: idx });
            idx++;
          } else if (block.type === 'tool_use') {
            send({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
            send({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } });
            send({ type: 'content_block_stop', index: idx });
            idx++;
          }
        }

        const stopReason = hasToolCalls ? 'tool_use' : toStop(cand?.finishReason);
        send({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.candidatesTokenCount || 0 } });

      } else if (d && d.type === 'message' && Array.isArray(d.content)) {
        // ── Anthropic 格式（后端已转好，直接透传 SSE 事件）──
        const stopReason = d.stop_reason || 'end_turn';
        const usage = d.usage || {};
        let idx = 0;

        for (const block of d.content) {
          if (block.type === 'text') {
            send({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
            send({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: block.text } });
            send({ type: 'content_block_stop', index: idx });
            idx++;
          } else if (block.type === 'tool_use') {
            send({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
            send({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } });
            send({ type: 'content_block_stop', index: idx });
            idx++;
          }
        }

        send({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens || 0 } });

      } else if (d && d.choices) {
        // ── OpenAI/DeepSeek 兼容格式 ──
        const choice = d.choices[0];
        const text = choice?.message?.content || '';
        const stopReason = choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
        let idx = 0;

        if (text) {
          send({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
          send({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text } });
          send({ type: 'content_block_stop', index: idx });
          idx++;
        }

        for (const tc of choice?.message?.tool_calls || []) {
          const args = typeof tc.function?.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments || {});
          send({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tc.id || ('toolu_' + uid()), name: tc.function?.name || '', input: {} } });
          send({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: args } });
          send({ type: 'content_block_stop', index: idx });
          idx++;
        }

        send({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: d.usage?.completion_tokens || 0 } });

      } else {
        console.error('[proxy] 未知后端响应格式，开启 PROXY_DEBUG=1 查看原始响应');
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

  // 打印原始请求的消息结构（用于调试 tool_result 问题）
  if (anthropicBody.messages) {
    dbg('原始 Anthropic 消息数量:', anthropicBody.messages.length);
    anthropicBody.messages.forEach((m, i) => {
      const contentTypes = Array.isArray(m.content) ? m.content.map(c => c.type).join(',') : 'text';
      dbg(`  msg[${i}] role=${m.role}, content types: ${contentTypes}`);
    });
  }

  const genAIBody = toGenAI(anthropicBody, isStream);
  const bodyStr = JSON.stringify(genAIBody);

  dbg('→ GenAI request (first 1000):', bodyStr.slice(0, 1000));

  // 流式请求发到 /v1/chat/stream（SSE 端点），非流式发到 /v1/chat/messages
  const backendUrl = isStream ? DEEPVCODE_URL_STREAM : DEEPVCODE_URL_SYNC;
  const url = new URL(backendUrl);
  const options = {
    hostname: url.hostname,
    port: 443,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'User-Agent': 'DeepVCode/CLI/proxy (darwin; arm64)',
      'X-Client-Version': 'proxy',
      ...(isStream ? { 'Accept': 'text/event-stream' } : {}),
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
        dbg('backend raw (non-stream, first 800):', body.slice(0, 800));
        try {
          const d = JSON.parse(body);
          let anthropic;
          if (d.candidates) {
            // GenAI 格式
            anthropic = genAIToAnthropic(d, model);
          } else if (d.type === 'message' && Array.isArray(d.content)) {
            // 已是 Anthropic 格式，直接透传
            anthropic = d;
          } else if (d.choices) {
            // OpenAI/DeepSeek 格式
            const choice = d.choices[0];
            const content = [];
            if (choice?.message?.content) content.push({ type: 'text', text: choice.message.content });
            for (const tc of choice?.message?.tool_calls || []) {
              content.push({ type: 'tool_use', id: tc.id || ('toolu_' + uid()), name: tc.function?.name || '', input: JSON.parse(tc.function?.arguments || '{}') });
            }
            anthropic = { id: 'msg_' + uid(), type: 'message', role: 'assistant', content, model, stop_reason: choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: d.usage?.prompt_tokens || 0, output_tokens: d.usage?.completion_tokens || 0 } };
          } else {
            console.error('[proxy] 未知后端响应格式，开启 PROXY_DEBUG=1 查看原始响应');
            throw new Error('未知后端响应格式');
          }
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
  console.log(`[DeepVCode Proxy] 流式转发 → ${DEEPVCODE_URL_STREAM}`);
  console.log(`[DeepVCode Proxy] 同步转发 → ${DEEPVCODE_URL_SYNC}`);
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
