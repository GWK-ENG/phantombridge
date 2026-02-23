# AGENTS.md - PhantomBridge 开发指南

## 项目概述

PhantomBridge 是一个专为 AI Agent 和自动化 CLI 打造的浏览器运行时环境。它将浏览器 DOM 结构、反爬机制、多标签页状态管理封装为大模型能够轻松调用的原子级 API。

**核心架构**：四层分离模型
1. **业务大脑层** - AI Agents / MCP 客户端
2. **本地路由网关** (`gateway/`) - Node.js 守护进程
3. **浏览器中枢控制层** (`extension/background.js`) - Chrome Extension Service Worker
4. **页面感知层** (`extension/content.js`) - Content Scripts 探针

---

## 构建/运行/测试命令

```bash
# 安装依赖
npm install

# 启动本地网关服务 (HTTP + WebSocket)
npm start
# 网关地址: http://localhost:7778
# WebSocket: ws://localhost:7778/ws

# 安装 Native Messaging Host (Windows 注册表)
npm run install-host

# 运行 Native Messaging 协议测试
npm run test:protocol

# 运行单个测试文件 (使用 Node.js 直接执行)
node test/test-native-protocol.js
```

**注意**：本项目无构建步骤，纯 JavaScript 运行时项目。无 TypeScript、无打包工具。

---

## 目录结构

```
ai浏览器扩展/
├── gateway/                    # Node.js 网关服务
│   ├── index.js               # 主入口 (Express + WebSocket)
│   ├── api-routes.js          # RESTful API 路由定义
│   ├── session-manager.js     # 浏览器会话连接池管理
│   ├── chrome-launcher.js     # Chrome 进程启动器
│   ├── native-messaging.js    # Native Messaging 协议编解码
│   ├── cli-detector.js        # AI CLI 工具检测
│   └── ai-chat.js             # AI 聊天集成
├── extension/                  # Chrome 扩展 (Manifest V3)
│   ├── manifest.json          # 扩展配置
│   ├── background.js          # Service Worker (中枢控制层)
│   ├── content.js             # Content Script (页面感知层)
│   ├── content-early.js       # 早期注入脚本
│   ├── sidepanel.html/js/css  # 侧边栏 UI
│   └── icons/                 # 扩展图标
├── test/                       # 测试文件
│   └── test-native-protocol.js
├── native-host-manifest.json   # Native Messaging Host 配置模板
├── install-host.js            # Windows 注册表安装脚本
└── 设计稿.md                   # 架构设计文档
```

---

## 代码风格规范

### 缩进与格式

- **缩进**：4 空格（项目统一）
- **引号**：优先使用单引号 `'`
- **分号**：不强制，保持一致性
- **行宽**：无硬性限制，但建议不超过 100 字符

### 命名约定

```javascript
// 变量/函数：camelCase
const sessionManager = new SessionManager();
function getActiveTab() { }

// 类/构造函数：PascalCase
class SessionManager { }
const SessionState = { LAUNCHING: 'launching', ... };

// 常量：UPPER_SNAKE_CASE
const GATEWAY_WS_URLS = ['ws://127.0.0.1:7778/ws'];
const HEARTBEAT_INTERVAL = 25000;

// 私有方法/属性：下划线前缀
this._buffer = Buffer.alloc(0);
this._tryParse() { }
```

### 模块系统

- 使用 **CommonJS** (`require` / `module.exports`)
- 不使用 ES Modules (`import` / `export`)

```javascript
// 导入
const express = require('express');
const { SessionManager, SessionState } = require('./session-manager');

// 导出
module.exports = { SessionManager, SessionState };
// 或
module.exports = { createApiRoutes };
```

### 注释规范

- **文件头注释**：描述模块职责
```javascript
/**
 * PhantomBridge - 会话管理器
 * 
 * 管理浏览器实例的连接池，维护 TaskID → BrowserInstance 的映射。
 */
```

