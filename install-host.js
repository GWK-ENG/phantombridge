/**
 * PhantomBridge - Native Messaging Host 安装脚本 (Windows)
 * 
 * 功能：
 * 1. 生成 Native Messaging Host manifest JSON 文件
 * 2. 写入 Windows 注册表，注册到 Chrome
 * 
 * 使用方式：node install-host.js [extension-id]
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const HOST_NAME = 'com.phantombridge.gateway';
const PROJECT_ROOT = __dirname;

// 从命令行参数获取 extension ID，或使用占位符
const extensionId = process.argv[2] || 'YOUR_EXTENSION_ID_HERE';

console.log('');
console.log('╔══════════════════════════════════════════════════════╗');
console.log('║   🌌 PhantomBridge - Native Messaging Host 安装     ║');
console.log('╚══════════════════════════════════════════════════════╝');
console.log('');

// ========== Step 1: 生成 manifest 文件 ==========

const manifestPath = path.join(PROJECT_ROOT, `${HOST_NAME}.json`);
const batPath = path.join(PROJECT_ROOT, 'native-host.bat');

const manifest = {
    name: HOST_NAME,
    description: 'PhantomBridge - AI Browser Control Gateway',
    path: batPath,
    type: 'stdio',
    allowed_origins: [
        `chrome-extension://${extensionId}/`,
    ],
};

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
console.log(`✅ Manifest 文件已生成: ${manifestPath}`);
console.log(`   Extension ID: ${extensionId}`);

// ========== Step 2: 写入 Windows 注册表 ==========

const regKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
const regCommand = `reg add "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`;

try {
    execSync(regCommand, { stdio: 'pipe' });
    console.log(`✅ 注册表已写入: ${regKey}`);
} catch (err) {
    console.error(`❌ 注册表写入失败:`, err.message);
    console.log('');
    console.log('请手动执行以下命令:');
    console.log(`  ${regCommand}`);
}

// ========== 输出使用说明 ==========

console.log('');
console.log('────────────────────────────────────────────────────────');
console.log('📋 安装完成!');
console.log('');
console.log('下一步操作:');
console.log('');
console.log('1. 获取扩展 ID:');
console.log('   打开 Chrome → chrome://extensions → 启用开发者模式');
console.log('   点击「加载已解压的扩展程序」→ 选择 extension/ 目录');
console.log('   复制扩展 ID (形如 abcdefghijklmnopqrstuvwxyz)');
console.log('');

if (extensionId === 'YOUR_EXTENSION_ID_HERE') {
    console.log('2. 用你的扩展 ID 重新运行此脚本:');
    console.log(`   node install-host.js <你的扩展ID>`);
    console.log('');
}

console.log('3. 启动网关:');
console.log('   npm start');
console.log('');
console.log('4. 打开扩展的 Service Worker DevTools 查看连接日志');
console.log('────────────────────────────────────────────────────────');
