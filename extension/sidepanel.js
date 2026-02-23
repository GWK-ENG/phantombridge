/**
 * PhantomBridge - Side Panel 聊天界面
 * 
 * 功能：
 * 1. 命令行式交互（/navigate, /markdown, /elements, /click, /type 等）
 * 2. CLI 模式切换
 * 3. 与 background.js Service Worker 通信
 * 4. 状态实时显示
 */

// ========== DOM 引用 ==========

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const chatArea = $('#chatArea');
const welcomeCard = $('#welcomeCard');
const messageInput = $('#messageInput');
const sendBtn = $('#sendBtn');
const modelBtn = $('#modelBtn');
const modelSelector = $('#modelSelector');
const modelDropdown = $('#modelDropdown');
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const brandHeader = $('#brandHeader');
const settingsBtn = $('#settingsBtn');
const settingsPanel = $('#settingsPanel');
const settingsCloseBtn = $('#settingsCloseBtn');
const confirmOverlay = $('#confirmOverlay');
const confirmBody = $('#confirmBody');
const confirmAllowBtn = $('#confirmAllowBtn');
const confirmDenyBtn = $('#confirmDenyBtn');
const captchaWarning = $('#captchaWarning');

// ========== 配置 ==========

const GATEWAY_URL = 'http://localhost:7778';
const conversationId = 'sidepanel-' + Date.now();
const BUILD_ID = '2026-02-19-v14-safety-features';
const CLI_DETECT_TIMEOUT_MS = 5000;
const CLI_DETECT_RETRY_MS = 3000;

// ========== 状态 ==========

let currentCli = null;      // 当前选中的 CLI id
let detectedClis = [];       // 检测到的 CLI 列表
let isWaiting = false;
let messageCount = 0;
let gatewayConnected = false;
let lastClickedElement = null; // { x, y, text, tag, url, at }
let lastExecutionTrace = null; // 最近一次自动执行轨迹
let cliDetectRetryCount = 0;
let cliDetectTimer = null;
let lastCliDetectError = '';

// ========== 命令定义 ==========

const COMMANDS = {
    '/help': { desc: '显示帮助信息', handler: cmdHelp },
    '/tab': { desc: '获取当前标签页信息', handler: cmdTabInfo },
    '/markdown': { desc: '提取页面 Markdown', handler: cmdMarkdown },
    '/elements': { desc: '扫描交互元素', handler: cmdElements },
    '/screenshot': { desc: '截取当前页面截图', handler: cmdScreenshot },
    '/console': { desc: '查看 Console 日志', handler: cmdConsoleLogs },
    '/network': { desc: '查看网络请求日志', handler: cmdNetworkLogs },
    '/tabs': { desc: '列出所有标签页', handler: cmdListTabs },
    '/debugctx': { desc: '诊断当前页面上下文', handler: cmdDebugContext },
    '/trace': { desc: '查看最近执行轨迹', handler: cmdTrace },
    '/clitest': { desc: '测试 CLI 连通性', handler: cmdCliTest, args: '[all|当前cli]' },
    '/navigate': { desc: '导航到 URL', handler: cmdNavigate, args: '<url>' },
    '/click': { desc: 'CDP 点击坐标', handler: cmdClick, args: '<x> <y>' },
    '/type': { desc: 'CDP 键盘输入', handler: cmdType, args: '<text>' },
    '/eval': { desc: '执行 JavaScript', handler: cmdEval, args: '<code>' },
    '/clear': { desc: '清空聊天记录', handler: cmdClear },
    '/status': { desc: '查看连接状态', handler: cmdStatus },
};

const TOOL_ACTIONS = new Set([
    'navigate',
    'get_markdown',
    'get_interactive_elements',
    'cdp_click',
    'cdp_type',
    'evaluate_js',
    'get_tab_info',
    'take_screenshot',
    'get_console_logs',
    'get_network_logs',
    'list_tabs',
    'switch_tab',
    'create_tab',
    'close_tab',
]);

const MAX_TOOL_ROUNDS = 4;
const MAX_TOOL_CALLS_PER_ROUND = 6;
const MAX_MARKDOWN_CONTEXT = 2500;
const MAX_ELEMENTS_CONTEXT = 60;
const MIN_RELEVANCE_SCORE = 0.12;
const MAX_RELEVANCE_KEYWORDS = 18;
const RELEVANCE_STOPWORDS = new Set([
    '请', '帮我', '一下', '一下子', '这个', '那个', '这里', '那里', '是否', '是不是',
    '可以', '能够', '能不能', '你', '我', '他', '她', '它', '我们', '你们', '他们',
    '现在', '当前', '然后', '并且', '或者', '以及', '还有', '已经', '还是', '就是',
    '页面', '网页', '内容', '信息', '一下子', '看看', '看下', '一下啊', '谢谢',
    'the', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'is', 'are',
    'can', 'could', 'would', 'please', 'help', 'with', 'that', 'this', 'from', 'your',
]);

// ========== 初始化 ==========

function init() {
    // 输入框事件
    messageInput.addEventListener('input', onInputChange);
    messageInput.addEventListener('keydown', onInputKeydown);

    // 发送按钮
    sendBtn.addEventListener('click', handleSend);

    // 快捷按钮
    $$('.quick-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const cmd = btn.dataset.cmd;
            messageInput.value = cmd;
            onInputChange();
            handleSend();
        });
    });

    // 模型选择器（底部 CLI 切换）
    modelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        modelSelector.classList.toggle('open');
    });

    // 点击外部关闭下拉菜单
    document.addEventListener('click', () => {
        modelSelector.classList.remove('open');
    });

    // 检查连接状态
    checkGatewayStatus();
    setInterval(checkGatewayStatus, 5000);

    // 自动检测本地 CLI 工具
    detectClis();

    // 设置问候语
    setGreeting();

    // 设置面板
    settingsBtn.addEventListener('click', openSettings);
    settingsCloseBtn.addEventListener('click', closeSettings);
    settingsPanel.addEventListener('click', (e) => {
        if (e.target === settingsPanel) closeSettings();
    });
}

// ========== 安全设置 ==========

async function openSettings() {
    const perms = await chrome.runtime.sendMessage({ type: 'GET_PERMISSIONS' });

    $('#permEnabled').checked = perms.enabled !== false;
    $('#permMode').value = perms.mode || 'blocklist';
    $('#highRiskConfirm').checked = perms.highRiskConfirm !== false;
    $('#captchaDetect').checked = perms.captchaDetect !== false;
    $('#promptInjectionGuard').checked = perms.promptInjectionGuard !== false;

    renderPatternList('blocklist', perms.blocklist || []);
    renderPatternList('allowlist', perms.allowlist || []);
    updateListVisibility(perms.mode || 'blocklist');

    $('#permMode').onchange = (e) => updateListVisibility(e.target.value);

    $('#blocklistAddBtn').onclick = () => addPattern('blocklist');
    $('#allowlistAddBtn').onclick = () => addPattern('allowlist');
    $('#blocklistInput').onkeydown = (e) => { if (e.key === 'Enter') addPattern('blocklist'); };
    $('#allowlistInput').onkeydown = (e) => { if (e.key === 'Enter') addPattern('allowlist'); };

    const saveOnChange = () => saveCurrentPermissions();
    $('#permEnabled').onchange = saveOnChange;
    $('#permMode').addEventListener('change', saveOnChange);
    $('#highRiskConfirm').onchange = saveOnChange;
    $('#captchaDetect').onchange = saveOnChange;
    $('#promptInjectionGuard').onchange = saveOnChange;

    settingsPanel.style.display = '';
}

function closeSettings() {
    settingsPanel.style.display = 'none';
}

function updateListVisibility(mode) {
    $('#blocklistSection').style.display = mode === 'blocklist' ? '' : 'none';
    $('#allowlistSection').style.display = mode === 'allowlist' ? '' : 'none';
}

function renderPatternList(listName, patterns) {
    const container = $(`#${listName}Items`);
    container.innerHTML = '';
    patterns.forEach((pattern, i) => {
        const item = document.createElement('div');
        item.className = 'pattern-item';
        item.innerHTML = `
            <span>${escapeHtml(pattern)}</span>
            <button class="pattern-remove-btn" data-list="${listName}" data-index="${i}">✕</button>
        `;
        item.querySelector('.pattern-remove-btn').addEventListener('click', () => {
            removePattern(listName, i);
        });
        container.appendChild(item);
    });
}

async function addPattern(listName) {
    const input = $(`#${listName}Input`);
    const value = input.value.trim();
    if (!value) return;

    const perms = await chrome.runtime.sendMessage({ type: 'GET_PERMISSIONS' });
    const list = perms[listName] || [];
    if (list.includes(value)) {
        input.value = '';
        return;
    }
    list.push(value);
    perms[listName] = list;
    await chrome.runtime.sendMessage({ type: 'SET_PERMISSIONS', permissions: perms });
    input.value = '';
    renderPatternList(listName, list);
}

async function removePattern(listName, index) {
    const perms = await chrome.runtime.sendMessage({ type: 'GET_PERMISSIONS' });
    const list = perms[listName] || [];
    list.splice(index, 1);
    perms[listName] = list;
    await chrome.runtime.sendMessage({ type: 'SET_PERMISSIONS', permissions: perms });
    renderPatternList(listName, list);
}

async function saveCurrentPermissions() {
    const perms = await chrome.runtime.sendMessage({ type: 'GET_PERMISSIONS' });
    perms.enabled = $('#permEnabled').checked;
    perms.mode = $('#permMode').value;
    perms.highRiskConfirm = $('#highRiskConfirm').checked;
    perms.captchaDetect = $('#captchaDetect').checked;
    perms.promptInjectionGuard = $('#promptInjectionGuard').checked;
    await chrome.runtime.sendMessage({ type: 'SET_PERMISSIONS', permissions: perms });
}

// ========== 高风险操作确认 ==========

const HIGH_RISK_PATTERNS = [
    { pattern: /(购买|付款|支付|checkout|purchase|pay|buy)/i, label: '支付/购买' },
    { pattern: /(删除|移除|清空|remove|delete|clear|drop)/i, label: '删除操作' },
    { pattern: /(发布|提交|发送|submit|publish|post|send)/i, label: '发布/提交' },
    { pattern: /(注销|退出|登出|logout|signout|sign.out)/i, label: '登出操作' },
    { pattern: /(转账|汇款|transfer|wire)/i, label: '转账操作' },
    { pattern: /(确认订单|下单|place.order)/i, label: '下单操作' },
];

function detectHighRiskAction(command, context) {
    if (command.action === 'evaluate_js') {
        const code = String(command.code || '');
        if (/(\.submit\(\)|\.click\(\)|location\s*=|window\.open)/i.test(code)) {
            return { risky: true, label: '执行可能改变页面状态的 JavaScript', detail: code.slice(0, 120) };
        }
    }

    if (command.action === 'cdp_click' && context?.elements) {
        const x = command.x, y = command.y;
        const nearby = (context.elements || []).find(el =>
            Math.abs(el.x - x) < 30 && Math.abs(el.y - y) < 30
        );
        if (nearby) {
            const text = String(nearby.text || '');
            for (const { pattern, label } of HIGH_RISK_PATTERNS) {
                if (pattern.test(text)) {
                    return { risky: true, label, detail: `点击「${text}」(${x}, ${y})` };
                }
            }
        }
    }

    if (command.action === 'navigate') {
        const url = String(command.url || '');
        if (/(payment|checkout|pay|billing)/i.test(url)) {
            return { risky: true, label: '导航到支付页面', detail: url };
        }
    }

    return { risky: false };
}

