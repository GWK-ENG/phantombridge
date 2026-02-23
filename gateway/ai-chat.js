/**
 * PhantomBridge - AI 聊天服务
 * 
 * 通过 Ollama (或 OpenAI 兼容 API) 提供 AI 聊天能力。
 * AI 具有浏览器控制工具调用能力。
 */

const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.PHANTOM_AI_MODEL || 'deepseek-r1:8b';

const SYSTEM_PROMPT = `你是浏览器控制助手。你已经能看到当前页面内容。用中文回复。

调用工具时，输出以下格式（可多次）：
\`\`\`tool
{"action": "navigate", "url": "https://baidu.com"}
\`\`\`

可用 action：navigate, get_markdown, get_interactive_elements, cdp_click(x,y), cdp_type(text), evaluate_js(code), get_tab_info, take_screenshot, get_console_logs, get_network_logs, list_tabs, switch_tab(tabId), create_tab(url), close_tab(tabId)

示例1 - 用户说"打开百度"：
\`\`\`tool
{"action": "navigate", "url": "https://www.baidu.com"}
\`\`\`
正在为你打开百度。

示例2 - 用户说"点击搜索按钮"，页面元素有 [5] <button> "百度一下" @ (600,350)：
\`\`\`tool
{"action": "cdp_click", "x": 600, "y": 350}
\`\`\`
已点击"百度一下"按钮。

示例3 - 用户说"在搜索框输入天气"：
\`\`\`tool
{"action": "cdp_click", "x": 400, "y": 200}
\`\`\`
\`\`\`tool
{"action": "cdp_type", "text": "天气"}
\`\`\`
已在搜索框中输入"天气"。

规则：
1. 需要操作时必须输出 \`\`\`tool JSON\`\`\` 格式
2. 点击前用页面上下文中的坐标，不要编造坐标
3. 不要说"我看不到/无法访问"，你已拿到页面上下文
4. 直接回应用户请求，禁止寒暄模板
`;


class AiChat {
    constructor() {
        this.conversations = new Map(); // conversationId -> messages[]
        this.model = DEFAULT_MODEL;
    }

    /**
     * 发送聊天消息（非流式）
     */
    async chat(conversationId, userMessage, onToolCall = null) {
        // 获取或创建对话历史
        if (!this.conversations.has(conversationId)) {
            this.conversations.set(conversationId, []);
        }
        const history = this.conversations.get(conversationId);

        // 添加用户消息
        history.push({ role: 'user', content: userMessage });

        // 构建请求
        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...history.slice(-20), // 保留最近 20 条消息
        ];

