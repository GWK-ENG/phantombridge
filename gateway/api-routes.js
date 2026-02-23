/**
 * PhantomBridge - API 路由定义
 * 
 * 对外暴露 RESTful HTTP 接口，供 AI Agent / CLI / MCP 客户端调用。
 */

const express = require('express');
const { CliDetector } = require('./cli-detector');
const { AiChat } = require('./ai-chat');

// Ollama 本地 AI 聊天实例（免费，HTTP API 直连）
const aiChat = new AiChat();

/**
 * 创建 API 路由
 * @param {import('./session-manager').SessionManager} sessionManager
 * @returns {express.Router}
 */
function createApiRoutes(sessionManager, cliDetector) {
    const router = express.Router();

    // ========== 会话管理 ==========

    /**
     * POST /session/start
     * 创建新会话并启动 Chrome
     * Body: { url?: string }
     */
    router.post('/session/start', async (req, res) => {
        try {
            const { url } = req.body || {};
            const session = sessionManager.createSession({ url });

            res.json({
                success: true,
                session: {
                    id: session.id,
                    state: session.state,
                    chromePid: session.chromePid,
                },
                message: `会话 ${session.id} 创建成功，等待扩展连接...`,
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * GET /session/:id
     * 获取会话状态
     */
    router.get('/session/:id', (req, res) => {
        const session = sessionManager.getSession(req.params.id);
        if (!session) {
            return res.status(404).json({ success: false, error: '会话不存在' });
        }
        res.json({
            success: true,
            session: {
                id: session.id,
                state: session.state,
                chromePid: session.chromePid,
                activeTabId: session.activeTabId,
                debuggerAttached: session.debuggerAttached,
                createdAt: session.createdAt,
                lastActivity: session.lastActivity,
            },
        });
    });

    /**
     * GET /sessions
     * 列出所有活动会话
     */
    router.get('/sessions', (req, res) => {
        const sessions = sessionManager.listSessions().map((s) => ({
            id: s.id,
            state: s.state,
            chromePid: s.chromePid,
            createdAt: s.createdAt,
        }));
        res.json({ success: true, sessions });
    });

    /**
     * DELETE /session/:id
     * 关闭会话
     */
    router.delete('/session/:id', (req, res) => {
        const session = sessionManager.getSession(req.params.id);
        if (!session) {
            return res.status(404).json({ success: false, error: '会话不存在' });
        }
        sessionManager.closeSession(req.params.id);
        res.json({ success: true, message: `会话 ${req.params.id} 已关闭` });
    });

    // ========== 浏览器操作 ==========

    /**
     * POST /session/:id/navigate
     * 导航到指定 URL
     * Body: { url: string }
     */
    router.post('/session/:id/navigate', async (req, res) => {
        try {
            const { url } = req.body;
            if (!url) {
                return res.status(400).json({ success: false, error: '缺少 url 参数' });
            }
            const result = await sessionManager.sendCommand(req.params.id, {
                action: 'navigate',
                url,
            });
            res.json({ success: true, result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * GET /session/:id/markdown
     * 获取当前页面的 Markdown 内容
     */
    router.get('/session/:id/markdown', async (req, res) => {
        try {
            const result = await sessionManager.sendCommand(req.params.id, {
                action: 'get_markdown',
            });
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * GET /session/:id/elements
     * 获取页面交互元素列表（含坐标映射）
     */
    router.get('/session/:id/elements', async (req, res) => {
        try {
            const result = await sessionManager.sendCommand(req.params.id, {
                action: 'get_interactive_elements',
            });
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * POST /session/:id/click
     * CDP 真实点击
     * Body: { x: number, y: number, button?: 'left'|'right'|'middle' }
     */
    router.post('/session/:id/click', async (req, res) => {
        try {
            const { x, y, button = 'left' } = req.body;
            if (x === undefined || y === undefined) {
                return res.status(400).json({ success: false, error: '缺少 x, y 坐标参数' });
            }
            const result = await sessionManager.sendCommand(req.params.id, {
                action: 'cdp_click',
                x: Number(x),
                y: Number(y),
                button,
            });
            res.json({ success: true, result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * POST /session/:id/type
     * CDP 键盘输入
     * Body: { text: string }
     */
    router.post('/session/:id/type', async (req, res) => {
        try {
            const { text } = req.body;
            if (!text) {
                return res.status(400).json({ success: false, error: '缺少 text 参数' });
            }
            const result = await sessionManager.sendCommand(req.params.id, {
                action: 'cdp_type',
                text,
            });
            res.json({ success: true, result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * POST /session/:id/eval
     * 在页面中执行 JavaScript
     * Body: { code: string }
     */
    router.post('/session/:id/eval', async (req, res) => {
        try {
            const { code } = req.body;
            if (!code) {
                return res.status(400).json({ success: false, error: '缺少 code 参数' });
            }
            const result = await sessionManager.sendCommand(req.params.id, {
                action: 'evaluate_js',
                code,
            });
            res.json({ success: true, result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * GET /session/:id/tab
     * 获取当前标签页信息（在任何页面上都能工作，包括受限页面）
     */
    router.get('/session/:id/tab', async (req, res) => {
        try {
            const result = await sessionManager.sendCommand(req.params.id, {
                action: 'get_tab_info',
            });
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ========== 截图 ==========

    /**
     * GET /session/:id/screenshot
     * 截取当前页面截图
     */
    router.get('/session/:id/screenshot', async (req, res) => {
        try {
            const result = await sessionManager.sendCommand(req.params.id, {
                action: 'take_screenshot',
            });
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ========== Console / Network 日志 ==========

    /**
     * GET /session/:id/console
     * 获取 Console 日志
     */
    router.get('/session/:id/console', async (req, res) => {
        try {
            const count = parseInt(req.query.count) || 20;
            const result = await sessionManager.sendCommand(req.params.id, {
                action: 'get_console_logs',
                count,
            });
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * GET /session/:id/network
     * 获取 Network 日志
     */
    router.get('/session/:id/network', async (req, res) => {
        try {
            const count = parseInt(req.query.count) || 20;
            const errorsOnly = req.query.errorsOnly === 'true';
            const result = await sessionManager.sendCommand(req.params.id, {
                action: 'get_network_logs',
                count,
                errorsOnly,
            });
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ========== 多标签页管理 ==========

    /**
     * GET /session/:id/tabs
     * 列出所有标签页
     */
    router.get('/session/:id/tabs', async (req, res) => {
        try {
            const result = await sessionManager.sendCommand(req.params.id, {
                action: 'list_tabs',
            });
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * POST /session/:id/tab/switch
     * 切换到指定标签页
     * Body: { tabId: number }
     */
    router.post('/session/:id/tab/switch', async (req, res) => {
        try {
            const { tabId } = req.body;
            if (tabId === undefined) {
                return res.status(400).json({ success: false, error: '缺少 tabId 参数' });
            }
            const result = await sessionManager.sendCommand(req.params.id, {
                action: 'switch_tab',
                tabId: Number(tabId),
            });
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * POST /session/:id/tab/create
     * 创建新标签页
     * Body: { url?: string }
     */
    router.post('/session/:id/tab/create', async (req, res) => {
        try {
            const { url } = req.body || {};
            const result = await sessionManager.sendCommand(req.params.id, {
                action: 'create_tab',
                url: url || 'about:blank',
            });
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * DELETE /session/:id/tab/:tabId
     * 关闭指定标签页
     */
    router.delete('/session/:id/tab/:tabId', async (req, res) => {
        try {
            const result = await sessionManager.sendCommand(req.params.id, {
                action: 'close_tab',
                tabId: Number(req.params.tabId),
            });
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ========== CLI 检测 & AI 聊天 ==========

    /**
     * GET /cli/detect
     * 自动检测本地已安装的 AI CLI 工具
     */
    router.get('/cli/detect', (req, res) => {
        const force = req.query.refresh === 'true';
        const clis = cliDetector.detect(force);
        const active = cliDetector.getActive();
        res.json({
            success: true,
            clis,
            active: active ? active.id : null,
        });
    });

    /**
     * POST /cli/select
     * 选择当前使用的 CLI 工具
     * Body: { cli: string }
     */
    router.post('/cli/select', (req, res) => {
        try {
            const { cli } = req.body;
            if (!cli) {
                return res.status(400).json({ success: false, error: '缺少 cli 参数' });
            }
            const selected = cliDetector.setActive(cli);
            res.json({ success: true, cli: selected });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    /**
     * POST /chat/stream
     * 通过当前选中的 CLI 工具流式聊天（SSE）
     * Body: { message: string, cli?: string }
     */
    router.post('/chat/stream', async (req, res) => {
        try {
            const { message, cli } = req.body;
            if (!message) {
                return res.status(400).json({ success: false, error: '缺少 message 参数' });
            }
            await cliDetector.chatStream(message, res, cli || null);
        } catch (err) {
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: err.message });
            }
        }
    });

    /**
     * POST /chat
     * 通过当前选中的 CLI 工具聊天（非流式）
     * Body: { message: string, cli?: string }
     */
    router.post('/chat', async (req, res) => {
        try {
            const { message, cli, conversationId, allowFallback } = req.body;
            if (!message) {
                return res.status(400).json({ success: false, error: '缺少 message 参数' });
            }

            // Ollama 走本地 HTTP API（免费、稳定、支持结构化输出）
            if (cli === 'ollama') {
                const convId = conversationId || `ollama-${Date.now()}`;
                const result = await aiChat.chat(convId, message);
                res.json({
                    success: !result.error,
                    text: result.text || '',
                    cli: 'ollama',
                    error: result.error || undefined,
                });
                return;
            }

            const result = await cliDetector.chat(message, cli || null, {
                allowFallback: allowFallback !== false,
            });
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    /**
     * POST /chat/abort
     * 终止当前正在运行的 CLI 进程
     */
    router.post('/chat/abort', (req, res) => {
        const aborted = cliDetector.abort();
        res.json({ success: true, aborted });
    });

    return router;
}

module.exports = { createApiRoutes };
