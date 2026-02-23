/**
 * PhantomBridge - 会话管理器
 * 
 * 管理浏览器实例的连接池，维护 TaskID → BrowserInstance 的映射。
 * 处理会话的完整生命周期：创建 → 就绪 → 活动 → 关闭
 */

const { v4: uuidv4 } = require('uuid');
const { launchChrome } = require('./chrome-launcher');

// 会话状态枚举
const SessionState = {
    LAUNCHING: 'launching',   // Chrome 正在启动
    CONNECTING: 'connecting', // 等待扩展回连
    READY: 'ready',           // 扩展已连接，可以接受指令
    BUSY: 'busy',             // 正在执行指令
    CLOSED: 'closed',         // 已关闭
};

class SessionManager {
    constructor() {
        /** @type {Map<string, Session>} */
        this.sessions = new Map();

        // 等待扩展连接的回调池
        /** @type {Map<string, Function>} */
        this._pendingConnections = new Map();
    }

    /**
     * 创建一个新的浏览器会话
     * @param {object} options
     * @param {string} [options.url] - 初始 URL
     * @returns {Session}
     */
    createSession(options = {}) {
        const id = uuidv4().slice(0, 8); // 短 ID 便于日志

        const session = {
            id,
            state: SessionState.LAUNCHING,
            chromeProcess: null,
            nativePort: null,
            activeTabId: null,
            debuggerAttached: false,
            createdAt: Date.now(),
            lastActivity: Date.now(),
        };

        // 启动 Chrome
        try {
            const { process: chromeProcess, profileDir, pid } = launchChrome({
                taskId: id,
                url: options.url,
            });

            session.chromeProcess = chromeProcess;
            session.profileDir = profileDir;
            session.chromePid = pid;
            session.state = SessionState.CONNECTING;

            console.log(`[SessionManager] 会话 ${id} 已创建, Chrome PID: ${pid}`);
        } catch (err) {
            session.state = SessionState.CLOSED;
            session.error = err.message;
            console.error(`[SessionManager] 会话 ${id} 创建失败:`, err.message);
        }

        this.sessions.set(id, session);
        return session;
    }

    /**
     * 获取一个会话
     * @param {string} id
     * @returns {Session|undefined}
     */
    getSession(id) {
        return this.sessions.get(id);
    }

    /**
     * 列出所有活动会话
     * @returns {Session[]}
     */
    listSessions() {
        return Array.from(this.sessions.values()).filter(
            (s) => s.state !== SessionState.CLOSED
        );
    }

    /**
     * 当扩展通过 Native Messaging 连接回来时调用
     * @param {string} sessionId
     * @param {object} nativePort - 通信通道引用
     */
    onExtensionConnected(sessionId, nativePort) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            console.warn(`[SessionManager] 收到未知会话 ${sessionId} 的连接`);
            return;
        }

        session.nativePort = nativePort;
        session.state = SessionState.READY;
        session.lastActivity = Date.now();
        console.log(`[SessionManager] 会话 ${sessionId} 扩展已连接, 状态: READY`);

        // 触发等待中的回调
        const pending = this._pendingConnections.get(sessionId);
        if (pending) {
            pending(session);
            this._pendingConnections.delete(sessionId);
        }
    }

    /**
     * 等待扩展连接就绪
     * @param {string} sessionId
     * @param {number} timeoutMs
     * @returns {Promise<Session>}
     */
    waitForReady(sessionId, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            const session = this.sessions.get(sessionId);
            if (!session) {
                return reject(new Error(`会话 ${sessionId} 不存在`));
            }
            if (session.state === SessionState.READY) {
                return resolve(session);
            }

            const timer = setTimeout(() => {
                this._pendingConnections.delete(sessionId);
                reject(new Error(`等待会话 ${sessionId} 连接超时 (${timeoutMs}ms)`));
            }, timeoutMs);

            this._pendingConnections.set(sessionId, (readySession) => {
                clearTimeout(timer);
                resolve(readySession);
            });
        });
    }

    /**
     * 向会话发送指令并等待响应
     * @param {string} sessionId
     * @param {object} command - 要发送的指令
     * @param {number} timeoutMs - 超时时间
     * @returns {Promise<object>}
     */
    sendCommand(sessionId, command, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            const session = this.sessions.get(sessionId);
            if (!session) {
                return reject(new Error(`会话 ${sessionId} 不存在`));
            }
            if (
                session.state !== SessionState.READY &&
                session.state !== SessionState.BUSY &&
                session.state !== SessionState.CONNECTING
            ) {
                return reject(new Error(`会话 ${sessionId} 状态异常: ${session.state}`));
            }

            const requestId = uuidv4().slice(0, 8);
            const fullCommand = { ...command, _requestId: requestId };

            session.state = SessionState.BUSY;
            session.lastActivity = Date.now();

            const timer = setTimeout(() => {
                session.state = session.nativePort ? SessionState.READY : SessionState.CONNECTING;
                reject(new Error(`指令超时 (${timeoutMs}ms): ${command.action}`));
            }, timeoutMs);

            // 注册一次性响应监听
            const responseHandler = (response) => {
                if (response._requestId === requestId) {
                    clearTimeout(timer);
                    session.state = SessionState.READY;
                    session.lastActivity = Date.now();
                    session._removeResponseHandler(responseHandler);
                    resolve(response);
                }
            };

            // 将 handler 绑定到 session 上
            if (!session._responseHandlers) {
                session._responseHandlers = [];
            }
            session._responseHandlers.push(responseHandler);
            session._removeResponseHandler = (handler) => {
                session._responseHandlers = session._responseHandlers.filter((h) => h !== handler);
            };

            // 通过 WebSocket 或 Native Messaging 发送
            this.emit('send_to_extension', sessionId, fullCommand);
        });
    }

    /**
     * 处理来自扩展的响应
     * @param {string} sessionId
     * @param {object} response
     */
    handleResponse(sessionId, response) {
        const session = this.sessions.get(sessionId);
        if (!session || !session._responseHandlers) return;

        for (const handler of session._responseHandlers) {
            handler(response);
        }
    }

    /**
     * 关闭一个会话
     * @param {string} sessionId
     */
    closeSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        session.state = SessionState.CLOSED;

        // 尝试终止 Chrome 进程
        if (session.chromeProcess && !session.chromeProcess.killed) {
            try {
                session.chromeProcess.kill();
            } catch (e) {
                // Chrome 可能已经关闭
            }
        }

        console.log(`[SessionManager] 会话 ${sessionId} 已关闭`);
    }

    /**
     * 关闭所有会话
     */
    closeAll() {
        for (const [id] of this.sessions) {
            this.closeSession(id);
        }
    }
}

// 混入 EventEmitter
const { EventEmitter } = require('events');
Object.setPrototypeOf(SessionManager.prototype, EventEmitter.prototype);

module.exports = { SessionManager, SessionState };
