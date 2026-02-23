/**
 * PhantomBridge - CLI 自动检测与交互
 *
 * 自动检测本地已安装的 AI CLI 工具，通过子进程管道交互。
 * 支持: Gemini CLI, Claude CLI, Codex, OpenCode, Ollama, Aider 等。
 */

const { spawn, execSync } = require('child_process');
const os = require('os');

// ========== CLI 工具注册表 ==========

const CLI_REGISTRY = [
    {
        id: 'gemini',
        name: 'Gemini CLI',
        icon: '✦',
        commands: ['gemini'],
        // 使用稳定的非交互模式；不强制 --sandbox（部分环境会因沙箱镜像拉取失败）
        spawnArgs: (prompt) => ['gemini', ['-p', shellQuoteArg(prompt)]],
        detectVersion: (bin) => execSafe(`${bin} --version`),
        suppressStderr: true, // Gemini 的 stderr 都是调试信息，不输出
    },
    {
        id: 'claude',
        name: 'Claude CLI',
        icon: '🟤',
        commands: ['claude'],
        // 强制非交互权限模式，避免后台进程等待用户确认导致挂起
        spawnArgs: (prompt) => ['claude', ['-p', shellQuoteArg(prompt), '--permission-mode', 'dontAsk']],
        detectVersion: (bin) => execSafe(`${bin} --version`),
        suppressStderr: true,
    },
    {
        id: 'codex',
        name: 'Codex CLI',
        icon: '🟢',
        commands: ['codex'],
        // 旧版 --quiet 已移除，改为稳定的非交互子命令
        spawnArgs: (prompt) => ['codex', ['exec', '--skip-git-repo-check', '--color', 'never', shellQuoteArg(prompt)]],
        detectVersion: (bin) => execSafe(`${bin} --version`),
        suppressStderr: true,
    },
    {
        id: 'opencode',
        name: 'OpenCode',
        icon: '⚡',
        commands: ['opencode'],
        // 直接用 run 子命令，避免启动 TUI 导致阻塞
        spawnArgs: (prompt) => ['opencode', ['run', shellQuoteArg(prompt)]],
        detectVersion: (bin) => execSafe(`${bin} --version`),
        suppressStderr: true,
    },
    {
        id: 'aider',
        name: 'Aider',
        icon: '🔧',
        commands: ['aider'],
        spawnArgs: (prompt) => ['aider', ['--message', shellQuoteArg(prompt), '--no-git', '--yes']],
        detectVersion: (bin) => execSafe(`${bin} --version`),
        suppressStderr: false,
    },
    {
        id: 'ollama',
        name: 'Ollama',
        icon: '🦙',
        commands: ['ollama'],
        // ollama run model prompt
        spawnArgs: (prompt, model = 'deepseek-r1:8b') => ['ollama', ['run', model, shellQuoteArg(prompt)]],
        detectVersion: (bin) => execSafe(`${bin} --version`),
        suppressStderr: false,
    },
];

const FALLBACK_PRIORITY = ['codex', 'claude', 'opencode', 'ollama', 'aider', 'gemini'];

function pickPreferredCliId(clis = []) {
    if (!Array.isArray(clis) || clis.length === 0) return null;
    for (const id of FALLBACK_PRIORITY) {
        if (clis.some((c) => c.id === id)) return id;
    }
    return clis[0].id;
}

// ========== 工具函数 ==========

