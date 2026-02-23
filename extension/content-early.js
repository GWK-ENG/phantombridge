/**
 * PhantomBridge - Content Script (早期注入)
 * 
 * 在 document_start 时机注入，必须在页面任何脚本加载之前执行。
 * 职责：Visibility Override 保活欺骗
 */

(function () {
    'use strict';

    // ========== Visibility Override 保活欺骗 ==========
    // 欺骗前端框架（React、Vue 等），让它永远以为页面处于前台激活状态
    // 防止切换标签时页面冻结/暂停渲染

    try {
        // 覆写 document.visibilityState → 永远返回 'visible'
        Object.defineProperty(document, 'visibilityState', {
            get: function () { return 'visible'; },
            configurable: true,
        });

        // 覆写 document.hidden → 永远返回 false
        Object.defineProperty(document, 'hidden', {
            get: function () { return false; },
            configurable: true,
        });

        // 拦截 visibilitychange 事件，阻止传播
        document.addEventListener('visibilitychange', function (e) {
            e.stopImmediatePropagation();
        }, true);

        // 拦截 Page Visibility API 的 pagehide/pageshow
        window.addEventListener('pagehide', function (e) {
            e.stopImmediatePropagation();
        }, true);

        console.log('[PhantomBridge] 🛡️ Visibility Override 已激活');
    } catch (err) {
        console.error('[PhantomBridge] Visibility Override 注入失败:', err);
    }
})();
