/**
 * PhantomBridge - Chrome 进程启动器
 * 
 * 实现"幽灵启动"：静默拉起独立 Chrome 实例，
 * 每个任务使用隔离的 Profile，并自动加载扩展。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Chrome 可能的安装路径（Windows）
const CHROME_PATHS = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
].filter(Boolean);

/**
 * 自动检测 Chrome 安装路径
 * @returns {string|null}
 */
function findChromePath() {
    for (const p of CHROME_PATHS) {
        try {
            if (fs.existsSync(p)) return p;
        } catch (e) {
            // 忽略权限等错误
        }
    }
    return null;
}

/**
 * 启动一个隔离的 Chrome 实例
 * @param {object} options
 * @param {string} options.taskId - 任务 ID，用于创建独立 Profile
 * @param {string} [options.url] - 初始导航 URL
 * @param {string} [options.extensionPath] - 扩展目录路径
 * @param {string} [options.chromePath] - 自定义 Chrome 路径
 * @param {string} [options.userDataDir] - 用户数据目录
 * @returns {{ process: ChildProcess, profileDir: string }}
 */
function launchChrome(options) {
    const {
        taskId,
        url = 'about:blank',
        extensionPath = path.resolve(__dirname, '..', 'extension'),
        chromePath = findChromePath(),
        userDataDir = path.resolve(__dirname, '..', '.chrome-profiles'),
    } = options;

    if (!chromePath) {
        throw new Error(
            '未找到 Chrome 浏览器。请设置环境变量 CHROME_PATH 或确保 Chrome 安装在默认路径。'
        );
    }

    const profileDir = `Profile_${taskId}`;
    const fullProfilePath = path.join(userDataDir, profileDir);

    // 确保 profile 目录存在
    fs.mkdirSync(fullProfilePath, { recursive: true });

    const args = [
        // 每个会话使用独立 user-data-dir，避免被已运行实例吞掉参数（尤其是 --load-extension）
        `--user-data-dir=${fullProfilePath}`,
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--new-window',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
        '--disable-popup-blocking',
        url,
    ];

    console.log(`[PhantomBridge] 正在启动 Chrome...`);
    console.log(`[PhantomBridge] 路径: ${chromePath}`);
    console.log(`[PhantomBridge] Profile: ${fullProfilePath}`);
    console.log(`[PhantomBridge] URL: ${url}`);

    const chromeProcess = spawn(chromePath, args, {
        detached: true,
        stdio: 'ignore',
    });

    chromeProcess.unref();

    chromeProcess.on('error', (err) => {
        console.error(`[PhantomBridge] Chrome 启动失败:`, err.message);
    });

    chromeProcess.on('exit', (code) => {
        console.log(`[PhantomBridge] Chrome 进程退出, code=${code}`);
    });

    return {
        process: chromeProcess,
        profileDir,
        pid: chromeProcess.pid,
    };
}

module.exports = { launchChrome, findChromePath };