let _confirmResolve = null;

function showConfirmDialog(riskInfo) {
    return new Promise((resolve) => {
        _confirmResolve = resolve;
        confirmBody.innerHTML = `
            <p><strong>操作类型：</strong>${escapeHtml(riskInfo.label)}</p>
            <p><strong>详情：</strong>${escapeHtml(riskInfo.detail || '(无)')}</p>
            <p style="margin-top:8px;color:var(--warning);">此操作可能产生实际影响（如扣款、删除数据），请确认是否继续。</p>
        `;
        confirmOverlay.style.display = '';

        confirmAllowBtn.onclick = () => {
            confirmOverlay.style.display = 'none';
            _confirmResolve = null;
            resolve(true);
        };
        confirmDenyBtn.onclick = () => {
            confirmOverlay.style.display = 'none';
            _confirmResolve = null;
            resolve(false);
        };
    });
}

// ========== CAPTCHA 检测 ==========

const CAPTCHA_SIGNATURES = [
    /recaptcha/i,
    /hcaptcha/i,
    /cf-challenge/i,
    /captcha/i,
    /challenge-platform/i,
    /turnstile/i,
    /arkose/i,
    /funcaptcha/i,
];

function detectCaptchaInMarkdown(markdown) {
    const text = String(markdown || '');
    return CAPTCHA_SIGNATURES.some(sig => sig.test(text));
}

function detectCaptchaInElements(elements) {
    if (!Array.isArray(elements)) return false;
    return elements.some(el => {
        const text = String(el.text || '').toLowerCase();
        const tag = String(el.tag || '');
        return CAPTCHA_SIGNATURES.some(sig => sig.test(text) || sig.test(tag));
    });
}

let captchaWarningVisible = false;

function showCaptchaWarning() {
    if (captchaWarningVisible) return;
    captchaWarningVisible = true;
    captchaWarning.style.display = '';
    setTimeout(() => {
        captchaWarning.style.display = 'none';
        captchaWarningVisible = false;
    }, 8000);
}

// ========== 提示注入防护 ==========

const INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /ignore\s+(the\s+)?(above|prior)/i,
    /disregard\s+(all\s+)?previous/i,
    /forget\s+(all\s+)?previous/i,
    /you\s+are\s+now\s+a/i,
    /new\s+instructions?\s*:/i,
    /system\s*:\s*you\s+are/i,
    /ADMIN\s*OVERRIDE/i,
    /忽略(之前|以上|上面)(的|所有)?指令/,
    /无视(之前|以上|上面)(的|所有)?指令/,
    /你现在(是|扮演)/,
    /新(的)?指令\s*[：:]/,
];

function sanitizePromptContent(text) {
    let sanitized = String(text || '');
    let injectionDetected = false;

    for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(sanitized)) {
            injectionDetected = true;
            sanitized = sanitized.replace(pattern, '[内容已过滤]');
        }
    }

    return { sanitized, injectionDetected };
}

// ========== 问候语 ==========

function setGreeting() {
    const hour = new Date().getHours();
    let greeting;
    if (hour < 6) greeting = '夜深了，还在忙？';
    else if (hour < 12) greeting = 'Hi，早上好！👋';
    else if (hour < 14) greeting = 'Hi，中午好！';
    else if (hour < 18) greeting = 'Hi，下午好！';
    else greeting = 'Hi，晚上好！🌙';

    $('#greeting').textContent = greeting;
}

// ========== 输入处理 ==========

function onInputChange() {
    const value = messageInput.value.trim();
    sendBtn.disabled = !value || isWaiting;

    // 自动调整高度
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
}

function onInputKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!sendBtn.disabled) handleSend();
    }
}

// ========== 发送消息 ==========

async function handleSend() {
    const text = messageInput.value.trim();
    if (!text || isWaiting) return;

    // 清空输入
    messageInput.value = '';
    messageInput.style.height = 'auto';
    sendBtn.disabled = true;

    // 隐藏欢迎卡片
    if (welcomeCard) {
        welcomeCard.style.display = 'none';
    }

    // 折叠顶部区域
    brandHeader.classList.add('collapsed');

    // 添加用户消息
    addMessage('user', text);

    // 解析并执行
    if (text.startsWith('/')) {
        await handleCommand(text);
    } else {
        // 普通对话模式 — 发送到 AI 聊天后端（SSE 流式）
        await streamChat(text);
    }
}

// ========== 命令处理 ==========

async function handleCommand(text) {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    if (COMMANDS[cmd]) {
        await COMMANDS[cmd].handler(args);
    } else {
        addMessage('ai', `❌ 未知命令: \`${cmd}\`\n\n输入 \`/help\` 查看可用命令。`);
    }
}

// ========== 命令实现 ==========

function cmdHelp() {
    let html = '<div class="help-panel"><h3>📖 可用命令</h3>';
    for (const [cmd, info] of Object.entries(COMMANDS)) {
        const argStr = info.args ? ` <code>${info.args}</code>` : '';
        html += `<div class="help-cmd"><code>${cmd}</code>${argStr}<span>— ${info.desc}</span></div>`;
    }
    html += '</div>';
    addMessage('ai', html, true);
}

async function cmdTabInfo() {
    const result = await sendCommand({ action: 'get_tab_info' });
    if (result.error) {
        addMessage('ai', `❌ ${result.error}`);
        return;
    }
    const info = [
        `**标签页信息**`,
        `- **ID**: ${result.tabId}`,
        `- **URL**: ${result.url}`,
        `- **标题**: ${result.title}`,
        `- **状态**: ${result.status}`,
    ].join('\n');
    addMessage('ai', formatMarkdown(info));
}

async function cmdMarkdown() {
    const result = await sendCommand({ action: 'get_markdown' });
    if (result.error) {
        addMessage('ai', `❌ ${result.error}`);
        return;
    }
    const md = result.markdown || '(空内容)';
    const preview = md.length > 500 ? md.slice(0, 500) + '...' : md;
    addMessage('ai', `
        <div class="result-card">
            <div class="result-card-header">
                <span>📝 Markdown · ${result.title || ''}</span>
                <span>${md.length} 字符</span>
            </div>
            <div class="result-card-body"><pre><code>${escapeHtml(preview)}</code></pre></div>
        </div>
    `, true);
}

async function cmdElements() {
    const result = await sendCommand({ action: 'get_interactive_elements' });
    if (result.error) {
        addMessage('ai', `❌ ${result.error}`);
        return;
    }
    const elements = result.elements || [];
    if (elements.length === 0) {
        addMessage('ai', '🔍 未找到交互元素。');
        return;
    }

    let table = '<div class="result-card">';
    table += `<div class="result-card-header"><span>🔍 交互元素</span><span>${elements.length} 个</span></div>`;
    table += '<div class="result-card-body"><table style="width:100%;font-size:11px;border-collapse:collapse;">';
    table += '<tr style="border-bottom:1px solid var(--border);"><th style="text-align:left;padding:3px;">ID</th><th style="text-align:left;padding:3px;">标签</th><th style="text-align:left;padding:3px;">文本</th><th style="text-align:left;padding:3px;">坐标</th></tr>';

    const shown = elements.slice(0, 20);
    for (const el of shown) {
        table += `<tr style="border-bottom:1px solid var(--border);">`;
        table += `<td style="padding:3px;">${el.id}</td>`;
        table += `<td style="padding:3px;"><code>${el.tag}</code></td>`;
        table += `<td style="padding:3px;">${escapeHtml((el.text || '').slice(0, 30))}</td>`;
        table += `<td style="padding:3px;">${el.x},${el.y}</td>`;
        table += `</tr>`;
    }
    table += '</table>';
    if (elements.length > 20) {
        table += `<div style="padding:6px 0;color:var(--text-muted);font-size:11px;">...还有 ${elements.length - 20} 个元素</div>`;
    }
    table += '</div></div>';
    addMessage('ai', table, true);
}

// ---------- 截图 ----------

async function cmdScreenshot() {
    const result = await sendCommand({ action: 'take_screenshot' });
    if (result.error) {
        addMessage('ai', `❌ ${result.error}`);
        return;
    }
    const html = `
        <div class="result-card">
            <div class="result-card-header">
                <span>📸 页面截图 · ${escapeHtml(result.title || '')}</span>
                <span>${result.mode || 'unknown'}</span>
            </div>
            <div class="result-card-body" style="padding:8px;">
                <img src="${result.dataUrl}" style="max-width:100%;border-radius:6px;cursor:pointer;" 
                     onclick="window.open(this.src)" title="点击放大" />
            </div>
        </div>`;
    addMessage('ai', html, true);
}

// ---------- Console 日志 ----------

async function cmdConsoleLogs() {
    const result = await sendCommand({ action: 'get_console_logs', count: 20 });
    if (result.error) {
        addMessage('ai', `❌ ${result.error}`);
        return;
    }
    const logs = result.logs || [];
    if (logs.length === 0) {
        addMessage('ai', '📝 Console 日志为空。先浏览网页产生一些日志后再试。');
        return;
    }
    let html = '<div class="result-card">';
    html += `<div class="result-card-header"><span>📝 Console 日志</span><span>${logs.length}/${result.total} 条</span></div>`;
    html += '<div class="result-card-body"><div style="font-size:11px;font-family:monospace;max-height:300px;overflow-y:auto;">';
    for (const log of logs) {
        const color = log.level === 'error' ? '#ff6b6b' : log.level === 'warning' ? '#ffd93d' : 'var(--text-muted)';
        const time = new Date(log.timestamp).toLocaleTimeString();
        html += `<div style="padding:2px 4px;border-bottom:1px solid var(--border);">`;
        html += `<span style="color:${color};font-weight:bold;">[${log.level}]</span> `;
        html += `<span style="color:var(--text-muted);">${time}</span> `;
        html += `${escapeHtml(log.text)}`;
        html += `</div>`;
    }
    html += '</div></div></div>';
    addMessage('ai', html, true);
}

// ---------- Network 日志 ----------

async function cmdNetworkLogs() {
    const result = await sendCommand({ action: 'get_network_logs', count: 20 });
    if (result.error) {
        addMessage('ai', `❌ ${result.error}`);
        return;
    }
    const logs = result.logs || [];
    if (logs.length === 0) {
        addMessage('ai', '🌐 Network 日志为空。先浏览网页产生一些请求后再试。');
        return;
    }
    let html = '<div class="result-card">';
    html += `<div class="result-card-header"><span>🌐 Network 日志</span><span>${logs.length}/${result.total} 条</span></div>`;
    html += '<div class="result-card-body"><div style="font-size:11px;font-family:monospace;max-height:300px;overflow-y:auto;">';
    for (const log of logs) {
        const isErr = log.status === 0 || log.status >= 400;
        const color = isErr ? '#ff6b6b' : '#51cf66';
        const statusLabel = log.status === 0 ? 'FAIL' : String(log.status);
        const shortUrl = (log.url || '').length > 80 ? log.url.slice(0, 80) + '...' : log.url;
        html += `<div style="padding:2px 4px;border-bottom:1px solid var(--border);">`;
        html += `<span style="color:${color};font-weight:bold;">${statusLabel}</span> `;
        html += `<span style="color:var(--text-muted);">${log.type || ''}</span> `;
        html += `${escapeHtml(shortUrl)}`;
        html += `</div>`;
    }
    html += '</div></div></div>';
    addMessage('ai', html, true);
}