- **函数注释**：JSDoc 格式
```javascript
/**
 * 创建一个新的浏览器会话
 * @param {object} options
 * @param {string} [options.url] - 初始 URL
 * @returns {Session}
 */
createSession(options = {}) { }
```

- **区块分隔**：使用统一格式
```javascript
// ========== WebSocket 连接管理 ==========
// ========== 指令执行器 ==========
```

- **语言**：注释使用中文，与项目风格一致

### 错误处理

- 使用 `try/catch` 包裹可能失败的异步操作
- 错误消息使用中文
- 网络错误提供重试机制

```javascript
try {
    const result = await sessionManager.sendCommand(sessionId, command);
    res.json({ success: true, result });
} catch (err) {
    res.status(500).json({ success: false, error: err.message });
}
```

### 日志规范

- 使用 `[ComponentName]` 前缀标识日志来源
- 使用 emoji 增强可读性（可选）

```javascript
console.log('[Gateway] 新的 WebSocket 连接');
console.log('[SessionManager] 会话 ${id} 已创建');
console.log('[PhantomBridge] 📡 Content Script 已就绪');
```

### 异步代码

- 优先使用 `async/await`
- 避免回调地狱

```javascript
// 推荐
async function executeCommand(command) {
    const tab = await getActiveTab();
    const result = await cdpEval(tab.id, tab.url, expression);
    return result;
}
```

---

## API 响应格式

所有 RESTful API 返回统一格式：

```javascript
// 成功
{ success: true, result: { ... }, ... }

// 失败
{ success: false, error: '错误消息' }
```

---

## Chrome 扩展开发注意事项

### Manifest V3 约束

- Service Worker 替代 Background Page
- 使用 `chrome.scripting` API 注入脚本
- `chrome.debugger` 需要用户主动触发或特定权限

### 受限页面

以下页面无法执行 CDP 操作：
- `chrome://`、`edge://`、`brave://`
- `chrome-extension://`
- `about:`、`view-source:`
- `devtools://`

处理方式：自动跳转到回退页面 (`https://www.google.com/`)

### WebSocket 连接

扩展通过 WebSocket 连接本地网关：
- 地址：`ws://127.0.0.1:7778/ws`
- 心跳间隔：25 秒
- 重连间隔：3 秒

---

## 测试指南

运行测试：
```bash
node test/test-native-protocol.js
```

测试框架：无框架，使用简单的 `assert` 函数

```javascript
function assert(condition, testName) {
    if (condition) {
        console.log(`  ✅ ${testName}`);
        passed++;
    } else {
        console.error(`  ❌ ${testName}`);
        failed++;
    }
}
```

---

## 关键技术点

### Native Messaging 协议

每条消息 = 4 字节小端序长度前缀 + UTF-8 JSON body

```javascript
// 编码
const header = Buffer.alloc(4);
header.writeUInt32LE(body.length, 0);
const message = Buffer.concat([header, body]);

// 解码
const length = buffer.readUInt32LE(0);
const json = buffer.slice(4, 4 + length).toString('utf-8');
```

### CDP (Chrome DevTools Protocol)

使用 `chrome.debugger` API 执行内核级操作：

```javascript
// 真实鼠标点击
await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1
});
await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1
});
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PHANTOM_PORT` | 7778 | 网关 HTTP/WebSocket 端口 |
| `CHROME_PATH` | 自动检测 | Chrome 可执行文件路径 |

---

## 常见开发任务

### 添加新的 API 端点

1. 在 `gateway/api-routes.js` 中添加路由
2. 在 `extension/background.js` 的 `executeCommand()` 中添加 case
3. 实现 `cmdXxx()` 函数

### 添加新的 CDP 操作

1. 在 `extension/background.js` 中实现命令处理函数
2. 使用 `ensureDebugger()` 确保 debugger 已附加
3. 调用 `chrome.debugger.sendCommand()`
4. 提供 scripting 兜底方案

### 调试扩展

1. 打开 `chrome://extensions/`
2. 启用"开发者模式"
3. 加载 `extension/` 目录
4. 点击"Service Worker"链接查看日志