function execSafe(cmd) {
    try {
        return execSync(cmd, {
            encoding: 'utf-8',
            timeout: 5000,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
    } catch {
        return null;
    }
}

function findBinary(name) {
    const where = os.platform() === 'win32' ? 'where.exe' : 'which';
    try {
        const result = execSync(`${where} ${name}`, {
            encoding: 'utf-8',
            timeout: 3000,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        // where.exe 可能返回多行，取第一个
        return result.split(/\r?\n/)[0].trim();
    } catch {
        return null;
    }
}

function shellQuoteArg(value) {
    const text = String(value ?? '');
    // Windows shell=true 会先经 cmd 解析；统一包双引号避免 prompt 被按空格拆分
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isLikelyCliFailureText(text = '') {
    const t = String(text).toLowerCase();
    if (!t.trim()) return false;
    const failurePatterns = [
        /\berror:/i,
        /\bunknown option\b/i,
        /\bunexpected argument\b/i,
        /^\s*usage:/im,
        /\bpermission denied\b/i,
        /\bnot found\b/i,
        /\bfailed\b/i,
    ];
    return failurePatterns.some((pattern) => pattern.test(t));
}

function isCapacityOrRateLimitError(text = '') {
    const t = String(text || '').toLowerCase();
    if (!t.trim()) return false;
    return (
        t.includes('resource_exhausted') ||
        t.includes('model_capacity_exhausted') ||
        t.includes('no capacity available for model') ||
        t.includes('rate limit') ||
        t.includes('ratelimit') ||
        t.includes('rateLimitExceeded'.toLowerCase()) ||
        t.includes('too many requests') ||
        t.includes('"code": 429') ||
        t.includes('status 429')
    );
}

function isNotConfiguredError(text = '') {
    const t = String(text || '').toLowerCase();
    if (!t.trim()) return false;
    return (
        t.includes('api key is missing') ||
        t.includes('missing credentials') ||
        t.includes('not logged in') ||
        t.includes('authentication') ||
        t.includes('unauthorized') ||
        t.includes('forbidden') ||
        t.includes('google_generative_ai_api_key')
    );
}

function isRetryableTransportError(text = '') {
    const t = String(text || '').toLowerCase();
    if (!t.trim()) return false;
    return (
        t.includes('timeout') ||
        t.includes('timed out') ||
        t.includes('econnreset') ||
        t.includes('socket hang up') ||
        t.includes('temporarily unavailable') ||
        t.includes('service unavailable') ||
        t.includes('connection refused')
    );
}

function shouldAutoFallbackByError(text = '') {
    return isCapacityOrRateLimitError(text) || isRetryableTransportError(text);
}

function compactCliError(detail, cliName = 'CLI') {
    const raw = cleanCliOutput(String(detail || ''));
    const lower = raw.toLowerCase();

    if (!raw) return `${cliName} 返回空错误信息`;
    if (isCapacityOrRateLimitError(lower)) {
        return `${cliName} 额度/容量不足（429），请稍后重试或切换其他 CLI。`;
    }
    if (isNotConfiguredError(lower)) {
        return `${cliName} 未完成配置（登录/API Key），请先配置后再试。`;
    }

    const noisePatterns = [
        /^at\s+/i,
        /^config:\s*$/i,
        /^response:\s*$/i,
        /^request:\s*$/i,
        /^error:\s*$/i,
        /^gaxioserror/i,
        /^loaded cached credentials\.?$/i,
        /^server\s+['"][^'"]+['"]\s+supports tool updates/i,
        /^skill conflict detected:/i,
        /^\[symbol\(gaxios-gaxios-error\)\]/i,
        /^\{$/,
        /^\}$/,
    ];

    const lines = raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !noisePatterns.some((re) => re.test(line)));

    if (lines.length === 0) {
        return `${cliName} 执行失败（详情已省略）`;
    }

    const picked = lines.slice(0, 3).join(' | ');
    return picked.length > 320 ? `${picked.slice(0, 320)}...` : picked;
}

// ========== CliDetector 类 ==========

class CliDetector {
    constructor() {
        this.detected = [];       // 已检测到的 CLI 列表
        this.activeCli = null;    // 当前选中的 CLI id
        this.activeProcess = null; // 当前运行的子进程
        this._detectCache = null;
    }

    /**
     * 检测所有已安装的 CLI 工具
     */
    detect(forceRefresh = false) {
        if (this._detectCache && !forceRefresh) {
            return this._detectCache;
        }

        console.log('[CliDetector] 正在扫描本地 AI CLI 工具...');
        const results = [];

        for (const cli of CLI_REGISTRY) {
            for (const cmd of cli.commands) {
                const binPath = findBinary(cmd);
                if (binPath) {
                    const version = cli.detectVersion(binPath) || '未知版本';
                    results.push({
                        id: cli.id,
                        name: cli.name,
                        icon: cli.icon,
                        command: cmd,
                        binPath,
                        version: version.split('\n')[0].slice(0, 60),
                        available: true,
                    });
                    console.log(`  ✅ ${cli.name}: ${binPath} (${version.split('\n')[0].slice(0, 40)})`);
                    break; // 找到一个就够了
                }
            }
        }

        if (results.length === 0) {
            console.log('  ⚠️ 未检测到任何 AI CLI 工具');
        }

        this._detectCache = results;
        this.detected = results;

        // 默认优先选择稳定 CLI（避免 Gemini 容量波动导致首轮卡死）
        if (results.length > 0 && !this.activeCli) {
            this.activeCli = pickPreferredCliId(results);
        } else if (results.length > 0 && this.activeCli && !results.some((c) => c.id === this.activeCli)) {
            // 当前 active 不在检测结果里时，自动回落到可用优先项
            this.activeCli = pickPreferredCliId(results);
        }

        return results;
    }

    /**
     * 获取已检测的 CLI 列表
     */
    getDetected() {
        if (!this._detectCache) this.detect();
        return this.detected;
    }

    /**
     * 设置当前活动 CLI
     */
    setActive(cliId) {
        const found = this.detected.find((c) => c.id === cliId);
        if (!found) throw new Error(`CLI 未找到: ${cliId}`);
        this.activeCli = cliId;
        return found;
    }

    /**
     * 获取当前活动 CLI 信息
     */
    getActive() {
        return this.detected.find((c) => c.id === this.activeCli) || null;
    }

    /**
     * 通过 CLI 执行聊天（非流式，等待完成）
     */
    async chat(message, cliId = null, options = {}) {
        const allowFallback = options.allowFallback !== false;
        const requested = this._getCli(cliId);
        const tried = [];

        try {
            return await this._runChatOnce(requested, message);
        } catch (primaryErr) {
            const primaryText = primaryErr?.rawDetail || primaryErr?.message || '';
            tried.push({ cli: requested.id, detail: compactCliError(primaryText, requested.name) });

            if (!allowFallback || !shouldAutoFallbackByError(primaryText)) {
                throw new Error(`${requested.name} 不可用：${compactCliError(primaryText, requested.name)}`);
            }

            const fallbackCandidates = this._getFallbackCandidates(requested.id);
            for (const fallback of fallbackCandidates) {
                try {
                    const result = await this._runChatOnce(fallback, message);
                    if (!cliId || cliId === this.activeCli || requested.id === this.activeCli) {
                        this.activeCli = fallback.id;
                    }
                    console.warn(
                        `[CliDetector] 主 CLI ${requested.id} 失败，已自动降级到 ${fallback.id}`
                    );
                    return {
                        ...result,
                        fallbackFrom: requested.id,
                        fallbackReason: compactCliError(primaryText, requested.name),
                    };
                } catch (fallbackErr) {
                    const fallbackText = fallbackErr?.rawDetail || fallbackErr?.message || '';
                    tried.push({ cli: fallback.id, detail: compactCliError(fallbackText, fallback.name) });
                }
            }

            const summary = tried.map((t) => `${t.cli}: ${t.detail}`).join(' | ');
            throw new Error(`所有可用 CLI 均失败。${summary}`);
        }
    }

    /**
     * 通过 CLI 流式执行聊天（SSE）
     */
    async chatStream(message, res, cliId = null) {
        const cli = this._getCli(cliId);
        const registry = CLI_REGISTRY.find((r) => r.id === cli.id);
        if (!registry) throw new Error(`CLI 注册表中未找到: ${cli.id}`);

        const [cmd, args] = registry.spawnArgs(message);

        // SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });

        return new Promise((resolve) => {
            let fullOutput = '';
            let rawStderr = '';

            const proc = spawn(cmd, args, {
                shell: true,
                windowsHide: true,
                env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
                timeout: 300000,
            });
            // 非交互调用时主动关闭 stdin，避免部分 CLI 等待输入导致挂起
            proc.stdin.end();

            this.activeProcess = proc;

            proc.stdout.on('data', (chunk) => {
                const text = chunk.toString();
                fullOutput += text;
                res.write(`data: ${JSON.stringify({ token: text, done: false })}\n\n`);
            });

            proc.stderr.on('data', (chunk) => {
                const text = chunk.toString();
                rawStderr += text;
                // 部分 CLI 的 stderr 是调试信息，根据配置决定是否输出
                if (text.trim() && !registry.suppressStderr) {
                    fullOutput += text;
                    res.write(`data: ${JSON.stringify({ token: text, done: false })}\n\n`);
                }
            });

            proc.on('close', (code) => {
                this.activeProcess = null;
                const cleaned = cleanCliOutput(fullOutput);
                const cleanedErr = cleanCliOutput(rawStderr);
                const combined = `${cleanedErr}\n${cleaned}`.trim();
                if (code === 0 && !cleaned && cleanedErr && isLikelyCliFailureText(cleanedErr)) {
                    res.write(`data: ${JSON.stringify({ error: `${cli.name} 返回错误: ${compactCliError(cleanedErr, cli.name)}` })}\n\n`);
                } else if (code !== 0 && (!cleaned || isLikelyCliFailureText(combined))) {
                    const detail = cleanedErr || cleaned || '无错误输出';
                    res.write(`data: ${JSON.stringify({ error: `${cli.name} 退出码 ${code}: ${compactCliError(detail, cli.name)}` })}\n\n`);
                }
                res.write(`data: ${JSON.stringify({ done: true, full: cleaned, exitCode: code })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                resolve();
            });

            proc.on('error', (err) => {
                this.activeProcess = null;
                res.write(`data: ${JSON.stringify({ error: compactCliError(err.message || '未知错误', cli.name) })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                resolve();
            });

            // 客户端断开时终止子进程
            res.on('close', () => {
                if (proc && !proc.killed) {
                    proc.kill('SIGTERM');
                    this.activeProcess = null;
                }
            });
        });
    }

    /**
     * 终止当前运行中的进程
     */
    abort() {
        if (this.activeProcess && !this.activeProcess.killed) {
            this.activeProcess.kill('SIGTERM');
            this.activeProcess = null;
            return true;
        }
        return false;
    }

    _getCli(cliId) {
        const id = cliId || this.activeCli;
        const cli = this.detected.find((c) => c.id === id);
        if (!cli) throw new Error(`没有可用的 CLI 工具。请安装 Gemini CLI / Claude CLI / Codex 等。`);
        return cli;
    }

    _getFallbackCandidates(primaryCliId) {
        const available = (this.detected || []).filter((c) => c.id !== primaryCliId);
        if (available.length === 0) return [];

        const orderMap = new Map();
        FALLBACK_PRIORITY.forEach((id, idx) => orderMap.set(id, idx));

        return available
            .slice()
            .sort((a, b) => {
                const ai = orderMap.has(a.id) ? orderMap.get(a.id) : Number.MAX_SAFE_INTEGER;
                const bi = orderMap.has(b.id) ? orderMap.get(b.id) : Number.MAX_SAFE_INTEGER;
                if (ai !== bi) return ai - bi;
                return a.id.localeCompare(b.id);
            });
    }

    _runChatOnce(cli, message) {
        const registry = CLI_REGISTRY.find((r) => r.id === cli.id);
        if (!registry) {
            const err = new Error(`CLI 注册表中未找到: ${cli.id}`);
            err.rawDetail = err.message;
            throw err;
        }

        const [cmd, args] = registry.spawnArgs(message);

        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let rawStderr = '';

            const proc = spawn(cmd, args, {
                shell: true,
                windowsHide: true,
                env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
                timeout: 300000,
            });
            // 非交互调用时主动关闭 stdin，避免部分 CLI 等待输入导致挂起
            proc.stdin.end();

            proc.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
            });

            proc.stderr.on('data', (chunk) => {
                const text = chunk.toString();
                rawStderr += text;
                // 只在不 suppress 时收集 stderr
                if (!registry.suppressStderr) {
                    stderr += text;
                }
            });

            proc.on('close', (code) => {
                const cleanedOut = cleanCliOutput(stdout.trim() || stderr.trim());
                const cleanedErr = cleanCliOutput(rawStderr.trim());
                const combined = `${cleanedErr}\n${cleanedOut}`.trim();

                if (code === 0) {
                    if (!cleanedOut && cleanedErr && isLikelyCliFailureText(cleanedErr)) {
                        const detail = compactCliError(cleanedErr, cli.name);
                        const err = new Error(`${cli.name} 返回错误: ${detail}`);
                        err.rawDetail = combined || cleanedErr;
                        err.exitCode = code;
                        reject(err);
                        return;
                    }
                    resolve({
                        text: cleanedOut || cleanedErr,
                        cli: cli.id,
                        exitCode: code,
                    });
                } else if (cleanedOut && !isLikelyCliFailureText(combined)) {
                    // 某些 CLI 在超时/信号下会返回 null code，但已有可用输出，按成功返回
                    resolve({
                        text: cleanedOut,
                        cli: cli.id,
                        exitCode: code,
                    });
                } else {
                    const rawDetail = (cleanedErr || cleanedOut || '无错误输出');
                    const detail = compactCliError(rawDetail, cli.name);
                    const err = new Error(`${cli.name} 退出码 ${code}: ${detail}`);
                    err.rawDetail = rawDetail;
                    err.exitCode = code;
                    reject(err);
                }
            });

            proc.on('error', (err) => {
                const rawDetail = `启动 ${cli.name} 失败: ${err.message}`;
                const e = new Error(compactCliError(rawDetail, cli.name));
                e.rawDetail = rawDetail;
                reject(e);
            });
        });
    }
}

// ========== 输出清理 ==========

function cleanCliOutput(raw) {
    return raw
        // 移除 ANSI 转义序列
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        // 移除回车符
        .replace(/\r/g, '')
        // 移除多余空行
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

module.exports = { CliDetector, CLI_REGISTRY };