// ---------- 多标签页管理 ----------

async function cmdListTabs() {
    const result = await sendCommand({ action: 'list_tabs' });
    if (result.error) {
        addMessage('ai', `❌ ${result.error}`);
        return;
    }
    const tabs = result.tabs || [];
    if (tabs.length === 0) {
        addMessage('ai', '❌ 未获取到标签页。');
        return;
    }
    let html = '<div class="result-card">';
    html += `<div class="result-card-header"><span>📋 所有标签页</span><span>${tabs.length} 个</span></div>`;
    html += '<div class="result-card-body"><table style="width:100%;font-size:11px;border-collapse:collapse;">';
    html += '<tr style="border-bottom:1px solid var(--border);"><th style="text-align:left;padding:3px;">ID</th><th style="text-align:left;padding:3px;">标题</th><th style="text-align:left;padding:3px;">状态</th></tr>';
    for (const tab of tabs) {
        const active = tab.active ? '✅' : '';
        const shortTitle = (tab.title || '').length > 30 ? tab.title.slice(0, 30) + '...' : (tab.title || '(无标题)');
        html += `<tr style="border-bottom:1px solid var(--border);">`;
        html += `<td style="padding:3px;">${tab.id}</td>`;
        html += `<td style="padding:3px;">${escapeHtml(shortTitle)}</td>`;
        html += `<td style="padding:3px;">${active}</td>`;
        html += `</tr>`;
    }
    html += '</table></div></div>';
    addMessage('ai', html, true);
}

async function cmdDebugContext() {
    const context = await buildPageContext();
    if (context.tabError) {
        addMessage('ai', `❌ 上下文诊断失败：${context.tabError}`);
        return;
    }

    const details = [
        '**上下文诊断**',
        `- **Build**: ${BUILD_ID}`,
        `- **URL**: ${context.tab?.url || '(未知)'}`,
        `- **标题**: ${context.tab?.title || '(无标题)'}`,
        `- **可控**: ${context.controllable ? '是' : '否'}`,
        `- **Markdown 长度**: ${context.markdown.length}`,
        `- **元素数量**: ${context.elements.length}`,
        `- **Markdown 错误**: ${context.markdownError || '无'}`,
        `- **元素提取错误**: ${context.elementsError || '无'}`,
        `- **最近点击**: ${lastClickedElement ? `${lastClickedElement.x},${lastClickedElement.y} ${lastClickedElement.text || ''}` : '无'}`,
        `- **最近路径**: ${lastExecutionTrace?.path || '无'}`,
    ].join('\n');

    const preview = (context.elements || [])
        .slice(0, 8)
        .map((el) => `- \`${el.tag}\` ${el.text || '(无文本)'} @ ${el.x},${el.y}`)
        .join('\n');

    addMessage('ai', `${details}\n\n**元素预览**\n${preview || '- (无)'}`);
}

async function cmdNavigate(url) {
    if (!url) {
        addMessage('ai', '❌ 请提供 URL。用法: `/navigate https://example.com`');
        return;
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }
    const result = await sendCommand({ action: 'navigate', url });
    if (result.error) {
        addMessage('ai', `❌ ${result.error}`);
    } else {
        addMessage('ai', `✅ 已导航到: ${url}`);
    }
}

async function cmdClick(args) {
    const parts = args.split(/\s+/);
    const x = parseInt(parts[0]);
    const y = parseInt(parts[1]);
    if (isNaN(x) || isNaN(y)) {
        addMessage('ai', '❌ 请提供坐标。用法: `/click 100 200`');
        return;
    }
    const result = await sendCommand({ action: 'cdp_click', x, y });
    if (result.error) {
        addMessage('ai', `❌ ${result.error}`);
    } else {
        rememberClickedElement({ x, y, text: '', tag: 'unknown' });
        addMessage('ai', `✅ 已点击坐标 (${x}, ${y})`);
    }
}

async function cmdType(text) {
    if (!text) {
        addMessage('ai', '❌ 请提供文本。用法: `/type hello world`');
        return;
    }
    const result = await sendCommand({ action: 'cdp_type', text });
    if (result.error) {
        addMessage('ai', `❌ ${result.error}`);
    } else {
        addMessage('ai', `✅ 已输入 ${text.length} 个字符`);
    }
}

async function cmdEval(code) {
    if (!code) {
        addMessage('ai', '❌ 请提供 JS 代码。用法: `/eval document.title`');
        return;
    }
    const result = await sendCommand({ action: 'evaluate_js', code });
    if (result.error) {
        addMessage('ai', `❌ ${result.error}`);
    } else {
        const value = typeof result.result === 'object'
            ? JSON.stringify(result.result, null, 2)
            : String(result.result);
        addMessage('ai', `
            <div class="result-card">
                <div class="result-card-header"><span>⚡ eval 结果</span></div>
                <div class="result-card-body"><pre><code>${escapeHtml(value)}</code></pre></div>
            </div>
        `, true);
    }
}

function cmdClear() {
    // 清除所有消息，重新显示欢迎卡片
    chatArea.innerHTML = '';
    if (welcomeCard) {
        chatArea.appendChild(welcomeCard);
        welcomeCard.style.display = '';
    }
    brandHeader.classList.remove('collapsed');
    messageCount = 0;
    addMessage('ai', '🧹 聊天记录已清空。');
}

function cmdStatus() {
    const status = gatewayConnected ? '✅ 已连接' : '❌ 未连接';
    const cliInfo = detectedClis.length > 0
        ? detectedClis.map(c => `${c.icon} \`${c.name}\``).join(', ')
        : '正在检测...';
    const activeCli = detectedClis.find(c => c.id === currentCli);
    const activeStr = activeCli ? `${activeCli.icon} ${activeCli.name}` : '无';
    addMessage('ai', `**网关连接**: ${status}\n**当前 CLI**: ${activeStr}\n**已检测到**: ${cliInfo}`);
}

function cmdTrace() {
    if (!lastExecutionTrace) {
        addMessage('ai', '暂无执行轨迹。先发送一条普通消息再查看。');
        return;
    }

    const lines = [
        '**最近执行轨迹**',
        `- Build: ${lastExecutionTrace.build}`,
        `- 时间: ${new Date(lastExecutionTrace.at).toLocaleString()}`,
        `- CLI: ${lastExecutionTrace.cli || '(未选择)'}`,
        `- 执行路径: ${lastExecutionTrace.path || '(无)'}`,
        `- 规则兜底: ${lastExecutionTrace.usedRuleFallback ? '是' : '否'}`,
        `- 用户输入: ${lastExecutionTrace.userMessage || '(空)'}`,
    ];
    addMessage('ai', lines.join('\n'));
}

