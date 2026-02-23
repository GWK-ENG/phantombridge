/**
 * PhantomBridge - 本地路由网关 主入口
 * 
 * 启动 HTTP + WebSocket 服务，协调以下组件：
 * - SessionManager: 管理浏览器会话连接池
 * - API Routes: RESTful 接口
 * - WebSocket: 实时双向通信（扩展 ↔ 网关 ↔ Agent）
 */

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { SessionManager, SessionState } = require('./session-manager');
const { createApiRoutes } = require('./api-routes');
const { CliDetector } = require('./cli-detector');

const PORT = process.env.PHANTOM_PORT || 7778;

// ========== 初始化 ==========

const app = express();
app.use(express.json());

const sessionManager = new SessionManager();
const cliDetector = new CliDetector();

// 启动时检测 CLI
cliDetector.detect();

const server = http.createServer(app);

// ========== HTTP API ==========

// 健康检查
app.get('/', (req, res) => {
    res.json({
        name: 'PhantomBridge Gateway',
        version: '0.1.0',
        status: 'running',
        activeSessions: sessionManager.listSessions().length,
    });
});

// 挂载 API 路由
app.use('/api', createApiRoutes(sessionManager, cliDetector));

// 兼容短路径
app.use('/', createApiRoutes(sessionManager, cliDetector));

// ========== WebSocket ==========

const wss = new WebSocketServer({ server, path: '/ws' });

// 存储扩展的 WebSocket 连接 (extensionId -> ws)
const extensionConnections = new Map();

function getAnyOpenExtensionConnection() {
    for (const conn of extensionConnections.values()) {
        if (conn && conn.readyState === WebSocket.OPEN) {
            return conn;
        }
    }
    return null;
}

function bindSessionToConnection(sessionId, ws, reason = 'auto') {
    const session = sessionManager.getSession(sessionId);
    if (!session) return false;
    sessionManager.onExtensionConnected(sessionId, ws);
    ws.sessionId = sessionId;
    console.log(`[Gateway] 会话 ${sessionId} 已绑定扩展连接 (${reason})`);
    return true;
}

function autoBindLatestConnectingSession(ws) {
    const connecting = sessionManager
        .listSessions()
        .filter((s) => s.state === SessionState.CONNECTING)
        .sort((a, b) => b.createdAt - a.createdAt);

    if (connecting.length === 0) {
        return null;
    }

    const chosen = connecting[0];
    if (connecting.length > 1) {
        console.warn(
            `[Gateway] 检测到 ${connecting.length} 个待连接会话，自动绑定最新会话 ${chosen.id}`
        );
    }

    bindSessionToConnection(chosen.id, ws, 'register');
    return chosen.id;
}

wss.on('connection', (ws, req) => {
    console.log('[Gateway] 新的 WebSocket 连接');

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            handleWebSocketMessage(ws, message);
        } catch (err) {
            console.error('[Gateway] WebSocket 消息解析失败:', err.message);
            ws.send(JSON.stringify({ error: '消息格式错误' }));
        }
    });

    ws.on('close', () => {
        console.log('[Gateway] WebSocket 连接断开');
        // 清理扩展连接映射
        for (const [key, conn] of extensionConnections) {
            if (conn === ws) {
                extensionConnections.delete(key);
                console.log(`[Gateway] 扩展 ${key} 断开连接`);
            }
        }

        if (ws.sessionId) {
            const session = sessionManager.getSession(ws.sessionId);
            if (session && session.state !== SessionState.CLOSED) {
                session.nativePort = null;
                session.state = SessionState.CONNECTING;
                console.log(`[Gateway] 会话 ${ws.sessionId} 已标记为 CONNECTING，等待重连`);
            }
        }
    });

    ws.on('error', (err) => {
        console.error('[Gateway] WebSocket 错误:', err.message);
    });
});

/**
 * 处理来自 WebSocket 的消息
 */
function handleWebSocketMessage(ws, message) {
    const { type, sessionId } = message;

    switch (type) {
        // 扩展注册：扩展连接后发送注册消息
        case 'extension_register': {
            const { extensionId, sessionId: requestedSessionId } = message;
            extensionConnections.set(extensionId, ws);
            ws.extensionId = extensionId;
            console.log(`[Gateway] 扩展已注册: ${extensionId}`);
            ws.send(JSON.stringify({ type: 'registered', extensionId }));

            // 优先绑定显式 sessionId；否则自动绑定最新 connecting 会话
            if (requestedSessionId) {
                const ok = bindSessionToConnection(requestedSessionId, ws, 'register-requested');
                if (!ok) {
                    console.warn(`[Gateway] 注册时指定的会话不存在: ${requestedSessionId}`);
                }
            } else {
                autoBindLatestConnectingSession(ws);
            }
            break;
        }

        // 扩展报告会话就绪（Chrome 启动完成，扩展加载成功）
        case 'session_ready': {
            console.log(`[Gateway] 会话 ${sessionId} 扩展已就绪`);
            sessionManager.onExtensionConnected(sessionId, ws);
            break;
        }

        // 扩展返回指令执行结果
        case 'command_response': {
            console.log(`[Gateway] 收到会话 ${sessionId} 的响应`);
            sessionManager.handleResponse(sessionId, message.data);
            break;
        }

        // 心跳
        case 'ping': {
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            break;
        }

        default:
            console.warn(`[Gateway] 未知消息类型: ${type}`);
    }
}

// 将 SessionManager 的指令发送事件绑定到 WebSocket
sessionManager.on('send_to_extension', (sessionId, command) => {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
        console.error(`[Gateway] 会话 ${sessionId} 不存在`);
        return;
    }

    let ws = session.nativePort;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        ws = getAnyOpenExtensionConnection();
        if (!ws) {
            console.error(`[Gateway] 会话 ${sessionId} 无可用连接`);
            return;
        }
        bindSessionToConnection(sessionId, ws, 'on-demand-send');
    }

    ws.send(JSON.stringify({
        type: 'command',
        sessionId,
        data: command,
    }));
});

// WebSocket 心跳检测（30 秒间隔）
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            console.log('[Gateway] WebSocket 心跳超时，关闭连接');
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(heartbeatInterval);
});

// ========== 启动服务 ==========

server.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║                                                      ║');
    console.log('║   🌌 PhantomBridge Gateway v0.1.0                    ║');
    console.log('║   ──────────────────────────────────                  ║');
    console.log(`║   HTTP API:    http://localhost:${PORT}                  ║`);
    console.log(`║   WebSocket:   ws://localhost:${PORT}/ws                 ║`);
    console.log('║                                                      ║');
    console.log('║   等待 Chrome 扩展连接...                            ║');
    console.log('║                                                      ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');
});

// 优雅退出
process.on('SIGINT', () => {
    console.log('\n[Gateway] 正在关闭...');
    sessionManager.closeAll();
    server.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n[Gateway] 正在关闭...');
    sessionManager.closeAll();
    server.close();
    process.exit(0);
});

module.exports = { app, server, sessionManager };
