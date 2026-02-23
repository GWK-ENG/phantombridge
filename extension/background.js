/**
 * PhantomBridge - Service Worker (中枢控制层)
 * 
 * 职责：
 * 1. 通过 WebSocket 与本地网关保持长连接
 * 2. 接收网关指令 → 调度执行 → 返回结果
 * 3. chrome.debugger (CDP) 执行真实鼠标/键盘事件
 * 4. 标签页管理
 */

// ========== 配置 ==========

const GATEWAY_WS_URLS = [
    'ws://127.0.0.1:7778/ws',
    'ws://localhost:7778/ws',
];
const HEARTBEAT_INTERVAL = 25000; // 25 秒心跳
const RECONNECT_DELAY = 3000;     // 3 秒重连间隔
const GATEWAY_HINT_INTERVAL = 30000; // 30 秒最多提示一次
const FALLBACK_PAGE_URL = 'https://www.google.com/';
const RESTRICTED_URL_PREFIXES = [
    'chrome://',
    'edge://',
    'brave://',
    'vivaldi://',
    'opera://',
    'devtools://',
    'chrome-extension://',
    'about:',
    'view-source:',
    'chrome-search://',
];
const BUILD_ID = '2026-02-20-v13-ws-stale-fix';
const WS_CONNECT_TIMEOUT = 10000;

// ========== 站点权限系统 ==========

const DEFAULT_PERMISSIONS = {
    enabled: true,
    mode: 'blocklist',       // 'blocklist' | 'allowlist'
    blocklist: [],            // URL 模式列表，如 '*://*.bank.com/*'
    allowlist: [],
    highRiskConfirm: true,    // 高风险操作确认
    captchaDetect: true,      // CAPTCHA 检测
    promptInjectionGuard: true, // 提示注入防护
};

let _sitePermissions = null;

/**
 * 加载站点权限配置
 * @returns {Promise<object>}
 */
async function loadSitePermissions() {
    if (_sitePermissions) return _sitePermissions;
    try {
        const data = await chrome.storage.local.get('phantomPermissions');
        _sitePermissions = { ...DEFAULT_PERMISSIONS, ...(data.phantomPermissions || {}) };
    } catch {
        _sitePermissions = { ...DEFAULT_PERMISSIONS };
    }
    return _sitePermissions;
}

/**
 * 保存站点权限配置
 * @param {object} permissions
 */
async function saveSitePermissions(permissions) {
    _sitePermissions = { ...DEFAULT_PERMISSIONS, ...permissions };
    await chrome.storage.local.set({ phantomPermissions: _sitePermissions });
}

/**
 * 将 URL 模式（如 *://*.example.com/*）转换为正则表达式
 * 支持格式：
 * - *://*.example.com/*  → 匹配 example.com 及其子域名
 * - *://exact.com/*      → 匹配 exact.com
 * - https://example.com/path/* → 匹配特定路径
 * - example.com           → 简写，匹配该域名
 */
function urlPatternToRegex(pattern) {
    let p = String(pattern || '').trim();
    if (!p) return null;

    // 简写模式：纯域名 → *://*.domain/*
    if (!/[:/]/.test(p)) {
        p = `*://*.${p}/*`;
    }

    // 转义特殊字符，保留通配符 *
    const escaped = p
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // 转义正则特殊字符
        .replace(/\\\*/g, '___STAR___');           // 暂存通配符

    // 还原通配符为正则
    const regexStr = escaped
        .replace(/___STAR___:\/\/___STAR___\\\./g, 'https?://([^/]+\\.)?')  // *://*.
        .replace(/___STAR___:\/\//g, 'https?://')                            // *://
        .replace(/___STAR___/g, '.*');                                       // 其余 *

    try {
        return new RegExp(`^${regexStr}$`, 'i');
    } catch {
        console.warn(`[PhantomBridge] 无效的 URL 模式: ${pattern}`);
        return null;
    }
}

/**
 * 检查 URL 是否匹配模式列表中的任意一项
 * @param {string} url
 * @param {string[]} patterns
 * @returns {boolean}
 */
function urlMatchesAnyPattern(url, patterns) {
    if (!url || !Array.isArray(patterns) || patterns.length === 0) return false;
    const normalizedUrl = String(url).trim();
    for (const pattern of patterns) {
        const regex = urlPatternToRegex(pattern);
        if (regex && regex.test(normalizedUrl)) return true;
    }
    return false;
}

/**
 * 检查站点权限：当前 URL 是否允许被自动化操作
 * @param {string} url - 标签页 URL
 * @returns {Promise<{allowed: boolean, reason: string}>}
 */
async function checkSitePermission(url) {
    const perms = await loadSitePermissions();
    if (!perms.enabled) {
        return { allowed: true, reason: '权限系统已禁用' };
    }

    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl || normalizedUrl === 'about:blank') {
        return { allowed: true, reason: '空白页' };
    }

    if (perms.mode === 'blocklist') {
        // 黑名单模式：列表中的站点被禁止
        if (urlMatchesAnyPattern(normalizedUrl, perms.blocklist)) {
            return {
                allowed: false,
                reason: `站点 ${normalizedUrl} 在黑名单中，已阻止自动化操作。可在设置中修改。`,
            };
        }
        return { allowed: true, reason: '不在黑名单中' };
    }

    if (perms.mode === 'allowlist') {
        // 白名单模式：只有列表中的站点才允许
        if (urlMatchesAnyPattern(normalizedUrl, perms.allowlist)) {
            return { allowed: true, reason: '在白名单中' };
        }
        return {
            allowed: false,
            reason: `站点 ${normalizedUrl} 不在白名单中，已阻止自动化操作。可在设置中修改。`,
        };
    }

    return { allowed: true, reason: '未知模式，默认允许' };
}