async function cmdCliTest(args) {
    const mode = String(args || '').trim().toLowerCase();
    const testAll = mode === 'all';

    let clis = [];
    try {
        const res = await fetch(`${GATEWAY_URL}/cli/detect`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        clis = Array.isArray(data.clis) ? data.clis : [];
    } catch (err) {
        addMessage('ai', `❌ 获取 CLI 列表失败：${err.message || err}`);
        return;
    }

    if (clis.length === 0) {
        addMessage('ai', '❌ 未检测到可用 CLI。');
        return;
    }

    const selected = testAll
        ? clis
        : clis.filter((c) => c.id === (currentCli || c.id)).slice(0, 1);

    const rows = [];
    for (const cli of selected) {
        const r = await runSingleCliProbe(cli.id);
        rows.push({
            id: cli.id,
            ok: r.ok,
            status: r.status,
            detail: r.detail,
            usedCli: r.usedCli,
            ms: r.ms,
            attempts: r.attempts,
        });
    }

    const lines = [
        `**CLI 连通性测试** (${testAll ? 'all' : '当前'})`,
        `- Build: ${BUILD_ID}`,
        `- 当前选择: ${currentCli || '(无)'}`,
        '',
    ];

    for (const row of rows) {
        const icon = row.ok ? '✅' : row.status === 'timeout' ? '⏱️' : row.status === 'not_configured' ? '⚙️' : '❌';
        lines.push(`${icon} \`${row.id}\` -> status=\`${row.status}\`, used=\`${row.usedCli || '-'}\`, ${row.ms}ms, 尝试${row.attempts}次, ${row.detail}`);
    }

    addMessage('ai', lines.join('\n'));
}

async function runSingleCliProbe(cliId) {
    const timeoutMs = (cliId === 'gemini' || cliId === 'ollama') ? 120000 : 90000;
    const attempts = 2;
    let last = null;

    for (let i = 1; i <= attempts; i++) {
        const r = await runCliProbeOnce(cliId, timeoutMs, i);
        if (r.ok) {
            return r;
        }
        last = r;

        // 未配置类错误不重试
        if (r.status === 'not_configured') {
            return r;
        }
    }

    return last || {
        ok: false,
        status: 'error',
        usedCli: cliId,
        ms: 0,
        attempts,
        detail: '未知错误',
    };
}

async function runCliProbeOnce(cliId, timeoutMs, attempt) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const probePrompt = cliId === 'ollama'
        ? 'Respond with exactly CLI_OK. No thinking, no explanation.'
        : 'Reply exactly: CLI_OK';

    try {
        const res = await fetch(`${GATEWAY_URL}/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: probePrompt,
                cli: cliId,
                conversationId: `probe-${Date.now()}-${cliId}-a${attempt}`,
                allowFallback: false,
            }),
            signal: controller.signal,
        });

        const ms = Date.now() - start;
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            const detail = String(err.error || `HTTP ${res.status}`);
            const lower = detail.toLowerCase();
            const status = isNotConfiguredError(lower) ? 'not_configured' : 'error';
            return {
                ok: false,
                status,
                usedCli: cliId,
                ms,
                attempts: attempt,
                detail,
            };
        }

        const data = await res.json();
        const text = String(data.text || '').trim().slice(0, 200);
        const usedCli = data.cli || cliId;
        const lower = text.toLowerCase();
        const looksBad = /execution error|error:|usage:|failed|forbidden|unauthorized/.test(lower);
        const ok = !!data.success && !looksBad && text.length > 0;
        return {
            ok,
            status: ok ? 'ok' : 'error',
            usedCli,
            ms,
            attempts: attempt,
            detail: ok ? `text="${text}"` : `text="${text || '(空)'}"`,
        };
    } catch (err) {
        return {
            ok: false,
            status: err.name === 'AbortError' ? 'timeout' : 'error',
            usedCli: cliId,
            ms: Date.now() - start,
            attempts: attempt,
            detail: err.name === 'AbortError' ? `超时(${Math.round(timeoutMs / 1000)}s)` : (err.message || String(err)),
        };
    } finally {
        clearTimeout(timer);
    }
}

function isNotConfiguredError(lowerText) {
    const t = String(lowerText || '');
    return (
        t.includes('api key is missing') ||
        t.includes('google_generative_ai_api_key') ||
        t.includes('authentication') ||
        t.includes('not logged in') ||
        t.includes('missing credentials')
    );
}

// ========== 与 Background.js 通信 ==========

async function sendCommand(command, options = {}) {
    const quiet = !!options.quiet;

    if (!quiet) {
        setWaiting(true);
        showThinking();
    }

    try {
        const response = await chrome.runtime.sendMessage({
            type: 'SIDEPANEL_COMMAND',
            command,
        });
        return response || {};
    } catch (err) {
        return { error: err.message || '通信失败' };
    } finally {
        if (!quiet) {
            hideThinking();
            setWaiting(false);
        }
    }
}

async function checkGatewayStatus() {
    try {
        const response = await chrome.runtime.sendMessage({
            type: 'SIDEPANEL_STATUS',
        });
        gatewayConnected = response?.connected || false;
    } catch {
        gatewayConnected = false;
    }
    updateStatus();
}

// ========== AI 聊天（自动工具调用） ==========

async function streamChat(userMessage) {
    setWaiting(true);

    const msgDiv = document.createElement('div');
    msgDiv.className = 'message ai';
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.innerHTML = '<div class="thinking-indicator"><div class="thinking-dot"></div><div class="thinking-dot"></div><div class="thinking-dot"></div></div>';
    msgDiv.appendChild(bubble);
    chatArea.appendChild(msgDiv);
    scrollToBottom();

    try {
        const context = await buildPageContext();
        if (context.tabError) {
            bubble.innerHTML = formatMarkdown(`❌ 获取页面上下文失败：${context.tabError}`);
            scrollToBottom();
            setWaiting(false);
            return;
        }
        if (!context.controllable) {
            const currentUrl = context.tab?.url || '(未知)';
            bubble.innerHTML = formatMarkdown(
                `❌ 当前页面受 Chrome 安全策略限制，无法自动识别或点击：\`${currentUrl}\`\n\n请切换到普通网页（如 https://example.com）后重试。`
            );
            scrollToBottom();
            setWaiting(false);
            return;
        }

        let prompt = buildAgentPrompt(userMessage, context);
        let finalText = '';
        const runTrace = [];
        let usedRuleFallback = false;
        let usedRelevanceRecovery = false;

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const ai = await chatOnce(prompt);
            if (ai.fallbackFrom && ai.cli && ai.cli !== currentCli) {
                const prevCli = currentCli || ai.fallbackFrom;
                currentCli = ai.cli;
                if (Array.isArray(detectedClis) && detectedClis.some((c) => c.id === currentCli)) {
                    renderTopCliSelector();
                    renderCliDropdown();
                }
                runTrace.push(`CLI:auto-fallback(${prevCli}->${ai.cli})`);
            }
            const modelText = (ai.text || '').trim();
            const toolCalls = extractToolCalls(modelText).slice(0, MAX_TOOL_CALLS_PER_ROUND);
            const cleanText = cleanToolBlocks(modelText);
            const roundCli = ai.cli || currentCli || 'unknown';

            if (toolCalls.length === 0) {
                runTrace.push(`AI:text-only(${roundCli})`);
                const candidateText = cleanText || modelText || '';
                const relevance = getReplyRelevanceScore(userMessage, candidateText);
                const isGeneric = isGenericAssistantReply(candidateText);
                const isOffTopic = isLikelyOffTopicReply(userMessage, candidateText, relevance);

                // CLI 返回通用/泛化回复时，优先尝试规则兜底（点击/输入/切换/识别类）
                const shouldFallback = isGeneric || isActionableIntent(userMessage);
                if (shouldFallback) {
                    const directHandledText = await tryHandleDirectIntent(userMessage, context);
                    if (directHandledText) {
                        finalText = directHandledText;
                        usedRuleFallback = true;
                        runTrace.push('RULE:fallback');
                        break;
                    }
                }

                if (isOffTopic) {
                    runTrace.push(`AI:offtopic(score=${relevance.toFixed(2)})`);

                    // 二次纠偏：让同一 CLI 基于“用户问题 + 上一轮偏题回答”重答
                    const recovery = await chatOnce(
                        buildRelevanceRecoveryPrompt(userMessage, context, candidateText)
                    );
                    const recoveryText = cleanToolBlocks(recovery.text || '').trim();
                    const recoveryScore = getReplyRelevanceScore(userMessage, recoveryText);

                    if (recoveryText && !isLikelyOffTopicReply(userMessage, recoveryText, recoveryScore)) {
                        finalText = recoveryText;
                        usedRelevanceRecovery = true;
                        runTrace.push(`AI:recovered(${recovery.cli || roundCli},score=${recoveryScore.toFixed(2)})`);
                    } else {
                        finalText = buildDeterministicRelevantReply(userMessage, context);
                        usedRelevanceRecovery = true;
                        runTrace.push('LOCAL:recovered');
                    }
                } else {
                    finalText = candidateText || '🤔 AI 没有返回内容。';
                }
                break;
            }

            const toolResults = [];
            for (const rawTool of toolCalls) {
                const normalized = normalizeToolCall(rawTool);
                if (!normalized.ok) {
                    toolResults.push({
                        action: rawTool?.action || 'unknown',
                        ok: false,
                        error: normalized.error,
                    });
                    continue;
                }

                const perms = await chrome.runtime.sendMessage({ type: 'GET_PERMISSIONS' });
                if (perms.highRiskConfirm) {
                    const risk = detectHighRiskAction(normalized.command, context);
                    if (risk.risky) {
                        const confirmed = await showConfirmDialog(risk);
                        if (!confirmed) {
                            toolResults.push({
                                action: normalized.command.action,
                                ok: false,
                                error: `用户取消了高风险操作: ${risk.label}`,
                            });
                            continue;
                        }
                    }
                }

                const result = await sendCommand(normalized.command, { quiet: true });
                runTrace.push(`AI:${normalized.command.action}(${roundCli})`);
                toolResults.push({
                    action: normalized.command.action,
                    command: normalized.command,
                    ok: !result.error,
                    result: result.error ? undefined : result,
                    error: result.error || null,
                });
            }

            prompt = buildToolFollowUpPrompt(userMessage, context, cleanText, toolResults);
            finalText = cleanText;

            if (round === MAX_TOOL_ROUNDS - 1) {
                finalText = (finalText ? `${finalText}\n\n` : '') + '⚠️ 已达到自动工具调用上限，请把目标拆小后重试。';
            }
        }

        // ===== Planning Mode 检测 =====
        const pathText = runTrace.length > 0 ? runTrace.join(' -> ') : 'AI:text-only';
        const planSteps = parsePlanSteps(finalText);
        if (planSteps && planSteps.length > 0) {
            // 渲染计划卡片并复用 bubble
            renderPlanCard(bubble, planSteps, finalText);
        } else {
            const finalWithPath = `${(finalText || '🤔 AI 没有返回内容。').trim()}\n\n执行路径：${pathText}`;
            bubble.innerHTML = formatMarkdown(finalWithPath);
        }

        lastExecutionTrace = {
            build: BUILD_ID,
            at: Date.now(),
            cli: currentCli,
            path: pathText,
            usedRuleFallback,
            usedRelevanceRecovery,
            userMessage,
        };
    } catch (err) {
        bubble.innerHTML = formatMarkdown(`❌ ${err.message || '聊天失败'}`);
    }

    scrollToBottom();
    setWaiting(false);
}

async function chatOnce(message) {
    const response = await fetch(`${GATEWAY_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message,
            conversationId,
            cli: currentCli || null,
        }),
    });

    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || response.statusText || 'AI 服务错误');
    }

    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || 'AI 服务错误');
    }
    return {
        text: data.text || '',
        cli: data.cli || currentCli,
        fallbackFrom: data.fallbackFrom || null,
        fallbackReason: data.fallbackReason || '',
    };
}

async function buildPageContext() {
    const tab = await sendCommand({ action: 'get_tab_info' }, { quiet: true });
    if (tab.error) {
        return {
            tabError: tab.error,
            controllable: false,
            tab: null,
            markdown: '',
            elements: [],
            markdownError: null,
            elementsError: null,
        };
    }

    const context = {
        tabError: null,
        controllable: !!tab.controllable,
        tab: {
            url: tab.url || '',
            title: tab.title || '',
            restricted: !!tab.restricted,
            controllable: !!tab.controllable,
        },
        markdown: '',
        elements: [],
        markdownError: null,
        elementsError: null,
    };

    const perms = await chrome.runtime.sendMessage({ type: 'GET_PERMISSIONS' }).catch(() => ({}));

    if (!context.controllable) {
        return context;
    }

    const [mdRes, elRes] = await Promise.all([
        sendCommand({ action: 'get_markdown' }, { quiet: true }),
        sendCommand({ action: 'get_interactive_elements' }, { quiet: true }),
    ]);

    if (!mdRes.error) {
        const md = String(mdRes.markdown || '');
        context.markdown = md.length > MAX_MARKDOWN_CONTEXT
            ? `${md.slice(0, MAX_MARKDOWN_CONTEXT)}\n...（已截断）`
            : md;
    } else {
        context.markdownError = mdRes.error;
    }

    if (!elRes.error && Array.isArray(elRes.elements)) {
        context.elements = elRes.elements.slice(0, MAX_ELEMENTS_CONTEXT).map((el) => ({
            id: el.id,
            tag: el.tag,
            text: (el.text || '').slice(0, 80),
            x: el.x,
            y: el.y,
        }));
    } else if (elRes.error) {
        context.elementsError = elRes.error;
    }

    // CAPTCHA 检测
    if (perms.captchaDetect !== false) {
        const hasCaptcha = detectCaptchaInMarkdown(context.markdown) || detectCaptchaInElements(context.elements);
        if (hasCaptcha) {
            context.captchaDetected = true;
            showCaptchaWarning();
        }
    }

    return context;
}

function buildAgentPrompt(userMessage, context) {
    let contextText = renderContext(context);

    // 提示注入防护
    const { sanitized, injectionDetected } = sanitizePromptContent(contextText);
    if (injectionDetected) {
        contextText = sanitized;
        console.warn('[PhantomBridge] ⚠️ 检测到疑似提示注入内容，已过滤');
    }

    return [
        '你是浏览器助手，能通过工具操作当前网页。用中文回复。',
        '',
        '调用工具格式（可多次）：',
        '```tool',
        '{"action":"navigate","url":"https://baidu.com"}',
        '```',
        '',
        '可用action: navigate, get_markdown, get_interactive_elements, cdp_click(x,y), cdp_type(text), evaluate_js(code), take_screenshot, get_console_logs, get_network_logs, list_tabs, switch_tab(tabId), create_tab(url), close_tab(tabId)',
        '',
        '示例 - 点击搜索按钮(元素[5] @ 600,350):',
        '```tool',
        '{"action":"cdp_click","x":600,"y":350}',
        '```',
        '已点击搜索按钮。',
        '',
        '规则：用上下文中的坐标点击，不编造；不说"看不到"；禁止寒暄模板。',
        '',
        '当前页面上下文：',
        contextText,
        '',
        `用户请求：${userMessage}`,
    ].join('\n');
}

