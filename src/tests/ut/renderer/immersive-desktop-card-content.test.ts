import { composeCardSrcDoc, hasCardContent } from '../../../renderer/components/desktop/cardContent.js';
import { buildDesktopStyles } from '../../../renderer/components/desktop/desktopStyles.js';
import { nextThemePreference } from '../../../renderer/components/desktop/desktopTheme.js';
import { readFileSync } from 'node:fs';

const immersiveDesktopSource = readFileSync(
    new URL('../../../renderer/components/desktop/immersiveDesktop.ts', import.meta.url),
    'utf8'
);
const desktopEffectsSource = readFileSync(
    new URL('../../../renderer/components/desktop/desktopEffects.ts', import.meta.url),
    'utf8'
);
const desktopEntrySource = readFileSync(
    new URL('../../../renderer/components/desktop/entry.ts', import.meta.url),
    'utf8'
);
const confirmModalSource = readFileSync(
    new URL('../../../renderer/components/confirmModal.ts', import.meta.url),
    'utf8'
);
const zhLocaleSource = readFileSync(new URL('../../../locale/zh-cn.ts', import.meta.url), 'utf8');
const enLocaleSource = readFileSync(new URL('../../../locale/en-us.ts', import.meta.url), 'utf8');
const titlebarStylesSource = readFileSync(new URL('../../../renderer/styles/titlebar.css', import.meta.url), 'utf8');