let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let gatewayUrlIndex = 0;
let lastGatewayHintAt = 0;

// ========== Console / Network 日志缓冲区 ==========

const MAX_LOG_BUFFER = 50;
const consoleLogs = [];   // { level, text, url, timestamp }
const networkLogs = [];   // { url, status, method, type, timestamp }
let cdpEventsAttachedTabs = new Set(); // 已注册 CDP 事件的 tabId

// CDP 事件全局监听器（仅注册一次）
if (chrome.debugger?.onEvent) {
    chrome.debugger.onEvent.addListener((source, method, params) => {
        if (method === 'Runtime.consoleAPICalled') {
            const entry = {
                level: params.type || 'log',
                text: (params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 500),
                url: params.stackTrace?.callFrames?.[0]?.url || '',
                timestamp: Date.now(),
            };
            consoleLogs.push(entry);
            if (consoleLogs.length > MAX_LOG_BUFFER) consoleLogs.shift();
        }
        if (method === 'Runtime.exceptionThrown') {
            const ex = params.exceptionDetails || {};
            const entry = {
                level: 'error',
                text: ex.text || ex.exception?.description || 'Unknown exception',
                url: ex.url || '',
                line: ex.lineNumber,
                column: ex.columnNumber,
                timestamp: Date.now(),
            };
            consoleLogs.push(entry);
            if (consoleLogs.length > MAX_LOG_BUFFER) consoleLogs.shift();
        }
        if (method === 'Network.responseReceived') {
            const resp = params.response || {};
            const entry = {
                url: resp.url || params.requestId || '',
                status: resp.status || 0,
                statusText: resp.statusText || '',
                method: resp.requestHeaders?.[':method'] || '',
                type: params.type || '',
                mimeType: resp.mimeType || '',
                timestamp: Date.now(),
            };
            networkLogs.push(entry);
            if (networkLogs.length > MAX_LOG_BUFFER) networkLogs.shift();
        }
        if (method === 'Network.loadingFailed') {
            const entry = {
                url: params.requestId || '',
                status: 0,
                statusText: params.errorText || 'loading failed',
                method: '',
                type: params.type || '',
                mimeType: '',
                blocked: !!params.blockedReason,
                timestamp: Date.now(),
            };
            networkLogs.push(entry);
            if (networkLogs.length > MAX_LOG_BUFFER) networkLogs.shift();
        }
    });
}

/**
 * 为指定标签页启用 CDP 日志收集（Runtime + Network）
 */
async function enableCdpLogging(tabId, tabUrl) {
    if (cdpEventsAttachedTabs.has(tabId)) return;
    try {
        const target = await ensureDebugger(tabId, tabUrl);
        await chrome.debugger.sendCommand(target, 'Runtime.enable', {});
        await chrome.debugger.sendCommand(target, 'Network.enable', {});
        cdpEventsAttachedTabs.add(tabId);
    } catch {
        // 静默失败，不影响主流程
    }
}

// debugger 断开时清理追踪
if (chrome.debugger?.onDetach) {
    chrome.debugger.onDetach.addListener((source) => {
        if (source.tabId) cdpEventsAttachedTabs.delete(source.tabId);
    });
}

function currentGatewayUrl() {
    return GATEWAY_WS_URLS[gatewayUrlIndex % GATEWAY_WS_URLS.length];
}

function rotateGatewayUrl() {
    if (GATEWAY_WS_URLS.length > 1) {
        gatewayUrlIndex = (gatewayUrlIndex + 1) % GATEWAY_WS_URLS.length;
    }
}

function toErrorMessage(err) {
    if (err && typeof err.message === 'string' && err.message.length > 0) {
        return err.message;
    }
    try {
        return String(err);
    } catch {
        return 'unknown error';
    }
}

function formatWsCreateError(err) {
    const name = err?.name ? `[${err.name}] ` : '';
    const msg = toErrorMessage(err);
    const stack = typeof err?.stack === 'string' ? err.stack.split('\n').slice(0, 2).join(' | ') : '';
    return `${name}${msg}${stack ? ` | ${stack}` : ''}`;
}

function normalizeGatewayWsUrl(rawUrl) {
    try {
        const url = new URL(String(rawUrl || ''));
        if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
            throw new Error(`协议必须是 ws/wss，当前是 ${url.protocol}`);
        }
        return url.toString();
    } catch {
        return null;
    }
}

function maybeLogGatewayStartHint(gatewayWsUrl) {
    const now = Date.now();
    if (now - lastGatewayHintAt < GATEWAY_HINT_INTERVAL) return;
    lastGatewayHintAt = now;
    const httpUrl = String(gatewayWsUrl || '').replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/ws$/, '/');
    console.warn(
        '[PhantomBridge] 网关连接失败（本地服务不可达）。' +
        `请在项目目录运行 \`npm start\` 启动网关，然后访问 ${httpUrl} 确认可达。`
    );
}