function buildToolFollowUpPrompt(userMessage, context, assistantText, toolResults) {
    return [
        '继续同一任务。',
        `用户原始请求：${userMessage}`,
        '',
        '你上一步回复：',
        assistantText || '(无)',
        '',
        '工具执行结果(JSON)：',
        JSON.stringify(toolResults, null, 2),
        '',
        '请根据结果继续：',
        '- 如果已经完成，直接给出中文最终回复。',
        '- 如果还需要下一步操作，继续输出 ```tool ...```。',
        '- 禁止输出与用户请求无关的寒暄或自我介绍。',
        '- 若你上一步偏题，本轮第一句必须先纠正并直接回答用户问题。',
        '- 严禁输出“看不到屏幕/当前目录/项目路径/CLI限制”等无关信息。',
        '',
        '页面上下文：',
        renderContext(context),
    ].join('\n');
}

function renderContext(context) {
    if (context.tabError) {
        return `获取标签页失败: ${context.tabError}`;
    }

    if (!context.tab) {
        return '无可用标签页上下文';
    }

    const elementsText = context.elements.length > 0
        ? context.elements.map((el) => `- [${el.id}] <${el.tag}> "${el.text}" @ (${el.x},${el.y})`).join('\n')
        : '- (无可用元素)';

    return [
        `URL: ${context.tab.url}`,
        `标题: ${context.tab.title}`,
        `可控: ${context.tab.controllable ? '是' : '否'}`,
        `受限页: ${context.tab.restricted ? '是' : '否'}`,
        `Markdown 错误: ${context.markdownError || '无'}`,
        `元素提取错误: ${context.elementsError || '无'}`,
        '',
        '页面 Markdown（节选）：',
        context.markdown || '(无)',
        '',
        '交互元素（节选）：',
        elementsText,
    ].join('\n');
}

async function tryHandleDirectIntent(userMessage, context) {
    const text = String(userMessage || '').trim();
    if (!text) return null;

    if (isVisibilityIntent(text)) {
        return `可以，我能读取当前页面。\n\n${summarizeContext(context, true)}`;
    }

    if (isRecognitionIntent(text)) {
        return `已读取当前页面内容。\n\n${summarizeContext(context, true)}`;
    }

    const switchIntent = parseSwitchIntent(text);
    if (switchIntent) {
        return await handleSwitchIntent(switchIntent, context);
    }

    const clickTarget = parseClickTarget(text);
    if (clickTarget) {
        const element = pickBestElement(context.elements, clickTarget);
        if (!element) {
            const suggestions = (context.elements || [])
                .slice(0, 8)
                .map((el) => `- ${el.text || `<${el.tag}>`} @ (${el.x},${el.y})`)
                .join('\n');
            return [
                `未找到与“${clickTarget}”匹配的可点击元素。`,
                '',
                '你可以更具体一点，例如：',
                '- 点击“订阅”按钮',
                '- 点击标题包含“MrBeast”的视频卡片',
                '',
                '当前可见元素示例：',
                suggestions || '- (无)',
            ].join('\n');
        }

        const clickRes = await sendCommand({
            action: 'cdp_click',
            x: element.x,
            y: element.y,
            button: 'left',
        }, { quiet: true });

        if (clickRes.error) {
            return `点击“${clickTarget}”失败：${clickRes.error}`;
        }

        rememberClickedElement(element, context.tab?.url);

        return `已点击：${element.text || `<${element.tag}>`}（坐标 ${element.x}, ${element.y}）。`;
    }

    const typeIntent = parseTypeIntent(text);
    if (typeIntent) {
        const inputCandidates = (context.elements || []).filter((el) => {
            const tag = String(el.tag || '').toLowerCase();
            const label = String(el.text || '').toLowerCase();
            return (
                tag === 'input' ||
                tag === 'textarea' ||
                label.includes('搜索') ||
                label.includes('search')
            );
        });

        const targetInput = typeIntent.target
            ? pickBestElement(inputCandidates, typeIntent.target) || inputCandidates[0]
            : inputCandidates[0];

        if (!targetInput) {
            return '未找到可输入的输入框，请先把输入框滚动到可见区域后重试。';
        }

        const clickRes = await sendCommand({
            action: 'cdp_click',
            x: targetInput.x,
            y: targetInput.y,
            button: 'left',
        }, { quiet: true });

        if (clickRes.error) {
            return `定位输入框失败：${clickRes.error}`;
        }

        const typeRes = await sendCommand({
            action: 'cdp_type',
            text: typeIntent.value,
        }, { quiet: true });

        if (typeRes.error) {
            return `输入失败：${typeRes.error}`;
        }

        return `已输入：${typeIntent.value}`;
    }

    // 总结/概述页面内容（规则兜底，不依赖 AI）
    if (/(总结|概述|概括|摘要|简介|讲了什么|什么内容|这页是什么)/.test(text)) {
        const title = context.tab?.title || '(未知标题)';
        const url = context.tab?.url || '';
        const md = String(context.markdown || '').replace(/\s+/g, ' ').trim();
        if (!md) {
            return `当前页面：${title}\nURL：${url}\n\n页面内容为空或无法提取。`;
        }
        const snippet = md.length > 500 ? md.slice(0, 500) + '...' : md;
        const elementCount = Array.isArray(context.elements) ? context.elements.length : 0;
        return [
            `📄 **${title}**`,
            `🔗 ${url}`,
            `📊 可交互元素：${elementCount} 个`,
            '',
            '**页面内容节选：**',
            snippet,
        ].join('\n');
    }

    // 截图意图
    if (/(截图|截屏|screenshot|拍照|截个图)/.test(text)) {
        const ssRes = await sendCommand({ action: 'take_screenshot' }, { quiet: true });
        if (ssRes.error) {
            return `截图失败：${ssRes.error}`;
        }
        return '✅ 截图已完成。' + (ssRes.dataUrl ? '\n\n(截图数据已获取)' : '');
    }

    // 导航意图
    const navMatch = text.match(/(?:打开|导航|访问|跳转|前往|进入|go\s*to|open)\s*(.+)/i);
    if (navMatch) {
        let target = navMatch[1].trim().replace(/[""'']/g, '');
        // 常见网站快捷名
        const shortcuts = {
            '百度': 'https://www.baidu.com',
            '谷歌': 'https://www.google.com',
            'google': 'https://www.google.com',
            'baidu': 'https://www.baidu.com',
            '知乎': 'https://www.zhihu.com',
            'bilibili': 'https://www.bilibili.com',
            'b站': 'https://www.bilibili.com',
            'github': 'https://github.com',
            '淘宝': 'https://www.taobao.com',
            '京东': 'https://www.jd.com',
            '微博': 'https://weibo.com',
            'youtube': 'https://www.youtube.com',
        };
        let url = shortcuts[target.toLowerCase()] || target;
        if (!/^https?:\/\//i.test(url)) {
            url = 'https://' + url;
        }
        const navRes = await sendCommand({ action: 'navigate', url }, { quiet: true });
        if (navRes.error) {
            return `导航到 ${url} 失败：${navRes.error}`;
        }
        return `✅ 已导航到：${url}`;
    }

    return null;
}

function isVisibilityIntent(text) {
    const normalized = String(text || '').replace(/\s+/g, '');
    return (
        /你可以看|能看到|看得到|看见|能识别|可识别|看一下|看看|帮我看|帮我瞧|查看一下/.test(normalized) &&
        /(当前页面|这个页面|网页|页面|这页|当前页)/.test(normalized)
    );
}

function isRecognitionIntent(text) {
    const normalized = String(text || '').replace(/\s+/g, '');
    return (
        /(识别|读取|提取|分析|总结|看一下|看看|帮我看|告诉我|描述|解析|了解|看下)/.test(normalized) &&
        /(页面|网页|内容|这个|这页|当前)/.test(normalized)
    );
}

