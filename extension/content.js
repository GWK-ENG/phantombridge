/**
 * PhantomBridge - Content Script (页面感知层)
 * 
 * 在 document_idle 时机注入，页面 DOM 已就绪。
 * 职责：
 * 1. DOM → Markdown 清洗器 (Readability)
 * 2. 交互元素坐标映射 (Spatial Mapping)
 */

(function () {
    'use strict';

    // ========== DOM → Markdown 清洗器 ==========

    /**
     * 将当前页面 DOM 转换为精简的 Markdown 文本
     * @returns {string}
     */
    function domToMarkdown() {
        const body = document.body;
        if (!body) return '';

        // 克隆 body 以避免修改原始 DOM
        const clone = body.cloneNode(true);

        // 移除无用元素
        const removeSelectors = [
            'script', 'style', 'noscript', 'iframe', 'svg',
            'link', 'meta', '[hidden]', '[aria-hidden="true"]',
            '.phantombridge-marker', // 我们自己注入的标记
        ];
        removeSelectors.forEach((sel) => {
            clone.querySelectorAll(sel).forEach((el) => el.remove());
        });

        // 递归转换
        return nodeToMarkdown(clone).trim();
    }

    /**
     * 递归地将 DOM 节点转换为 Markdown
     * @param {Node} node
     * @param {number} depth
     * @returns {string}
     */
    function nodeToMarkdown(node, depth = 0) {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.replace(/\s+/g, ' ').trim();
            return text ? text : '';
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const el = /** @type {HTMLElement} */ (node);
        const tag = el.tagName.toLowerCase();

        // 检查是否隐藏
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') {
            return '';
        }

        // 获取子节点的 Markdown 内容
        const childMarkdown = () => {
            let result = '';
            for (const child of el.childNodes) {
                result += nodeToMarkdown(child, depth);
            }
            return result;
        };

        switch (tag) {
            // 标题
            case 'h1': return `\n# ${childMarkdown().trim()}\n\n`;
            case 'h2': return `\n## ${childMarkdown().trim()}\n\n`;
            case 'h3': return `\n### ${childMarkdown().trim()}\n\n`;
            case 'h4': return `\n#### ${childMarkdown().trim()}\n\n`;
            case 'h5': return `\n##### ${childMarkdown().trim()}\n\n`;
            case 'h6': return `\n###### ${childMarkdown().trim()}\n\n`;

            // 段落和块级元素
            case 'p': return `\n${childMarkdown().trim()}\n\n`;
            case 'div':
            case 'section':
            case 'article':
            case 'main':
            case 'aside':
            case 'header':
            case 'footer':
            case 'nav':
                return `\n${childMarkdown()}\n`;

            // 换行
            case 'br': return '\n';
            case 'hr': return '\n---\n\n';

            // 内联格式
            case 'strong':
            case 'b': {
                const text = childMarkdown().trim();
                return text ? `**${text}**` : '';
            }
            case 'em':
            case 'i': {
                const text = childMarkdown().trim();
                return text ? `*${text}*` : '';
            }
            case 'code': {
                const text = childMarkdown().trim();
                return text ? `\`${text}\`` : '';
            }
            case 'del':
            case 's': {
                const text = childMarkdown().trim();
                return text ? `~~${text}~~` : '';
            }

            // 链接
            case 'a': {
                const href = el.getAttribute('href') || '';
                const text = childMarkdown().trim();
                const phantomId = el.dataset.phantomId;
                const idTag = phantomId ? ` [${phantomId}]` : '';
                return text ? `[${text}](${href})${idTag}` : '';
            }

            // 图片
            case 'img': {
                const alt = el.getAttribute('alt') || '';
                const src = el.getAttribute('src') || '';
                return `![${alt}](${src})`;
            }

            // 列表
            case 'ul':
            case 'ol':
                return '\n' + childMarkdown() + '\n';
            case 'li': {
                const parent = el.parentElement;
                const isOrdered = parent && parent.tagName.toLowerCase() === 'ol';
                const prefix = isOrdered
                    ? `${Array.from(parent.children).indexOf(el) + 1}. `
                    : '- ';
                return `${prefix}${childMarkdown().trim()}\n`;
            }

            // 预格式化/代码块
            case 'pre': {
                const code = el.querySelector('code');
                const lang = code?.className?.match(/language-(\w+)/)?.[1] || '';
                const text = (code || el).textContent || '';
                return `\n\`\`\`${lang}\n${text.trim()}\n\`\`\`\n\n`;
            }

            // 表格
            case 'table':
                return '\n' + tableToMarkdown(el) + '\n';

            // 表单元素（添加 phantom ID 标记）
            case 'input':
            case 'textarea':
            case 'select':
            case 'button': {
                const phantomId = el.dataset.phantomId;
                const idTag = phantomId ? `[${phantomId}]` : '';
                const label = el.getAttribute('aria-label')
                    || el.getAttribute('placeholder')
                    || el.getAttribute('name')
                    || el.textContent?.trim()
                    || tag;
                return ` ${idTag}[${tag}: ${label}] `;
            }

            // 忽略的元素
            case 'head':
            case 'script':
            case 'style':
                return '';

            // 默认：递归处理子节点
            default:
                return childMarkdown();
        }
    }

    /**
     * 将 HTML table 转换为 Markdown 表格
     * @param {HTMLTableElement} table
     * @returns {string}
     */
    function tableToMarkdown(table) {
        const rows = [];
        const allRows = table.querySelectorAll('tr');

        allRows.forEach((tr) => {
            const cells = [];
            tr.querySelectorAll('th, td').forEach((cell) => {
                cells.push(cell.textContent.replace(/\s+/g, ' ').trim());
            });
            rows.push(cells);
        });

        if (rows.length === 0) return '';

        // 构建 Markdown 表格
        let md = '';
        rows.forEach((row, i) => {
            md += '| ' + row.join(' | ') + ' |\n';
            if (i === 0) {
                md += '| ' + row.map(() => '---').join(' | ') + ' |\n';
            }
        });

        return md;
    }

    // ========== 交互元素空间映射 (Spatial Mapping) ==========

    // 元素 ID 计数器
    let elementCounter = 0;

    /**
     * 扫描页面上所有可交互元素，生成坐标映射
     * @returns {Array<{id: string, tag: string, type: string, text: string, x: number, y: number, width: number, height: number}>}
     */
    function mapInteractiveElements() {
        elementCounter = 0;

        // 清除之前的标记
        document.querySelectorAll('[data-phantom-id]').forEach((el) => {
            delete el.dataset.phantomId;
        });

        const selectors = [
            'a[href]',
            'button',
            'input',
            'textarea',
            'select',
            '[role="button"]',
            '[role="link"]',
            '[role="tab"]',
            '[role="menuitem"]',
            '[role="checkbox"]',
            '[role="radio"]',
            '[onclick]',
            '[tabindex]:not([tabindex="-1"])',
        ];

        const elements = document.querySelectorAll(selectors.join(', '));
        const mapped = [];

        elements.forEach((el) => {
            const htmlEl = /** @type {HTMLElement} */ (el);

            // 跳过隐藏元素
            const style = window.getComputedStyle(htmlEl);
            if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.opacity === '0' ||
                htmlEl.offsetWidth === 0 ||
                htmlEl.offsetHeight === 0
            ) {
                return;
            }

            const rect = htmlEl.getBoundingClientRect();

            // 跳过不在视口内的元素
            if (rect.width === 0 || rect.height === 0) return;

            const tag = htmlEl.tagName.toLowerCase();
            elementCounter++;
            const id = `${tag}-${elementCounter}`;

            // 为元素打上唯一 ID 标签
            htmlEl.dataset.phantomId = id;

            // 获取元素描述
            const text =
                htmlEl.getAttribute('aria-label') ||
                htmlEl.getAttribute('title') ||
                htmlEl.getAttribute('placeholder') ||
                htmlEl.getAttribute('alt') ||
                htmlEl.innerText?.trim().slice(0, 80) ||
                htmlEl.getAttribute('name') ||
                '';

            mapped.push({
                id,
                tag,
                type: htmlEl.getAttribute('type') || htmlEl.getAttribute('role') || tag,
                text,
                href: htmlEl.getAttribute('href') || undefined,
                value: htmlEl.value || undefined,
                x: Math.round(rect.x + rect.width / 2),  // 元素中心 X
                y: Math.round(rect.y + rect.height / 2),  // 元素中心 Y
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                rect: {
                    top: Math.round(rect.top),
                    left: Math.round(rect.left),
                    bottom: Math.round(rect.bottom),
                    right: Math.round(rect.right),
                },
            });
        });

        console.log(`[PhantomBridge] 🗺️ 已映射 ${mapped.length} 个交互元素`);
        return mapped;
    }

    // ========== 消息监听器 ==========

    // 监听来自 background.js (通过 chrome.scripting.executeScript) 的请求
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;

        switch (event.data?.type) {
            case 'PHANTOM_GET_MARKDOWN': {
                const markdown = domToMarkdown();
                window.postMessage({
                    type: 'PHANTOM_MARKDOWN_RESULT',
                    markdown,
                }, '*');
                break;
            }

            case 'PHANTOM_GET_ELEMENTS': {
                const elements = mapInteractiveElements();
                window.postMessage({
                    type: 'PHANTOM_ELEMENTS_RESULT',
                    elements,
                }, '*');
                break;
            }
        }
    });

    // 通知 Service Worker Content Script 已就绪
    try {
        chrome.runtime.sendMessage({
            type: 'PHANTOM_CONTENT_READY',
            url: window.location.href,
        });
    } catch (e) {
        // 扩展上下文可能无效
    }

    console.log('[PhantomBridge] 📡 Content Script 已就绪');
})();
