/**
 * PhantomBridge - Native Messaging 协议测试
 * 
 * 验证 encodeMessage / decodeMessage 的正确性，
 * 无需真实 Chrome 环境即可测试核心编解码逻辑。
 */

const { encodeMessage, decodeMessage } = require('../gateway/native-messaging');

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

function assertDeepEqual(a, b, testName) {
    assert(JSON.stringify(a) === JSON.stringify(b), testName);
}

console.log('');
console.log('🧪 Native Messaging 协议测试');
console.log('══════════════════════════════════════');

// ========== 测试 1: 基础编解码 ==========
console.log('\n📦 测试 1: 基础编解码');
{
    const original = { action: 'navigate', url: 'https://example.com' };
    const encoded = encodeMessage(original);

    // 验证长度前缀
    const expectedLength = Buffer.from(JSON.stringify(original), 'utf-8').length;
    assert(encoded.readUInt32LE(0) === expectedLength, '长度前缀正确');

    // 验证解码
    const { message, remaining } = decodeMessage(encoded);
    assertDeepEqual(message, original, '解码内容匹配');
    assert(remaining.length === 0, '无剩余数据');
}

// ========== 测试 2: 中文内容 ==========
console.log('\n📦 测试 2: 中文内容编解码');
{
    const original = { action: 'type', text: '你好世界！这是一段中文测试。' };
    const encoded = encodeMessage(original);
    const { message } = decodeMessage(encoded);
    assertDeepEqual(message, original, '中文内容正确编解码');
}

// ========== 测试 3: 大消息 ==========
console.log('\n📦 测试 3: 大消息编解码');
{
    const original = {
        action: 'get_markdown',
        markdown: 'x'.repeat(100000), // 100KB 文本
    };
    const encoded = encodeMessage(original);
    const { message } = decodeMessage(encoded);
    assert(message.markdown.length === 100000, '大消息正确编解码 (100KB)');
}

// ========== 测试 4: 多消息拼接 ==========
console.log('\n📦 测试 4: 多消息拼接解码');
{
    const msg1 = { id: 1, action: 'click' };
    const msg2 = { id: 2, action: 'type' };
    const msg3 = { id: 3, action: 'navigate' };

    const combined = Buffer.concat([
        encodeMessage(msg1),
        encodeMessage(msg2),
        encodeMessage(msg3),
    ]);

    let buf = combined;
    const decoded = [];

    while (buf.length >= 4) {
        try {
            const { message, remaining } = decodeMessage(buf);
            decoded.push(message);
            buf = remaining;
        } catch {
            break;
        }
    }

    assert(decoded.length === 3, '解码出 3 条消息');
    assertDeepEqual(decoded[0], msg1, '消息 1 正确');
    assertDeepEqual(decoded[1], msg2, '消息 2 正确');
    assertDeepEqual(decoded[2], msg3, '消息 3 正确');
}

// ========== 测试 5: 不完整消息 ==========
console.log('\n📦 测试 5: 不完整消息处理');
{
    const encoded = encodeMessage({ test: true });
    const partial = encoded.slice(0, encoded.length - 5); // 截断

    try {
        decodeMessage(partial);
        assert(false, '应该抛出错误');
    } catch (err) {
        assert(err.message.includes('不完整'), '正确抛出不完整数据错误');
    }
}

// ========== 测试 6: 空 buffer ==========
console.log('\n📦 测试 6: 空 Buffer 处理');
{
    try {
        decodeMessage(Buffer.alloc(0));
        assert(false, '应该抛出错误');
    } catch (err) {
        assert(err.message.includes('太短'), '正确抛出 Buffer 太短错误');
    }
}

// ========== 结果 ==========
console.log('\n══════════════════════════════════════');
console.log(`结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
    process.exit(1);
} else {
    console.log('🎉 全部通过!\n');
}
