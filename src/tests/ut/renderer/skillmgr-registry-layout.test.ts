import fs from 'fs';
import { describe, expect, test } from '@jest/globals';
import { zhCn } from '../../../main/applications/skillmgr/locale/zh-cn.js';
import { enUs } from '../../../main/applications/skillmgr/locale/en-us.js';

// 源码为 CRLF：统一成 LF，下面的函数体切片才能用 '\n    }\n' 定位边界
const source = fs
    .readFileSync(new URL('../../../main/applications/skillmgr/renderer/entry.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n');

/* 技能中心 registry（ClawHub / SkillHub 等外部注册源）面板的结果计数与标题间距回归 */
describe('skill center registry panel layout', () => {
    const panelStart = source.indexOf('_renderRegistryPanel(tabId) {');
    const panelBody = source.slice(panelStart, source.indexOf('\n    }\n', panelStart));

    test('the result count reported by a registry sits inside the search input', () => {
        expect(panelStart).toBeGreaterThan(-1);
        // 注册源用非错误 message 回传「显示 x / y 个结果」，此前单独占一行、与输入框之间留下大块空白
        expect(panelBody).toContain("${countHtml ? 'has-count' : ''}");
        expect(panelBody).toContain('class="search-count');
        expect(panelBody).toContain('_registryCountHtml(state)');
        // 计数不得再进 info bar
        expect(panelBody).not.toContain('registry-info-bar');
        expect(panelBody).not.toContain('${msgHtml}');
    });

    test('registry errors keep a dedicated row instead of being clipped inside the input', () => {
        const bodyStart = source.indexOf('_renderRegistryBody(tabId) {');
        expect(bodyStart).toBeGreaterThan(-1);
        const body = source.slice(bodyStart, source.indexOf('\n    }\n', bodyStart));
        expect(body).toContain('state.message?.isError');
        expect(body).toContain('class="registry-msg error"');
        expect(body).toContain('${errHtml}${filterHtml}');
    });

    test('the inline count reserves input space and ellipsizes instead of covering the query', () => {
        expect(source).toContain('.search-input-wrap.has-count .search-input { padding-right: 196px; }');
        expect(source).toContain('.search-count {');
        expect(source).toContain('text-overflow: ellipsis');
        expect(source).toContain('pointer-events: none');
        // 深色主题下沿用弱化文字色
        expect(source).toContain(':host([data-theme="dark"]) .search-count');
    });

    test('the registry hero title no longer carries the oversized top gap', () => {
        const heroStart = source.indexOf('\n.hero-title {');
        expect(heroStart).toBeGreaterThan(-1);
        const heroRule = source.slice(heroStart, source.indexOf('}', heroStart));
        expect(heroRule).not.toContain('28px');
        expect(heroRule).toContain('padding: 6px 20px 20px');
    });

    test('an empty search box hides its clear button and clear-and-reload becomes a no-op', () => {
        // 空搜索框点清除只会无谓地重新拉取列表，并让结果区闪一下
        expect(source).toContain('.search-input:placeholder-shown ~ .search-clear { display: none; }');
        const fnStart = source.indexOf('clearAndReload(tabId) {');
        expect(fnStart).toBeGreaterThan(-1);
        const fnBody = source.slice(fnStart, source.indexOf('\n    }', fnStart));
        expect(fnBody).toContain('if (!state.query.trim()) return;');
        expect(fnBody).not.toContain('state.results = []');
    });

    test('searching keeps the previous results and only animates the count area', () => {
        const fnStart = source.indexOf('async _doSearch(tabId, query, page) {');
        expect(fnStart).toBeGreaterThan(-1);
        const fnBody = source.slice(fnStart, source.indexOf('\n    }\n', fnStart));
        const head = fnBody.slice(fnBody.indexOf('state.searching = true;'), fnBody.indexOf('try {'));
        // 搜索开始不整页重渲染、不清空结果，只在计数处显示刷新态
        expect(head).toContain('this._syncRegistrySearchState(tabId)');
        expect(head).not.toContain('this.render()');
        expect(head).not.toContain('state.results = []');
        const finallyBody = fnBody.slice(fnBody.indexOf('finally {'));
        // 完成后局部替换结果区并淡入，而不是重新渲染整个面板
        expect(finallyBody).toContain('this._syncRegistryBody(tabId, { fade: true, resetScroll: true })');
        expect(finallyBody).not.toContain('this.render()');
    });

    test('the count slot carries the refreshing spinner while a search is in flight', () => {
        const fnStart = source.indexOf('_registryCountHtml(state) {');
        expect(fnStart).toBeGreaterThan(-1);
        const fnBody = source.slice(fnStart, source.indexOf('\n    }', fnStart));
        expect(fnBody).toContain('state.searching');
        expect(fnBody).toContain('mini-spinner');
        expect(fnBody).toContain('renderer.skill.search.refreshing');
        expect(zhCn['renderer.skill.search.refreshing']).toBe('刷新中…');
        expect(enUs['renderer.skill.search.refreshing']).toBe('Refreshing...');
    });

    test('the result area is swapped in place with a fade transition', () => {
        expect(source).toContain('.registry-body { transition: opacity 0.18s ease; }');
        const fnStart = source.indexOf('_syncRegistryBody(tabId, { fade = false, resetScroll = false } = {}) {');
        expect(fnStart).toBeGreaterThan(-1);
        const fnBody = source.slice(fnStart, source.indexOf('\n    }\n', fnStart));
        expect(fnBody).toContain('_swapResultArea(body,');
        expect(fnBody).toContain('renderHtml: () => this._renderRegistryBody(tabId)');
        // 局部替换后卡片与筛选器事件必须重新绑定
        expect(fnBody).toContain('this._bindCardEvents(el)');
        expect(fnBody).toContain('this._bindRegistryFilterEvents(el)');
    });

    test('both result areas share one fade helper that cancels in-flight swaps', () => {
        const helperStart = source.indexOf('_swapResultArea(container, {');
        expect(helperStart).toBeGreaterThan(-1);
        const helperBody = source.slice(helperStart, source.indexOf('\n    }\n', helperStart));
        expect(helperBody).toContain('clearTimeout(pending)');
        expect(helperBody).toContain('_pendingSwaps.set(container, timer)');
        expect(helperBody).toContain("container.style.opacity = '0'");
        // 内容在定时器触发时才生成，淡出窗口内的旧快照不会回写
        expect(helperBody).toContain('const html = renderHtml();');
        // 卸载时必须丢掉在途定时器（否则会继续操作已脱离文档的节点）
        const cancelStart = source.indexOf('_cancelPendingSwaps() {');
        expect(cancelStart).toBeGreaterThan(-1);
        const cancelBody = source.slice(cancelStart, source.indexOf('\n    }\n', cancelStart));
        expect(cancelBody).toContain('clearTimeout(timer)');
        const disconnectStart = source.indexOf('disconnectedCallback() {');
        const disconnectBody = source.slice(disconnectStart, source.indexOf('\n    }\n', disconnectStart));
        expect(disconnectBody).toContain('this._cancelPendingSwaps()');
    });

    test('installed / external / builtin searches only swap the result area', () => {
        // 结果区独立成 .panel-body：搜索框与已选托盘留在外面，重建不会重播托盘入场动画
        expect(source).toContain('<div class="panel-body">${contentHtml}</div>');
        expect(source).toContain('.panel-body { transition: opacity 0.18s ease; }');
        for (const fn of ['_searchInstalled()', '_searchBuiltin()', '_searchExternal()']) {
            const start = source.indexOf(fn + ' {');
            expect(start).toBeGreaterThan(-1);
            const body = source.slice(start, source.indexOf('\n    }\n', start));
            expect(body).toContain('_syncPanelBody(');
            expect(body).not.toContain('this.render()');
        }
        for (const fn of ['_clearInstalledSearch()', '_clearBuiltinSearch()', '_clearExternalSearch()']) {
            const start = source.indexOf(fn + ' {');
            expect(start).toBeGreaterThan(-1);
            const body = source.slice(start, source.indexOf('\n    }\n', start));
            // 空搜索框点清除不再触发重新渲染
            expect(body).toContain('if (!this.');
            expect(body).not.toContain('this.render()');
            expect(body).toContain('_syncPanelBody(');
        }
        const syncStart = source.indexOf('_syncPanelBody(scope, { fade = true, resetScroll = false } = {}) {');
        expect(syncStart).toBeGreaterThan(-1);
        const syncBody = source.slice(syncStart, source.indexOf('\n    }\n', syncStart));
        expect(syncBody).toContain("querySelector('.panel-body')");
        expect(syncBody).toContain('this._bindSkillCardEvents(el)');
        expect(syncBody).toContain('_swapResultArea(body,');
        // 当前面板没有结果区节点（空态 / loading / 错误）时退回整页重建
        expect(syncBody).toContain('if (!body) {');
        expect(syncBody.split('this.render()').length - 1).toBe(1);
        // 新内容本身没有结果区（如技能被清空）同样交给整页重建
        expect(syncBody).toContain('return nextBody ? nextBody.innerHTML : null;');
    });

    test('top refresh keeps the page in place instead of re-rendering everything', () => {
        const fnStart = source.indexOf('async refresh() {');
        expect(fnStart).toBeGreaterThan(-1);
        const fnBody = source.slice(fnStart, source.indexOf('\n    }\n', fnStart));
        expect(fnBody).toContain('this._setRefreshBusy(true)');
        expect(fnBody).toContain('this.loadSkills({ silent: true })');
        expect(fnBody).toContain('this._syncPanelBody(');
        // 正常路径不整页重渲染：只有结构变化 / 错误 / 分析面板才回退
        expect(fnBody.split('this.render()').length - 1).toBe(1);
        expect(fnBody).toContain('hadExternalTab');
        // 静默加载不触发 render
        const loadStart = source.indexOf('async loadSkills({ silent = false } = {}) {');
        expect(loadStart).toBeGreaterThan(-1);
        const loadBody = source.slice(loadStart, source.indexOf('\n    }\n', loadStart));
        expect(loadBody).toContain('if (!silent) this.render();');
        // 忙碌态只切按钮内容
        const busyStart = source.indexOf('_setRefreshBusy(busy) {');
        expect(busyStart).toBeGreaterThan(-1);
        const busyBody = source.slice(busyStart, source.indexOf('\n    }\n', busyStart));
        expect(busyBody).toContain("querySelector('#refresh-btn')");
        expect(busyBody).toContain('mini-spinner');
        expect(busyBody).not.toContain('this.render()');
    });

    test('card interactions are rebound from one place after a local swap', () => {
        const bindStart = source.indexOf('_bindSkillCardEvents(root = this.shadowRoot) {');
        expect(bindStart).toBeGreaterThan(-1);
        const bindBody = source.slice(bindStart, source.indexOf('\n    }\n', bindStart));
        for (const sel of [
            '[data-batch-check]',
            '[data-view-skill]',
            '[data-builtin-skill]',
            '[data-toggle-id]',
            '[data-delete]'
        ]) {
            expect(bindBody).toContain(sel);
        }
        // 勾选圈不得再在 _bindEvents 里单独绑定（否则局部替换后的新卡片失去响应）
        const bindEventsStart = source.indexOf('_bindEvents() {');
        const bindEventsBody = source.slice(bindEventsStart, source.indexOf('\n    }\n', bindEventsStart));
        expect(bindEventsBody).toContain('this._bindSkillCardEvents();');
        expect(bindEventsBody).not.toContain("$$('[data-batch-check]')");
    });
});
