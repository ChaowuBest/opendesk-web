/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * 录制控制页面
 * 负责：启动/停止录制、窗口选择、实时预览、历史活动展示
 */
class RecordingPage extends HTMLElement {
    constructor() {
        super();

        /** @type {'idle' | 'recording'} */
        this.currentStatus = 'idle';
        /** @type {RecallActivity | null} */
        this.currentActivity = null;
        /** @type {NodeJS.Timeout | null} */
        this.reloadThumbnailInterval = null;
        /** @type {number} */
        this.reloadThumbnailIntervalMs = 2000;

        /** @type {Object[]} 预录制窗口配置 */
        this.preRecordingWindowConfigs = [];
        /** @type {Object[]} 缓存的窗口列表 */
        this.cachedWindowList = [];
    }

    connectedCallback() {
        this.render();
        this.reloadPreviewArea();
        window.applicationAPI.call('getWindowList');
    }

    disconnectedCallback() {
        // 清理定时器
        if (this.reloadThumbnailInterval) {
            clearInterval(this.reloadThumbnailInterval);
        }
    }

    // ------ 窗口相关api ------
    async updateWindowSelect() {
        const windows = await window.applicationAPI.call('getWindowList');
        const displayCount = (await window.applicationAPI.call('getDisplayCount')) || 1;
        const displayConfigsResult = await window.applicationAPI.call('getDisplayConfigs');

        // 如果API调用失败（例如未开始录制），使用默认配置
        let displayConfigs = [];
        if (displayConfigsResult?.success && displayConfigsResult.displayConfigs) {
            displayConfigs = displayConfigsResult.displayConfigs;
        } else {
            // 默认配置：每个显示器捕获自身
            displayConfigs = Array.from({ length: displayCount }, (_, i) => ({
                displayIndex: i,
                captureMode: 'monitor',
                targetId: null
            }));
        }

        const windowSelectContainer = this.querySelector('#window-select-container');
        if (!windowSelectContainer) {
            console.warn('[RecordingPage] window-select-container not found');
            return;
        }

        // 为每个显示器创建选择器
        let selectorsHtml = '';

        for (let i = 0; i < displayCount; i++) {
            const config = displayConfigs[i] || {
                displayIndex: i,
                captureMode: 'monitor',
                targetId: null
            };

            // 过滤出该显示器上的窗口
            const windowsOnDisplay = windows.filter((w) => w.displayIndex === i);

            // 确定当前选择的文本
            let selectedText = `显示器 ${i + 1}`;
            if (config.captureMode === 'window' && config.targetId) {
                const window = windows.find((w) => w.windowId.toString() === config.targetId);
                if (window) {
                    const title =
                        window.windowTitle.length > 20
                            ? window.windowTitle.substring(0, 20) + '...'
                            : window.windowTitle;
                    selectedText = `${window.windowId} - ${title}`;
                }
            }

            selectorsHtml += `
                <div class="display-selector mb-2">
                    <label class="block text-xs text-gray-600 mb-1 font-medium">
                        <i class="fa-solid fa-display text-blue-500"></i> 显示器 ${i + 1}
                    </label>
                    <div class="relative">
                        <button class="window-select-btn w-full text-xs px-2 py-1.5 rounded-lg border border-gray-300 hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white text-left truncate flex items-center justify-between transition-colors" data-display="${i}">
                            <span class="truncate">${selectedText}</span>
                            <i class="fa-solid fa-chevron-down text-[10px] text-gray-400 ml-1"></i>
                        </button>
                        <div class="window-dropdown hidden absolute top-full left-0 mt-1 w-full min-w-[240px] max-w-[320px] max-h-64 overflow-y-auto bg-white border border-gray-300 rounded-lg shadow-xl z-50 py-1" data-display="${i}">
                            <!-- 显示器选项 -->
                            <div class="window-option px-3 py-2.5 hover:bg-blue-50 cursor-pointer text-xs flex items-center gap-2 transition-colors ${config.captureMode === 'monitor' ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-700'}" data-value="monitor" data-display="${i}">
                                <i class="fa-solid fa-display text-xs ${config.captureMode === 'monitor' ? 'text-blue-600' : 'text-gray-400'}"></i>
                                <span>捕获显示器 ${i + 1}</span>
                                ${config.captureMode === 'monitor' ? '<i class="fa-solid fa-check ml-auto text-blue-600"></i>' : ''}
                            </div>
                            <div class="border-t border-gray-200 my-1"></div>
                            ${
                                windowsOnDisplay.length > 0
                                    ? windowsOnDisplay
                                          .map((window) => {
                                              const selected =
                                                  config.captureMode === 'window' &&
                                                  config.targetId === window.windowId.toString();
                                              const title =
                                                  window.windowTitle.length > 30
                                                      ? window.windowTitle.substring(0, 30) + '...'
                                                      : window.windowTitle;
                                              const displayText = `${window.windowId} - ${title}`;

                                              return `
                                    <div class="window-option px-3 py-2.5 hover:bg-blue-50 cursor-pointer text-xs flex items-center gap-2 transition-colors ${selected ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-700'}" data-value="${window.windowId}" data-display="${i}" title="${window.windowTitle}">
                                        <i class="fa-solid fa-window-maximize text-xs ${selected ? 'text-blue-600' : 'text-gray-400'}"></i>
                                        <span class="truncate flex-1">${displayText}</span>
                                        ${selected ? '<i class="fa-solid fa-check ml-auto text-blue-600"></i>' : ''}
                                    </div>
                                `;
                                          })
                                          .join('')
                                    : '<div class="px-3 py-2 text-xs text-gray-400 text-center">该显示器上没有窗口</div>'
                            }
                        </div>
                    </div>
                </div>
            `;
        }

        windowSelectContainer.innerHTML = selectorsHtml;

        // 设置所有选择器的事件监听
        windowSelectContainer.querySelectorAll('.window-select-btn').forEach((btn) => {
            btn.onclick = async (e) => {
                e.stopPropagation();
                const displayIndex = parseInt(btn.dataset.display);
                const dropdown = windowSelectContainer.querySelector(
                    `.window-dropdown[data-display="${displayIndex}"]`
                );

                // 关闭其他下拉框
                windowSelectContainer.querySelectorAll('.window-dropdown').forEach((d) => {
                    if (d !== dropdown) d.classList.add('hidden');
                });

                // 如果要打开下拉框，先刷新窗口列表
                if (dropdown.classList.contains('hidden')) {
                    await this.refreshRecordingDropdown(displayIndex);
                }

                dropdown.classList.toggle('hidden');
            };
        });

        // 设置所有选项的点击事件
        windowSelectContainer.querySelectorAll('.window-option').forEach((option) => {
            option.onclick = async (e) => {
                e.stopPropagation();
                const displayIndex = parseInt(option.dataset.display);
                const value = option.dataset.value;

                // 更新按钮文本
                const btn = windowSelectContainer.querySelector(`.window-select-btn[data-display="${displayIndex}"]`);
                btn.querySelector('span').textContent = option.querySelector('span').textContent;

                // 关闭下拉框
                const dropdown = windowSelectContainer.querySelector(
                    `.window-dropdown[data-display="${displayIndex}"]`
                );
                dropdown.classList.add('hidden');

                // 调用新的API更新配置
                if (value === 'monitor') {
                    await window.applicationAPI.call('changeDisplayConfig', displayIndex, {
                        captureMode: 'monitor',
                        targetId: null
                    });
                } else {
                    await window.applicationAPI.call('changeDisplayConfig', displayIndex, {
                        captureMode: 'window',
                        targetId: value
                    });
                }

                // 重新加载选择器以更新UI
                this.updateWindowSelect();
            };
        });

        // 点击外部关闭所有下拉框
        document.addEventListener('click', () => {
            windowSelectContainer.querySelectorAll('.window-dropdown').forEach((d) => d.classList.add('hidden'));
        });
    }