function isRestrictedUrl(url = '') {
    const lower = String(url).toLowerCase();
    return RESTRICTED_URL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function canAutoFallback(url = '') {
    return isRestrictedUrl(url);
}

function restrictedUrlError(actionName, url) {
    return new Error(
        `当前页面受 Chrome 安全策略限制，无法执行 ${actionName}: ${url}。` +
        `请先打开普通网页（例如 ${FALLBACK_PAGE_URL}）。`
    );
}

// ========== WebSocket 连接管理 ==========

function connectToGateway() {
    if (typeof WebSocket === 'undefined') {
        console.error('[PhantomBridge] 当前环境不支持 WebSocket，请升级 Chrome 到 116+');
        scheduleReconnect();
        return;
    }

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    if (!Array.isArray(GATEWAY_WS_URLS) || GATEWAY_WS_URLS.length === 0) {
        console.error('[PhantomBridge] GATEWAY_WS_URLS 为空，无法连接网关');
        scheduleReconnect();
        return;
    }

    const rawGatewayUrl = currentGatewayUrl();
    const gatewayUrl = normalizeGatewayWsUrl(rawGatewayUrl);
    if (!gatewayUrl) {
        console.error('[PhantomBridge] 网关地址无效:', rawGatewayUrl);
        rotateGatewayUrl();
        scheduleReconnect();
        return;
    }

    console.log('[PhantomBridge] 正在连接网关...', gatewayUrl);

    let connectTimeoutTimer = null;
    let hadOpened = false;
    let socket = null;

    try {
        socket = new WebSocket(gatewayUrl);
    } catch (err) {
        console.error('[PhantomBridge] WebSocket 创建失败:', formatWsCreateError(err));
        rotateGatewayUrl();
        scheduleReconnect();
        return;
    }

    ws = socket;

    const clearConnectTimer = () => {
        if (connectTimeoutTimer) {
            clearTimeout(connectTimeoutTimer);
            connectTimeoutTimer = null;
        }
    };

    const isStaleSocket = () => ws !== socket;

    connectTimeoutTimer = setTimeout(() => {
        if (isStaleSocket()) return;
        if (socket.readyState === WebSocket.CONNECTING) {
            console.warn('[PhantomBridge] WebSocket 连接超时，主动关闭并重试:', gatewayUrl);
            try {
                socket.close(4000, 'connect-timeout');
            } catch {
                // ignore
            }
        }
    }, WS_CONNECT_TIMEOUT);

    socket.onopen = () => {
        if (isStaleSocket()) return;
        hadOpened = true;
        clearConnectTimer();
        console.log('[PhantomBridge] ✅ 已连接到网关', gatewayUrl);

        try {
            socket.send(JSON.stringify({
                type: 'extension_register',
                extensionId: chrome.runtime.id,
            }));
        } catch (err) {
            console.error('[PhantomBridge] 发送注册消息失败:', toErrorMessage(err));
        }

        startHeartbeat();
    };

    socket.onmessage = (event) => {
        if (isStaleSocket()) return;
        try {
            const message = JSON.parse(event.data);
            handleGatewayMessage(message);
        } catch (err) {
            console.error('[PhantomBridge] 消息解析失败:', err.message);
        }
    };

    socket.onclose = (event) => {
        clearConnectTimer();
        if (isStaleSocket()) return;
        console.log('[PhantomBridge] WebSocket 断开:', event.code, event.reason);
        if (!hadOpened && event.code === 1006) {
            maybeLogGatewayStartHint(gatewayUrl);
        }
        stopHeartbeat();
        ws = null;
        rotateGatewayUrl();
        scheduleReconnect();
    };

    socket.onerror = (event) => {
        if (isStaleSocket()) return;
        const detail = event?.message || event?.type || 'unknown event';
        const state = socket.readyState;
        console.error('[PhantomBridge] WebSocket 错误:', detail, '| url=', gatewayUrl, '| readyState=', state);
    };
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    console.log(`[PhantomBridge] ${RECONNECT_DELAY / 1000}秒后重连...`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToGateway();
    }, RECONNECT_DELAY);
}

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        }
    }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

function sendToGateway(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    } else {
        console.error('[PhantomBridge] 网关未连接，无法发送消息');
    }
}

// ========== 消息路由 ==========

async function handleGatewayMessage(message) {
    const { type, sessionId, data } = message;

    switch (type) {
        case 'registered':
            console.log('[PhantomBridge] 扩展注册成功');
            break;

        case 'pong':
            // 心跳回复
            break;

        case 'command':
            console.log(`[PhantomBridge] 收到指令: ${data.action}`);
            try {
                const result = await executeCommand(data);
                sendToGateway({
                    type: 'command_response',
                    sessionId,
                    data: { ...result, _requestId: data._requestId },
                });
            } catch (err) {
                sendToGateway({
                    type: 'command_response',
                    sessionId,
                    data: {
                        error: err.message,
                        _requestId: data._requestId,
                    },
                });
            }
            break;

        default:
            console.warn(`[PhantomBridge] 未知消息类型: ${type}`);
    }
}

// ========== CDP 通用工具 ==========

/**
 * 获取当前活动标签页
 */
async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('没有活动标签页');
    return tab;
}

/**
 * 确保当前标签页可被扩展控制；必要时从默认受限页自动跳转到回退页
 */