function parseClickTarget(text) {
    const normalized = String(text || '').trim();
    if (!/(点击|点一下|点开|帮我点)/.test(normalized)) {
        return '';
    }

    const quoted = extractQuotedText(normalized);
    if (quoted) return quoted;

    const match = normalized.match(/(?:点击|点一下|点开|帮我点)(.+)$/);
    if (!match) return '';

    const cleaned = match[1]
        .replace(/[“”"'`]/g, '')
        .replace(/(一下|这个|那个|按钮|链接|选项|请|谢谢|。|？|\?)/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return cleaned;
}

function parseTypeIntent(text) {
    const normalized = String(text || '').trim();
    if (!/(输入|键入|填写|搜索|帮我搜)/.test(normalized)) {
        return null;
    }

    const quoted = extractQuotedText(normalized);
    if (!quoted) return null;

    const targetMatch = normalized.match(/在(.+?)(输入|里输入|中输入|搜索|里搜索)/);
    const target = targetMatch ? targetMatch[1].replace(/[“”"'`]/g, '').trim() : '';

    return {
        value: quoted,
        target,
    };
}

function parseSwitchIntent(text) {
    const normalized = String(text || '').trim();
    if (!normalized) return null;

    const isNext = /(切换下一个|下一个|下一条|下条|下个|下一页|往下翻|下滑|下翻|切到下一个)/.test(normalized);
    const isPrev = /(切换上一个|上一个|上一条|上条|上个|上一页|往上翻|上滑|上翻|切到上一个)/.test(normalized);
    if (!isNext && !isPrev) return null;

    let target = '';
    if (/(视频|video|short|reel)/i.test(normalized)) target = 'video';
    else if (/(帖子|post|动态)/i.test(normalized)) target = 'post';
    else if (/(商品|product)/i.test(normalized)) target = 'product';
    else if (/(结果|result)/i.test(normalized)) target = 'result';
    else if (/(卡片|条目|item)/i.test(normalized)) target = 'item';

    return {
        direction: isNext ? 'next' : 'prev',
        target,
    };
}

function isActionableIntent(text) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    return Boolean(
        parseClickTarget(raw) ||
        parseTypeIntent(raw) ||
        parseSwitchIntent(raw) ||
        /(导航|打开|跳转|滚动|刷新|回到|返回|查找|搜索|点击|输入|切换|看一下|看看|帮我看|查看|识别|分析|总结|提取|截图|控制台|网络)/.test(raw)
    );
}

function isGenericAssistantReply(text) {
    const t = String(text || '').replace(/\s+/g, '');
    if (!t) return true;
    const patterns = [
        /请告诉我你希望我做什么/,
        /请给出您的指令/,
        /我已准备好/,
        /随时准备/,
        /你好.*浏览器助手/,
        /请问有什么我可以帮您/,
        /我已经准备好通过工具/,
        /请告诉我您希望/,
        /我可以帮助您/,
        /已经准备好接收/,
        /请随时告诉我/,
        /告诉我下一步/,
        /协助您操作/,
        /请指示我/,
    ];
    return patterns.some((re) => re.test(t));
}

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function isSmallTalkMessage(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return false;
    if (t.length > 24) return false;
    return /^(hi|hello|hey|在吗|在不在|你好|您好|有人吗|在不|在么|在？|在\?|ok|好的)$/.test(t);
}

function detectUserIntent(userMessage) {
    const raw = String(userMessage || '').trim();
    return {
        raw,
        clickTarget: parseClickTarget(raw),
        typeIntent: parseTypeIntent(raw),
        switchIntent: parseSwitchIntent(raw),
        visibility: isVisibilityIntent(raw),
        recognition: isRecognitionIntent(raw),
        navigation: /(导航|打开|访问|跳转|前往|进入|go to|open)/i.test(raw),
        screenshot: /(截图|截屏|screenshot)/i.test(raw),
        askContent: /(什么内容|讲了什么|内容|总结|摘要|简介|概述|介绍)/.test(raw),
        greeting: isSmallTalkMessage(raw),
    };
}

function extractRelevanceKeywords(text) {
    const raw = String(text || '').toLowerCase();
    if (!raw) return [];

    const normalized = raw
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^\u4e00-\u9fffa-z0-9]+/g, ' ');

    const tokens = normalized.split(/\s+/).filter(Boolean);
    const out = [];
    const seen = new Set();

    const pushToken = (token) => {
        const t = String(token || '').trim();
        if (!t) return;
        if (t.length < 2) return;
        if (/^\d+$/.test(t)) return;
        if (RELEVANCE_STOPWORDS.has(t)) return;
        if (seen.has(t)) return;
        seen.add(t);
        out.push(t);
    };

    for (const token of tokens) {
        pushToken(token.slice(0, 36));
        if (/^[\u4e00-\u9fff]{4,}$/.test(token)) {
            pushToken(token.slice(0, 2));
            pushToken(token.slice(-2));
        }
        if (out.length >= MAX_RELEVANCE_KEYWORDS) break;
    }

    return out;
}

function computeKeywordOverlap(questionKeywords, answerKeywords) {
    if (!questionKeywords.length || !answerKeywords.length) return 0;
    let hit = 0;
    for (const q of questionKeywords) {
        const found = answerKeywords.some((a) => a === q || a.includes(q) || q.includes(a));
        if (found) hit += 1;
    }
    return hit / questionKeywords.length;
}

function hasOffTopicMetaSignal(userMessage, replyText) {
    const question = String(userMessage || '');
    const answer = String(replyText || '');

    const userTalksCode = /(项目|代码|文件|目录|脚本|命令行|报错|错误|日志|debug|调试|cli|终端)/i.test(question);
    const answerTalksCode = /([a-z]:\\|\/(?:users|home|workspace|project)\b|当前目录|项目目录|读取文件|执行命令|终端|shell|cli助手|命令行)/i.test(answer);
    const answerTalksScreenLimit = /(无法直接看到屏幕|看不到你的页面|不能直接看到你的页面|只能通过读取文件)/.test(answer);

    if (!userTalksCode && (answerTalksCode || answerTalksScreenLimit)) {
        return true;
    }

    const userWebTask = /(点击|输入|切换|页面|网页|视频|按钮|搜索|导航|识别|内容|截图)/.test(question);
    if (userWebTask && /(浏览器扩展项目|开发项目|代码仓库|文件夹|目录路径)/.test(answer)) {
        return true;
    }
    return false;
}

function computeIntentSignalScore(intent, replyText) {
    const answer = String(replyText || '');
    let score = 0;

    if (intent.clickTarget) {
        score += /(点击|已点击|未找到|坐标|元素|按钮|卡片|匹配|click|失败|成功)/i.test(answer) ? 0.35 : -0.22;
    }
    if (intent.typeIntent) {
        score += /(输入|已输入|键入|搜索框|input|textarea|失败|成功)/i.test(answer) ? 0.35 : -0.22;
    }
    if (intent.switchIntent) {
        score += /(切换|下一个|上一个|滚动|arrow|尝试|失败|成功)/i.test(answer) ? 0.32 : -0.2;
    }
    if (intent.navigation) {
        score += /(导航|跳转|打开|前往|url|http)/i.test(answer) ? 0.28 : -0.18;
    }
    if (intent.screenshot) {
        score += /(截图|截屏|图片|screenshot)/i.test(answer) ? 0.25 : -0.15;
    }
    if (intent.visibility || intent.recognition || intent.askContent) {
        score += /(标题|url|页面|内容|元素|markdown|节选|摘要|可见)/i.test(answer) ? 0.25 : -0.14;
    }
    return score;
}

function getReplyRelevanceScore(userMessage, replyText) {
    const question = String(userMessage || '').trim();
    const answer = String(replyText || '').trim();
    if (!answer) return 0;

    const intent = detectUserIntent(question);
    if (intent.greeting) {
        return clamp01(answer.length >= 2 ? 0.7 : 0.4);
    }

    const qKeywords = extractRelevanceKeywords(question);
    const aKeywords = extractRelevanceKeywords(answer);
    const overlap = computeKeywordOverlap(qKeywords, aKeywords);

    let score = overlap * 0.62;
    if (answer.length >= 12) score += 0.06;
    if (answer.length >= 40) score += 0.05;
    if (answer.length >= 260) score -= 0.05;

    score += computeIntentSignalScore(intent, answer);

    if (isGenericAssistantReply(answer)) score -= 0.35;
    if (hasOffTopicMetaSignal(question, answer)) score -= 0.45;
    if (/^(你好|您好|在的|在。|我是)/.test(answer) && !intent.greeting) score -= 0.08;

    return clamp01(score);
}

function isLikelyOffTopicReply(userMessage, replyText, relevanceScore) {
    const question = String(userMessage || '').trim();
    const answer = String(replyText || '').trim();
    if (!answer) return true;

    const intent = detectUserIntent(question);
    if (intent.greeting) return false;

    const score = Number.isFinite(relevanceScore)
        ? relevanceScore
        : getReplyRelevanceScore(question, answer);

    if (hasOffTopicMetaSignal(question, answer)) return true;
    if (score < MIN_RELEVANCE_SCORE) return true;
    if (isGenericAssistantReply(answer) && score < 0.45) return true;

    if (intent.clickTarget && !/(点击|未找到|坐标|元素|按钮|卡片|匹配|失败|成功|click)/i.test(answer)) {
        return true;
    }
    if (intent.typeIntent && !/(输入|搜索|键入|输入框|失败|成功|input|textarea)/i.test(answer)) {
        return true;
    }
    if (intent.switchIntent && !/(切换|下一个|上一个|滚动|失败|成功|arrow|尝试)/i.test(answer)) {
        return true;
    }
    if ((intent.visibility || intent.recognition || intent.askContent) &&
        !/(标题|url|页面|元素|内容|节选|摘要|markdown|可见|无)/i.test(answer)) {
        return true;
    }

    if (/(请告诉我你希望我做什么|请给出您的指令|请随时告诉我|告诉我下一步)/.test(answer)) {
        return true;
    }

    return false;
}

function buildRelevanceRecoveryPrompt(userMessage, context, previousReply) {
    return [
        '你刚才的回答与用户问题相关性不足，请立即纠偏重答。',
        '',
        '重答规则：',
        '1. 第一行直接回答用户请求，不要寒暄、不要自我介绍。',
        '2. 禁止输出“看不到屏幕/当前目录/项目路径/CLI限制”等无关信息。',
        '3. 如果需要操作页面，优先给出可执行结果；需要工具时输出 ```tool JSON```。',
        '4. 如果信息不足，只允许问 1 个澄清问题。',
        '',
        `用户请求：${userMessage}`,
        '',
        '你上一条偏题回复：',
        previousReply || '(无)',
        '',
        '当前页面上下文：',
        renderContext(context),
        '',
        '请现在重新回答：',
    ].join('\n');
}

function buildDeterministicRelevantReply(userMessage, context) {
    const raw = String(userMessage || '').trim();
    if (!raw) {
        return '请告诉我要在当前页面执行的具体动作，例如“点击第2个视频”。';
    }

    if (isVisibilityIntent(raw) || isRecognitionIntent(raw)) {
        return `我已读取当前页面。\n\n${summarizeContext(context, true)}`;
    }

    const clickTarget = parseClickTarget(raw);
    if (clickTarget) {
        const targetElement = pickBestElement(context.elements, clickTarget);
        if (targetElement) {
            return `我已定位到“${clickTarget}”：${targetElement.text || `<${targetElement.tag}>`}（坐标 ${targetElement.x}, ${targetElement.y}）。请再发一次“点击${clickTarget}”，我会直接执行。`;
        }
        return `当前页没有找到与“${clickTarget}”匹配的可点击元素。请先滚动到目标区域后再试。`;
    }

    const typeIntent = parseTypeIntent(raw);
    if (typeIntent) {
        return `已识别输入需求：在“${typeIntent.target || '输入框'}”输入“${typeIntent.value}”。请再发送一次同样指令，我会直接执行输入。`;
    }

    const switchIntent = parseSwitchIntent(raw);
    if (switchIntent) {
        return `已识别切换需求：${switchIntent.direction === 'next' ? '下一个' : '上一个'}${switchIntent.target ? ` ${switchIntent.target}` : ''}。请直接发送“切换${switchIntent.direction === 'next' ? '下一个' : '上一个'}”。`;
    }

    const keywords = extractRelevanceKeywords(raw).slice(0, 4).join('、');
    const pageTitle = context?.tab?.title || '当前页面';
    const elementCount = Array.isArray(context?.elements) ? context.elements.length : 0;
    const snippet = String(context?.markdown || '').replace(/\s+/g, ' ').slice(0, 140);

    return [
        `我已聚焦你的问题：${keywords || raw.slice(0, 24)}。`,
        `当前页面：${pageTitle}；可识别交互元素 ${elementCount} 个。`,
        snippet ? `页面节选：${snippet}${snippet.length >= 140 ? '...' : ''}` : '',
        '请给一个更具体动作，例如“点击第2个视频”或“总结这页前3条内容”。',
    ].filter(Boolean).join('\n');
}

async function handleSwitchIntent(intent, context) {
    const chosen = chooseSequentialElement(context.elements, intent, context.tab?.url);
    if (chosen) {
        const clickRes = await sendCommand({
            action: 'cdp_click',
            x: chosen.x,
            y: chosen.y,
            button: 'left',
        }, { quiet: true });

        if (!clickRes.error) {
            rememberClickedElement(chosen, context.tab?.url);
            return `已切换到${intent.direction === 'next' ? '下一个' : '上一个'}：${chosen.text || `<${chosen.tag}>`}（坐标 ${chosen.x}, ${chosen.y}）。`;
        }
    }

    // 兜底：跨站点通用按键 + 滚动，避免只靠站点结构匹配
    const evalRes = await sendCommand({
        action: 'evaluate_js',
        code: buildSwitchScript(intent.direction),
    }, { quiet: true });

    if (evalRes.error) {
        return `切换${intent.direction === 'next' ? '下一个' : '上一个'}失败：${evalRes.error}`;
    }

    const mode = evalRes.mode ? `（${evalRes.mode}）` : '';
    return `已尝试切换到${intent.direction === 'next' ? '下一个' : '上一个'}${mode}。`;
}

function chooseSequentialElement(elements, intent, currentUrl = '') {
    if (!Array.isArray(elements) || elements.length === 0) return null;

    let candidates = elements.filter((el) => {
        const tag = String(el.tag || '').toLowerCase();
        const text = String(el.text || '').trim();
        if (!['a', 'button', 'div', 'span'].includes(tag) && !tag.startsWith('ytd-')) return false;
        if (!text) return false;
        if (isLikelyNavigationNoise(text)) return false;
        return true;
    });

    if (intent.target === 'video') {
        const videoLike = candidates.filter((el) => {
            const text = String(el.text || '').trim();
            return (
                /\d{1,2}:\d{2}/.test(text) ||
                /(观看|views|播放|video|shorts?|reels?)/i.test(text) ||
                text.length >= 8
            );
        });
        if (videoLike.length > 0) candidates = videoLike;
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.y - b.y) || (a.x - b.x));

    const sameUrl = !!currentUrl && !!lastClickedElement?.url && lastClickedElement.url === currentUrl;
    if (sameUrl && lastClickedElement?.y != null) {
        const y0 = Number(lastClickedElement.y);
        const byDirection = candidates.filter((el) =>
            intent.direction === 'next' ? el.y > y0 + 6 : el.y < y0 - 6
        );
        if (byDirection.length > 0) {
            byDirection.sort((a, b) =>
                Math.abs(a.y - y0) - Math.abs(b.y - y0) || Math.abs(a.x - (lastClickedElement.x || 0)) - Math.abs(b.x - (lastClickedElement.x || 0))
            );
            return byDirection[0];
        }
    }

    // 无历史点击时：next 取偏后的元素，prev 取偏前的元素
    if (intent.direction === 'next') {
        return candidates[Math.min(2, candidates.length - 1)];
    }
    return candidates[Math.max(0, candidates.length - 3)];
}

function buildSwitchScript(direction) {
    const goNext = direction === 'next';
    const key = goNext ? 'ArrowDown' : 'ArrowUp';
    const delta = goNext ? 1 : -1;
    return `(() => {
        const dir = ${JSON.stringify(direction)};
        const key = ${JSON.stringify(key)};
        const delta = ${delta};
        const host = location.hostname || '';
        const path = location.pathname || '';
        const isShortVideoSite =
            (/youtube\\.com$/.test(host) && path.startsWith('/shorts')) ||
            /tiktok\\.com$/.test(host) ||
            (/instagram\\.com$/.test(host) && /\\/reel\\//.test(path));

        const target = document.activeElement || document.body || document.documentElement;
        const opts = { key, code: key, bubbles: true, cancelable: true, composed: true };
        const events = ['keydown', 'keyup'];
        for (const type of events) {
            try { target.dispatchEvent(new KeyboardEvent(type, opts)); } catch {}
            try { document.dispatchEvent(new KeyboardEvent(type, opts)); } catch {}
            try { window.dispatchEvent(new KeyboardEvent(type, opts)); } catch {}
        }

        // 短视频页优先按键，普通信息流用滚动推进
        if (!isShortVideoSite) {
            const top = Math.round(window.innerHeight * 0.88 * delta);
            try { window.scrollBy({ top, behavior: 'smooth' }); } catch {}
        }

        return { ok: true, dir, key, isShortVideoSite, url: location.href };
    })()`;
}

function isLikelyNavigationNoise(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    return /(首页|shorts|订阅|历史记录|library|music|设置|登录|通知|菜单|search|搜索|更多|帮助|上传|频道)/i.test(t);
}

function rememberClickedElement(element, currentUrl = '') {
    if (!element) return;
    lastClickedElement = {
        x: Number(element.x || 0),
        y: Number(element.y || 0),
        text: String(element.text || ''),
        tag: String(element.tag || ''),
        url: currentUrl || '',
        at: Date.now(),
    };
}

function extractQuotedText(text) {
    const match = String(text || '').match(/[“"']([^”"']{1,120})[”"']/);
    return match ? match[1].trim() : '';
}

function parseOrdinalIndex(text) {
    const raw = String(text || '');
    const digit = raw.match(/第\s*(\d+)\s*个/);
    if (digit) {
        const n = Number(digit[1]);
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    const cn = raw.match(/第\s*([一二三四五六七八九十两]+)\s*个/);
    if (!cn) return null;

    const map = {
        一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 两: 2,
    };
    const s = cn[1];
    if (s === '十') return 10;
    if (s.startsWith('十')) return 10 + (map[s.slice(1)] || 0);
    if (s.endsWith('十')) return (map[s[0]] || 1) * 10;
    if (s.includes('十')) {
        const [a, b] = s.split('十');
        const tens = map[a] || 1;
        const ones = map[b] || 0;
        return tens * 10 + ones;
    }
    return map[s] || null;
}

function pickBestElement(elements, targetText) {
    const target = String(targetText || '').trim().toLowerCase();
    if (!target) return null;
    if (!Array.isArray(elements) || elements.length === 0) return null;

    const ordinal = parseOrdinalIndex(target);

    if (/视频|video/.test(target)) {
        const videoCandidates = elements.filter((el) => {
            const tag = String(el.tag || '').toLowerCase();
            const label = String(el.text || '').trim();
            if (!label || label.length < 6) return false;
            if (!['a', 'div', 'span'].includes(tag) && !tag.startsWith('ytd-')) return false;
            return !/(首页|shorts|订阅|历史记录|播放列表|library|music|设置|登录)/i.test(label);
        });
        if (videoCandidates.length > 0) {
            if (ordinal && ordinal <= videoCandidates.length) {
                return videoCandidates[ordinal - 1];
            }
            return videoCandidates[0];
        }
    }

    const clickable = elements.filter((el) => {
        const tag = String(el.tag || '').toLowerCase();
        return tag === 'a' || tag === 'button' || tag === 'div';
    });

    if (ordinal) {
        const dense = clickable.filter((el) => String(el.text || '').trim().length >= 2);
        return dense[ordinal - 1] || clickable[ordinal - 1] || dense[0] || clickable[0] || elements[0];
    }
    if (/搜索框|输入框/.test(target)) {
        const input = elements.find((el) => {
            const tag = String(el.tag || '').toLowerCase();
            const label = String(el.text || '').toLowerCase();
            return tag === 'input' || tag === 'textarea' || label.includes('搜索') || label.includes('search');
        });
        if (input) return input;
    }

    let best = null;
    let bestScore = -Infinity;

    for (const el of elements) {
        const label = String(el.text || '').toLowerCase();
        const tag = String(el.tag || '').toLowerCase();
        let score = 0;

        if (label === target) score += 100;
        if (label.includes(target)) score += 60;
        if (target.includes(label) && label.length >= 2) score += 20;
        if (tag === 'button' || tag === 'a') score += 8;
        if (label.length > 0 && label.length < 40) score += 4;

        if (score > bestScore) {
            bestScore = score;
            best = el;
        }
    }

    return bestScore >= 20 ? best : null;
}

function summarizeContext(context, includeMarkdown = false) {
    const tab = context.tab || {};
    const elements = Array.isArray(context.elements) ? context.elements : [];
    const topElements = elements
        .slice(0, 8)
        .map((el) => `- ${el.text || `<${el.tag}>`} @ (${el.x},${el.y})`)
        .join('\n');

    const markdown = includeMarkdown
        ? String(context.markdown || '').replace(/\s+/g, ' ').slice(0, 260)
        : '';

    const parts = [
        `Build：${BUILD_ID}`,
        `标题：${tab.title || '(无标题)'}`,
        `URL：${tab.url || '(未知)'}`,
        `可见交互元素：${elements.length} 个`,
        `Markdown错误：${context.markdownError || '无'}`,
        `元素错误：${context.elementsError || '无'}`,
        '元素示例：',
        topElements || '- (无)',
    ];

    if (includeMarkdown) {
        parts.push('', `页面内容节选：${markdown || '(无)'}`);
    }

    return parts.join('\n');
}

function extractToolCalls(text) {
    const calls = [];
    const raw = String(text || '');

    // 先移除 <think>...</think> 标签（DeepSeek-R1 特有的思考过程）
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');

    // 格式1: ```tool ... ``` 或 ```json ... ``` 或 ``` ... ```（无语言标记）
    const fencedRegex = /```(?:tool|json)?\s*\n?([\s\S]*?)```/gi;
    let match;
    while ((match = fencedRegex.exec(cleaned)) !== null) {
        const block = (match[1] || '').trim();
        if (!block) continue;
        const obj = _tryParseToolJson(block);
        if (obj && obj.action) {
            calls.push(obj);
        }
    }

    // 格式2: 裸 JSON 行 {"action": "..."} （当 fenced 解析无结果时尝试）
    if (calls.length === 0) {
        const lines = cleaned.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('{') && trimmed.includes('"action"')) {
                // 找到右括号的位置（可能行中还有其他文字）
                const braceEnd = trimmed.lastIndexOf('}');
                if (braceEnd > 0) {
                    const jsonStr = trimmed.slice(0, braceEnd + 1);
                    const obj = _tryParseToolJson(jsonStr);
                    if (obj && obj.action) {
                        calls.push(obj);
                    }
                }
            }
        }
    }

    return calls;
}

