/**
 * PhantomBridge - Native Messaging 协议编解码模块
 * 
 * Chrome Native Messaging 协议：
 * - 每条消息 = 4 字节小端序长度前缀 + UTF-8 编码的 JSON body
 * - stdin 读取浏览器扩展发来的消息
 * - stdout 向扩展发送消息
 */

const { EventEmitter } = require('events');

class NativeMessagingHost extends EventEmitter {
  constructor() {
    super();
    this._buffer = Buffer.alloc(0);
    this._started = false;
  }

  /**
   * 启动 stdin 监听（被 Chrome 以 Native Messaging Host 模式启动时使用）
   */
  start() {
    if (this._started) return;
    this._started = true;

    // stdin 以二进制模式读取
    process.stdin.on('data', (chunk) => {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      this._tryParse();
    });

    process.stdin.on('end', () => {
      this.emit('disconnect');
    });

    process.stdin.on('error', (err) => {
      this.emit('error', err);
    });
  }

  /**
   * 尝试从 buffer 中解析完整的消息
   */
  _tryParse() {
    while (this._buffer.length >= 4) {
      // 读取 4 字节小端序长度前缀
      const messageLength = this._buffer.readUInt32LE(0);

      // 安全检查：消息不应超过 1MB
      if (messageLength > 1024 * 1024) {
        this.emit('error', new Error(`消息过大: ${messageLength} bytes`));
        this._buffer = Buffer.alloc(0);
        return;
      }

      // 数据还不够，等待更多数据
      if (this._buffer.length < 4 + messageLength) {
        return;
      }

      // 提取完整消息
      const messageBytes = this._buffer.slice(4, 4 + messageLength);
      this._buffer = this._buffer.slice(4 + messageLength);

      try {
        const message = JSON.parse(messageBytes.toString('utf-8'));
        this.emit('message', message);
      } catch (err) {
        this.emit('error', new Error(`JSON 解析失败: ${err.message}`));
      }
    }
  }

  /**
   * 向 Chrome 扩展发送消息（写入 stdout）
   * @param {object} message - 要发送的 JSON 对象
   */
  send(message) {
    const json = JSON.stringify(message);
    const body = Buffer.from(json, 'utf-8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);

    try {
      process.stdout.write(header);
      process.stdout.write(body);
    } catch (err) {
      this.emit('error', new Error(`发送消息失败: ${err.message}`));
    }
  }
}

/**
 * 编码一条 Native Messaging 消息为 Buffer（用于测试和模拟）
 * @param {object} message - JSON 对象
 * @returns {Buffer}
 */
function encodeMessage(message) {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * 从 Buffer 中解码一条 Native Messaging 消息（用于测试和模拟）
 * @param {Buffer} buffer
 * @returns {{ message: object, remaining: Buffer }}
 */
function decodeMessage(buffer) {
  if (buffer.length < 4) {
    throw new Error('Buffer 太短，无法读取长度前缀');
  }
  const length = buffer.readUInt32LE(0);
  if (buffer.length < 4 + length) {
    throw new Error('Buffer 数据不完整');
  }
  const message = JSON.parse(buffer.slice(4, 4 + length).toString('utf-8'));
  const remaining = buffer.slice(4 + length);
  return { message, remaining };
}

module.exports = { NativeMessagingHost, encodeMessage, decodeMessage };