async function ensureControllableTab(tab, actionName, autoFallback = true) {
    let activeTab = tab;
    if (!activeTab?.id) throw new Error('活动标签页无效');

    if (isRestrictedUrl(activeTab.url) && autoFallback && canAutoFallback(activeTab.url)) {
        console.warn(
            `[PhantomBridge] 当前页面受限 (${activeTab.url})，自动跳转到 ${FALLBACK_PAGE_URL}`
        );
        activeTab = await updateTabUrlAndWait(activeTab.id, FALLBACK_PAGE_URL);
    }

    if (isRestrictedUrl(activeTab.url)) {
        throw restrictedUrlError(actionName, activeTab.url);
    }

    return activeTab;
}

/**
 * 确保 debugger 已附加到目标标签页
 * 如果已附加则忽略错误
 */
async function ensureDebugger(tabId, tabUrl = '') {
    const target = { tabId };
    try {
        await chrome.debugger.attach(target, '1.3');
    } catch (e) {
        const message = toErrorMessage(e);
        if (!message.includes('Already attached')) {
            if (isRestrictedUrl(tabUrl)) {
                throw restrictedUrlError('附加调试器', tabUrl);
            }
            if (message.includes('Another debugger is already attached')) {
                throw new Error(
                    '当前标签页已被其他调试器占用（通常是 DevTools）。请先关闭该标签页的 DevTools 后重试。'
                );
            }
            throw new Error(`附加调试器失败: ${message}`);
        }
    }
    return target;
}

/**
 * 通过 CDP Runtime.evaluate 在页面中执行 JS 表达式
 * 该方法适用于普通网页；Chrome 内置受限页面会被浏览器拦截
 */
async function cdpEval(tabId, tabUrl, expression, awaitPromise = false) {
    const target = await ensureDebugger(tabId, tabUrl);
    const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
    });
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || 'CDP Runtime.evaluate 执行出错');
    }
    return result.result?.value;
}

function isDebuggerOccupiedError(err) {
    const msg = toErrorMessage(err);
    return (
        msg.includes('其他调试器占用') ||
        msg.includes('Another debugger is already attached')
    );
}

/**
 * 通过 chrome.scripting 在页面中执行函数（CDP 失败时兜底）
 */
async function execScriptInTab(tabId, func, args = []) {
    const injected = await chrome.scripting.executeScript({
        target: { tabId },
        func,
        args,
    });
    return injected?.[0]?.result;
}

/**
 * 页面内：提取 Markdown 风格文本（支持遍历 open Shadow DOM）
 */