    /**
     * 刷新录制中的下拉框（下拉时动态更新窗口列表）
     */
    async refreshRecordingDropdown(displayIndex) {
        // 获取最新窗口列表
        const windows = await window.applicationAPI.call('getWindowList');
        const displayConfigsResult = await window.applicationAPI.call('getDisplayConfigs');

        if (!displayConfigsResult?.success) return;

        const config = displayConfigsResult.displayConfigs[displayIndex];
        const windowsOnDisplay = windows.filter((w) => w.displayIndex === displayIndex);

        // 找到下拉框容器
        const dropdown = this.querySelector(`.window-dropdown[data-display="${displayIndex}"]`);
        if (!dropdown) return;

        // 重新生成选项HTML
        let optionsHtml = `
            <div class="window-option px-3 py-2.5 hover:bg-blue-50 cursor-pointer text-xs flex items-center gap-2 transition-colors ${config.captureMode === 'monitor' ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-700'}" data-value="monitor" data-display="${displayIndex}">
                <i class="fa-solid fa-display text-xs ${config.captureMode === 'monitor' ? 'text-blue-600' : 'text-gray-400'}"></i>
                <span>捕获显示器 ${displayIndex + 1}</span>
                ${config.captureMode === 'monitor' ? '<i class="fa-solid fa-check ml-auto text-blue-600"></i>' : ''}
            </div>
            <div class="border-t border-gray-200 my-1"></div>
        `;

        if (windowsOnDisplay.length > 0) {
            windowsOnDisplay.forEach((window) => {
                const selected = config.captureMode === 'window' && config.targetId === window.windowId.toString();
                const title =
                    window.windowTitle.length > 30 ? window.windowTitle.substring(0, 30) + '...' : window.windowTitle;
                const displayText = `${window.windowId} - ${title}`;

                optionsHtml += `
                    <div class="window-option px-3 py-2.5 hover:bg-blue-50 cursor-pointer text-xs flex items-center gap-2 transition-colors ${selected ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-700'}" data-value="${window.windowId}" data-display="${displayIndex}" title="${window.windowTitle}">
                        <i class="fa-solid fa-window-maximize text-xs ${selected ? 'text-blue-600' : 'text-gray-400'}"></i>
                        <span class="truncate flex-1">${displayText}</span>
                        ${selected ? '<i class="fa-solid fa-check ml-auto text-blue-600"></i>' : ''}
                    </div>
                `;
            });
        } else {
            optionsHtml += '<div class="px-3 py-2 text-xs text-gray-400 text-center">该显示器上没有窗口</div>';
        }

        dropdown.innerHTML = optionsHtml;

        // 重新绑定选项点击事件
        const windowSelectContainer = this.querySelector('#window-select-container');
        dropdown.querySelectorAll('.window-option').forEach((option) => {
            option.onclick = async (e) => {
                e.stopPropagation();
                const displayIdx = parseInt(option.dataset.display);
                const value = option.dataset.value;

                // 更新按钮文本
                const btn = windowSelectContainer.querySelector(`.window-select-btn[data-display="${displayIdx}"]`);
                btn.querySelector('span').textContent = option.querySelector('span').textContent;

                // 关闭下拉框
                dropdown.classList.add('hidden');

                // 调用API更新配置
                if (value === 'monitor') {
                    await window.applicationAPI.call('changeDisplayConfig', displayIdx, {
                        captureMode: 'monitor',
                        targetId: null
                    });
                } else {
                    await window.applicationAPI.call('changeDisplayConfig', displayIdx, {
                        captureMode: 'window',
                        targetId: value
                    });
                }

                // 重新加载选择器以更新UI
                this.updateWindowSelect();
            };
        });
    }

    // ------ 准备录制窗口选择 ------

    /**
     * 初始化准备录制界面的窗口选择器
     */
    async setupPreRecordingWindowSelectors() {
        const container = this.querySelector('#pre-recording-window-container');
        if (!container) return;

        // 获取显示器数量
        const displayCount = (await window.applicationAPI.call('getDisplayCount')) || 1;

        // 初始化配置数组（默认全部选择"捕获显示器"）
        this.preRecordingWindowConfigs = Array.from({ length: displayCount }, (_, i) => ({
            displayIndex: i,
            captureMode: 'monitor',
            targetId: null
        }));

        // 渲染选择器
        await this.renderPreRecordingWindowContainer(displayCount);

        // 绑定事件
        this.bindPreRecordingWindowEvents();

        // 初始加载窗口数量
        await this.updatePreRecordingWindowCounts();
    }

    /**
     * 渲染准备录制窗口选择器容器
     */
    async renderPreRecordingWindowContainer(displayCount) {
        const container = this.querySelector('#pre-recording-window-container');
        if (!container) return;

        // 决定网格列数：1-2个显示器用1列，3+用2列
        const gridClass = displayCount <= 2 ? 'grid-cols-1' : 'grid-cols-2';
        container.className = `grid gap-2 ${gridClass}`;

        // 生成HTML
        let html = '';
        for (let i = 0; i < displayCount; i++) {
            html += this.getDisplaySelectorHtml(i);
        }

        container.innerHTML = html;
    }

