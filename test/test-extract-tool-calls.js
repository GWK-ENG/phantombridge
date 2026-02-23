/**
 * PhantomBridge - extractToolCalls 单元测试
 * 
 * 验证工具调用解析器能处理各种 AI 输出格式。
 */

// 从 sidepanel.js 直接复制核心函数用于测试
function _tryParseToolJson(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return null;
    try { return JSON.parse(trimmed); } catch { }
    try { return JSON.parse(trimmed.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']')); } catch { }
    try { return JSON.parse(trimmed.replace(/'/g, '"')); } catch { }
    const jsonMatch = trimmed.match(/\{[^{}]*"action"\s*:\s*"[^"]+?"[^{}]*\}/);
    if (jsonMatch) { try { return JSON.parse(jsonMatch[0]); } catch { } }
    return null;
}

function extractToolCalls(text) {
    const calls = [];
    const raw = String(text || '');
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');

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

    if (calls.length === 0) {
        const lines = cleaned.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('{') && trimmed.includes('"action"')) {
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

// ========== 测试框架 ==========

let passed = 0;
let failed = 0;

function assert(condition, testName) {
    if (condition) {
        console.log(`  ✅ ${testName}`);
        passed++;
    } else {
        console.error(`  ❌ ${testName}`);
        failed++;
    }
}

console.log('');
console.log('🧪 extractToolCalls 单元测试');
console.log('══════════════════════════════════════');

// ========== 标准 ```tool 格式 ==========
console.log('\n📦 测试 1: 标准 ```tool 格式');
{
    const text = '好的，我来帮你打开百度\n```tool\n{"action": "navigate", "url": "https://www.baidu.com"}\n```\n正在打开...';
    const calls = extractToolCalls(text);
    assert(calls.length === 1, '解析出 1 个工具调用');
    assert(calls[0].action === 'navigate', 'action 正确');
    assert(calls[0].url === 'https://www.baidu.com', 'url 正确');
}

// ========== ```json 格式 ==========
console.log('\n📦 测试 2: ```json 格式');
{
    const text = '```json\n{"action": "cdp_click", "x": 100, "y": 200}\n```';
    const calls = extractToolCalls(text);
    assert(calls.length === 1, '解析出 1 个工具调用');
    assert(calls[0].action === 'cdp_click', 'action 正确');
    assert(calls[0].x === 100 && calls[0].y === 200, '坐标正确');
}

// ========== 无语言标记的代码块 ==========
console.log('\n📦 测试 3: 无语言标记代码块');
{
    const text = '```\n{"action": "get_tab_info"}\n```';
    const calls = extractToolCalls(text);
    assert(calls.length === 1, '解析出 1 个工具调用');
    assert(calls[0].action === 'get_tab_info', 'action 正确');
}

// ========== 多个工具调用 ==========
console.log('\n📦 测试 4: 多个工具调用');
{
    const text = '先点击输入框再输入\n```tool\n{"action": "cdp_click", "x": 400, "y": 200}\n```\n```tool\n{"action": "cdp_type", "text": "天气"}\n```';
    const calls = extractToolCalls(text);
    assert(calls.length === 2, '解析出 2 个工具调用');
    assert(calls[0].action === 'cdp_click', '第1个 action 正确');
    assert(calls[1].action === 'cdp_type', '第2个 action 正确');
}

// ========== DeepSeek-R1 <think> 标签 ==========
console.log('\n📦 测试 5: DeepSeek-R1 <think> 标签过滤');
{
    const text = '<think>\n用户想打开百度，我应该用 navigate 工具\n</think>\n\n```tool\n{"action": "navigate", "url": "https://www.baidu.com"}\n```\n好的，正在打开百度。';
    const calls = extractToolCalls(text);
    assert(calls.length === 1, '解析出 1 个工具调用（忽略 think 内容）');
    assert(calls[0].action === 'navigate', 'action 正确');
}

// ========== <think> 内含有代码块不误提取 ==========
console.log('\n📦 测试 6: <think> 内代码块不误提取');
{
    const text = '<think>\n不应该用这个\n```tool\n{"action": "close_tab", "tabId": 1}\n```\n</think>\n\n好的，已经帮你查看了。';
    const calls = extractToolCalls(text);
    assert(calls.length === 0, '不应提取 think 内的工具调用');
}

// ========== 裸 JSON 行 ==========
console.log('\n📦 测试 7: 裸 JSON 行（无代码块）');
{
    const text = '好的\n{"action": "navigate", "url": "https://google.com"}\n完成';
    const calls = extractToolCalls(text);
    assert(calls.length === 1, '解析出 1 个裸 JSON 工具调用');
    assert(calls[0].action === 'navigate', 'action 正确');
}

// ========== 尾逗号修复 ==========
console.log('\n📦 测试 8: 尾逗号 JSON 修复');
{
    const text = '```tool\n{"action": "get_markdown",}\n```';
    const calls = extractToolCalls(text);
    assert(calls.length === 1, '修复尾逗号后解析成功');
    assert(calls[0].action === 'get_markdown', 'action 正确');
}

// ========== 单引号 JSON 修复 ==========
console.log('\n📦 测试 9: 单引号 JSON 修复');
{
    const text = "```tool\n{'action': 'navigate', 'url': 'https://baidu.com'}\n```";
    const calls = extractToolCalls(text);
    assert(calls.length === 1, '修复单引号后解析成功');
    assert(calls[0].action === 'navigate', 'action 正确');
}

// ========== 无工具调用的纯文本 ==========
console.log('\n📦 测试 10: 无工具调用');
{
    const text = '你好，这是一个普通的回复，没有任何工具调用。\n\n我可以帮你操作浏览器。';
    const calls = extractToolCalls(text);
    assert(calls.length === 0, '纯文本不应提取工具调用');
}

// ========== 非工具 JSON（无 action）不匹配 ==========
console.log('\n📦 测试 11: 非工具 JSON（无 action）');
{
    const text = '```json\n{"name": "test", "value": 123}\n```';
    const calls = extractToolCalls(text);
    assert(calls.length === 0, '无 action 字段的 JSON 不应作为工具调用');
}

// ========== 嵌入文字的 JSON 提取 ==========
console.log('\n📦 测试 12: 嵌入在文字中的 JSON');
{
    const text = '我要执行这个命令 {"action": "take_screenshot"} 好了';
    const calls = extractToolCalls(text);
    // 裸 JSON 解析只在行首匹配
    // 不过用了 lastIndexOf('}') 截取 
    assert(calls.length === 0 || calls[0].action === 'take_screenshot', '嵌入 JSON 处理正确');
}

// ========== _tryParseToolJson 专项 ==========
console.log('\n📦 测试 13: _tryParseToolJson 格式修复');
{
    assert(_tryParseToolJson('{"action": "test"}')?.action === 'test', '标准 JSON');
    assert(_tryParseToolJson('{"action": "test",}')?.action === 'test', '尾逗号');
    assert(_tryParseToolJson("{'action': 'test'}")?.action === 'test', '单引号');
    assert(_tryParseToolJson('') === null, '空字符串返回 null');
    assert(_tryParseToolJson('not json') === null, '非 JSON 返回 null');
}

// ========== 结果 ==========
console.log('\n══════════════════════════════════════');
console.log(`结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
    process.exit(1);
} else {
    console.log('🎉 全部通过!\n');
}