function extractMarkdownInPage(maxLines = 240, maxLength = 12000) {
    function collectRoots() {
        const roots = [document];
        const queue = [document.documentElement];
        const seen = new Set(queue);

        while (queue.length > 0) {
            const node = queue.shift();
            if (!node) continue;
            if (node.shadowRoot) roots.push(node.shadowRoot);

            const children = node.children || [];
            for (const child of children) {
                if (!seen.has(child)) {
                    seen.add(child);
                    queue.push(child);
                }
            }
        }
        return roots;
    }

    function getText(el) {
        return String(el?.innerText || el?.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function isVisible(el) {
        if (!el || el.nodeType !== 1) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function pushUnique(lines, seen, line) {
        const clean = String(line || '').replace(/\s+/g, ' ').trim();
        if (!clean || clean.length < 2) return;
        const key = clean.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        lines.push(clean);
    }

    const roots = collectRoots();
    const lines = [];
    const seen = new Set();

    for (const root of roots) {
        if (!root?.querySelectorAll) continue;

        for (const h of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
            if (!isVisible(h)) continue;
            const level = Number(String(h.tagName || '').slice(1)) || 1;
            const prefix = '#'.repeat(Math.max(1, Math.min(6, level)));
            pushUnique(lines, seen, `${prefix} ${getText(h)}`);
            if (lines.length >= maxLines) break;
        }
        if (lines.length >= maxLines) break;

        for (const el of root.querySelectorAll('p,li,button,[role="button"],a[href],h1,h2,h3')) {
            if (!isVisible(el)) continue;
            pushUnique(lines, seen, getText(el));
            if (lines.length >= maxLines) break;
        }
        if (lines.length >= maxLines) break;
    }

    if (lines.length === 0) {
        const fallback = getText(document.body || document.documentElement);
        if (fallback) lines.push(fallback);
    }

    return lines.join('\n').slice(0, maxLength).trim();
}

/**
 * 页面内：提取可交互元素（支持遍历 open Shadow DOM）
 */
function extractInteractiveElementsInPage(maxItems = 400) {
    function collectRoots() {
        const roots = [document];
        const queue = [document.documentElement];
        const seen = new Set(queue);

        while (queue.length > 0) {
            const node = queue.shift();
            if (!node) continue;
            if (node.shadowRoot) roots.push(node.shadowRoot);

            const children = node.children || [];
            for (const child of children) {
                if (!seen.has(child)) {
                    seen.add(child);
                    queue.push(child);
                }
            }
        }
        return roots;
    }

    function isVisible(el) {
        if (!el || el.nodeType !== 1) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
    }

    function inViewport(rect) {
        return !(
            rect.bottom < 0 ||
            rect.right < 0 ||
            rect.top > window.innerHeight ||
            rect.left > window.innerWidth
        );
    }

    function clamp(num, min, max) {
        return Math.max(min, Math.min(max, num));
    }

    function getText(el) {
        return String(
            el.getAttribute('aria-label') ||
            el.getAttribute('title') ||
            el.innerText ||
            el.textContent ||
            el.value ||
            el.placeholder ||
            ''
        ).replace(/\s+/g, ' ').trim().slice(0, 100);
    }

    const selectors = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [onclick], [tabindex]:not([tabindex="-1"])';
    const roots = collectRoots();
    const seenElements = new Set();
    const seenKeys = new Set();
    const results = [];
    let id = 0;

    for (const root of roots) {
        if (!root?.querySelectorAll) continue;
        const els = root.querySelectorAll(selectors);

        for (const el of els) {
            if (seenElements.has(el)) continue;
            seenElements.add(el);

            const rect = el.getBoundingClientRect();
            if (!inViewport(rect)) continue;
            if (!isVisible(el)) continue;

            const x = Math.round(clamp(rect.left + rect.width / 2, 1, Math.max(1, window.innerWidth - 1)));
            const y = Math.round(clamp(rect.top + rect.height / 2, 1, Math.max(1, window.innerHeight - 1)));
            const tag = String(el.tagName || '').toLowerCase();
            const text = getText(el);
            const key = `${tag}|${text}|${x}|${y}`;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);

            results.push({
                id: id++,
                tag,
                type: el.type || undefined,
                role: el.getAttribute('role') || undefined,
                text,
                href: el.href || undefined,
                x,
                y,
                width: Math.round(rect.width),
                height: Math.round(rect.height),
            });

            if (results.length >= maxItems) break;
        }

        if (results.length >= maxItems) break;
    }

    results.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    return results;
}

/**
 * 页面内：按坐标点击（CDP 不可用时兜底）
 */
function clickAtPointInPage(x, y, button = 'left') {
    const el = document.elementFromPoint(Number(x), Number(y));
    if (!el) return { ok: false, error: 'elementFromPoint 未找到元素' };

    const view = window;
    const eventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: Number(x),
        clientY: Number(y),
        button: button === 'right' ? 2 : button === 'middle' ? 1 : 0,
    };

    try {
        el.dispatchEvent(new MouseEvent('mousemove', eventInit));
        el.dispatchEvent(new MouseEvent('mouseover', eventInit));
        el.dispatchEvent(new MouseEvent('mousedown', eventInit));
        el.dispatchEvent(new MouseEvent('mouseup', eventInit));
        if (button === 'right') {
            el.dispatchEvent(new MouseEvent('contextmenu', eventInit));
        } else {
            el.dispatchEvent(new MouseEvent('click', eventInit));
            if (typeof el.click === 'function') {
                el.click();
            }
        }
    } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
    }

    const label = String(
        el.getAttribute?.('aria-label') ||
        el.getAttribute?.('title') ||
        el.innerText ||
        el.textContent ||
        ''
    ).replace(/\s+/g, ' ').trim().slice(0, 120);

    return {
        ok: true,
        tag: String(el.tagName || '').toLowerCase(),
        text: label,
    };
}

/**
 * 页面内：向可编辑元素输入文本（CDP 不可用时兜底）
 */
function typeTextInPage(text) {
    const active = document.activeElement;
    const isEditable = (el) => {
        if (!el) return false;
        const tag = String(el.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return true;
        if (el.isContentEditable) return true;
        return false;
    };

    let target = isEditable(active) ? active : null;

    if (!target) {
        const candidate = document.querySelector(
            'input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), [contenteditable="true"]'
        );
        if (candidate) {
            target = candidate;
            if (typeof target.focus === 'function') target.focus();
        }
    }

    if (!target) {
        return { ok: false, error: '未找到可输入的元素（请先点击输入框）' };
    }

    try {
        if (target.isContentEditable) {
            target.textContent = String(text);
        } else {
            target.value = String(text);
        }

        target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
    }

    return {
        ok: true,
        tag: String(target.tagName || '').toLowerCase(),
        length: String(text).length,
    };
}

/**
 * 页面内：执行 JS（CDP 不可用时兜底）
 */
function evalCodeInPage(code) {
    try {
        // eslint-disable-next-line no-eval
        const value = (0, eval)(String(code));
        return { ok: true, value };
    } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
    }
}

// ========== 指令执行器 ==========