/**
 * 尝试解析 JSON，修复常见格式问题
 */
function _tryParseToolJson(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return null;

    // 直接尝试
    try { return JSON.parse(trimmed); } catch { }

    // 修复尾逗号: {"a": 1,} → {"a": 1}
    try {
        return JSON.parse(trimmed.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'));
    } catch { }

    // 修复单引号: {'action': 'navigate'} → {"action": "navigate"}
    try {
        return JSON.parse(trimmed.replace(/'/g, '"'));
    } catch { }

    // 提取嵌入在文字中的 JSON 对象
    const jsonMatch = trimmed.match(/\{[^{}]*"action"\s*:\s*"[^"]+?"[^{}]*\}/);
    if (jsonMatch) {
        try { return JSON.parse(jsonMatch[0]); } catch { }
    }

    return null;
}

function cleanToolBlocks(text) {
    return String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```(?:tool|json)?\s*[\s\S]*?```/gi, '')
        .trim();
}

function normalizeToolCall(tool) {
    const action = String(tool?.action || '').trim();
    if (!TOOL_ACTIONS.has(action)) {
        return { ok: false, error: `不支持的工具 action: ${action || '(空)'}` };
    }

    switch (action) {
        case 'navigate': {
            let url = String(tool.url || '').trim();
            if (!url) return { ok: false, error: 'navigate 缺少 url' };
            if (!/^https?:\/\//i.test(url)) {
                url = `https://${url}`;
            }
            return { ok: true, command: { action, url } };
        }
        case 'cdp_click': {
            const x = Number(tool.x);
            const y = Number(tool.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                return { ok: false, error: 'cdp_click 需要有效数字 x/y' };
            }
            const button = ['left', 'right', 'middle'].includes(tool.button) ? tool.button : 'left';
            return { ok: true, command: { action, x: Math.round(x), y: Math.round(y), button } };
        }
        case 'cdp_type': {
            const text = String(tool.text || '');
            if (!text) return { ok: false, error: 'cdp_type 缺少 text' };
            return { ok: true, command: { action, text } };
        }
        case 'evaluate_js': {
            const code = String(tool.code || '').trim();
            if (!code) return { ok: false, error: 'evaluate_js 缺少 code' };
            return { ok: true, command: { action, code } };
        }
        case 'get_markdown':
        case 'get_interactive_elements':
        case 'get_tab_info':
        case 'take_screenshot':
        case 'list_tabs':
            return { ok: true, command: { action } };
        case 'get_console_logs': {
            const count = Number(tool.count) || 20;
            return { ok: true, command: { action, count } };
        }
        case 'get_network_logs': {
            const count = Number(tool.count) || 20;
            const errorsOnly = !!tool.errorsOnly;
            return { ok: true, command: { action, count, errorsOnly } };
        }
        case 'switch_tab': {
            const tabId = Number(tool.tabId);
            if (!Number.isFinite(tabId)) return { ok: false, error: 'switch_tab 需要 tabId' };
            return { ok: true, command: { action, tabId } };
        }
        case 'create_tab': {
            let url = String(tool.url || 'about:blank').trim();
            if (url && !/^https?:\/\//i.test(url) && url !== 'about:blank') url = `https://${url}`;
            return { ok: true, command: { action, url } };
        }
        case 'close_tab': {
            const tabId = Number(tool.tabId);
            if (!Number.isFinite(tabId)) return { ok: false, error: 'close_tab 需要 tabId' };
            return { ok: true, command: { action, tabId } };
        }
        default:
            return { ok: false, error: `未处理的 action: ${action}` };
    }
}

// ========== CLI 工具管理 ==========

async function detectClis() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLI_DETECT_TIMEOUT_MS);
    try {
        const res = await fetch(`${GATEWAY_URL}/cli/detect`, {
            signal: controller.signal,
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        cliDetectRetryCount = 0;
        lastCliDetectError = '';

        if (data.clis && data.clis.length > 0) {
            detectedClis = data.clis;
            currentCli = data.active || data.clis[0].id;
            renderTopCliSelector();
            renderCliDropdown();
            console.log(`[SidePanel] 检测到 ${data.clis.length} 个 CLI 工具:`, data.clis.map(c => c.name));
        } else {
            setCliLoadingText('⚠️ 未检测到 AI CLI 工具（可先运行 /clitest all 诊断）');
        }
    } catch (err) {
        cliDetectRetryCount += 1;
        lastCliDetectError = err?.name === 'AbortError'
            ? `超时(${Math.round(CLI_DETECT_TIMEOUT_MS / 1000)}s)`
            : (err?.message || String(err));
        setCliLoadingText(`⚠️ 网关未连接，请先运行 npm start（重试 ${cliDetectRetryCount} 次）`);
        scheduleCliDetectRetry();
    } finally {
        clearTimeout(timeout);
    }
}

function setCliLoadingText(text) {
    const loading = $('#cliLoading');
    if (!loading) return;
    loading.textContent = text;
    loading.title = text;
}

function scheduleCliDetectRetry(delayMs = CLI_DETECT_RETRY_MS) {
    if (cliDetectTimer) return;
    cliDetectTimer = setTimeout(() => {
        cliDetectTimer = null;
        detectClis();
    }, delayMs);
}

/** 填充顶部 CLI 选择器按钮 */
function renderTopCliSelector() {
    const container = $('#cliSelector');
    container.innerHTML = '';

    detectedClis.forEach((cli, i) => {
        if (i > 0) {
            const divider = document.createElement('span');
            divider.className = 'cli-divider';
            divider.textContent = '|';
            container.appendChild(divider);
        }

        const btn = document.createElement('button');
        btn.className = 'cli-btn' + (cli.id === currentCli ? ' active' : '');
        btn.dataset.cli = cli.id;
        btn.title = `${cli.name} (${cli.version})`;
        btn.innerHTML = `<span class="cli-icon">${cli.icon}</span>`;

        // 第一个按钮显示名称
        if (cli.id === currentCli) {
            btn.innerHTML += `<span class="cli-label">${cli.name}</span>`;
        }

        btn.addEventListener('click', () => {
            switchCli(cli.id);
            renderTopCliSelector(); // 重新渲染以更新高亮
        });

        container.appendChild(btn);
    });
}

/** 填充底部 CLI 下拉菜单 */
function renderCliDropdown() {
    const dropdown = $('#modelDropdown');
    dropdown.innerHTML = '';
    for (const cli of detectedClis) {
        const opt = document.createElement('div');
        opt.className = 'model-option' + (cli.id === currentCli ? ' active' : '');
        opt.dataset.model = cli.id;
        opt.innerHTML = `<span class="model-dot"></span>${cli.icon} ${escapeHtml(cli.name)}`;
        opt.addEventListener('click', () => switchCli(cli.id));
        dropdown.appendChild(opt);
    }
    updateModelDisplay();
}

async function switchCli(cliId) {
    try {
        const res = await fetch(`${GATEWAY_URL}/cli/select`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cli: cliId }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `切换 CLI 失败: HTTP ${res.status}`);
        }
        currentCli = cliId;
        renderTopCliSelector();
        renderCliDropdown();
        modelSelector.classList.remove('open');
    } catch (err) {
        addMessage('ai', `❌ ${err.message || '切换 CLI 失败'}`);
    }
}

// ========== UI 更新 ==========

function addMessage(role, content, isHtml = false) {
    messageCount++;
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    if (isHtml) {
        bubble.innerHTML = content;
    } else {
        bubble.innerHTML = formatMarkdown(content);
    }

    msgDiv.appendChild(bubble);
    chatArea.appendChild(msgDiv);
    scrollToBottom();
}

function showThinking() {
    const thinkingDiv = document.createElement('div');
    thinkingDiv.className = 'message ai';
    thinkingDiv.id = 'thinkingMsg';
    thinkingDiv.innerHTML = `
        <div class="message-bubble">
            <div class="thinking-indicator">
                <div class="thinking-dot"></div>
                <div class="thinking-dot"></div>
                <div class="thinking-dot"></div>
            </div>
        </div>
    `;
    chatArea.appendChild(thinkingDiv);
    scrollToBottom();
}

function hideThinking() {
    const thinking = $('#thinkingMsg');
    if (thinking) thinking.remove();
}

function setWaiting(waiting) {
    isWaiting = waiting;
    sendBtn.disabled = waiting || !messageInput.value.trim();
    messageInput.disabled = waiting;
    if (!waiting) messageInput.focus();
}

function updateStatus() {
    if (gatewayConnected) {
        statusDot.className = 'status-dot connected';
        statusText.textContent = '已连接到网关';
    } else {
        statusDot.className = 'status-dot';
        if (cliDetectRetryCount > 0) {
            statusText.textContent = `网关未连接（请运行 npm start）${lastCliDetectError ? ` · ${lastCliDetectError}` : ''}`;
        } else {
            statusText.textContent = '正在连接网关...';
        }
    }
}

function updateModelDisplay() {
    const cli = detectedClis.find(c => c.id === currentCli);
    const displayName = cli ? `${cli.icon} ${cli.name}` : '检测中...';
    $('.model-name').textContent = displayName.length > 20 ? displayName.slice(0, 20) + '…' : displayName;
}

function scrollToBottom() {
    requestAnimationFrame(() => {
        chatArea.scrollTop = chatArea.scrollHeight;
    });
}

// ========== 工具函数 ==========

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatMarkdown(text) {
    return text
        // 代码块
        .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
        // 行内代码
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // 粗体
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        // 斜体
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        // 链接
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        // 换行
        .replace(/\n/g, '<br>');
}

// ========== Planning Mode ==========

/**
 * 检测 AI 回复中的计划步骤
 * 支持格式：
 * 1. PLAN: 块
 * 2. 有序列表包含工具调用的步骤
 */
function parsePlanSteps(text) {
    if (!text) return null;

    // 检测 PLAN: 块
    const planMatch = text.match(/(?:PLAN|plan|计划|步骤)[:\uff1a]\s*\n([\s\S]+?)(?=\n\n|$)/i);
    const section = planMatch ? planMatch[1] : text;

    // 提取有序列表项
    const lines = section.split('\n');
    const steps = [];

    for (const line of lines) {
        const match = line.match(/^\s*(?:\d+[.)\uff0e]|[-*\u2022])\s+(.+)/);
        if (match) {
            const stepText = match[1].trim();
            // 尝试提取内嵌的工具调用
            let toolCall = null;
            const toolMatch = stepText.match(/```(?:tool|json)\s*([\s\S]*?)```/);
            if (toolMatch) {
                try {
                    toolCall = JSON.parse(toolMatch[1].trim());
                } catch { }
            }
            steps.push({
                text: stepText.replace(/```(?:tool|json)\s*[\s\S]*?```/g, '').trim(),
                toolCall,
                done: false,
                running: false,
            });
        }
    }

    return steps.length >= 2 ? steps : null;
}

/**
 * 渲染计划卡片 UI
 */
function renderPlanCard(bubble, steps, originalText) {
    // 清理工具块的纯文本
    const cleanText = cleanToolBlocks(originalText).trim();
    const headerText = cleanText.split('\n').filter(l => !l.match(/^\s*(?:\d+[.)\uff0e]|[-*\u2022])\s+/))[0] || '';

    let html = '<div class="plan-card">';
    if (headerText) {
        html += `<div class="plan-header">${formatMarkdown(headerText)}</div>`;
    }
    html += '<div class="plan-steps">';
    steps.forEach((step, i) => {
        html += `<div class="plan-step" data-index="${i}">`;
        html += `<span class="plan-step-icon">⬜</span>`;
        html += `<span class="plan-step-text">${escapeHtml(step.text)}</span>`;
        html += '</div>';
    });
    html += '</div>';
    html += '<button class="plan-execute-btn" id="planExecBtn">▶ 执行计划</button>';
    html += '</div>';

    bubble.innerHTML = html;

    // 绑定执行按钮
    const btn = bubble.querySelector('#planExecBtn');
    if (btn) {
        btn.addEventListener('click', () => executePlan(bubble, steps));
    }
}