describe('immersive desktop card srcdoc composition', () => {
    test('cycles theme preferences in the same order as the main sidebar', () => {
        expect(nextThemePreference('light')).toBe('dark');
        expect(nextThemePreference('dark')).toBe('system');
        expect(nextThemePreference('system')).toBe('light');
    });

    test('provides a localized theme toggle without changing native fullscreen state', () => {
        expect(immersiveDesktopSource).toContain('data-desktop-theme-toggle');
        expect(immersiveDesktopSource).toContain('globalWindow.themeAPI.setPreference(next)');
        expect(immersiveDesktopSource).toContain("'renderer.sidebar.themeToggleToLight'");
        expect(immersiveDesktopSource).not.toContain('enterFullscreen');
        expect(immersiveDesktopSource).not.toContain('exitFullscreen');
        expect(immersiveDesktopSource).not.toContain('settingAPI?.setFullscreen');
    });

    test('generated card styling uses one-shot entrance animation and a caption capsule floating below the card', () => {
        const styles = buildDesktopStyles();
        expect(styles).toContain('.od-card.od-card-enter { animation: od-card-in');
        expect(styles).toContain('.od-card.od-card-done .od-card-header');
        // 标题浮层是底部居中的小胶囊，浮出在卡片下缘之外（不遮挡卡片内容）
        expect(styles).toMatch(/\.od-card\.od-card-done \.od-card-pill\s*\{[^}]*border-radius:\s*999px;/);
        expect(styles).toMatch(/\.od-card\.od-card-done \.od-card-pill\s*\{[^}]*opacity:\s*0;/);
        expect(styles).toMatch(/\.od-card\.od-card-done \.od-card-header\s*\{[^}]*top:\s*100%;/);
        expect(styles).toMatch(/\.od-card\.od-card-done \.od-card-header\s*\{[^}]*margin-top:\s*6px;/);
        // 胶囊要浮出卡片外，卡片不再裁剪溢出；圆角裁剪由内容区承担
        expect(styles).toMatch(/\.od-card\s*\{[^}]*overflow:\s*visible;/);
        expect(styles).toMatch(/\.od-card\.od-card-done \.od-card-body\s*\{[^}]*border-radius:\s*13px;/);
        // 悬停卡片任意位置即显示（Chromium 将 iframe 上的悬停态传播给父层），拖动中保持显示
        expect(styles).toContain('.od-card.od-card-done:hover .od-card-pill');
        expect(styles).toContain('.od-card.od-card-done.od-card-dragging .od-card-pill');
        expect(styles).not.toContain('.od-card.od-card-done:hover .od-card-header');
        expect(styles).toContain('.od-card.od-card-done .od-card-body { margin: 0; border-radius: 13px; }');
        expect(styles).not.toContain('.od-card.od-card-done { border-color: rgba(16, 185, 129');
    });

    test('drag hotspot is a top strip on the card, not the caption capsule', () => {
        const styles = buildDesktopStyles();
        // 顶部整条透明拖动区，指针样式为 grab
        expect(styles).toMatch(/\.od-card-drag-zone\s*\{[^}]*top:\s*0;/);
        expect(styles).toMatch(/\.od-card-drag-zone\s*\{[^}]*cursor:\s*grab;/);
        expect(styles).toMatch(/\.od-card\.od-card-dragging \.od-card-drag-zone\s*\{[^}]*cursor:\s*grabbing;/);
        // data-card-drag 挂在拖动区上，胶囊只是状态指示器
        expect(immersiveDesktopSource).toContain('<div class="od-card-drag-zone" data-card-drag=');
        expect(immersiveDesktopSource).not.toContain('<div class="od-card-pill" data-card-drag=');
        // 双击顶部拖动区仍打开设置（沿用 data-card-drag 上的双击检测）
        const dragStartSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private startCardDrag('),
            immersiveDesktopSource.indexOf('private _lastHeaderDragMoved') >= 0
                ? immersiveDesktopSource.indexOf('private handleCardDragMove(')
                : immersiveDesktopSource.indexOf('private handleCardDragMove(')
        );
        expect(dragStartSource).toContain('this.showCardEditor(card)');
    });

    test('uses the main interface semantic palette and restrained desktop surfaces', () => {
        const styles = buildDesktopStyles();
        expect(styles).toContain('--od-ink: var(--od-text, #1f2937);');
        expect(styles).toContain('--od-blue: var(--od-accent, #3b82f6);');
        expect(styles).toContain('--od-panel: var(--od-bg-elevated, #ffffff);');
        expect(styles).not.toContain('.od-blob');
        expect(styles).not.toContain('var(--od-violet)');
    });

    test('uses one coherent spatial transition without confetti-style particles', () => {
        const styles = buildDesktopStyles();
        expect(styles).toContain('clip-path: inset(');
        expect(styles).toContain('immersive-desktop.od-leaving');
        expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
        expect(desktopEffectsSource).not.toContain('spawnParticles');
        expect(desktopEffectsSource).toContain('data-desktop-transition');
    });

    test('uses the compact embedded task layout inside floating conversation windows', () => {
        const styles = buildDesktopStyles();
        const embeddedTaskMounts = immersiveDesktopSource.match(/<task-view embedded task_id=/g) ?? [];

        expect(embeddedTaskMounts).toHaveLength(2);
        expect(styles).toContain('.od-floating-window-content > task-view');
        expect(styles).toContain('width: 100%; height: 100%;');
        expect(styles).toContain('min-width: 0; min-height: 0; overflow: hidden;');
    });

    test('mounts the desktop under the main app root so embedded conversations inherit the main theme', () => {
        expect(desktopEntrySource).toContain("document.getElementById('app-root') ?? document.body");
        expect(desktopEntrySource).toContain('desktopHost.appendChild(desktop);');
    });

    test('keeps desktop toolbar controls outside the native window drag region', () => {
        const styles = buildDesktopStyles();

        expect(immersiveDesktopSource).toContain("document.body.classList.add('immersive-desktop-open');");
        expect(immersiveDesktopSource).toContain("document.body.classList.remove('immersive-desktop-open');");
        expect(titlebarStylesSource).toMatch(/body\.immersive-desktop-open\s+\.drag-overlay\s*\{[^}]*display:\s*none;/);
        expect(styles).toMatch(/\.od-topbar\s*\{[^}]*-webkit-app-region:\s*drag;/);
        expect(styles).toMatch(/\.od-status,\s*\.od-status\s+\*\s*\{[^}]*-webkit-app-region:\s*no-drag;/);
    });

    test('keeps the card grid equally inset from the header, sides, and dock', () => {
        const styles = buildDesktopStyles();

        expect(styles).toContain('--od-grid-edge: 28px;');
        expect(styles).toContain('--od-grid-card-inset: 8px;');
        expect(styles).toContain('padding-inline: calc(var(--od-grid-edge) - var(--od-grid-card-inset));');
        expect(styles).toContain('gap: calc(var(--od-grid-edge) - var(--od-grid-card-inset));');
        expect(styles).toContain(
            'padding-bottom: calc(var(--od-dock-bottom) + var(--od-dock-height) + var(--od-grid-edge) - var(--od-grid-card-inset));'
        );
        expect(styles).toMatch(/\.od-topbar\s*\{[^}]*border-bottom:\s*1px solid var\(--od-card-line\);/);
    });

    test('uses one compact pill dock without prompt suggestions', () => {
        const styles = buildDesktopStyles();

        expect(immersiveDesktopSource).not.toContain('SUGGESTION_KEYS');
        expect(immersiveDesktopSource).not.toContain('data-suggests');
        expect(immersiveDesktopSource).not.toContain('data-suggest=');
        expect(styles).not.toContain('.od-suggests');
        expect(styles).not.toContain('.od-sug');
        expect(styles).toMatch(/\.od-dock\s*\{[^}]*border-radius:\s*999px;/);
        expect(styles).toMatch(/\.od-icon-btn\s*\{[^}]*border-radius:\s*50%;/);
    });

    test('opens a main-interface-style application menu above the launcher button', () => {
        const styles = buildDesktopStyles();

        expect(immersiveDesktopSource).toMatch(
            /<div class="od-dock">[\s\S]*<div class="od-applist"[^>]*data-applist[^>]*><\/div>[\s\S]*data-apps-btn/
        );
        expect(immersiveDesktopSource).toContain('<rect x="3" y="3" width="7" height="7" rx="3.5"/>');
        expect(immersiveDesktopSource).toContain('`./applications/${app.bundleName}/icon.svg`');
        expect(immersiveDesktopSource).toContain("'./applications/default_icon.png'");
        expect(styles).toMatch(/\.od-applist\s*\{[^}]*bottom:\s*calc\(100% \+ 8px\);[^}]*width:\s*220px;/);
        expect(styles).toMatch(/\.od-applist-item\s*\{[^}]*flex-direction:\s*row;/);
    });

    test('matches the main application menu scrollbar in light and dark themes', () => {
        const styles = buildDesktopStyles();

        expect(styles).toMatch(/\.od-applist::-webkit-scrollbar\s*\{[^}]*width:\s*4px;/);
        expect(styles).toMatch(/\.od-applist::-webkit-scrollbar-track\s*\{[^}]*background:\s*transparent;/);
        expect(styles).toMatch(
            /immersive-desktop\.theme-dark \.od-applist::-webkit-scrollbar-thumb\s*\{[^}]*rgba\(255, 255, 255, 0\.18\)/
        );
        expect(styles).toMatch(
            /immersive-desktop\.theme-dark \.od-applist::-webkit-scrollbar-thumb:hover\s*\{[^}]*rgba\(255, 255, 255, 0\.28\)/
        );
    });

    test('only plays card entrance animations for the first card load, not a theme redraw', () => {
        const applyThemeSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private applyTheme(): void'),
            immersiveDesktopSource.indexOf('private getTheme():')
        );
        const loadCardsSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private async loadCards(): Promise<void>'),
            immersiveDesktopSource.indexOf('private normalizeCard(')
        );
        const renderCardsSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private renderCards('),
            immersiveDesktopSource.indexOf('private updateEmptyState(): void')
        );

        expect(applyThemeSource).toContain('this.renderCards(false);');
        expect(loadCardsSource).toContain('this.renderCards(true);');
        expect(renderCardsSource).toContain('private renderCards(enter = false): void');
        expect(renderCardsSource).toContain('this.createCardElement(card, enter)');
    });

    test('card stacking is restored after drag and resize snapping', () => {
        expect(immersiveDesktopSource).toContain('this.restoreCardStacking(element);');
        expect(immersiveDesktopSource).toContain("element.style.removeProperty('z-index');");
    });
    test('card links use the browser readiness-aware URL entry point', () => {
        expect(immersiveDesktopSource).toContain('browser?.openUrl?.(url);');
    });
    test('mounts and sizes card containers before loading iframe content', () => {
        const renderCardsSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private renderCards('),
            immersiveDesktopSource.indexOf('private updateEmptyState(): void')
        );
        const createCardSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private createCardElement('),
            immersiveDesktopSource.indexOf('private renderCardErrorBadge(')
        );
        const updateCardSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private updateSingleCard('),
            immersiveDesktopSource.indexOf('private beginCardRefresh(')
        );

        expect(renderCardsSource).toMatch(
            /stage\.appendChild\(element\);[\s\S]*this\.positionCardElement\(element, card\);[\s\S]*this\.renderCardContent\(element, card\);/
        );
        expect(createCardSource).not.toContain('this.renderCardContent(element, card);');
        expect(updateCardSource).toMatch(
            /existing\.replaceWith\(next\);[\s\S]*this\.positionCardElement\(next, card\);[\s\S]*this\.renderCardContent\(next, card\);/
        );
    });
    test('hides unconfigured cards without hiding configured cards awaiting generation', () => {
        expect(hasCardContent({ prompt: '', html: '' })).toBe(false);
        expect(hasCardContent({ prompt: '   ', html: '' })).toBe(false);
        expect(hasCardContent({ prompt: '天气', html: '' })).toBe(true);
        expect(hasCardContent({ prompt: '', html: '<div>已有内容</div>' })).toBe(true);
    });
    test('injects base style and link interceptor after <head> when present', () => {
        const html = '<!doctype html><html><head><title>x</title></head><body><p>hi</p></body></html>';
        const result = composeCardSrcDoc(html, 'light');
        expect(result).toContain('<head><style>');
        expect(result).toContain('html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;}');
        expect(result).toContain('color-scheme:light;');
        expect(result).toContain('od-open-link');
        // 原有内容保持完整
        expect(result).toContain('<title>x</title>');
    });

    test('pins generated card CSS to the current desktop theme instead of the operating system theme', () => {
        const html = '<html><head><style>:root{color-scheme:light dark}</style></head><body>card</body></html>';
        const result = composeCardSrcDoc(html, 'dark');
        expect(result).toContain("document.documentElement.dataset.theme='dark'");
    });

    test('falls back to <html> injection when head is missing', () => {
        const html = '<html><body><p>x</p></body></html>';
        const result = composeCardSrcDoc(html, 'dark');
        expect(result.startsWith('<html>')).toBe(true);
        expect(result).toContain('color-scheme:dark;');
        expect(result).toContain('od-open-link');
    });

    test('prepends injection for bare fragments', () => {
        const result = composeCardSrcDoc('<div>card</div>', 'light');
        expect(result.startsWith('<style>')).toBe(true);
        expect(result.endsWith('<div>card</div>')).toBe(true);
        expect(result).toContain('color-scheme:light;');
    });

    test('link interceptor captures clicks in capture phase and forwards to parent', () => {
        const result = composeCardSrcDoc('<a href="https://a.com">x</a>', 'light');
        expect(result).toContain("addEventListener('click'");
        expect(result).toContain(',true);');
        expect(result).toContain('e.preventDefault()');
        expect(result).toContain('parent.postMessage');
    });

    test('reflows generated content after its first stable frame', () => {
        const result = composeCardSrcDoc('<div id="chart"></div>', 'light');
        expect(result).toContain("addEventListener('load'");
        expect(result).toContain(
            "requestAnimationFrame(function(){requestAnimationFrame(function(){window.dispatchEvent(new Event('resize'));});});"
        );
    });

    test('capsule reveal relies on whole-card hover and the zone tracker is fully removed', () => {
        const result = composeCardSrcDoc('<div>card</div>', 'light');
        // 改为悬停卡片任意位置显示后，顶部 1/4 分区上报机制整体移除
        expect(result).not.toContain('od-card-pointer');
        expect(result).not.toContain('odHoverZone');
        expect(immersiveDesktopSource).not.toContain('od-card-pointer');
        expect(immersiveDesktopSource).not.toContain('od-hover-reset');
        expect(immersiveDesktopSource).not.toContain('syncCardHoverZone');
        const endInteractionSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private endDesktopInteraction(): void'),
            immersiveDesktopSource.indexOf('private startCardDrag(')
        );
        expect(endInteractionSource).not.toContain('od-hover-top');
        expect(endInteractionSource).toContain("this.classList.remove('od-interacting')");
    });

    test('injects a context menu interceptor that forwards right clicks to the desktop', () => {
        const result = composeCardSrcDoc('<div>card</div>', 'light');
        // 卡片内容铺满 iframe，右键事件不会落到父层：必须拦截默认菜单并回传卡片内坐标
        expect(result).toContain("addEventListener('contextmenu'");
        expect(result).toContain('e.preventDefault()');
        expect(result).toContain('od-card-contextmenu');
    });

    test('card drag follows the pointer absolutely so the card snaps back after window excursions', () => {
        const stateSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf("type: 'card-drag',"),
            immersiveDesktopSource.indexOf('private handleCardDragMove(')
        );
        // 按下时记录抓取偏移：指针相对卡片左缘的位置
        expect(stateSource).toContain('grabOffsetX: event.clientX - startRect.left');
        expect(stateSource).toContain('grabOffsetY: event.clientY - startRect.top');
        const moveSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private handleCardDragMove('),
            immersiveDesktopSource.indexOf('private finishCardDrag(')
        );
        // 目标位置 = 指针当前位置 + 抓取偏移（绝对跟随）：移出窗口丢失的事件不再累积
        // 位移差，指针回到窗口时卡片立即吸附回指针，而不是带着偏移平行漂移
        expect(moveSource).toContain('event.clientX - state.grabOffsetX - state.currentRect.left');
        expect(moveSource).toContain('event.clientY - state.grabOffsetY - state.currentRect.top');
        expect(moveSource).not.toContain('state.lastClientX');
    });

    test('card context menu opens from anywhere via iframe right-click forwarding', () => {
        expect(immersiveDesktopSource).toContain("data.type === 'od-card-contextmenu'");
        expect(immersiveDesktopSource).toContain('this.showCardContextMenuFromFrame(event.source, data.x, data.y)');
        const forwardSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private showCardContextMenuFromFrame('),
            immersiveDesktopSource.indexOf('private async openLinkInBrowser(')
        );
        expect(forwardSource).toContain("element.querySelector('iframe')?.contentWindow === source");
        // iframe 视口坐标需换算为桌面客户区坐标（考虑可能的缩放）
        expect(forwardSource).toContain('rect.left + x * scaleX');
        expect(forwardSource).toContain('rect.top + y * scaleY');
    });

    test('card drag and resize capture the pointer to survive window-boundary excursions', () => {
        // 移出窗口期间 pointermove 会丢失，回窗产生巨大增量导致卡片跳变：
        // 按下时对卡片元素 setPointerCapture，移出窗口也能连续收到坐标
        const dragSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private startCardDrag('),
            immersiveDesktopSource.indexOf('private handleCardDragMove(')
        );
        expect(dragSource).toContain('this.captureCardPointer(element, event);');
        const resizeSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private startCardResize('),
            immersiveDesktopSource.indexOf('private handleCardResizeMove(')
        );
        expect(resizeSource).toContain('this.captureCardPointer(element, event);');
        expect(immersiveDesktopSource).toContain('element?.setPointerCapture(event.pointerId);');
        // pointercancel 与 pointerup 共用收尾，系统打断不会让拖动状态卡死
        expect(immersiveDesktopSource).toContain(
            "window.addEventListener('pointercancel', this.onGlobalPointerCancel);"
        );
        expect(immersiveDesktopSource).toContain('private finishPointerInteraction');
    });

    test('card editor modal reuses the shared top-banner modal system (modal.html spec)', () => {
        // 复用 confirmModal 的顶部色带体系：MODAL_CSS + 深浅色检测 + SVG 关闭图标
        expect(confirmModalSource).toContain('export const CLOSE_SVG');
        expect(immersiveDesktopSource).toContain("from '../confirmModal.js'");
        expect(immersiveDesktopSource).toContain('<style>${MODAL_CSS}');
        expect(immersiveDesktopSource).toContain('od-confirm-modal-overlay');
        expect(immersiveDesktopSource).toContain('od-confirm-modal-banner info');
        expect(immersiveDesktopSource).toContain('od-confirm-modal-footer');
        // 左上角为语义色实心容器内的 SVG 图标（替代旧蓝点），标题"卡片设置"用齿轮
        expect(immersiveDesktopSource).toContain("renderIcon('fa-gear')");
        expect(immersiveDesktopSource).not.toContain('<span class="dot"></span>');
    });

    test('card editor modal never dismisses on overlay click to protect form input', () => {
        const editorSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private showCardEditor('),
            immersiveDesktopSource.indexOf('private closeCardEditor():')
        );
        // 旧实现在遮罩上单击即 closeCardEditor，正在填写的表单会丢失
        expect(editorSource).not.toContain("overlay?.addEventListener('click'");
        expect(editorSource).not.toContain('event.target === overlay');
        // 关闭只能通过色带关闭按钮 / 取消按钮 / Escape
        expect(editorSource).toContain('data-card-editor-close');
        expect(editorSource).toContain('data-card-editor-cancel');
    });

    test('card editor footer switches save vs save-and-generate by trimmed prompt diff', () => {
        const editorSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private showCardEditor('),
            immersiveDesktopSource.indexOf('private closeCardEditor():')
        );
        // 两个保存动作：未变化只显示"保存"，变化后追加"保存并立即生成"（初始隐藏）
        expect(editorSource).toContain('data-card-editor-save');
        expect(editorSource).toMatch(/data-card-editor-save-generate[^>]*hidden/);
        // 关注内容按首尾空格裁剪后对比，输入时动态切换按钮显隐
        expect(editorSource).toContain('generateBtn.hidden = textarea.value.trim() === originalPrompt.trim()');
        expect(editorSource).toContain('syncEditorActions');
        // 仅"保存并立即生成"触发刷新；"保存"只保存，不做无变化重建
        expect(editorSource).toContain('applyEditor(false)');
        expect(editorSource).toContain('applyEditor(true)');
        expect(editorSource).toContain('if (generate && latest.prompt)');
        // 两个按钮恒为红色主样式，切换只控制显隐——避免"保存"按钮背景闪变
        expect(editorSource).toContain('class="od-confirm-btn od-confirm-btn-primary" data-card-editor-save');
        expect(editorSource).not.toContain("saveBtn.classList.toggle('od-confirm-btn-primary'");
        expect(editorSource).not.toContain("saveBtn.classList.toggle('od-confirm-btn-cancel'");
    });

    test('card editor save labels are localized in zh-cn and en-us', () => {
        expect(zhLocaleSource).toContain("'renderer.desktop.card.save': '保存'");
        expect(zhLocaleSource).toContain("'renderer.desktop.card.saveAndGenerate': '保存并立即生成'");
        expect(enLocaleSource).toContain("'renderer.desktop.card.save': 'Save'");
        expect(enLocaleSource).toContain("'renderer.desktop.card.saveAndGenerate': 'Save & Generate Now'");
    });

    test('card context menu hosts an interval submenu with the current interval checked', () => {
        const menuSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private showCardContextMenu('),
            immersiveDesktopSource.indexOf('private showBlankContextMenu(')
        );
        // "刷新时间"项悬停展开二级菜单，三个间隔选项，当前项打勾
        expect(menuSource).toContain("this.t('renderer.desktop.menu.interval')");
        expect(menuSource).toMatch(/od-context-sub-trigger/);
        expect(menuSource).toContain('od-context-submenu');
        expect(menuSource).toContain('data-menu="interval"');
        expect(menuSource).toContain('option.value === card?.interval');
        // 文案中英双语
        expect(zhLocaleSource).toContain("'renderer.desktop.menu.interval': '刷新时间'");
        expect(enLocaleSource).toContain("'renderer.desktop.menu.interval': 'Refresh interval'");
        // 悬停展开；贴右侧屏幕时翻转到左侧展开
        const styles = buildDesktopStyles();
        expect(styles).toMatch(/\.od-context-sub-trigger:hover \.od-context-submenu/);
        expect(styles).toContain('.od-context-menu.od-sub-opens-left .od-context-submenu');
        expect(immersiveDesktopSource).toContain("menu.classList.toggle('od-sub-opens-left'");
    });

    test('context menu interval click saves the new interval and updates the pill badge in place', () => {
        const clickSource = immersiveDesktopSource.slice(
            immersiveDesktopSource.indexOf('private handleContextMenuClick'),
            immersiveDesktopSource.indexOf('/**\n     * 卡片内链接点击')
        );
        expect(clickSource).toContain("case 'interval'");
        expect(clickSource).toContain('normalizeInterval(item.dataset.value)');
        // 只改间隔不重建卡片：就地更新胶囊上的间隔徽标，避免 iframe 重载闪烁
        expect(clickSource).toContain('.od-card[data-card-id="${CSS.escape(card.id)}"] .od-card-live');
    });
});