async function executeCommand(command) {
    const { action } = command;

    // 需要站点权限检查的操作（排除纯信息查询类操作）
    const ACTIONS_NEED_PERMISSION = new Set([
        'navigate', 'cdp_click', 'cdp_type', 'evaluate_js',
        'get_markdown', 'get_interactive_elements', 'take_screenshot',
        'get_console_logs', 'get_network_logs',
    ]);

    if (ACTIONS_NEED_PERMISSION.has(action)) {
        try {
            const tab = await getActiveTab();
            const permCheck = await checkSitePermission(tab.url);
            if (!permCheck.allowed) {
                throw new Error(permCheck.reason);
            }
        } catch (err) {
            if (err.message && err.message.includes('黑名单') || err.message.includes('白名单')) {
                throw err;
            }
            // getActiveTab 失败等情况，不阻塞
        }
    }

    switch (action) {
        case 'navigate':
            return await cmdNavigate(command);

        case 'get_markdown':
            return await cmdGetMarkdown(command);

        case 'get_interactive_elements':
            return await cmdGetInteractiveElements(command);

        case 'cdp_click':
            return await cmdCdpClick(command);

        case 'cdp_type':
            return await cmdCdpType(command);

        case 'evaluate_js':
            return await cmdEvaluateJs(command);

        case 'get_tab_info':
            return await cmdGetTabInfo();

        // ===== 新功能: 截图 =====
        case 'take_screenshot':
            return await cmdTakeScreenshot(command);

        // ===== 新功能: Console / Network 日志 =====
        case 'get_console_logs':
            return await cmdGetConsoleLogs(command);
        case 'get_network_logs':
            return await cmdGetNetworkLogs(command);

        // ===== 新功能: 多标签页管理 =====
        case 'list_tabs':
            return await cmdListTabs();
        case 'switch_tab':
            return await cmdSwitchTab(command);
        case 'create_tab':
            return await cmdCreateTab(command);
        case 'close_tab':
            return await cmdCloseTab(command);

        default:
            throw new Error(`未知指令: ${action}`);
    }
}

// ---------- 获取标签页信息 ----------

async function cmdGetTabInfo() {
    const tab = await getActiveTab();
    return {
        action: 'get_tab_info',
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        status: tab.status,
        restricted: isRestrictedUrl(tab.url),
        controllable: !isRestrictedUrl(tab.url),
    };
}

// ---------- 导航 ----------

async function cmdNavigate({ url }) {
    const tab = await getActiveTab();
    const updatedTab = await updateTabUrlAndWait(tab.id, url);
    return { action: 'navigate', status: 'ok', url: updatedTab.url || url };
}

function updateTabUrlAndWait(tabId, url, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        let done = false;
        let timer = null;

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
        };

        const finish = (tab) => {
            if (done) return;
            done = true;
            cleanup();
            resolve(tab);
        };

        const fail = (err) => {
            if (done) return;
            done = true;
            cleanup();
            reject(err instanceof Error ? err : new Error(toErrorMessage(err)));
        };

        const listener = (updatedTabId, changeInfo, updatedTab) => {
            if (updatedTabId !== tabId) return;
            if (changeInfo.status === 'complete') {
                finish(updatedTab);
            }
        };

        chrome.tabs.onUpdated.addListener(listener);

        timer = setTimeout(() => {
            fail(new Error(`页面加载超时: ${url}`));
        }, timeoutMs);

        chrome.tabs.update(tabId, { url }).catch(fail);
    });
}

// ---------- 获取 Markdown（全 CDP 实现，普通网页可用） ----------

async function cmdGetMarkdown() {
    const tab = await ensureControllableTab(await getActiveTab(), 'get_markdown');
    let markdown = '';
    let cdpError = null;

    try {
        markdown = await cdpEval(tab.id, tab.url, `
            (function() {
                return String(document.body?.innerText || document.documentElement?.innerText || '')
                    .replace(/\\s+/g, ' ')
                    .trim()
                    .slice(0, 12000);
            })()
        `);
    } catch (err) {
        cdpError = toErrorMessage(err);
        console.warn('[PhantomBridge] get_markdown CDP 失败，回退 scripting:', cdpError);
    }

    if (!String(markdown || '').trim()) {
        try {
            markdown = await execScriptInTab(tab.id, extractMarkdownInPage, [240, 12000]);
        } catch (err) {
            const scriptError = toErrorMessage(err);
            if (cdpError) {
                throw new Error(`提取页面内容失败: CDP=${cdpError}; Scripting=${scriptError}`);
            }
            throw new Error(`提取页面内容失败: ${scriptError}`);
        }
    }

    return {
        action: 'get_markdown',
        markdown: String(markdown || '').trim() || tab.title || '',
        url: tab.url,
        title: tab.title,
    };
}

// ---------- 获取交互元素（全 CDP 实现，普通网页可用） ----------

async function cmdGetInteractiveElements() {
    const tab = await ensureControllableTab(await getActiveTab(), 'get_interactive_elements');
    let elements = [];
    let cdpError = null;

    try {
        const cdpElements = await cdpEval(tab.id, tab.url, `
            (function() {
                const selectors = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick], [tabindex]:not([tabindex="-1"])';
                const els = document.querySelectorAll(selectors);
                const out = [];
                let i = 0;
                for (const el of els) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width <= 1 || rect.height <= 1) continue;
                    if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) continue;
                    const style = getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
                    out.push({
                        id: i++,
                        tag: String(el.tagName || '').toLowerCase(),
                        text: String(el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
                        x: Math.round(rect.left + rect.width / 2),
                        y: Math.round(rect.top + rect.height / 2),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height)
                    });
                    if (out.length >= 300) break;
                }
                return out;
            })()
        `);
        elements = Array.isArray(cdpElements) ? cdpElements : [];
    } catch (err) {
        cdpError = toErrorMessage(err);
        console.warn('[PhantomBridge] get_interactive_elements CDP 失败，回退 scripting:', cdpError);
    }

    if (elements.length === 0) {
        try {
            const scripted = await execScriptInTab(tab.id, extractInteractiveElementsInPage, [400]);
            elements = Array.isArray(scripted) ? scripted : [];
        } catch (err) {
            const scriptError = toErrorMessage(err);
            if (cdpError) {
                throw new Error(`提取交互元素失败: CDP=${cdpError}; Scripting=${scriptError}`);
            }
            throw new Error(`提取交互元素失败: ${scriptError}`);
        }
    }

    return {
        action: 'get_interactive_elements',
        elements,
        url: tab.url,
    };
}