/**
 * 逐步执行计划
 */
async function executePlan(bubble, steps) {
    const btn = bubble.querySelector('#planExecBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ 执行中...';
    }

    const stepEls = bubble.querySelectorAll('.plan-step');

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const el = stepEls[i];

        // 标记运行中
        if (el) {
            el.classList.add('running');
            el.querySelector('.plan-step-icon').textContent = '⏳';
        }

        if (step.toolCall) {
            const normalized = normalizeToolCall(step.toolCall);
            if (normalized.ok) {
                const result = await sendCommand(normalized.command, { quiet: true });
                step.done = !result.error;
                step.result = result;
            } else {
                step.done = false;
                step.result = { error: normalized.error };
            }
        } else {
            // 无工具调用的步骤视为已完成
            step.done = true;
        }

        // 更新 UI
        if (el) {
            el.classList.remove('running');
            el.classList.add(step.done ? 'done' : 'failed');
            el.querySelector('.plan-step-icon').textContent = step.done ? '✅' : '❌';

            if (step.result?.error) {
                const errSpan = document.createElement('span');
                errSpan.className = 'plan-step-error';
                errSpan.textContent = ` — ${step.result.error}`;
                el.appendChild(errSpan);
            }
        }

        // 每步之间等待一下，让 UI 有时间更新
        await new Promise(r => setTimeout(r, 300));
    }

    if (btn) {
        const allDone = steps.every(s => s.done);
        btn.textContent = allDone ? '✅ 计划已完成' : '⚠️ 部分步骤失败';
        btn.classList.add(allDone ? 'done' : 'partial');
    }

    scrollToBottom();
}

// ========== 启动 ==========

init();
console.log('[PhantomBridge] SidePanel build:', BUILD_ID);