    /**
     * 生成单个显示器选择器HTML
     */
    getDisplaySelectorHtml(displayIndex) {
        return `
            <div class="display-selector">
                <div class="flex items-center gap-1.5 mb-1">
                    <i class="fa-solid fa-display text-[10px] text-purple-600"></i>
                    <span class="text-[10px] text-gray-600 font-medium">显示器 ${displayIndex + 1}</span>
                    <span class="text-[9px] text-gray-400 ml-auto" data-window-count="${displayIndex}">0个窗口</span>
                </div>

                <div class="relative z-10">
                    <button class="pre-window-select-btn w-full text-xs px-2.5 py-1.5 rounded-lg border border-gray-300 hover:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-500 bg-white text-left flex items-center justify-between transition-all"
                            data-display="${displayIndex}">
                        <span class="truncate text-gray-700">捕获显示器 ${displayIndex + 1}</span>
                        <i class="fa-solid fa-chevron-down text-[9px] text-gray-400 ml-1 transition-transform" data-chevron="${displayIndex}"></i>
                    </button>

                    <div class="pre-window-dropdown hidden fixed bg-white border-2 border-purple-200 rounded-lg shadow-2xl overflow-hidden"
                         data-display="${displayIndex}"
                         style="z-index: 9999; min-width: 280px; max-width: 360px;">

                        <div class="sticky top-0 bg-gradient-to-r from-purple-50 to-indigo-50 border-b-2 border-purple-100 p-2.5">
                            <div class="relative">
                                <input type="text"
                                       class="window-search-input w-full text-xs px-2.5 py-1.5 pl-8 rounded-lg border-2 border-purple-200 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-400 bg-white transition-all"
                                       placeholder="🔍 搜索窗口..."
                                       data-display="${displayIndex}">
                                <i class="fa-solid fa-search absolute left-2.5 top-1/2 -translate-y-1/2 text-[11px] text-purple-400"></i>
                            </div>
                        </div>

                        <div class="window-options-container max-h-72 overflow-y-auto py-1"
                             data-display="${displayIndex}"
                             style="scrollbar-width: thin; scrollbar-color: #c084fc #f3e8ff;">
                            <!-- 动态填充选项 -->
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * 刷新准备录制下拉框
     */
    async refreshPreRecordingDropdown(displayIndex) {
        // 1. 获取最新窗口列表
        this.cachedWindowList = await window.applicationAPI.call('getWindowList');

        // 2. 过滤该显示器的窗口
        const windowsOnDisplay = this.cachedWindowList.filter((w) => w.displayIndex === displayIndex);

        // 3. 更新窗口数量显示
        const countSpan = this.querySelector(`[data-window-count="${displayIndex}"]`);
        if (countSpan) {
            countSpan.textContent = `${windowsOnDisplay.length}个窗口`;
        }

        // 4. 获取当前配置
        const config = this.preRecordingWindowConfigs[displayIndex];

        // 5. 渲染选项HTML
        const optionsContainer = this.querySelector(`.window-options-container[data-display="${displayIndex}"]`);
        if (!optionsContainer) return;

        optionsContainer.innerHTML = this.getWindowOptionsHtml(displayIndex, windowsOnDisplay, config);

        // 6. 绑定选项点击事件
        this.bindOptionClickEvents(displayIndex);
    }

    /**
     * 生成窗口选项HTML
     */
    getWindowOptionsHtml(displayIndex, windows, config) {
        const monitorSelected = config.captureMode === 'monitor';

        let html = `
            <div class="window-option px-3 py-2.5 hover:bg-purple-50 cursor-pointer text-xs flex items-center gap-2 transition-colors ${monitorSelected ? 'bg-purple-100 text-purple-700 font-medium' : 'text-gray-700'}"
                 data-value="monitor"
                 data-display="${displayIndex}"
                 data-search-text="捕获显示器">
                <i class="fa-solid fa-display text-xs ${monitorSelected ? 'text-purple-600' : 'text-gray-400'}"></i>
                <span>捕获显示器 ${displayIndex + 1}</span>
                ${monitorSelected ? '<i class="fa-solid fa-check ml-auto text-purple-600"></i>' : ''}
            </div>
        `;

        if (windows.length > 0) {
            html += '<div class="border-t border-gray-200"></div>';

            windows.forEach((win) => {
                const selected = config.captureMode === 'window' && config.targetId === win.windowId.toString();
                const title = win.windowTitle || '未命名窗口';

                html += `
                    <div class="window-option px-3 py-2.5 hover:bg-purple-50 cursor-pointer text-xs flex items-center gap-2 transition-colors ${selected ? 'bg-purple-100 text-purple-700 font-medium' : 'text-gray-700'}"
                         data-value="${win.windowId}"
                         data-display="${displayIndex}"
                         data-title="${title}"
                         data-search-text="${win.windowId} ${title}">
                        <i class="fa-solid fa-window-maximize text-xs ${selected ? 'text-purple-600' : 'text-gray-400'}"></i>
                        <div class="flex-1 min-w-0">
                            <div class="truncate font-medium">${title.length > 30 ? title.substring(0, 30) + '...' : title}</div>
                            <div class="text-[10px] text-gray-400">ID: ${win.windowId}</div>
                        </div>
                        ${selected ? '<i class="fa-solid fa-check ml-auto text-purple-600"></i>' : ''}
                    </div>
                `;
            });
        }

        html += `
            <div class="no-results hidden px-3 py-4 text-xs text-gray-400 text-center">
                <i class="fa-solid fa-search mb-2 text-lg"></i>
                <div>未找到匹配的窗口</div>
            </div>
        `;

        return html;
    }

    /**
     * 处理窗口搜索
     */
    handlePreRecordingWindowSearch(displayIndex, searchText) {
        const container = this.querySelector(`.window-options-container[data-display="${displayIndex}"]`);
        if (!container) return;

        const options = container.querySelectorAll('.window-option');
        const noResults = container.querySelector('.no-results');

        let visibleCount = 0;
        const search = searchText.toLowerCase().trim();

        options.forEach((option) => {
            const searchableText = option.dataset.searchText?.toLowerCase() || '';
            const isMatch = !search || searchableText.includes(search);

            option.style.display = isMatch ? 'flex' : 'none';
            if (isMatch) visibleCount++;
        });

        // 显示/隐藏无结果提示
        if (noResults) {
            noResults.classList.toggle('hidden', visibleCount > 0);
        }
    }

    /**
     * 选择窗口
     */
    selectPreRecordingWindow(displayIndex, value, titleText) {
        // 1. 更新配置
        if (value === 'monitor') {
            this.preRecordingWindowConfigs[displayIndex] = {
                displayIndex,
                captureMode: 'monitor',
                targetId: null
            };
        } else {
            this.preRecordingWindowConfigs[displayIndex] = {
                displayIndex,
                captureMode: 'window',
                targetId: value
            };
        }

        // 2. 更新按钮文本
        const btn = this.querySelector(`.pre-window-select-btn[data-display="${displayIndex}"]`);
        if (btn) {
            const textSpan = btn.querySelector('span');
            textSpan.textContent = titleText;
        }

        // 3. 关闭下拉框
        this.closeAllPreRecordingDropdowns();

        // 4. 重置搜索
        const dropdown = this.querySelector(`.pre-window-dropdown[data-display="${displayIndex}"]`);
        if (dropdown) {
            const searchInput = dropdown.querySelector('.window-search-input');
            if (searchInput) {
                searchInput.value = '';
                this.handlePreRecordingWindowSearch(displayIndex, '');
            }
        }
    }

    /**
     * 绑定准备录制窗口选择事件
     */
    bindPreRecordingWindowEvents() {
        const container = this.querySelector('#pre-recording-window-container');
        if (!container) return;

        // 按钮点击事件
        container.querySelectorAll('.pre-window-select-btn').forEach((btn) => {
            btn.onclick = async (e) => {
                e.stopPropagation();
                const displayIndex = parseInt(btn.dataset.display);
                const dropdown = this.querySelector(`.pre-window-dropdown[data-display="${displayIndex}"]`);
                const chevron = btn.querySelector(`[data-chevron="${displayIndex}"]`);

                // 关闭其他下拉框
                this.closeAllPreRecordingDropdowns();

                // 刷新并打开
                if (dropdown && dropdown.classList.contains('hidden')) {
                    await this.refreshPreRecordingDropdown(displayIndex);

                    // 计算下拉框位置（fixed定位）
                    const rect = btn.getBoundingClientRect();
                    dropdown.style.top = `${rect.bottom + 4}px`;
                    dropdown.style.left = `${rect.left}px`;
                    dropdown.style.width = `${Math.max(rect.width, 280)}px`;

                    dropdown.classList.remove('hidden');
                    if (chevron) chevron.classList.add('rotate-180');
                } else if (dropdown) {
                    dropdown.classList.add('hidden');
                    if (chevron) chevron.classList.remove('rotate-180');
                }
            };
        });

        // 搜索输入事件
        container.querySelectorAll('.window-search-input').forEach((input) => {
            input.oninput = (e) => {
                const displayIndex = parseInt(input.dataset.display);
                this.handlePreRecordingWindowSearch(displayIndex, e.target.value);
            };

            // 阻止点击搜索框时关闭下拉框
            input.onclick = (e) => e.stopPropagation();
        });

        // 阻止下拉框内点击冒泡
        container.querySelectorAll('.pre-window-dropdown').forEach((dropdown) => {
            dropdown.onclick = (e) => e.stopPropagation();
        });

        // 点击外部关闭所有准备录制下拉框
        document.addEventListener('click', () => {
            this.closeAllPreRecordingDropdowns();
        });
    }

    /**
     * 绑定选项点击事件
     */
    bindOptionClickEvents(displayIndex) {
        const container = this.querySelector(`.window-options-container[data-display="${displayIndex}"]`);
        if (!container) return;

        container.querySelectorAll('.window-option').forEach((option) => {
            option.onclick = (e) => {
                e.stopPropagation();
                const value = option.dataset.value;
                const displayIdx = parseInt(option.dataset.display);

                let titleText;
                if (value === 'monitor') {
                    titleText = `捕获显示器 ${displayIdx + 1}`;
                } else {
                    const title = option.dataset.title || '未命名窗口';
                    const shortTitle = title.length > 20 ? title.substring(0, 20) + '...' : title;
                    titleText = `${value} - ${shortTitle}`;
                }

                this.selectPreRecordingWindow(displayIdx, value, titleText);
            };
        });
    }

    /**
     * 关闭所有准备录制下拉框
     */
    closeAllPreRecordingDropdowns() {
        this.querySelectorAll('.pre-window-dropdown').forEach((dropdown) => {
            dropdown.classList.add('hidden');
        });
        this.querySelectorAll('[data-chevron]').forEach((chevron) => {
            chevron.classList.remove('rotate-180');
        });
    }

    /**
     * 更新准备录制窗口数量显示
     */
    async updatePreRecordingWindowCounts() {
        const windows = await window.applicationAPI.call('getWindowList');
        const displayCount = this.preRecordingWindowConfigs.length;

        for (let i = 0; i < displayCount; i++) {
            const windowsOnDisplay = windows.filter((w) => w.displayIndex === i);
            const countSpan = this.querySelector(`[data-window-count="${i}"]`);
            if (countSpan) {
                countSpan.textContent = `${windowsOnDisplay.length}个窗口`;
            }
        }
    }

    // ------ 主页面显示 ------
    async reloadPreviewArea() {
        const recallStatus = await this.getRecallStatus();
        this.currentStatus = recallStatus.status;
        this.currentActivity = recallStatus.activity;

        this.reloadHistoryActivities();

        // 2. 清理定时器
        this.clearThumbnailInterval();

        // 3. 分流渲染
        if (this.currentStatus === 'idle') {
            this.renderIdleView();
        } else if (this.currentStatus === 'recording') {
            this.renderRecordingView(recallStatus);
        }
    }

    /**
     * 渲染空闲/设置界面
     */
    renderIdleView() {
        this.querySelector('#recall-status-recording').style.display = 'none';
        this.querySelector('#recall-status-idle').style.display = 'flex';

        document.startViewTransition(() => {
            this.querySelector('#recall-current-activity').innerHTML = this.getIdleHtml();

            // --- 闭包内的局部变量状态 ---
            const tags = [];

            // DOM 引用
            const tagInput = this.querySelector('#tag-input');
            const tagsContainer = this.querySelector('#tags-container');

            tagInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && !e.isComposing) {
                    const val = tagInput.value.trim();
                    if (val && !tags.includes(val)) {
                        tags.push(val);
                        this.renderTags(tags, tagsContainer);
                        tagInput.value = '';
                    }
                }
            });

            this.querySelector('#start-recall-capture-btn').onclick = () => {
                const activityNameInput = this.querySelector('#activity-name-input');
                const activityName = activityNameInput.value.trim();
                this.executeStartCapture(activityName, tags);
            };

            // 初始化窗口选择器
            this.setupPreRecordingWindowSelectors();
        });
    }

    /**
     * 渲染录制中界面
     */
    renderRecordingView(recallStatus) {
        this.querySelector('#recall-status-recording').style.display = 'flex';
        this.querySelector('#recall-status-idle').style.display = 'none';

        document.startViewTransition(() => {
            this.querySelector('#recall-current-activity').innerHTML = this.getRecordingHtml(recallStatus);
            this.querySelector('#stop-recall-capture-btn').onclick = () => this.stopRecallCapture();

            // 启动轮询更新
            this.initRecordingPolling();
        });
    }

    // ------ 录制功能 ------
    /**
     * 统一处理录制开始逻辑
     */
    executeStartCapture(name, tags) {
        const now = new Date();
        let finalName = name;

        if (!finalName) {
            finalName = `在${now.getMonth() + 1}月${now.getDate()}日${now.getHours()}点${now.getMinutes()}分开始的活动`;
        }
        this.startRecallCapture(finalName, tags);
    }

    async startRecallCapture(activityName, tags = []) {
        const options = {};
        if (tags.length > 0) {
            options.tags = tags;
        }

        // 传递窗口配置
        if (this.preRecordingWindowConfigs && this.preRecordingWindowConfigs.length > 0) {
            // 检查是否所有显示器都使用默认的"捕获显示器"模式
            const allDefault = this.preRecordingWindowConfigs.every((c) => c.captureMode === 'monitor');

            if (!allDefault) {
                // 有自定义窗口选择，传递详细配置
                options.displayConfigs = this.preRecordingWindowConfigs;
            }
            // 如果全部默认，不需要传递配置（后端会使用默认行为）
        }

        const recallStatus = await window.applicationAPI.call('startRecallCapture', activityName, options);
        await this.reloadPreviewArea();
        await this.reloadHistoryActivities();
    }

    async stopRecallCapture() {
        const recallStatus = await window.applicationAPI.call('stopRecallCapture');
        this.reloadPreviewArea();
    }

    // ------ utils ------
    /**
     * 启动录制状态轮询
     */
    initRecordingPolling() {
        this.updateWindowSelect();
        const updatePreview = async () => {
            try {
                const thumbnailLoaded = await this.loadLatestThumbnails();
                if (thumbnailLoaded === false) {
                    this.handleRecordingEnd();
                    return;
                }

                await this.updateRecordingDuration();

                const latestStatus = await this.getRecallStatus();
                if (latestStatus?.activity) {
                    this.currentActivity = latestStatus.activity;
                    this.syncStatsUI();
                }
            } catch (error) {
                console.error('[RecallView] ❌ updatePreview 错误:', error);
                this.handleRecordingEnd();
            }
        };

        // 录制界面中无法更新窗口选项
        updatePreview();
        this.reloadThumbnailInterval = setInterval(updatePreview, this.reloadThumbnailIntervalMs);
    }

    /**
     * 同步实时统计 UI
     */
    syncStatsUI() {
        const act = this.currentActivity;
        const captureCountEl = this.querySelector('#recall-capture-count');
        const snapshotCountEl = this.querySelector('#recall-snapshot-count');
        const totalSizeEl = this.querySelector('#recall-total-size');

        if (captureCountEl) {
            captureCountEl.textContent = act.snapshotCount || 0;
        }
        if (snapshotCountEl) snapshotCountEl.textContent = act.snapshotCount || 0;
        if (totalSizeEl) totalSizeEl.textContent = ((act.totalSize || 0) / 1024 / 1024).toFixed(1);
    }

    async getRecallStatus() {
        const recallStatus = await window.applicationAPI.call('getRecallStatus');
        return recallStatus;
    }

    /**
     * 录制结束或出错时的清理
     */
    async handleRecordingEnd() {
        this.clearThumbnailInterval();
        await this.reloadPreviewArea();
    }

    clearThumbnailInterval() {
        if (this.reloadThumbnailInterval) {
            clearInterval(this.reloadThumbnailInterval);
            this.reloadThumbnailInterval = null;
        }
    }

    async reloadHistoryActivities() {
        // 获取今天的开始和结束时间戳
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
        const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();

        const historyActivities = await window.applicationAPI.call('getHistoryActivities', todayStart, todayEnd);
        const historyActivitiesHtml = historyActivities
            .map((activity) => {
                // 使用 Base64 data URL 替代 file:// URL
                const coverPath = activity.coverDataURL || '';
                const defaultImage =
                    'https://images.unsplash.com/photo-1555066931-4365d14bab8c?auto=format&fit=crop&q=40&w=300';
                // 计算时长
                const durationMinutes = activity.duration ? Math.floor(activity.duration / 1000 / 60) : 0;
                // 格式化时间
                const startTimeStr = activity.startTime
                    ? new Date(activity.startTime).toLocaleString('zh-CN', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit'
                      })
                    : '--';

                return `
        <div class="history-activity-item flex-none w-36 group cursor-pointer" data-activity_id="${activity.activityId}">
            <div class="relative aspect-video rounded-md overflow-hidden border border-zinc-200 group-hover:border-blue-400 transition-colors shadow-sm bg-white">
                <img src="${coverPath || defaultImage}" class="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity" onerror="this.src='${defaultImage}'">
                <!-- 删除图标（右上角） -->
                <button
                    class="delete-history-activity-btn absolute top-1 right-1 h-5 w-5 flex items-center justify-center bg-white/80 rounded-full cursor-pointer shadow hover:bg-red-500 hover:text-white transition group/delete"
                    title="删除此回顾"
                    style="z-index:1"
                    data-activity_id="${activity.activityId}"
                >
                    <i class="fa-solid fa-trash text-[10px]"></i>
                </button>
                <div class="absolute bottom-1 right-1 bg-white/70 backdrop-blur px-1 py-0.5 rounded text-[9px] font-mono text-gray-800 shadow">
                    ${durationMinutes}min
                </div>
            </div>
            <div class="mt-1.5 flex items-start gap-1.5">
                <i class="fa-solid fa-video text-red-500 mt-0.5 flex-shrink-0 text-xs"></i>
                <div class="min-w-0 flex-1">
                    <p class="text-xs font-medium group-hover:text-blue-500 transition-colors text-gray-800 overflow-hidden text-ellipsis whitespace-nowrap">
                        ${activity.activityName || '未命名活动'}
                    </p>
                    <p class="text-[10px] text-gray-500 overflow-hidden text-ellipsis whitespace-nowrap">
                        ${startTimeStr}
                    </p>
                </div>
            </div>
        </div>
        `;
            })
            .join('');

        document.querySelector('#recall-history-activity-list').innerHTML = historyActivitiesHtml;
        document.querySelectorAll('.delete-history-activity-btn').forEach((btn) => {
            btn.onclick = async (event) => {
                event.stopPropagation(); // 阻止事件冒泡
                const activityId = btn.dataset.activity_id;
                const confirmDelete = window.confirm('确定要删除这个回顾吗？删除后无法恢复。');
                if (!confirmDelete) {
                    return;
                }
                await window.applicationAPI.call('deleteHistoryActivity', activityId);
                this.reloadHistoryActivities();
            };
        });
        document.querySelectorAll('.history-activity-item').forEach((item) => {
            item.onclick = async () => {
                const activityId = item.dataset.activity_id;
                try {
                    const result = await window.applicationAPI.call('getHistoryActivityById', activityId);
                    if (result && result.success && result.activity) {
                        await window.applicationAPI.callMainWorld('openActivityFolder', result.activity.activityPath);
                    } else {
                        console.error('Failed to get activity or activity data is invalid:', result);
                    }
                } catch (error) {
                    console.error('Error while fetching activity data:', error);
                }
            };
        });
    }

    async updateRecordingDuration() {
        if (this.currentStatus != 'recording') {
            console.warn('not recording, skipping duration update');
            return;
        }

        const durationMs = Date.now() - this.currentActivity.startTime;
        const durationHours = Math.floor(durationMs / 3600000);
        const durationMinutes = Math.floor((durationMs % 3600000) / 60000);
        const durationSeconds = Math.floor((durationMs % 60000) / 1000);

        let durationString = `${durationSeconds}秒`;
        if (durationMinutes > 0) {
            durationString = `${durationMinutes}分钟` + durationString;
        }
        if (durationHours > 0) {
            durationString = `${durationHours}小时` + durationString;
        }

        const durationEl = document.querySelector('#recall-recording-duration');
        if (durationEl) {
            durationEl.innerHTML = durationString;
        }
    }

    async loadLatestThumbnails() {
        if (this.currentStatus != 'recording') {
            console.warn('not recording, skipping thumbnail load');
            return;
        }

        const latestThumbnail = await window.applicationAPI.call('getLatestThumbnails');
        const previewEl = document.querySelector('#recall-current-activity-preview');
        if (!previewEl) return;

        // 检查返回数据是否有效
        if (
            !latestThumbnail ||
            latestThumbnail.success === false ||
            !latestThumbnail.thumbnails ||
            !Array.isArray(latestThumbnail.thumbnails)
        ) {
            // 录制已停止（正常情况，如窗口消失或用户主动停止），直接返回false让调用者处理
            return false;
        }

        // 更新时间戳
        const timestampEl = document.querySelector('#preview-timestamp span');
        if (timestampEl) {
            const now = new Date();
            timestampEl.textContent = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
        }

        if (latestThumbnail.thumbnails.length === 0) {
            previewEl.innerHTML = `
                <div class="flex flex-col items-center justify-center gap-4 text-gray-400">
                    <i class="fa-solid fa-camera text-5xl animate-pulse"></i>
                    <span class="text-lg">等待截图中...</span>
                </div>
            `;
        } else if (latestThumbnail.thumbnails.length === 1) {
            // 单显示器：全屏显示
            previewEl.innerHTML = `
                <img src="${latestThumbnail.thumbnails[0]}" alt="实时预览" class="w-full h-full object-contain">
            `;
        } else if (latestThumbnail.thumbnails.length === 2) {
            // 两个显示器：并排布局
            previewEl.innerHTML = `
                <div class="flex gap-2 w-full h-full p-2">
                    ${latestThumbnail.thumbnails
                        .map(
                            (src, idx) => `
                        <div class="flex-1 relative flex items-center justify-center bg-black/20 rounded-lg overflow-hidden border border-white/10">
                            <img src="${src}" alt="显示器 ${idx + 1}" class="w-full h-full object-contain" />
                            <div class="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur-sm text-white text-xs px-2 py-1 rounded-md font-medium flex items-center gap-1">
                                <i class="fa-solid fa-display text-blue-400"></i>
                                显示器 ${idx + 1}
                            </div>
                        </div>
                        `
                        )
                        .join('')}
                </div>
            `;
        } else if (latestThumbnail.thumbnails.length === 3) {
            // 三个显示器：1+2布局（上1下2）
            previewEl.innerHTML = `
                <div class="flex flex-col gap-2 w-full h-full p-2">
                    <div class="flex-1 relative flex items-center justify-center bg-black/20 rounded-lg overflow-hidden border border-white/10">
                        <img src="${latestThumbnail.thumbnails[0]}" alt="显示器 1" class="w-full h-full object-contain" />
                        <div class="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur-sm text-white text-xs px-2 py-1 rounded-md font-medium flex items-center gap-1">
                            <i class="fa-solid fa-display text-blue-400"></i>
                            显示器 1
                        </div>
                    </div>
                    <div class="flex-1 flex gap-2">
                        ${latestThumbnail.thumbnails
                            .slice(1)
                            .map(
                                (src, idx) => `
                            <div class="flex-1 relative flex items-center justify-center bg-black/20 rounded-lg overflow-hidden border border-white/10">
                                <img src="${src}" alt="显示器 ${idx + 2}" class="w-full h-full object-contain" />
                                <div class="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur-sm text-white text-xs px-2 py-1 rounded-md font-medium flex items-center gap-1">
                                    <i class="fa-solid fa-display text-blue-400"></i>
                                    显示器 ${idx + 2}
                                </div>
                            </div>
                            `
                            )
                            .join('')}
                    </div>
                </div>
            `;
        } else {
            // 4个或更多显示器：2x2网格布局
            previewEl.innerHTML = `
                <div class="grid grid-cols-2 gap-2 w-full h-full p-2">
                    ${latestThumbnail.thumbnails
                        .map(
                            (src, idx) => `
                        <div class="relative flex items-center justify-center bg-black/20 rounded-lg overflow-hidden border border-white/10">
                            <img src="${src}" alt="显示器 ${idx + 1}" class="w-full h-full object-contain" />
                            <div class="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/70 backdrop-blur-sm text-white text-xs px-2 py-1 rounded-md font-medium flex items-center gap-1">
                                <i class="fa-solid fa-display text-blue-400"></i>
                                显示器 ${idx + 1}
                            </div>
                        </div>
                        `
                        )
                        .join('')}
                </div>
            `;
        }

        // 成功加载缩略图
        return true;
    }

    renderTags(tags, container) {
        const colors = [
            {
                bg: 'bg-blue-100',
                text: 'text-blue-800',
                border: 'border-blue-300',
                hover: 'hover:text-blue-900'
            },
            {
                bg: 'bg-green-100',
                text: 'text-green-800',
                border: 'border-green-300',
                hover: 'hover:text-green-900'
            },
            {
                bg: 'bg-indigo-100',
                text: 'text-indigo-800',
                border: 'border-indigo-300',
                hover: 'hover:text-indigo-900'
            },
            {
                bg: 'bg-orange-100',
                text: 'text-orange-800',
                border: 'border-orange-300',
                hover: 'hover:text-orange-900'
            },
            {
                bg: 'bg-teal-100',
                text: 'text-teal-800',
                border: 'border-teal-300',
                hover: 'hover:text-teal-900'
            },
            {
                bg: 'bg-cyan-100',
                text: 'text-cyan-800',
                border: 'border-cyan-300',
                hover: 'hover:text-cyan-900'
            },
            {
                bg: 'bg-pink-100',
                text: 'text-pink-800',
                border: 'border-pink-300',
                hover: 'hover:text-pink-900'
            }
        ];

        const getTagColor = (str) => {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                hash = str.charCodeAt(i) + ((hash << 5) - hash);
            }
            return colors[Math.abs(hash) % colors.length];
        };

        container.innerHTML = tags
            .map((tag) => {
                const color = getTagColor(tag);
                const colorClass = `${color.bg} ${color.text} border ${color.border}`;
                const hoverClass = color.hover;

                return `
                <span class="inline-flex items-center gap-1.5 px-3 py-1.5 ${colorClass} text-xs font-medium rounded-lg shadow-sm whitespace-nowrap">
                    <i class="fa-solid fa-tag text-xs"></i>
                    <span class="font-semibold">${tag}</span>
                    <button class="ml-0.5 ${hoverClass} transition-colors delete-tag-btn">
                        <i class="fa-solid fa-times text-xs"></i>
                    </button>
                </span>
            `;
            })
            .join('');

        // 添加删除标签的处理逻辑
        container.querySelectorAll('.delete-tag-btn').forEach((btn, index) => {
            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();

                const tagEl = btn.closest('span');
                const tagText = tagEl.querySelector('span.font-semibold').textContent;
                const tagIndex = tags.indexOf(tagText);

                if (tagIndex > -1) {
                    tags.splice(tagIndex, 1);
                    this.renderTags(tags, container);
                }
            };
        });
    }

    render() {
        this.innerHTML = `
        <div class='w-full h-full flex flex-col overflow-hidden pb-6'>
            <!-- 顶部导航栏 -->
            <header class="h-14 border-b border-gray-200 flex items-center justify-between px-6 bg-white/70 backdrop-blur-xl z-20">
                <div class="flex flex-1 justify-center items-center gap-5">
                    <div id='recall-status-recording' style="display: none;" class="flex items-center gap-2 px-3 py-1 bg-red-50 rounded-full border border-red-100">
                        <span class="relative flex h-2 w-2">
                            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                            <span class="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                        </span>
                        <span class="text-[11px] font-medium text-red-600 uppercase tracking-wider">Live Recording</span>
                    </div>
                    <div id='recall-status-idle' class="flex items-center gap-2 px-3 py-1 bg-gray-50 rounded-full border border-gray-200">
                        <span class="relative flex h-2 w-2">
                            <span class="relative inline-flex rounded-full h-2 w-2 bg-gray-400"></span>
                        </span>
                        <span class="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Idle</span>
                    </div>
                    <h1 class="font-medium text-md tracking-tight text-center">活动录制</h1>
                </div>
            </header>

            <!-- 上半部分：当前屏幕预览区 -->
            <main id='recall-current-activity' class="flex-[0.65] min-h-0 relative flex items-center justify-center px-4 py-2 overflow-hidden">
            </main>

            <!-- 下半部分：水平历史列表 -->
            <footer class="flex-[0.35] min-h-[180px] bg-white/50 backdrop-blur-2xl border-t border-gray-200 px-6 py-3 flex flex-col">
                <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-3">
                    <span class="text-xs font-bold text-gray-400 uppercase tracking-widest">您已经记录的活动</span>
                    <div class="px-2 py-0.5 bg-gray-200 rounded text-[10px] text-gray-600 font-bold tracking-tight">TODAY</div>
                </div>
                <div class="flex gap-2">
                    <button id="recall-history-scroll-left" class="p-1.5 hover:bg-gray-200 rounded-md text-gray-400"><i class="fa-solid fa-chevron-left text-xs"></i></button>
                    <button id="recall-history-scroll-right" class="p-1.5 hover:bg-gray-200 rounded-md text-gray-400"><i class="fa-solid fa-chevron-right text-xs"></i></button>
                </div>
                </div>

                <!-- 水平时间轴项 -->
                <div id='recall-history-activity-list' class="flex gap-4 overflow-x-auto pb-4 no-scrollbar h-full items-start">

                </div>
            </footer>
        </div>
        `;

        // 绑定滚动事件
        const scrollContainer = this.querySelector('#recall-history-activity-list');
        const leftBtn = this.querySelector('#recall-history-scroll-left');
        const rightBtn = this.querySelector('#recall-history-scroll-right');

        if (leftBtn && scrollContainer) {
            leftBtn.onclick = () => {
                scrollContainer.scrollBy({ left: -300, behavior: 'smooth' });
            };
        }

        if (rightBtn && scrollContainer) {
            rightBtn.onclick = () => {
                scrollContainer.scrollBy({ left: 300, behavior: 'smooth' });
            };
        }
    }

    /**
     * 渲染标签列表
     * @param {Array} tags 标签数组
     * @param {HTMLElement} container 容器元素
     */

    // --- HTML 模板库 ---
    getIdleHtml() {
        return `
        <div class="flex flex-col items-center justify-center w-full h-full gap-2 bg-gray-50 rounded-2xl shadow-inner p-4">
            <div class="w-full max-w-lg px-2">
                <div class="space-y-3 mb-5">
                    <div class="flex gap-4">
                        <div class="flex-1 min-w-0">
                            <label class="block text-xs font-medium text-gray-700 mb-1">
                                <i class="fa-solid fa-tag text-blue-500"></i> 活动名称(可选)
                            </label>
                            <input id="activity-name-input" type="text" placeholder="如：产品设计讨论"
                                class="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400" />
                        </div>
                    </div>
                    <div class="relative">
                        <label class="block text-xs font-medium text-gray-700 mb-2">
                            <i class="fa-solid fa-display text-purple-500"></i>
                            窗口选择 <span class="text-gray-400 text-[10px]">(可选)</span>
                        </label>
                        <div id="pre-recording-window-container" class="grid gap-2">
                            <!-- 动态生成显示器选择器 -->
                        </div>
                    </div>
                    <div class="relative">
                        <div id="wrapper-tags">
                            <label class="block text-xs font-medium text-gray-700 mb-1">
                                <i class="fa-solid fa-tags text-green-500"></i> 标签(可选)
                            </label>
                            <div class="w-full min-h-[36px] px-2 py-1 border border-gray-300 rounded-lg bg-white focus-within:ring-2 focus-within:ring-green-500 focus-within:border-transparent flex flex-wrap gap-1.5 items-center transition-all">
                                <div id="tags-container" class="contents"></div>
                                <input id="tag-input" type="text" placeholder="输入标签按Enter..."
                                    class="flex-1 min-w-[80px] bg-transparent outline-none text-sm h-7 placeholder-gray-400" />
                            </div>
                        </div>
                    </div>
                </div>
                <div class="flex justify-center">
                    <button id="start-recall-capture-btn" class="w-40 group relative flex items-center justify-center gap-2 py-2.5 rounded-xl bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-600 hover:to-red-700 text-white shadow-md hover:shadow-lg transition-all duration-200 overflow-hidden transform hover:-translate-y-0.5">
                        <div class="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-in-out"></div>
                        <span class="relative flex h-3 w-3">
                            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-50"></span>
                            <span class="relative inline-flex rounded-full h-3 w-3 bg-white"></span>
                        </span>
                        <span class="relative text-sm font-bold tracking-wide">开始录制</span>
                    </button>
                </div>
                <div class="mt-2 text-center">
                    <span class="text-[10px] text-gray-400">录制内容将自动分类并生成可回顾的时间轴</span>
                </div>
            </div>
        </div>`;
    }

    getRecordingHtml(recallStatus) {
        return `
        <div class="w-full h-full flex flex-col">
            <div class="flex-1 flex flex-row gap-3 px-4 pt-2 pb-4 min-h-0 justify-center items-center">
                <div class="flex-shrink-0 w-[420px] max-w-[50vw] min-h-[220px] h-[280px] max-h-[50vh] flex items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900 rounded-xl shadow-2xl overflow-hidden relative min-w-0">
                    <div id='recall-current-activity-preview' class="w-full h-full flex items-center justify-center">
                        <div class="flex flex-col items-center justify-center gap-4 text-gray-400">
                            <i class="fa-solid fa-camera text-5xl animate-pulse"></i>
                            <span class="text-lg">等待截图中...</span>
                        </div>
                    </div>
                    <div class="absolute top-3 left-3 flex items-center gap-2 bg-black/40 backdrop-blur-md px-3 py-1.5 rounded-full">
                        <div class="relative flex h-2 w-2">
                            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75"></span>
                            <span class="relative inline-flex rounded-full h-2 w-2 bg-red-600"></span>
                        </div>
                        <span class="text-xs font-bold text-white uppercase tracking-wider">REC</span>
                    </div>
                    <div id="preview-timestamp" class="absolute top-3 right-3 bg-black/40 backdrop-blur-md px-3 py-1.5 rounded-full">
                        <span class="text-xs font-mono text-white">--:--:--</span>
                    </div>
                </div>
                <div class="flex flex-col w-[340px] max-w-[40vw] gap-3 min-h-0">
                    <div class="flex-none bg-white rounded-xl shadow-xl px-4 py-3">
                        <div class="flex items-start gap-3">
                            <div id="window-select-container" class="flex-1 min-w-0 space-y-2"></div>
                            <div class="flex-none pt-5">
                                <button id="stop-recall-capture-btn" class="px-4 py-1.5 rounded-lg bg-gradient-to-r from-gray-700 to-gray-900 hover:from-gray-800 hover:to-black text-white font-bold text-sm shadow-lg hover:shadow-xl transition-all duration-200 flex items-center justify-center gap-2 whitespace-nowrap">
                                    <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 20 20"><rect x="5" y="5" width="10" height="10" rx="1"/></svg>停止
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="flex-1 overflow-y-auto bg-white rounded-xl shadow-xl px-4 py-3 space-y-3 min-h-0 max-h-[280px]" style="scrollbar-width: thin; scrollbar-color: #cbd5e1 #f1f5f9;">
                        <div class="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg p-3 border border-blue-100">
                            <div class="flex items-center gap-2 mb-2">
                                <i class="fa-solid fa-clock text-blue-600"></i>
                                <h4 class="text-xs font-bold text-gray-800">时间信息</h4>
                            </div>
                            <div class="space-y-2 text-xs">
                                <div class="flex justify-between">
                                    <span class="text-gray-600">开始</span>
                                    <span id="recall-recording-start-time" class="font-mono font-medium text-gray-900">
                                        ${new Date(recallStatus.activity?.startTime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                </div>
                                <div class="flex justify-between">
                                    <span class="text-gray-600">持续</span>
                                    <span id="recall-recording-duration" class="font-mono font-bold text-blue-600">--:--</span>
                                </div>
                            </div>
                        </div>
                        <div class="bg-gradient-to-br from-purple-50 to-pink-50 rounded-lg p-3 border border-purple-100">
                            <div class="flex items-center gap-2 mb-2">
                                <i class="fa-solid fa-chart-bar text-purple-600"></i>
                                <h4 class="text-xs font-bold text-gray-800">实时统计</h4>
                            </div>
                            <div class="grid grid-cols-3 gap-2">
                                <div class="bg-white rounded-lg p-2 text-center">
                                    <div class="text-xl font-bold text-purple-600" id="recall-capture-count">${recallStatus.activity?.snapshotCount || 0}</div>
                                    <div class="text-[10px] text-gray-600 mt-0.5">捕获</div>
                                </div>
                                <div class="bg-white rounded-lg p-2 text-center">
                                    <div class="text-xl font-bold text-blue-600" id="recall-snapshot-count">${recallStatus.activity?.snapshotCount || 0}</div>
                                    <div class="text-[10px] text-gray-600 mt-0.5">快照</div>
                                </div>
                                <div class="bg-white rounded-lg p-2 text-center">
                                    <div class="text-xl font-bold text-amber-600" id="recall-total-size">${((recallStatus.activity?.totalSize || 0) / 1024 / 1024).toFixed(1)}</div>
                                    <div class="text-[10px] text-gray-600 mt-0.5">MB</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
    }
}
customElements.define('recall-recording-page', RecordingPage);