// ---------- CDP 真实点击 ----------

async function cmdCdpClick({ x, y, button = 'left' }) {
    const tab = await ensureControllableTab(await getActiveTab(), 'cdp_click');
    const buttonMap = { left: 'left', right: 'right', middle: 'middle' };
    const cdpButton = buttonMap[button] || 'left';
    try {
        const target = await ensureDebugger(tab.id, tab.url);
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved', x, y,
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mousePressed', x, y, button: cdpButton, clickCount: 1,
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x, y, button: cdpButton, clickCount: 1,
        });

        return { action: 'cdp_click', status: 'ok', mode: 'cdp', x, y, button: cdpButton };
    } catch (err) {
        if (!isDebuggerOccupiedError(err)) {
            throw err;
        }
        console.warn('[PhantomBridge] cdp_click 调试器占用，回退 scripting');
        const fallback = await execScriptInTab(tab.id, clickAtPointInPage, [x, y, cdpButton]);
        if (!fallback?.ok) {
            throw new Error(`点击失败（scripting 兜底）: ${fallback?.error || '未知错误'}`);
        }
        return {
            action: 'cdp_click',
            status: 'ok',
            mode: 'scripting',
            x,
            y,
            button: cdpButton,
            targetTag: fallback.tag,
            targetText: fallback.text,
        };
    }
}

// ---------- CDP 键盘输入 ----------

async function cmdCdpType({ text }) {
    const tab = await ensureControllableTab(await getActiveTab(), 'cdp_type');
    try {
        const target = await ensureDebugger(tab.id, tab.url);

        for (const char of text) {
            await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
                type: 'keyDown', text: char, key: char, code: `Key${char.toUpperCase()}`,
            });
            await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
                type: 'char', text: char,
            });
            await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
                type: 'keyUp', key: char, code: `Key${char.toUpperCase()}`,
            });
            await new Promise((r) => setTimeout(r, 30 + Math.random() * 50));
        }

        return { action: 'cdp_type', status: 'ok', mode: 'cdp', length: text.length };
    } catch (err) {
        if (!isDebuggerOccupiedError(err)) {
            throw err;
        }
        console.warn('[PhantomBridge] cdp_type 调试器占用，回退 scripting');
        const fallback = await execScriptInTab(tab.id, typeTextInPage, [text]);
        if (!fallback?.ok) {
            throw new Error(`输入失败（scripting 兜底）: ${fallback?.error || '未知错误'}`);
        }
        return {
            action: 'cdp_type',
            status: 'ok',
            mode: 'scripting',
            length: fallback.length || String(text).length,
            targetTag: fallback.tag,
        };
    }
}

// ---------- 执行 JavaScript ----------

async function cmdEvaluateJs({ code }) {
    const tab = await ensureControllableTab(await getActiveTab(), 'evaluate_js');
    try {
        const value = await cdpEval(tab.id, tab.url, code, true);
        return {
            action: 'evaluate_js',
            result: value,
            mode: 'cdp',
        };
    } catch (err) {
        if (!isDebuggerOccupiedError(err)) {
            throw err;
        }
        console.warn('[PhantomBridge] evaluate_js 调试器占用，回退 scripting');
        const fallback = await execScriptInTab(tab.id, evalCodeInPage, [code]);
        if (!fallback?.ok) {
            throw new Error(`evaluate_js 失败（scripting 兜底）: ${fallback?.error || '未知错误'}`);
        }
        return {
            action: 'evaluate_js',
            result: fallback.value,
            mode: 'scripting',
        };
    }
}

// ========== 新功能: 截图 ==========

async function cmdTakeScreenshot({ clip } = {}) {
    const tab = await getActiveTab();

    // 优先尝试 CDP 截图（更灵活，支持 clip）
    if (!isRestrictedUrl(tab.url)) {
        try {
            const target = await ensureDebugger(tab.id, tab.url);
            const params = { format: 'png' };
            if (clip && typeof clip === 'object') {
                params.clip = {
                    x: Number(clip.x) || 0,
                    y: Number(clip.y) || 0,
                    width: Number(clip.width) || 800,
                    height: Number(clip.height) || 600,
                    scale: 1,
                };
            }
            const result = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', params);
            // 同时启用日志收集
            enableCdpLogging(tab.id, tab.url);
            return {
                action: 'take_screenshot',
                dataUrl: `data:image/png;base64,${result.data}`,
                mode: 'cdp',
                url: tab.url,
                title: tab.title,
            };
        } catch (err) {
            if (!isDebuggerOccupiedError(err)) {
                console.warn('[PhantomBridge] CDP 截图失败，回退 captureVisibleTab:', toErrorMessage(err));
            }
        }
    }

    // 兜底：chrome.tabs.captureVisibleTab (不支持 clip，但不需要 debugger)
    try {
        const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
        return {
            action: 'take_screenshot',
            dataUrl,
            mode: 'captureVisibleTab',
            url: tab.url,
            title: tab.title,
        };
    } catch (err) {
        throw new Error(`截图失败: ${toErrorMessage(err)}`);
    }
}

// ========== 新功能: Console / Network 日志 ==========