        try {
            const response = await this._callOllama(messages);

            // 解析工具调用
            const { text, toolCalls } = this._parseToolCalls(response);

            // 执行工具调用
            let finalText = text;
            if (toolCalls.length > 0 && onToolCall) {
                const toolResults = [];
                for (const tool of toolCalls) {
                    try {
                        const result = await onToolCall(tool);
                        toolResults.push({ tool, result, error: null });
                    } catch (err) {
                        toolResults.push({ tool, result: null, error: err.message });
                    }
                }

                // 将工具结果反馈给 AI
                const toolSummary = toolResults.map((r) => {
                    if (r.error) {
                        return `工具 ${r.tool.action} 执行失败: ${r.error}`;
                    }
                    return `工具 ${r.tool.action} 执行成功: ${JSON.stringify(r.result).slice(0, 500)}`;
                }).join('\n');

                history.push({ role: 'assistant', content: response });
                history.push({ role: 'user', content: `[工具执行结果]\n${toolSummary}\n\n请根据以上结果回复用户。` });

                const followUp = await this._callOllama([
                    { role: 'system', content: SYSTEM_PROMPT },
                    ...history.slice(-20),
                ]);

                history.push({ role: 'assistant', content: followUp });

                return {
                    text: followUp,
                    toolCalls,
                    toolResults,
                };
            }

            history.push({ role: 'assistant', content: response });

            return {
                text: finalText,
                toolCalls: [],
                toolResults: [],
            };
        } catch (err) {
            return {
                text: `⚠️ AI 服务错误: ${err.message}`,
                toolCalls: [],
                toolResults: [],
                error: err.message,
            };
        }
    }

    /**
     * 流式聊天（SSE）
     */
    async chatStream(conversationId, userMessage, res) {
        if (!this.conversations.has(conversationId)) {
            this.conversations.set(conversationId, []);
        }
        const history = this.conversations.get(conversationId);
        history.push({ role: 'user', content: userMessage });

        const messages = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...history.slice(-20),
        ];

        // SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });

        try {
            const ollamaRes = await fetch(`${OLLAMA_BASE}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.model,
                    messages,
                    stream: true,
                }),
            });

            if (!ollamaRes.ok) {
                const errText = await ollamaRes.text();
                res.write(`data: ${JSON.stringify({ error: `Ollama 错误: ${errText}` })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }

            let fullResponse = '';
            const reader = ollamaRes.body;

            // Node.js Readable stream
            let buffer = '';
            reader.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const json = JSON.parse(line);
                        if (json.message?.content) {
                            fullResponse += json.message.content;
                            res.write(`data: ${JSON.stringify({
                                token: json.message.content,
                                done: false
                            })}\n\n`);
                        }
                        if (json.done) {
                            history.push({ role: 'assistant', content: fullResponse });
                            res.write(`data: ${JSON.stringify({ done: true, full: fullResponse })}\n\n`);
                            res.write('data: [DONE]\n\n');
                            res.end();
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            });

            reader.on('error', (err) => {
                res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            });

            reader.on('end', () => {
                if (!res.writableEnded) {
                    if (fullResponse) {
                        history.push({ role: 'assistant', content: fullResponse });
                    }
                    res.write(`data: ${JSON.stringify({ done: true, full: fullResponse })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                }
            });
        } catch (err) {
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    }

    /**
     * 调用 Ollama API（非流式）
     */
    async _callOllama(messages) {
        const response = await fetch(`${OLLAMA_BASE}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.model,
                messages,
                stream: false,
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Ollama API 错误 (${response.status}): ${errText}`);
        }

        const data = await response.json();
        return data.message?.content || '';
    }

    /**
     * 解析 AI 回复中的工具调用（增强版，支持多种格式）
     */
    _parseToolCalls(text) {
        const toolCalls = [];

        // 先移除 <think>...</think> 标签（DeepSeek-R1 特有）
        const cleaned = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');

        // 格式1: ```tool ... ``` 或 ```json ... ```
        const fencedRegex = /```(?:tool|json)?\s*\n?([\s\S]*?)```/gi;
        let match;
        while ((match = fencedRegex.exec(cleaned)) !== null) {
            const parsed = this._tryParseJson(match[1]);
            if (parsed && parsed.action) {
                toolCalls.push(parsed);
            }
        }

        // 格式2: 裸 JSON 行 {"action": "..."}
        if (toolCalls.length === 0) {
            const lines = cleaned.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                    const parsed = this._tryParseJson(trimmed);
                    if (parsed && parsed.action) {
                        toolCalls.push(parsed);
                    }
                }
            }
        }

        // 移除工具调用块，保留纯文本
        let cleanText = cleaned
            .replace(/```(?:tool|json)?\s*\n?[\s\S]*?```/gi, '')
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .trim();

        return { text: cleanText, toolCalls };
    }

    /**
     * 尝试解析 JSON，修复常见格式问题
     */
    _tryParseJson(raw) {
        const trimmed = String(raw || '').trim();
        if (!trimmed) return null;

        // 直接尝试
        try {
            return JSON.parse(trimmed);
        } catch { }

        // 修复尾逗号
        try {
            return JSON.parse(trimmed.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'));
        } catch { }

        // 修复单引号
        try {
            return JSON.parse(trimmed.replace(/'/g, '"'));
        } catch { }

        return null;
    }

    /**
     * 清空对话历史
     */
    clearConversation(conversationId) {
        this.conversations.delete(conversationId);
    }

    /**
     * 设置模型
     */
    setModel(model) {
        this.model = model;
    }

    /**
     * 获取可用模型列表
     */
    async listModels() {
        try {
            const response = await fetch(`${OLLAMA_BASE}/api/tags`);
            if (!response.ok) throw new Error('Ollama 不可用');
            const data = await response.json();
            return (data.models || []).map((m) => ({
                name: m.name,
                size: m.size,
                modified: m.modified_at,
            }));
        } catch (err) {
            return [];
        }
    }
}

module.exports = { AiChat };