async function cmdGetConsoleLogs({ count = 20 } = {}) {
    // 自动尝试启用 CDP 日志收集
    try {
        const tab = await getActiveTab();
        if (!isRestrictedUrl(tab.url)) {
            await enableCdpLogging(tab.id, tab.url);
        }
    } catch { }

    const n = Math.min(Math.max(1, Number(count) || 20), MAX_LOG_BUFFER);
    const logs = consoleLogs.slice(-n);
    return {
        action: 'get_console_logs',
        logs,
        total: consoleLogs.length,
        maxBuffer: MAX_LOG_BUFFER,
    };
}

async function cmdGetNetworkLogs({ count = 20, errorsOnly = false } = {}) {
    try {
        const tab = await getActiveTab();
        if (!isRestrictedUrl(tab.url)) {
            await enableCdpLogging(tab.id, tab.url);
        }
    } catch { }

    const n = Math.min(Math.max(1, Number(count) || 20), MAX_LOG_BUFFER);
    let logs = networkLogs.slice(-n);
    if (errorsOnly) {
        logs = logs.filter(l => l.status === 0 || l.status >= 400);
    }
    return {
        action: 'get_network_logs',
        logs,
        total: networkLogs.length,
        maxBuffer: MAX_LOG_BUFFER,
    };
}

// ========== 新功能: 多标签页管理 ==========

async function cmdListTabs() {
    const tabs = await chrome.tabs.query({});
    return {
        action: 'list_tabs',
        tabs: tabs.map(t => ({
            id: t.id,
            url: t.url || '',
            title: t.title || '',
            active: !!t.active,
            windowId: t.windowId,
            index: t.index,
            restricted: isRestrictedUrl(t.url),
        })),
    };
}

async function cmdSwitchTab({ tabId }) {
    const id = Number(tabId);
    if (!Number.isFinite(id)) throw new Error('switch_tab 需要有效的 tabId');
    await chrome.tabs.update(id, { active: true });
    const tab = await chrome.tabs.get(id);
    // 聚焦其所在窗口
    if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true });
    }
    return {
        action: 'switch_tab',
        status: 'ok',
        tabId: id,
        url: tab.url,
        title: tab.title,
    };
}

async function cmdCreateTab({ url = 'about:blank', active = true } = {}) {
    const tab = await chrome.tabs.create({ url, active });
    return {
        action: 'create_tab',
        status: 'ok',
        tabId: tab.id,
        url: tab.pendingUrl || tab.url || url,
    };
}

async function cmdCloseTab({ tabId }) {
    const id = Number(tabId);
    if (!Number.isFinite(id)) throw new Error('close_tab 需要有效的 tabId');
    await chrome.tabs.remove(id);
    return {
        action: 'close_tab',
        status: 'ok',
        tabId: id,
    };
}

// ========== 启动 ==========

// 扩展安装/更新时启动连接
chrome.runtime.onInstalled.addListener(() => {
    console.log('[PhantomBridge] 扩展已安装/更新');
    connectToGateway();

    // 设置点击扩展图标打开侧边栏
    if (chrome.sidePanel) {
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
            .catch((e) => console.warn('[PhantomBridge] sidePanel 设置失败:', e.message));
    }
});

// Chrome 启动后唤醒 Service Worker，并主动重连网关
chrome.runtime.onStartup.addListener(() => {
    console.log('[PhantomBridge] 浏览器启动，准备连接网关');
    connectToGateway();
});

// Service Worker 激活时启动连接
connectToGateway();

// ========== 消息监听（Content Script + Side Panel） ==========

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Content Script 就绪通知
    if (message.type === 'PHANTOM_CONTENT_READY') {
        console.log(`[PhantomBridge] Content Script 就绪: ${sender.tab?.url}`);
        sendResponse({ status: 'ok' });
        return false;
    }

    // Side Panel 状态查询
    if (message.type === 'SIDEPANEL_STATUS') {
        sendResponse({
            connected: ws && ws.readyState === WebSocket.OPEN,
        });
        return false;
    }

    // Side Panel 命令执行
    if (message.type === 'SIDEPANEL_COMMAND') {
        const command = message.command;
        console.log(`[PhantomBridge] 侧面板指令: ${command.action}`);

        executeCommand(command)
            .then((result) => sendResponse(result))
            .catch((err) => sendResponse({ error: err.message }));

        return true; // 异步响应
    }

    // 站点权限管理
    if (message.type === 'GET_PERMISSIONS') {
        loadSitePermissions()
            .then((perms) => sendResponse(perms))
            .catch(() => sendResponse(DEFAULT_PERMISSIONS));
        return true;
    }

    if (message.type === 'SET_PERMISSIONS') {
        saveSitePermissions(message.permissions)
            .then(() => sendResponse({ success: true }))
            .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.type === 'CHECK_SITE_PERMISSION') {
        checkSitePermission(message.url)
            .then((result) => sendResponse(result))
            .catch(() => sendResponse({ allowed: true, reason: '检查失败，默认允许' }));
        return true;
    }

    return false;
});

console.log('[PhantomBridge] Service Worker 已启动 🌌', BUILD_ID);

// 自动为活动标签页启用 CDP 日志收集
try {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.id && !isRestrictedUrl(tab.url)) {
            enableCdpLogging(tab.id, tab.url);
        }
    });
} catch { }
