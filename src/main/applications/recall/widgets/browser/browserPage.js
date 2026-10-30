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
 * 回顾浏览页面
 * 重新设计：左侧活动列表（原设计） + 中间主视图（带搜索栏和时间轴） + 右侧详情（按需显示）
 */

/**
 * 将snapshots按captureId分组并转换为capture格式
 * @param {Array} snapshots - snapshot数组
 * @returns {Array} capture数组
 */
function groupSnapshotsByCapture(snapshots) {
    const captureGroups = new Map();
    snapshots.forEach((snapshot) => {
        const groupKey = snapshot.captureId || snapshot.id;
        if (!captureGroups.has(groupKey)) {
            captureGroups.set(groupKey, []);
        }
        captureGroups.get(groupKey).push(snapshot);
    });

    // 转换为显示数据，每个capture作为一个项
    return Array.from(captureGroups.entries()).map(([captureId, snapshots]) => {
        // 按sourceIndex排序
        snapshots.sort((a, b) => a.sourceIndex - b.sourceIndex);
        const firstSnapshot = snapshots[0];
        return {
            id: captureId,
            captureId: captureId,
            timestamp: firstSnapshot.timestamp,
            snapshots: snapshots,
            isMarked: snapshots.some((s) => s.isMarked),
            activityId: firstSnapshot.activityId,
            activityName: firstSnapshot.activityName
        };
    });
}

/**
 * 转换 snapshot 数据为统一格式的辅助函数
 * @param {Object} s - 原始 snapshot 数据
 * @param {Function} getAppNameFn - 获取应用名的方法
 * @returns {Object} 转换后的 snapshot 对象
 */
function transformSnapshot(s, getAppNameFn) {
    const snapshot = {
        id: s.id,
        captureId: s.captureId,
        timestamp: s.timestamp,
        thumbnail: s.thumbnailPath,
        imagePath: s.imagePath,
        thumbnailDataURL: s.thumbnailDataURL,
        imageDataURL: s.imageDataURL,
        appName: s.appName,
        activityId: s.activityId,
        activityName: s.activityName,
        width: s.width,
        height: s.height,
        isMarked: s.isMarked || false,
        sourceType: s.sourceType,
        sourceId: s.sourceId,
        sourceName: s.sourceName,
        sourceIndex: s.sourceIndex || 0,
        windowTitle: s.windowTitle,
        appBundleId: s.appBundleId
    };
    // 使用智能方法获取应用名
    snapshot.app = getAppNameFn(snapshot);
    return snapshot;
}

class BrowserPage extends HTMLElement {
    constructor() {
        super();
        // 视图模式：daily=日视图, activity=活动详情, eventGroup=事件组详情
        this.viewMode = 'daily';
        // 默认图片视图
        this.dailyViewType = 'images';

        this.currentIndex = 0; // 当前展示的索引
        this.currentActivityId = null; // 当前查看的活动ID
        this.currentEventGroupId = null; // 当前查看的事件组ID
        this.currentData = []; // 当前视图的数据（总是图片数组）

        // 保存日视图的状态，用于返回时恢复
        this.savedDailyState = {
            viewType: 'images', // 默认图片视图
            index: 0
        };

        this.showDetail = false;
        this.selectedItem = null;
        this.allActivities = [];
        this.bookmarks = new Set();

        // 可拖拽分隔条的宽度
        this.leftPanelWidth = 288;
        this.rightPanelWidth = 320;

        // 图片预加载缓存
        this.imageCache = new Map();

        // 选中的日期（默认今天）
        this.selectedDate = new Date().toISOString().split('T')[0];

        // PDF状态轮询
        this._pdfStatusPollingInterval = null;
        this._pollingActivityIds = new Set(); // 正在轮询的活动ID
    }

    connectedCallback() {
        // 启动PDF状态轮询（每2秒检查一次）
        this.startPDFStatusPolling();

        try {
            this.render();
        } catch (error) {
            console.error('[BrowserPage] render() 失败:', error);
            this.innerHTML = '<div class="p-4 text-red-500">初始化失败: ' + error.message + '</div>';
            return;
        }

        // 等待 DOM 完全挂载后再执行其他初始化
        requestAnimationFrame(() => {
            try {
                this.setupEventListeners();
                this.setupResizers();
                // 先加载真实活动数据
                this.loadActivities();
                // 加载所有截图用于日视图
                this.loadDailyView();
            } catch (error) {
                console.error('[BrowserPage] 初始化失败:', error);
            }
        });
    }

    /**
     * 加载日视图（所有截图）
     */
    async loadDailyView() {
        try {
            // 根据选中的日期计算时间范围
            const date = new Date(this.selectedDate);
            const startTime = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0).getTime();
            const endTime = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime();

            // 加载指定日期的截图
            const result = await window.applicationAPI.call('getAllSnapshots', startTime, endTime, 500);

            if (result && result.success && result.snapshots) {
                const allSnapshots = result.snapshots.map((s) =>
                    transformSnapshot(s, this.getSnapshotAppName.bind(this))
                );

                // 按captureId分组并转换为capture格式
                this.currentData = groupSnapshotsByCapture(allSnapshots);

                // 按时间排序
                this.currentData.sort((a, b) => a.timestamp - b.timestamp);

                // 从数据库加载标记状态
                this.bookmarks.clear();
                this.currentData.forEach((item) => {
                    item.snapshots.forEach((snapshot) => {
                        if (snapshot.isMarked) {
                            this.bookmarks.add(snapshot.id);
                        }
                    });
                });
            } else {
                this.currentData = [];
            }
        } catch (error) {
            console.error('[BrowserPage] Failed to load daily view:', error);
            this.currentData = [];
        }

        if (this.isConnected) {
            this.updateMainView();
            this.updateBackButton();
            this.updateViewTypeButtons();
            this.updateTimeline();
        }

        // 清除左侧活动列表的选中状态
        const listComponent = this.querySelector('recall-activity-list');
        if (listComponent) {
            listComponent.selectedActivityId = null;
            listComponent.render();
        }
    }

    async loadActivities() {
        try {
            const activities = await window.applicationAPI.call('getHistoryActivities', 0, Date.now());
            this.allActivities = activities || [];

            // 只在DOM已经挂载后才更新
            if (this.isConnected) {
                this.updateActivityList();
            }
        } catch (error) {
            console.error('[BrowserPage] 加载活动失败:', error);
        }
    }

    updateActivityList() {
        const listComponent = this.querySelector('recall-activity-list');
        if (listComponent) {
            listComponent.setActivities(this.allActivities);
            // 设置当前选中的活动
            if (this.viewMode === 'activity' && this.currentActivityId) {
                listComponent.selectedActivityId = this.currentActivityId;
                listComponent.render();
            }

            // 移除旧的事件监听器（如果存在）
            if (listComponent._activitySelectedHandler) {
                listComponent.removeEventListener('activitySelected', listComponent._activitySelectedHandler);
            }
            if (listComponent._activityDeletedHandler) {
                listComponent.removeEventListener('activityDeleted', listComponent._activityDeletedHandler);
            }

            // 创建新的事件处理器并保存引用
            listComponent._activitySelectedHandler = (e) => {
                this.loadActivityView(e.detail.activityId);
            };
            listComponent._activityDeletedHandler = async (e) => {
                const activityId = e.detail.activityId;
                try {
                    await window.applicationAPI.call('deleteHistoryActivity', activityId);

                    // 如果删除的是当前查看的活动，返回到日视图
                    if (this.viewMode === 'activity' && this.currentActivityId === activityId) {
                        this.viewMode = 'daily';
                        this.currentActivityId = null;
                        this.currentIndex = 0;

                        // 恢复之前的日视图状态
                        if (this.savedDailyState) {
                            this.dailyViewType = this.savedDailyState.viewType;
                            this.currentIndex = this.savedDailyState.index;
                        }

                        // 重新加载日视图数据
                        await this.loadDailyView();
                    }

                    // 重新加载活动列表
                    await this.loadActivities();
                } catch (error) {
                    console.error('[BrowserPage] 删除活动失败:', error);
                    alert('删除活动失败，请重试');
                }
            };

            // 添加事件监听器
            listComponent.addEventListener('activitySelected', listComponent._activitySelectedHandler);
            listComponent.addEventListener('activityDeleted', listComponent._activityDeletedHandler);
        }
    }

    async loadActivityView(activityId) {
        const loadStartTime = Date.now();

        // 立即显示加载状态，而不是等待数据
        const container = this.querySelector('#main-content');
        if (container) {
            container.innerHTML = `
                <div class="flex flex-col items-center justify-center h-full">
                    <div class="w-16 h-16 mb-4">
                        <svg class="animate-spin text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                        </svg>
                    </div>
                    <div class="text-gray-600">正在加载活动数据...</div>
                    <div class="text-xs text-gray-400 mt-2">活动 ID: ${activityId}</div>
                </div>
            `;
        }

        // 保存当前日视图状态
        if (this.viewMode === 'daily') {
            this.savedDailyState = {
                viewType: this.dailyViewType,
                index: this.currentIndex
            };
        }

        this.viewMode = 'activity';
        this.currentActivityId = activityId;
        this.currentEventGroupId = null;
        this.currentIndex = 0;

        // 加载指定活动的真实截图
        try {
            const activityResult = await window.applicationAPI.call('getHistoryActivityById', activityId);
            let currentActivity = null;
            if (activityResult && activityResult.success) {
                currentActivity = activityResult.activity;
            }

            const snapshotsStartTime = Date.now();
            const result = await window.applicationAPI.call('getActivitySnapshots', activityId);

            if (result && result.success && result.snapshots) {
                const allSnapshots = result.snapshots.map((s) =>
                    transformSnapshot(s, this.getSnapshotAppName.bind(this))
                );

                // 按captureId分组并转换为capture格式
                this.currentData = groupSnapshotsByCapture(allSnapshots);

                // 按时间排序
                this.currentData.sort((a, b) => a.timestamp - b.timestamp);

                // 处理PDF相关信息（所有活动统一处理）
                if (currentActivity) {
                    this.currentActivity = currentActivity;
                    const pdfStatus = currentActivity.pdfStatus;
                    const startedAt = currentActivity.metadata?.pdf?.startedAt;

                    // 检测僵尸状态：如果状态是 'processing' 但已经超过 5 分钟
                    if (pdfStatus === 'processing' && startedAt) {
                        const elapsedMinutes = (Date.now() - startedAt) / 1000 / 60;
                        if (elapsedMinutes > 5) {
                            console.warn('[BrowserPage] Detected stale processing status (>5min), showing as failed');
                            // 在本地更新为失败状态（不更新数据库，避免数据不一致）
                            this.currentActivity.pdfStatus = 'failed';
                            if (!this.currentActivity.metadata) this.currentActivity.metadata = {};
                            if (!this.currentActivity.metadata.pdf) this.currentActivity.metadata.pdf = {};
                            this.currentActivity.metadata.pdf.error = '处理超时（可能由于程序异常退出），请重新生成';
                        } else {
                            // 如果PDF正在生成且未超时，启动轮询检测
                            this.pollActivityStatus(activityId);
                        }
                    } else if (pdfStatus === 'processing') {
                        // 没有 startedAt 时间戳，但状态是 processing（旧数据），启动轮询
                        this.pollActivityStatus(activityId);
                    }
                } else {
                    this.currentActivity = null;
                }
            } else {
                this.currentData = [];
            }
        } catch (error) {
            console.error('[BrowserPage] ❌ 加载活动数据失败:', error);
            this.currentData = [];
        }

        this.updateMainView();
        this.updateBackButton();
        this.updateViewTypeButtons();
        this.updateActivityList();
    }

    /**
     * 轮询活动状态（用于PDF生成完成检测）
     * @param {string} activityId 活动ID
     */
    async pollActivityStatus(activityId) {
        const maxPolls = 60; // 最多轮询60次（2分钟）
        let polls = 0;

        const pollInterval = setInterval(async () => {
            polls++;

            try {
                // 获取最新活动状态
                const result = await window.applicationAPI.call('getHistoryActivityById', activityId);

                if (result && result.success && result.activity) {
                    const status = result.activity.pdfStatus;

                    // 如果不再是processing状态，或超时
                    if (status !== 'processing' || polls >= maxPolls) {
                        clearInterval(pollInterval);

                        // 重新加载活动列表和活动视图
                        if (status === 'completed') {
                            await this.loadActivities(); // 刷新活动列表
                            await this.loadActivityView(activityId);
                        } else if (status === 'failed') {
                            console.error('[BrowserPage] PDF generation failed');
                            await this.loadActivities(); // 刷新活动列表
                            await this.loadActivityView(activityId);
                        } else if (polls >= maxPolls) {
                            console.warn('[BrowserPage] PDF generation polling timeout');
                            await this.loadActivities(); // 超时也刷新
                        }
                    }
                } else {
                    clearInterval(pollInterval);
                }
            } catch (error) {
                console.error('[BrowserPage] Error polling activity status:', error);
                clearInterval(pollInterval);
            }
        }, 2000); // 每2秒检查一次
    }

    /**
     * 启动PDF状态轮询
     */
    startPDFStatusPolling() {
        // 清除旧的轮询
        this.stopPDFStatusPolling();

        this._pdfStatusPollingInterval = setInterval(() => {
            this.pollPDFStatus();
        }, 2000); // 每2秒检查一次
    }

    /**
     * 停止PDF状态轮询
     */
    stopPDFStatusPolling() {
        if (this._pdfStatusPollingInterval) {
            clearInterval(this._pdfStatusPollingInterval);
            this._pdfStatusPollingInterval = null;
        }
    }

    /**
     * 轮询检查PDF状态
     */
    async pollPDFStatus() {
        // 获取所有状态为 pending 或 processing 的活动
        const activitiesToPoll = this.allActivities.filter((activity) => {
            const status = activity.pdfStatus;
            return status === 'pending' || status === 'processing';
        });

        if (activitiesToPoll.length === 0) {
            return;
        }

        // 轮询每个活动
        for (const activity of activitiesToPoll) {
            try {
                const result = await window.applicationAPI.call('getHistoryActivityById', activity.activityId);

                if (result && result.success && result.activity) {
                    const newStatus = result.activity.pdfStatus;
                    const oldStatus = activity.pdfStatus;

                    // 如果状态发生变化
                    if (newStatus !== oldStatus) {
                        // 更新本地缓存
                        activity.pdfStatus = newStatus;
                        if (result.activity.pdfPath) {
                            activity.pdfPath = result.activity.pdfPath;
                        }
                        if (result.activity.keyframeCount) {
                            activity.keyframeCount = result.activity.keyframeCount;
                        }

                        // 刷新活动列表UI
                        this.updateActivityList();

                        // 如果当前正在查看这个活动，刷新活动视图
                        if (this.viewMode === 'activity' && this.currentActivityId === activity.activityId) {
                            await this.loadActivityView(activity.activityId);
                        }
                    }
                }
            } catch (error) {
                console.error(`[BrowserPage] 轮询活动 ${activity.activityId} 状态失败:`, error);
            }
        }
    }

    async loadEventGroupView(groupId) {
        console.warn('[BrowserPage] 事件组功能尚未实现');
        return;
    }

    goBack() {
        // 恢复到保存的日视图状态
        this.viewMode = 'daily';
        this.currentActivityId = null;
        this.currentEventGroupId = null;

        // 恢复日视图类型和索引
        this.dailyViewType = this.savedDailyState.viewType;
        this.currentIndex = this.savedDailyState.index;

        // 重新加载日视图数据
        this.loadDailyView();

        this.updateBackButton();
        this.updateViewTypeButtons();
        this.hideDetail();

        // 清除左侧活动列表的选中状态
        const listComponent = this.querySelector('recall-activity-list');
        if (listComponent) {
            listComponent.selectedActivityId = null;
            listComponent.render();
        }

        // Reset the search input to its placeholder state
        const searchInput = this.querySelector('#search-input');
        if (searchInput) {
            searchInput.value = ''; // Clear the input value
            searchInput.placeholder = '搜索活动'; // Reset the placeholder
        }
    }

    updateBackButton() {
        const backBtn = this.querySelector('#back-button');
        if (backBtn) {
            if (this.viewMode === 'daily') {
                backBtn.classList.add('invisible');
            } else {
                backBtn.classList.remove('invisible');
            }
        }
    }

    renderItemPreview(item, isGroup) {
        if (isGroup) {
            const thumbnailSrc = item.thumbnailDataURL || item.thumbnail || '';
            return `
                <div class="w-48 h-48 bg-gradient-to-br from-gray-50 to-gray-100 rounded-xl shadow-lg flex flex-col items-center justify-center p-4 border border-gray-200 pointer-events-none">
                    <img src="${thumbnailSrc}" alt="${item.app}" class="w-16 h-16 object-contain mb-2" />
                    <p class="text-xs text-gray-600 text-center truncate w-full px-2" title="${item.app}">${this.truncateAppName(item.app, 20)}</p>
                </div>
            `;
        } else {
            // 如果是capture组，显示第一个snapshot的缩略图
            const thumbnailSrc = item.snapshots
                ? item.snapshots[0].thumbnailDataURL || item.snapshots[0].imageDataURL || ''
                : item.thumbnailDataURL || item.imageDataURL || '';
            const altText = item.snapshots ? item.snapshots[0].sourceName : item.app;
            return `
                <img src="${thumbnailSrc}" alt="${altText}"
                     class="w-48 h-48 object-contain rounded-lg shadow-lg pointer-events-none" />
            `;
        }
    }

    onEventGroupClick(groupId) {
        // 点击事件组，进入事件组详情视图
        this.loadEventGroupView(groupId);
    }

    /**
     * 通过ID查找并显示图片详情
     * @param {string} snapshotId - snapshot的ID
     * @param {string} captureId - capture的ID
     */
    async showImageDetailById(snapshotId, captureId) {
        // 从currentData中查找对应的capture
        const capture = this.currentData.find((item) => item.captureId === captureId || item.id === captureId);
        if (!capture) {
            console.error('[BrowserPage] 找不到对应的capture:', captureId);
            return;
        }

        if (!capture.snapshots) {
            console.error('[BrowserPage] capture没有snapshots字段');
            return;
        }

        // 从capture的snapshots中查找对应的snapshot
        const snapshot = capture.snapshots.find((s) => s.id === snapshotId);
        if (!snapshot) {
            console.error('[BrowserPage] 找不到对应的snapshot:', snapshotId);
            return;
        }
        await this.getSnapshotExtraction(snapshot);
        this.showImageDetail(snapshot);
    }

    async getSnapshotExtraction(snapshot) {
        this.showDetail = true;
        this.selectedItem = snapshot;

        // 查询该快照的 extraction（每次点击都重新查询，确保数据最新）
        try {
            const result = await window.applicationAPI.call('getSnapshotExtractions', snapshot.id);

            if (result.success && result.extractions.length > 0) {
                // 找到 summary 类型的 extraction
                const summaryExtraction = result.extractions.find(
                    (e) => e.pageType === 'summary' && e.contentType === 'llm'
                );
                snapshot.memory = summaryExtraction ? summaryExtraction.content : null;
            } else {
                snapshot.memory = null;
            }
            console.info('[BrowserPage] extraction memory:', snapshot.memory);
        } catch (error) {
            console.error('[BrowserPage] Failed to load extraction:', error);
            snapshot.memory = null;
        }
    }

    showImageDetail(item) {
        // 点击单张图片，显示右侧详情面板
        this.selectedItem = item;
        this.showDetail = true;

        // 调整窗口大小以容纳详情面板
        this.adjustWindowSize(true);

        // 立即更新详情面板
        this.updateDetailPanel();
    }

    hideDetail() {
        this.showDetail = false;
        this.selectedItem = null;

        // 恢复窗口大小
        this.adjustWindowSize(false);

        // 隐藏详情面板，保持三栏布局
        const detailPanel = this.querySelector('#detail-panel');
        const rightResizer = this.querySelector('#right-resizer');

        if (detailPanel) {
            detailPanel.style.width = '0px';
            detailPanel.classList.add('hidden');
        }

        if (rightResizer) {
            rightResizer.classList.add('hidden');
        }
    }

    async nextItem() {
        if (this.currentIndex < this.currentData.length - 1) {
            this.currentIndex++;
            this.updateMainView();
            // 如果详情面板是打开的，更新详情内容
            if (this.showDetail) {
                const currentItem = this.currentData[this.currentIndex];
                // 如果是capture组，使用第一个snapshot；否则使用当前item
                this.selectedItem =
                    currentItem.snapshots && currentItem.snapshots.length > 0 ? currentItem.snapshots[0] : currentItem;
                if (this.selectedItem.memory === undefined) {
                    await this.getSnapshotExtraction(this.selectedItem);
                }
                this.updateDetailPanel();
            }
        }
    }

    async prevItem() {
        if (this.currentIndex > 0) {
            this.currentIndex--;
            this.updateMainView();
            // 如果详情面板是打开的，更新详情内容
            if (this.showDetail) {
                const currentItem = this.currentData[this.currentIndex];
                // 如果是capture组，使用第一个snapshot；否则使用当前item
                this.selectedItem =
                    currentItem.snapshots && currentItem.snapshots.length > 0 ? currentItem.snapshots[0] : currentItem;
                if (this.selectedItem.memory === undefined) {
                    await this.getSnapshotExtraction(this.selectedItem);
                }
                this.updateDetailPanel();
            }
        }
    }

    updateMainView() {
        const container = this.querySelector('#main-content');
        if (!container) {
            console.warn('[BrowserPage] ⚠️ #main-content 容器未找到');
            return;
        }

        // 活动视图模式
        if (this.viewMode === 'activity') {
            // 如果活动没有截图数据，显示空视图
            if (this.currentActivity && (!this.currentData || this.currentData.length === 0)) {
                const pdfStatus = this.currentActivity.pdfStatus || 'unknown';
                container.innerHTML = this.generateActivityEmptyView();
                return;
            }
        }

        if (!this.currentData || this.currentData.length === 0) {
            container.innerHTML = '<div class="flex items-center justify-center h-full text-gray-400">暂无数据</div>';
            return;
        }

        const item = this.currentData[this.currentIndex];

        const prevItem = this.currentIndex > 0 ? this.currentData[this.currentIndex - 1] : null;
        const nextItem =
            this.currentIndex < this.currentData.length - 1 ? this.currentData[this.currentIndex + 1] : null;

        // 只有在日视图且选择了事件组展示时，才显示事件组卡片
        const isGroup = this.viewMode === 'daily' && this.dailyViewType === 'groups';
        // 检查是否被标记（capture组检查snapshots，单个检查自身）
        const isBookmarked =
            item.isMarked ||
            (item.snapshots && item.snapshots.some((s) => this.bookmarks.has(s.id))) ||
            this.bookmarks.has(item.id);

        // 确保snapshots字段存在
        if (!isGroup && (!item.snapshots || item.snapshots.length === 0)) {
            console.error('[BrowserPage] 错误: item.snapshots为空或不存在!', item);
            container.innerHTML =
                '<div class="flex items-center justify-center h-full text-red-500">数据错误：无法找到截图</div>';
            return;
        }

        container.innerHTML = `
            <div class="w-full h-full flex items-center justify-center relative p-6 overflow-auto">
                <!-- 当前项目展示（中心） -->
                <div class="relative z-10 transition-all duration-500 ease-out flex items-center justify-center w-full" id="main-item-container">
                    ${
                        isGroup
                            ? `
                        <!-- 事件组显示（可悬停查看详情） -->
                        <div class="relative group cursor-pointer transition-all duration-300"
                             onclick="document.querySelector('recall-browser-page').onEventGroupClick('${item.id}')">
                            <div class="w-80 h-80 bg-gradient-to-br from-blue-50 to-purple-50 rounded-2xl shadow-2xl flex flex-col items-center justify-center p-8 border border-gray-200 transition-transform group-hover:scale-[1.05]">
                                <img src="${item.thumbnailDataURL || item.thumbnail || ''}" alt="${item.app}"
                                     class="w-32 h-32 object-contain mb-4"
                                     onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27100%27 height=%27100%27%3E%3Crect fill=%27%23ddd%27 width=%27100%27 height=%27100%27/%3E%3Ctext x=%2750%25%27 y=%2750%25%27 dominant-baseline=%27middle%27 text-anchor=%27middle%27 font-family=%27sans-serif%27 font-size=%2714%27 fill=%27%23999%27%3E${this.truncateAppName(item.app, 10)}%3C/text%3E%3C/svg%3E'" />
                                <h3 class="text-xl font-semibold text-gray-800 mb-2 text-center px-4" title="${item.app}">${this.truncateAppName(item.app, 25)}</h3>
                                <p class="text-sm text-gray-500 mb-4">${new Date(item.startTime).toLocaleTimeString('zh-CN')}</p>
                                <div class="flex items-center gap-2">
                                    <span class="bg-blue-100 text-blue-700 px-3 py-1 rounded-full text-sm font-medium">
                                        ${item.count} 张截图
                                    </span>
                                </div>
                            </div>

                            <!-- 悬停详情提示 -->
                            <div class="absolute inset-0 bg-black/80 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center p-8">
                                <div class="text-white text-center">
                                    <p class="text-lg font-semibold mb-2">点击查看所有截图</p>
                                    <p class="text-sm opacity-80">${item.description || '查看此事件组的详细内容'}</p>
                                    <p class="text-xs opacity-60 mt-3">
                                        ${new Date(item.startTime).toLocaleString('zh-CN')} - ${new Date(item.endTime).toLocaleString('zh-CN')}
                                    </p>
                                </div>
                            </div>
                        </div>
                    `
                            : `
                        <!-- Capture组显示（包含时间、显示器信息和截图网格） -->
                        <div class="flex flex-col gap-3 max-w-5xl" data-item-id="${item.id}">
                            <!-- 上方：时间信息 -->
                            <div class="bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg px-4 py-2 shadow-md border border-blue-100">
                                <div class="flex items-center justify-center gap-2">
                                    <svg class="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
                                    </svg>
                                    <div class="text-base font-semibold text-blue-600">
                                        ${new Date(item.timestamp).toLocaleString('zh-CN', {
                                            year: 'numeric',
                                            month: 'long',
                                            day: 'numeric',
                                            hour: '2-digit',
                                            minute: '2-digit',
                                            second: '2-digit'
                                        })}
                                    </div>
                                </div>
                            </div>

                            <!-- 中间：截图网格 -->
                            <div class="grid gap-3" style="grid-template-columns: repeat(${item.snapshots ? Math.min(item.snapshots.length, 2) : 1}, 1fr);">
                                ${
                                    item.snapshots
                                        ? item.snapshots
                                              .map(
                                                  (snapshot, idx) => `
                                    <div class="flex flex-col gap-2">
                                        <!-- 显示器标签 -->
                                        <div class="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg shadow-sm border border-blue-200">
                                            <svg class="w-3.5 h-3.5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
                                            </svg>
                                            <span class="text-xs font-semibold text-blue-600">显示器 ${snapshot.sourceIndex + 1}</span>
                                        </div>
                                        <!-- 图片 -->
                                        <div class="cursor-pointer transition-all duration-300 hover:scale-[1.02] hover:shadow-2xl group"
                                             data-snapshot-id="${snapshot.id}"
                                             data-capture-id="${item.captureId}"
                                             onclick="document.querySelector('recall-browser-page').showImageDetailById('${snapshot.id}', '${item.captureId}')">
                                            <div class="relative overflow-hidden rounded-lg border-2 border-gray-200 group-hover:border-blue-400 transition-colors">
                                                <img src="${snapshot.imageDataURL || snapshot.thumbnailDataURL || ''}"
                                                     alt="${this.getSnapshotAppName(snapshot)}"
                                                     class="w-full h-auto object-contain bg-gray-50"
                                                     style="max-height: 320px; display: block;" />
                                                <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-3 py-2">
                                                    <div class="text-xs text-white font-medium truncate" title="${this.getSnapshotAppName(snapshot)}">
                                                        ${this.truncateAppName(this.getSnapshotAppName(snapshot), 25)}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                `
                                              )
                                              .join('')
                                        : ''
                                }
                            </div>

                            <!-- 下方：提示文字 -->
                            <div class="flex items-center justify-center gap-2 text-xs text-gray-500 py-2 bg-gray-50/50 rounded">
                                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122"/>
                                </svg>
                                <span class="font-medium">点击截图查看详情</span>
                            </div>

                            ${this.viewMode === 'activity' && this.currentActivity && this.currentIndex === 0 ? this.generateActivityPDFCard() : ''}
                        </div>
                    `
                    }
                </div>

                <!-- 导航箭头 -->
                ${
                    this.currentIndex > 0
                        ? `
                    <button onclick="event.stopPropagation(); document.querySelector('recall-browser-page').prevItem()"
                            class="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 bg-white/90 hover:bg-white rounded-full shadow-lg flex items-center justify-center transition-all hover:scale-110 z-20">
                        <svg class="w-6 h-6 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
                        </svg>
                    </button>
                `
                        : ''
                }
                ${
                    this.currentIndex < this.currentData.length - 1
                        ? `
                    <button onclick="event.stopPropagation(); document.querySelector('recall-browser-page').nextItem()"
                            class="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 bg-white/90 hover:bg-white rounded-full shadow-lg flex items-center justify-center transition-all hover:scale-110 z-20">
                        <svg class="w-6 h-6 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                        </svg>
                    </button>
                `
                        : ''
                }

                <!-- 固定位置的标记按钮（左下角） -->
                <button onclick="event.stopPropagation(); document.querySelector('recall-browser-page').toggleBookmark('${item.id}')"
                        class="absolute left-6 bottom-6 w-12 h-12 rounded-full ${isBookmarked ? 'bg-yellow-400 ring-2 ring-yellow-500' : 'bg-white/90'} hover:bg-yellow-400 shadow-lg flex items-center justify-center transition-all hover:scale-110 z-20"
                        title="${isBookmarked ? '取消标记' : '添加标记'}">
                    <svg class="w-6 h-6 ${isBookmarked ? 'text-white' : 'text-gray-600'}" fill="${isBookmarked ? 'currentColor' : 'none'}" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2zm9-13.5V9"/>
                    </svg>
                </button>
            </div>
        `;

        this.updateTimeline();

        // 预加载相邻图片
        this.preloadAdjacentImages();

        // 注意：图片点击事件已经在HTML模板中通过onclick属性绑定
        // 不需要在这里重复绑定，否则会导致传递错误的数据（capture对象而不是snapshot对象）

        // 添加滑入动画
        const mainContainer = container.querySelector('#main-item-container');
        if (mainContainer) {
            mainContainer.style.opacity = '0';
            mainContainer.style.transform = 'scale(0.9)';
            setTimeout(() => {
                mainContainer.style.opacity = '1';
                mainContainer.style.transform = 'scale(1)';
            }, 50);
        }
    }

    async toggleBookmark(itemId) {
        // itemId可能是captureId（当前项）或snapshotId（单个快照）
        const currentItem = this.currentData[this.currentIndex];

        if (currentItem && currentItem.snapshots) {
            // 如果是capture组，标记所有snapshots
            const shouldMark = !currentItem.isMarked;

            for (const snapshot of currentItem.snapshots) {
                if (shouldMark) {
                    this.bookmarks.add(snapshot.id);
                } else {
                    this.bookmarks.delete(snapshot.id);
                }
                await window.applicationAPI.call('updateSnapshotMark', snapshot.id, shouldMark);
                snapshot.isMarked = shouldMark;
            }

            currentItem.isMarked = shouldMark;
        } else {
            // 单个快照的标记逻辑（兼容旧代码）
            if (this.bookmarks.has(itemId)) {
                this.bookmarks.delete(itemId);
                await window.applicationAPI.call('updateSnapshotMark', itemId, false);
            } else {
                this.bookmarks.add(itemId);
                await window.applicationAPI.call('updateSnapshotMark', itemId, true);
            }

            const item = this.currentData.find((d) => d.id === itemId);
            if (item) {
                item.isMarked = this.bookmarks.has(itemId);
            }
        }

        this.updateMainView();
    }

    // PDF 相关方法
    async generateActivityPDF(activityId) {
        try {
            // Check current status first
            const result = await window.applicationAPI.call('getHistoryActivityById', activityId);

            const currentStatus = result.activity?.pdfStatus;

            if (currentStatus === 'processing' || currentStatus === 'pending') {
                this.showNotification('PDF正在生成中，请稍候...', 'info');
                return;
            }

            const genResult = await window.applicationAPI.call('generateActivityPDF', activityId);

            if (genResult && genResult.success) {
                this.showNotification('PDF 生成已启动', 'success');

                // Update local state immediately
                if (this.currentActivity && this.currentActivity.activityId === activityId) {
                    if (!this.currentActivity.metadata) {
                        this.currentActivity.metadata = {};
                    }
                    this.currentActivity.pdfStatus = 'processing';
                    this.refreshPDFCard();
                }

                // 启动轮询检测状态变化
                this.pollActivityStatus(activityId);
            } else {
                this.showNotification('PDF 生成失败: ' + (genResult?.message || '未知错误'), 'error');
            }
        } catch (error) {
            console.error('[BrowserPage] 生成PDF失败:', error);
            this.showNotification('PDF 生成失败: ' + error.message, 'error');
        }
    }

    /**
     * Handle PDF status updates from backend
     */
    handlePDFStatusUpdate(payload) {
        const { activityId, status, pdfPath, keyframeCount, error } = payload;

        // CRITICAL: Update this.allActivities first to maintain data consistency
        const activity = this.allActivities.find((a) => a.activityId === activityId);
        if (activity) {
            if (!activity.metadata) activity.metadata = {};

            // Update fields
            activity.pdfStatus = status;
            if (pdfPath) activity.pdfPath = pdfPath;
            if (keyframeCount !== undefined) activity.keyframeCount = keyframeCount;
            if (error) {
                if (!activity.metadata.pdf) activity.metadata.pdf = {};
                activity.metadata.pdf.error = error;
            }
        } else {
            console.warn('[BrowserPage] ⚠️ Activity not found in allActivities:', activityId?.substring(0, 8));
        }

        // Update activity list component
        const activityListComponent = this.querySelector('recall-activity-list');
        if (activityListComponent) {
            activityListComponent.handlePDFStatusUpdate(payload);
        }

        // If currently viewing this activity, refresh detail view
        if (this.currentActivityId === activityId && this.currentActivity) {
            // Update current activity metadata
            if (this.currentActivity.activityId === activityId) {
                if (!this.currentActivity.metadata) {
                    this.currentActivity.metadata = {};
                }
                if (!this.currentActivity.metadata.pdf) {
                    this.currentActivity.metadata.pdf = {};
                }

                // Update all relevant fields from payload
                Object.assign(this.currentActivity.metadata.pdf, {
                    status: status,
                    ...(pdfPath && { pdfPath }),
                    ...(keyframeCount !== undefined && { keyframeCount }),
                    ...(error && { error })
                });

                // Refresh the PDF card only
                this.refreshPDFCard();
            }
        }
    }

    /**
     * Refresh only the PDF card component
     */
    refreshPDFCard() {
        const pdfCardContainer = this.querySelector('#pdf-card-container');
        if (pdfCardContainer && this.currentActivity) {
            pdfCardContainer.innerHTML = this.generateActivityPDFCard();
        }
    }

    async previewActivityPDF(activityId) {
        try {
            const result = await window.applicationAPI.call('getActivityPDFPath', activityId);
            console.info('[BrowserPage] PDF path result:', result);
            if (result && result.success && result.pdfPath) {
                // 打开文件管理器到PDF位置
                const previewResult = await window.applicationAPI.callMainWorld('previewActivityPDF', result.pdfPath);
                if (previewResult && previewResult.success) {
                    // PDF 预览成功，通常会在系统中打开
                    this.showNotification('正在打开 PDF 预览...', 'info');
                } else {
                    this.showNotification('PDF 预览失败: ' + (previewResult?.message || '未知错误'), 'error');
                }
            }
        } catch (error) {
            console.error('[BrowserPage] 预览PDF失败:', error);
            this.showNotification('PDF 预览失败: ' + error.message, 'error');
        }
    }

    async downloadActivityPDF(activityId) {
        try {
            const result = await window.applicationAPI.call('getActivityPDFPath', activityId);

            if (result && result.success && result.pdfPath) {
                // 打开文件管理器到PDF位置
                const showResult = await window.applicationAPI.callMainWorld('showFileInFolder', result.pdfPath);

                if (showResult && showResult.success) {
                    this.showNotification('PDF 已保存，正在打开文件位置...', 'success');
                } else {
                    this.showNotification(
                        'PDF 已保存，但无法打开文件位置: ' + (showResult.message || '未知错误'),
                        'warning'
                    );
                }
            } else {
                this.showNotification('PDF 下载失败: ' + (result?.message || '未知错误'), 'error');
            }
        } catch (error) {
            console.error('[BrowserPage] 下载PDF失败:', error);
            this.showNotification('PDF 下载失败: ' + error.message, 'error');
        }
    }

    showNotification(message, type = 'info') {
        // 简单的通知显示，可以后续扩展为更精美的UI

        // 创建临时通知元素
        const notification = document.createElement('div');
        notification.className = `fixed top-4 right-4 px-4 py-2 rounded-lg shadow-lg z-50 transition-all duration-300 ${
            type === 'success'
                ? 'bg-green-500 text-white'
                : type === 'error'
                  ? 'bg-red-500 text-white'
                  : type === 'warning'
                    ? 'bg-yellow-500 text-black'
                    : 'bg-blue-500 text-white'
        }`;
        notification.textContent = message;

        // 添加到页面
        document.body.appendChild(notification);

        // 3秒后移除
        setTimeout(() => {
            notification.style.opacity = '0';
            notification.style.transform = 'translateY(-20px)';
            setTimeout(() => {
                document.body.removeChild(notification);
            }, 300);
        }, 3000);
    }

    updateTimeline() {
        const timeline = this.querySelector('#timeline-container');
        if (!timeline || this.currentData.length === 0) return;

        const currentItem = this.currentData[this.currentIndex];
        const timeValue = currentItem.startTime || currentItem.timestamp;

        // 计算时间范围和热力值
        const timestamps = this.currentData.map((item) => item.startTime || item.timestamp);
        const minTime = Math.min(...timestamps);
        const maxTime = Math.max(...timestamps);
        const timeRange = maxTime - minTime || 1;
        const currentPosition = ((timeValue - minTime) / timeRange) * 100;

        // 计算热力图数据（将时间轴分成40个区间，更平滑）
        const heatmapSegments = 40;
        const segmentDuration = timeRange / heatmapSegments;
        const heatmap = new Array(heatmapSegments).fill(0);

        // 统计每个区间的截图数量，并添加平滑过渡
        timestamps.forEach((ts) => {
            const segmentIndex = Math.min(Math.floor((ts - minTime) / segmentDuration), heatmapSegments - 1);
            heatmap[segmentIndex]++;
            // 为相邻区间添加一些热度（平滑效果）
            if (segmentIndex > 0) heatmap[segmentIndex - 1] += 0.3;
            if (segmentIndex < heatmapSegments - 1) heatmap[segmentIndex + 1] += 0.3;
        });

        const maxHeat = Math.max(...heatmap, 1);

        // 格式化起始时间
        const startTimeStr = new Date(minTime).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit'
        });
        const endTimeStr = new Date(maxTime).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit'
        });
        const currentTimeStr = new Date(timeValue).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        timeline.innerHTML = `
            <div class="w-full h-full flex items-center gap-4">
                <!-- 起始时间 -->
                <div class="text-xs text-gray-500 whitespace-nowrap w-12 text-left">
                    ${startTimeStr}
                </div>

                <!-- 时间轴 -->
                <div class="flex-1 h-10 relative cursor-grab active:cursor-grabbing flex items-center" id="timeline-track" style="pointer-events: auto;">
                    <!-- 可点击的透明区域覆盖层 -->
                    <div class="absolute inset-0 z-10" style="pointer-events: auto;"></div>

                    <!-- 热力图背景（带渐变过渡） -->
                    <div class="absolute left-0 right-0 h-5 top-1/2 -translate-y-1/2 flex rounded-full overflow-hidden shadow-inner bg-gray-100" style="pointer-events: none;">
                        ${heatmap
                            .map((heat, i) => {
                                const intensity = Math.min(heat / maxHeat, 1);
                                // 使用渐变色，从蓝色到橙色到红色
                                const r = Math.round(59 + intensity * 180); // 59 -> 239
                                const g = Math.round(130 - intensity * 62); // 130 -> 68
                                const b = Math.round(246 - intensity * 178); // 246 -> 68
                                const alpha = 0.3 + intensity * 0.7; // 0.3 -> 1.0
                                return `<div style="flex: 1; background: rgba(${r}, ${g}, ${b}, ${alpha}); transition: all 0.3s ease; pointer-events: none;"></div>`;
                            })
                            .join('')}
                    </div>

                    <!-- 标记旗帜（在时间轴上） -->
                    ${this.currentData
                        .map((dataItem, idx) => {
                            // 检查当前项是否被标记（capture组或单个snapshot）
                            const isItemMarked =
                                dataItem.isMarked ||
                                (dataItem.snapshots && dataItem.snapshots.some((s) => this.bookmarks.has(s.id))) ||
                                this.bookmarks.has(dataItem.id);
                            if (!isItemMarked) return '';
                            const itemTime = dataItem.startTime || dataItem.timestamp;
                            const itemPosition = ((itemTime - minTime) / timeRange) * 100;
                            return `
                            <div class="absolute top-1/2 -translate-y-1/2 transition-all duration-300 z-15"
                                 style="left: ${itemPosition}%; pointer-events: none;">
                                <div class="absolute -top-6 left-1/2 -translate-x-1/2">
                                    <svg class="w-4 h-4 text-yellow-500 drop-shadow-lg" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/>
                                    </svg>
                                </div>
                            </div>
                        `;
                        })
                        .join('')}

                    <!-- 当前位置指示器 -->
                    <div class="absolute top-1/2 -translate-y-1/2 transition-all duration-300 z-20"
                         style="left: ${currentPosition}%; pointer-events: none;"
                         id="timeline-indicator">
                        <!-- 指示线 -->
                        <div class="w-0.5 h-10 bg-blue-600 -translate-x-1/2" style="pointer-events: none;"></div>
                        <!-- 指示点 -->
                        <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 bg-white border-2 border-blue-600 rounded-full shadow-lg" style="pointer-events: none;"></div>
                    </div>
                </div>

                <!-- 结束时间 -->
                <div class="text-xs text-gray-500 whitespace-nowrap w-12 text-right">
                    ${endTimeStr}
                </div>

                <!-- 当前索引（可输入跳转） -->
                <div class="flex items-center gap-2 text-sm text-gray-700 whitespace-nowrap font-medium">
                    <input type="number"
                           min="1"
                           max="${this.currentData.length}"
                           value="${this.currentIndex + 1}"
                           class="w-16 px-2 py-1 text-center border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-blue-600 font-semibold"
                           onchange="document.querySelector('recall-browser-page').jumpToIndex(parseInt(this.value) - 1)"
                           onclick="this.select()" />
                    <span class="text-gray-400">/</span>
                    <span class="text-gray-600">${this.currentData.length}</span>
                </div>
            </div>
        `;

        // 等待 DOM 渲染完成后设置拖动功能
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this.setupTimelineDrag();
            });
        });
    }

    jumpToIndex(index) {
        if (index >= 0 && index < this.currentData.length) {
            this.currentIndex = index;
            this.updateMainView();
            if (this.showDetail) {
                const item = this.currentData[this.currentIndex];
                this.selectedItem = item.snapshots && item.snapshots.length > 0 ? item.snapshots[0] : item;
                this.updateDetailPanel();
            }
        }
    }

    setupTimelineDrag() {
        const track = this.querySelector('#timeline-track');
        if (!track) {
            return;
        }
        if (this.currentData.length === 0) {
            return;
        }

        // 清理旧的监听器
        if (this._timelineDragListeners) {
            const old = this._timelineDragListeners;
            track.removeEventListener('mousedown', old.onMouseDown);
            track.removeEventListener('click', old.onClick);
            document.removeEventListener('mousemove', old.onMouseMove);
            document.removeEventListener('mouseup', old.onMouseUp);
        }

        let isDragging = false;
        let pendingIndex = null;

        const handleDrag = (clientX, isPreview = true) => {
            const rect = track.getBoundingClientRect();
            const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
            const percent = x / rect.width;

            // 按时间查找最近的项
            const timestamps = this.currentData.map((item) => item.startTime || item.timestamp);
            const minTime = Math.min(...timestamps);
            const maxTime = Math.max(...timestamps);
            const targetTime = minTime + (maxTime - minTime) * percent;

            // 找到最接近的项
            let closestIndex = 0;
            let minDiff = Math.abs(timestamps[0] - targetTime);
            for (let i = 1; i < timestamps.length; i++) {
                const diff = Math.abs(timestamps[i] - targetTime);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestIndex = i;
                }
            }

            if (closestIndex !== this.currentIndex) {
                pendingIndex = closestIndex;

                if (isPreview) {
                    // 拖动预览：只更新指示器位置和详情面板
                    const indicator = this.querySelector('#timeline-indicator');
                    if (indicator) {
                        const newPercent = ((timestamps[closestIndex] - minTime) / (maxTime - minTime)) * 100;
                        indicator.style.left = newPercent + '%';
                    }

                    // 如果详情面板是打开的，更新详情内容
                    if (this.showDetail) {
                        const item = this.currentData[closestIndex];
                        this.selectedItem = item.snapshots && item.snapshots.length > 0 ? item.snapshots[0] : item;
                        this.updateDetailPanel();
                    }
                } else {
                    // 最终确认：更新索引和主视图
                    this.currentIndex = closestIndex;
                    this.updateMainView();
                    if (this.showDetail) {
                        const item = this.currentData[this.currentIndex];
                        this.selectedItem = item.snapshots && item.snapshots.length > 0 ? item.snapshots[0] : item;
                        this.updateDetailPanel();
                    }
                }
            }
        };

        const onMouseDown = (e) => {
            isDragging = true;
            pendingIndex = null;
            track.style.cursor = 'grabbing';
            handleDrag(e.clientX, true); // 预览模式
            e.preventDefault();
        };

        const onMouseMove = (e) => {
            if (isDragging) {
                handleDrag(e.clientX, true); // 预览模式
            }
        };

        const onMouseUp = (e) => {
            if (isDragging) {
                isDragging = false;
                track.style.cursor = 'grab';
                // 松开鼠标时才更新主视图
                if (pendingIndex !== null && pendingIndex !== this.currentIndex) {
                    this.currentIndex = pendingIndex;
                    this.updateMainView();
                    if (this.showDetail) {
                        this.selectedItem = this.currentData[this.currentIndex];
                        this.updateDetailPanel();
                    }
                }
                pendingIndex = null;
            }
        };

        // 点击时间轴直接跳转
        const onClick = (e) => {
            if (!isDragging) {
                handleDrag(e.clientX, false); // 立即更新模式
            }
        };

        track.addEventListener('mousedown', onMouseDown);
        track.addEventListener('click', onClick);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        // 保存监听器引用以便清理
        this._timelineDragListeners = { onMouseDown, onClick, onMouseMove, onMouseUp };
    }

    updateTimelineIndicatorOnly() {
        // 只更新时间轴指示器位置，不重新渲染整个时间轴
        const indicator = this.querySelector('#timeline-indicator');
        const timeDisplay = this.querySelector('#timeline-container .text-sm');
        if (!indicator || this.currentData.length === 0) return;

        const currentItem = this.currentData[this.currentIndex];
        const timeValue = currentItem.startTime || currentItem.timestamp;
        const timestamps = this.currentData.map((item) => item.startTime || item.timestamp);
        const minTime = Math.min(...timestamps);
        const maxTime = Math.max(...timestamps);
        const timeRange = maxTime - minTime || 1;
        const currentPosition = ((timeValue - minTime) / timeRange) * 100;

        indicator.style.left = `${currentPosition}%`;

        if (timeDisplay) {
            timeDisplay.textContent = timeValue
                ? new Date(timeValue).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit'
                  })
                : '--:--';
        }

        // 更新标记旗帜
        const flagContainer = indicator.querySelector('div:first-child');
        if (flagContainer) {
            const isBookmarked = this.bookmarks.has(currentItem.id);
            if (isBookmarked && !flagContainer.querySelector('svg')) {
                flagContainer.innerHTML = `
                    <svg class="w-5 h-5 text-yellow-500 drop-shadow-lg animate-pulse" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/>
                    </svg>
                `;
            } else if (!isBookmarked) {
                flagContainer.innerHTML = '';
            }
        }
    }

    handleTimelineClick(event) {
        const timeline = event.currentTarget;
        const rect = timeline.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const percent = x / rect.width;

        // 如果有时间戳，按时间查找最近的项
        if (this.currentData.length > 0 && (this.currentData[0].startTime || this.currentData[0].timestamp)) {
            const timestamps = this.currentData.map((item) => item.startTime || item.timestamp);
            const minTime = Math.min(...timestamps);
            const maxTime = Math.max(...timestamps);
            const clickedTime = minTime + (maxTime - minTime) * percent;

            // 找到最接近的项
            let closestIndex = 0;
            let minDiff = Math.abs(timestamps[0] - clickedTime);
            for (let i = 1; i < timestamps.length; i++) {
                const diff = Math.abs(timestamps[i] - clickedTime);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestIndex = i;
                }
            }
            this.jumpToIndex(closestIndex);
        } else {
            // 按索引查找
            const index = Math.floor(percent * this.currentData.length);
            this.jumpToIndex(Math.max(0, Math.min(index, this.currentData.length - 1)));
        }
    }

    jumpToIndex(index) {
        this.currentIndex = index;
        this.updateMainView();
    }

    /**
     * 根据 snapshot 的 sourceType 智能获取应用名
     * @param {Object} snapshot - snapshot 对象
     * @returns {string} 应用名称
     */
    getSnapshotAppName(snapshot) {
        if (!snapshot) return '未知应用';

        // 直接使用 sourceName，这是最简单和清晰的方式
        const displayName = snapshot.sourceName || '未知来源';
        return displayName;
    }

    /**
     * 截断过长的应用名称
     * @param {string} name - 应用名称
     * @param {number} maxLength - 最大长度，默认30
     * @returns {string} 截断后的名称
     */
    truncateAppName(name, maxLength = 30) {
        if (!name) return '未知应用';
        if (name.length <= maxLength) return name;
        return name.substring(0, maxLength) + '...';
    }

    updateDetailPanel() {
        const panel = this.querySelector('#detail-panel');
        const rightResizer = this.querySelector('#right-resizer');

        if (!panel) {
            console.error('[BrowserPage] 找不到 detail-panel 元素!');
            return;
        }

        if (!this.showDetail || !this.selectedItem) {
            panel.classList.add('hidden');
            panel.style.width = '0px';
            if (rightResizer) {
                rightResizer.classList.add('hidden');
            }
            return;
        }

        // 如果selectedItem是capture组（包含snapshots数组），使用第一个snapshot的图片
        let imageSrc;
        if (this.selectedItem.snapshots && this.selectedItem.snapshots.length > 0) {
            // capture组，使用第一个snapshot的图片
            imageSrc =
                this.selectedItem.snapshots[0].imageDataURL || this.selectedItem.snapshots[0].thumbnailDataURL || '';
        } else {
            // 单个snapshot
            imageSrc = this.selectedItem.imageDataURL || this.selectedItem.thumbnailDataURL || '';
        }

        // 使用智能方法获取应用名
        const appName = this.getSnapshotAppName(this.selectedItem);

        // 显示面板
        panel.classList.remove('hidden');
        panel.style.width = `${this.rightPanelWidth}px`;
        if (rightResizer) {
            rightResizer.classList.remove('hidden');
        }

        panel.innerHTML = `
            <div class="p-6 h-full overflow-y-auto">
                <div class="flex items-center justify-between mb-6">
                    <h3 class="text-lg font-semibold text-gray-800">详细信息</h3>
                    <button onclick="document.querySelector('recall-browser-page').hideDetail()"
                            class="w-8 h-8 rounded-lg hover:bg-gray-100 flex items-center justify-center transition-colors">
                        <svg class="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                        </svg>
                    </button>
                </div>

                <div class="space-y-4">
                    <!-- 图片预览 -->
                    <div class="mb-4">
                        <img src="${imageSrc}"
                             alt="${appName}"
                             class="w-full rounded-lg border border-gray-200"
                             onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27100%27 height=%27100%27%3E%3Crect fill=%27%23ddd%27 width=%27100%27 height=%27100%27/%3E%3Ctext x=%2750%25%27 y=%2750%25%27 dominant-baseline=%27middle%27 text-anchor=%27middle%27 font-family=%27sans-serif%27 font-size=%2714%27 fill=%27%23999%27%3E图片加载失败%3C/text%3E%3C/svg%3E'" />
                    </div>

                    <div>
                        <div class="text-sm text-gray-500 mb-1">应用</div>
                        <div class="text-base font-medium text-gray-800" title="${appName}">
                            ${this.truncateAppName(appName)}
                        </div>
                    </div>

                    <div>
                        <div class="text-sm text-gray-500 mb-1">时间</div>
                        <div class="text-base text-gray-800">
                            ${new Date(this.selectedItem.startTime || this.selectedItem.timestamp).toLocaleString('zh-CN')}
                        </div>
                    </div>

                    ${
                        this.selectedItem.title
                            ? `
                        <div>
                            <div class="text-sm text-gray-500 mb-1">标题</div>
                            <div class="text-base text-gray-800">${this.selectedItem.title}</div>
                        </div>
                    `
                            : ''
                    }

                    ${
                        this.selectedItem.content
                            ? `
                        <div>
                            <div class="text-sm text-gray-500 mb-1">内容</div>
                            <div class="text-sm text-gray-600">${this.selectedItem.content}</div>
                        </div>
                    `
                            : ''
                    }

                    ${
                        this.selectedItem.count
                            ? `
                        <div>
                            <div class="text-sm text-gray-500 mb-1">截图数量</div>
                            <div class="text-base text-gray-800">${this.selectedItem.count} 张</div>
                        </div>
                    `
                            : ''
                    }

                    ${this.renderMemorySection(this.selectedItem)}

                    <div>
                        <div class="text-sm text-gray-500 mb-2">备注</div>
                        <textarea class="w-full h-24 px-3 py-2 border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                                  placeholder="添加备注..."></textarea>
                    </div>
                </div>
            </div>
        `;
    }

    setupResizers() {
        // 左侧分隔条
        const leftResizer = this.querySelector('#left-resizer');
        if (leftResizer) {
            let isResizing = false;
            let startX = 0;
            let startWidth = 0;
            // 发起拖动的指针：多指同按（触摸屏掌压、第二根手指）时只跟随它
            let pointerId = null;

            // 统一使用指针事件：触摸屏拖动不会派发 mousemove，只监听鼠标事件时
            // 分割线在触摸/触控笔场景下完全无法拖动
            leftResizer.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || isResizing) return;
                isResizing = true;
                pointerId = e.pointerId;
                startX = e.clientX;
                startWidth = this.leftPanelWidth;
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                e.preventDefault();
            });

            window.addEventListener('pointermove', (e) => {
                if (!isResizing || e.pointerId !== pointerId) return;
                const delta = e.clientX - startX;
                const newWidth = Math.max(200, Math.min(600, startWidth + delta));
                this.leftPanelWidth = newWidth;
                const leftPanel = this.querySelector('#left-panel');
                if (leftPanel) {
                    leftPanel.style.width = `${newWidth}px`;
                }
            });

            const endLeftResize = (e) => {
                if (!isResizing || e.pointerId !== pointerId) return;
                isResizing = false;
                pointerId = null;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            };
            window.addEventListener('pointerup', endLeftResize);
            window.addEventListener('pointercancel', endLeftResize);
        }

        // 右侧分隔条
        const rightResizer = this.querySelector('#right-resizer');
        if (rightResizer) {
            let isResizing = false;
            let startX = 0;
            let startWidth = 0;
            // 发起拖动的指针：多指同按（触摸屏掌压、第二根手指）时只跟随它
            let pointerId = null;

            rightResizer.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || isResizing) return;
                if (this.showDetail) {
                    isResizing = true;
                    pointerId = e.pointerId;
                    startX = e.clientX;
                    startWidth = this.rightPanelWidth;
                    document.body.style.cursor = 'col-resize';
                    document.body.style.userSelect = 'none';
                    e.preventDefault();
                }
            });

            window.addEventListener('pointermove', (e) => {
                if (!isResizing || e.pointerId !== pointerId) return;
                const delta = startX - e.clientX; // 反向，因为从右边拖动
                const newWidth = Math.max(200, Math.min(600, startWidth + delta));
                this.rightPanelWidth = newWidth;
                const rightPanel = this.querySelector('#detail-panel');
                if (rightPanel && this.showDetail) {
                    rightPanel.style.width = `${newWidth}px`;
                }
            });

            const endRightResize = (e) => {
                if (!isResizing || e.pointerId !== pointerId) return;
                isResizing = false;
                pointerId = null;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            };
            window.addEventListener('pointerup', endRightResize);
            window.addEventListener('pointercancel', endRightResize);
        }
    }

    setupEventListeners() {
        // 键盘导航
        const keyHandler = (e) => {
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                this.prevItem();
            }
            if (e.key === 'ArrowRight') {
                e.preventDefault();
                this.nextItem();
            }
            if (e.key === 'Escape') {
                this.hideDetail();
            }
        };
        document.addEventListener('keydown', keyHandler);

        // 搜索框事件
        const searchInput = this.querySelector('#search-input');
        if (searchInput) {
            let searchTimeout = null;
            searchInput.addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => {
                    this.handleSearch(e.target.value);
                }, 1000); // 防抖：1000ms后执行搜索
            });
        }

        // 日期选择器事件
        const dateInput = this.querySelector('#date-picker');
        if (dateInput) {
            dateInput.addEventListener('change', async (e) => {
                this.selectedDate = e.target.value;
                this.currentIndex = 0; // 重置索引到第一项

                // 记住详情面板是否打开
                const wasDetailOpen = this.showDetail;

                await this.loadDailyView();

                // 如果之前详情面板是打开的，更新为当前显示的项
                if (wasDetailOpen && this.currentData.length > 0) {
                    this.selectedItem = this.currentData[0];
                    this.updateDetailPanel();
                }
            });
        }

        // 组件销毁时移除监听器
        this._keyHandler = keyHandler;
    }

    /**
     * 预加载相邻的图片
     */
    preloadAdjacentImages() {
        const preloadCount = 3; // 预加载前后3张
        const start = Math.max(0, this.currentIndex - preloadCount);
        const end = Math.min(this.currentData.length - 1, this.currentIndex + preloadCount);

        for (let i = start; i <= end; i++) {
            if (i === this.currentIndex) continue; // 跳过当前图片
            const item = this.currentData[i];

            // 处理capture组（包含多个snapshots）
            if (item && item.snapshots) {
                item.snapshots.forEach((snapshot) => {
                    if (snapshot.imagePath && !this.imageCache.has(snapshot.imagePath)) {
                        const img = new Image();
                        img.src = snapshot.imagePath;
                        img.onload = () => {
                            this.imageCache.set(snapshot.imagePath, true);
                        };
                    }
                });
            }
            // 处理单个图片（兼容旧数据）
            else if (item && item.imagePath && !this.imageCache.has(item.imagePath)) {
                const img = new Image();
                img.src = item.imagePath;
                img.onload = () => {
                    this.imageCache.set(item.imagePath, true);
                };
            }
        }
    }

    /**
     * 调整窗口大小
     * @param {boolean} expandDetail - 是否展开详情面板
     */
    adjustWindowSize(expandDetail) {
        try {
            // 尝试多个可能的 electronAPI 位置
            let electronAPI = null;

            // 1. 检查当前 window
            if (window.electronAPI) {
                electronAPI = window.electronAPI;
            }
            // 2. 检查父窗口（iframe 情况）
            else if (window.parent && window.parent.electronAPI) {
                electronAPI = window.parent.electronAPI;
            }
            // 3. 检查顶层窗口
            else if (window.top && window.top.electronAPI) {
                electronAPI = window.top.electronAPI;
            }

            if (!electronAPI) {
                console.warn('[BrowserPage] 未找到 electronAPI，窗口大小将不会调整');
                // 不阻断执行，让详情面板仍然可以显示
                return;
            }

            if (!electronAPI.resizeWindow) {
                console.error('[BrowserPage] electronAPI.resizeWindow 方法不存在!');
                console.error('[BrowserPage] electronAPI 的所有方法:', Object.keys(electronAPI));
                return;
            }

            if (expandDetail) {
                // 展开详情面板，增加宽度以容纳详情面板（原宽度 + 详情面板宽度）
                const newWidth = 1200 + this.rightPanelWidth;
                electronAPI.resizeWindow(newWidth, 800);
            } else {
                // 关闭详情面板，恢复默认大小
                electronAPI.resizeWindow(1200, 800);
            }
        } catch (error) {
            console.error('[BrowserPage] 调整窗口大小失败:', error);
        }
    }

    async handleSearch(query) {
        if (!query || query.trim() === '') {
            // 清空搜索，返回日视图
            this.loadDailyView();
            return;
        }
        try {
            const result = await window.applicationAPI.call('searchSnapshots', query);

            if (result && result.success && result.snapshots) {
                const allSnapshots = result.snapshots.map((s) =>
                    transformSnapshot(s, this.getSnapshotAppName.bind(this))
                );
                // 按captureId分组并转换为capture格式
                this.currentData = groupSnapshotsByCapture(allSnapshots);
            } else {
                this.currentData = [];
            }
        } catch (error) {
            console.error('[BrowserPage] 搜索失败:', error);
            this.currentData = [];
        }

        this.viewMode = 'search';
        this.currentIndex = 0;
        this.updateMainView();
        this.updateBackButton();
        this.updateViewTypeButtons();
    }

    disconnectedCallback() {
        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler);
        }
        if (this._timelineDragListeners) {
            document.removeEventListener('mousemove', this._timelineDragListeners.onMouseMove);
            document.removeEventListener('mouseup', this._timelineDragListeners.onMouseUp);
        }
        // 清理PDF状态轮询
        this.stopPDFStatusPolling();
    }

    changeViewType(type) {
        // 只有在日视图下才能切换展示类型
        if (this.viewMode !== 'daily') {
            return;
        }

        // 暂时只支持图片视图
        if (type === 'groups') {
            console.warn('[BrowserPage] 事件组视图尚未实现');
            // 显示提示消息
            const container = this.querySelector('#main-content');
            if (container) {
                container.innerHTML = `
                    <div class="flex flex-col items-center justify-center h-full text-gray-500 gap-4">
                        <svg class="w-20 h-20 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/>
                        </svg>
                        <div class="text-xl font-semibold">事件组功能暂未开发</div>
                        <div class="text-sm text-gray-400">该功能需要后端实现事件组聚类算法，敬请期待</div>
                        <button onclick="document.querySelector('recall-browser-page').changeViewType('images')"
                                class="mt-4 px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors">
                            切换到图片视图
                        </button>
                    </div>
                `;
            }
            return;
        }

        // 切换到图片视图时始终刷新数据
        if (type === 'images') {
            this.dailyViewType = 'images';
            this.updateViewTypeButtons();
            this.loadDailyView();
            return;
        } else {
            this.dailyViewType = type;
            this.updateViewTypeButtons();
        }
    }

    updateViewTypeButtons() {
        const groupsBtn = this.querySelector('#view-groups-btn');
        const imagesBtn = this.querySelector('#view-images-btn');
        const viewTypeBtnsContainer = this.querySelector('#view-type-buttons');

        // 只有在日视图下才显示切换按钮
        if (viewTypeBtnsContainer) {
            if (this.viewMode === 'daily') {
                viewTypeBtnsContainer.style.display = 'flex';
            } else {
                viewTypeBtnsContainer.style.display = 'none';
            }
        }

        if (groupsBtn && imagesBtn) {
            if (this.dailyViewType === 'groups') {
                groupsBtn.className = 'px-3 py-2 text-sm bg-blue-500 text-white transition-colors';
                imagesBtn.className = 'px-3 py-2 text-sm bg-white text-gray-700 hover:bg-gray-100 transition-colors';
            } else {
                groupsBtn.className = 'px-3 py-2 text-sm bg-white text-gray-700 hover:bg-gray-100 transition-colors';
                imagesBtn.className = 'px-3 py-2 text-sm bg-blue-500 text-white transition-colors';
            }
        }
    }

    /**
     * 渲染记忆区域（数据已在 getSnapshotExtraction 中加载）
     */
    renderMemorySection(item) {
        console.info('[BrowserPage] 渲染记忆区域，item:', item);
        if (!item || !item.id) {
            return '';
        }

        // 根据 hasExtraction 判断状态
        if (item.memory) {
            console.info('[BrowserPage] 记忆存在', item.memory);
            // 有记忆，直接展示
            return `
                <div class="mb-4">
                    <div class="text-sm text-gray-500 mb-2 flex items-center">
                        <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
                        </svg>
                        记忆
                    </div>
                    <div class="text-sm text-gray-800 p-3 bg-gray-50 rounded-lg border border-gray-200">
                        ${item.memory}
                    </div>
                </div>
            `;
        } else if (item.hasExtraction === 0 || item.hasExtraction === false) {
            // 没有提取，显示处理中状态
            return `
                <div class="mb-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
                    <div class="text-sm text-blue-600 flex items-center">
                        <svg class="animate-spin h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                        </svg>
                        正在生成记忆...
                    </div>
                </div>
            `;
        } else {
            // 其他情况（如空白截图），不显示记忆区域
            return ``;
        }
    }
    // 生成活动 PDF 卡片
    generateActivityPDFCard() {
        if (!this.currentActivity) return '';

        const activity = this.currentActivity;
        // 使用顶层字段
        const status = activity.pdfStatus;
        const keyframeCount = activity.keyframeCount || 0;
        const pdfError = activity.metadata?.pdf?.error;

        return `
        <div id="pdf-card-container">
        <div class="mt-6 p-4 bg-white rounded-lg border border-gray-200 shadow-sm">
            <div class="flex items-center gap-3 mb-4">
                <div class="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                    <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                    </svg>
                </div>
                <div>
                    <h3 class="font-semibold text-gray-900">活动文档</h3>
                    <p class="text-sm text-gray-500">自动生成的活动 PDF 文档</p>
                </div>
            </div>

            <div class="space-y-3">
                ${
                    status === 'completed'
                        ? `
                    <!-- PDF 已生成状态 -->
                    <div class="flex items-center justify-between p-3 bg-green-50 border border-green-200 rounded-lg">
                        <div class="flex items-center gap-2">
                            <svg class="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                            </svg>
                            <span class="text-sm text-green-800 font-medium">PDF 文档已生成</span>
                        </div>
                        <div class="flex gap-2">
                            <button onclick="document.querySelector('recall-browser-page').downloadActivityPDF('${activity.activityId}')"
                                    class="px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 transition-colors">
                                下载
                            </button>
                            <button onclick="document.querySelector('recall-browser-page').previewActivityPDF('${activity.activityId}')"
                                    class="px-3 py-1 text-xs bg-white text-green-600 border border-green-600 rounded hover:bg-green-50 transition-colors">
                                预览
                            </button>
                        </div>
                    </div>
                `
                        : status === 'processing'
                          ? `
                    <!-- PDF 生成中状态 -->
                    <div class="bg-amber-50 border border-amber-200 rounded-lg p-4">
                        <div class="flex items-center gap-3">
                            <div class="flex-shrink-0">
                                <div class="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center">
                                    <svg class="w-5 h-5 text-amber-600 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                                    </svg>
                                </div>
                            </div>
                            <div class="flex-1 min-w-0">
                                <h4 class="text-sm font-medium text-amber-900">正在生成 PDF 文档...</h4>
                                <div class="mt-2">
                                    <div class="text-xs text-amber-600 font-mono flex items-center">
                                        <svg class="w-3 h-3 mr-1 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <circle cx="12" cy="12" r="10" stroke-width="3" stroke-dasharray="31.4 31.4" />
                                        </svg>
                                        处理中... 请勿关闭页面
                                    </div>
                                </div>
                            </div>
                        </div>
                        <!-- 禁用的预览按钮提示 -->
                        <div class="mt-3 pt-3 border-t border-amber-200">
                            <button disabled class="w-full px-4 py-2 bg-gray-200 text-gray-500 rounded-lg cursor-not-allowed text-sm flex items-center justify-center gap-2">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                                </svg>
                                生成完成后可预览
                            </button>
                        </div>
                    </div>
                `
                          : status === 'failed'
                            ? `
                    <!-- PDF 生成失败状态 -->
                    <div class="bg-red-50 border border-red-200 rounded-lg p-4">
                        <div class="flex items-center gap-3 mb-3">
                            <div class="flex-shrink-0">
                                <svg class="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                                </svg>
                            </div>
                            <div class="flex-1 min-w-0">
                                <h4 class="text-sm font-medium text-red-900">PDF 生成失败</h4>
                                <p class="text-xs text-red-700 mt-0.5">${pdfError || '未知错误'}</p>
                            </div>
                        </div>
                        <button onclick="document.querySelector('recall-browser-page').generateActivityPDF('${activity.activityId}')"
                                class="w-full px-3 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 transition-colors">
                            重新生成 PDF
                        </button>
                    </div>
                `
                            : status === 'completed'
                              ? `
                    <!-- 无关键帧状态 -->
                    <div class="bg-gray-50 border border-gray-200 rounded-lg p-4">
                        <div class="flex items-center gap-3">
                            <div class="flex-shrink-0">
                                <svg class="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                                </svg>
                            </div>
                            <div class="flex-1 min-w-0">
                                <h4 class="text-sm font-medium text-gray-900">无法生成 PDF</h4>
                                <p class="text-xs text-gray-700 mt-0.5">此活动没有足够的关键帧，无法生成 PDF 文档</p>
                            </div>
                        </div>
                    </div>
                `
                              : `
                    <!-- PDF 可生成状态（默认/null状态） -->
                    <div class="flex items-center justify-between p-3 bg-blue-50 border border-blue-200 rounded-lg">
                        <div class="flex items-center gap-2">
                            <svg class="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
                            </svg>
                            <span class="text-sm text-blue-800 font-medium">可生成 PDF 文档</span>
                        </div>
                        <button onclick="document.querySelector('recall-browser-page').generateActivityPDF('${activity.activityId}')"
                                class="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors">
                            生成 PDF
                        </button>
                    </div>
                `
                }

                <!-- 统计信息 -->
                <div class="grid grid-cols-2 gap-4 pt-3 border-t border-gray-100">
                    <div class="text-center">
                        <div class="text-lg font-semibold text-gray-900">${activity.captureCount || 0}</div>
                        <div class="text-xs text-gray-500">截图次数</div>
                    </div>
                    <div class="text-center">
                        <div class="text-lg font-semibold text-gray-900">${keyframeCount}</div>
                        <div class="text-xs text-gray-500">保存页数</div>
                    </div>
                </div>
            </div>
        </div>
        </div>
        `;
    }

    // 生成活动空视图
    generateActivityEmptyView() {
        if (!this.currentActivity) return '';

        const activity = this.currentActivity;
        // 使用顶层字段
        const status = activity.pdfStatus;
        const keyframeCount = activity.keyframeCount || 0;

        return `
        <div class="flex flex-col items-center justify-center h-full text-center p-8">
            <div class="w-24 h-24 bg-gradient-to-br from-blue-100 to-purple-100 rounded-full flex items-center justify-center mb-6">
                <svg class="w-12 h-12 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                </svg>
            </div>

            <h2 class="text-2xl font-bold text-gray-900 mb-2">活动记录</h2>
            <p class="text-gray-600 mb-8 max-w-md">
                这是一个活动记录，当前没有截图数据，但您可以查看或生成活动文档。
            </p>

            <!-- 活动信息卡片 -->
            <div class="w-full max-w-md bg-white rounded-lg border border-gray-200 shadow-sm p-6">
                <div class="flex items-center gap-3 mb-4">
                    <div class="w-10 h-10 bg-gradient-to-br from-green-500 to-blue-600 rounded-lg flex items-center justify-center">
                        <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3a2 2 0 012-2h4a2 2 0 012 2v4m0 0V7a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2h4z"/>
                        </svg>
                    </div>
                    <div>
                        <h3 class="font-semibold text-gray-900">${activity.activityName || '活动记录'}</h3>
                        <p class="text-sm text-gray-500">
                            ${new Date(activity.startTime).toLocaleString('zh-CN')}
                        </p>
                    </div>
                </div>

                <!-- 统计信息 -->
                <div class="grid grid-cols-2 gap-4 mb-4">
                    <div class="text-center p-3 bg-gray-50 rounded-lg">
                        <div class="text-lg font-semibold text-gray-900">${activity.captureCount || 0}</div>
                        <div class="text-xs text-gray-500">总截图数</div>
                    </div>
                    <div class="text-center p-3 bg-gray-50 rounded-lg">
                        <div class="text-lg font-semibold text-gray-900">${keyframeCount}</div>
                        <div class="text-xs text-gray-500">关键帧数</div>
                    </div>
                </div>

                ${
                    status === 'completed'
                        ? `
                    <!-- PDF 已生成状态 -->
                    <div class="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
                        <div class="flex items-center gap-2 mb-3">
                            <svg class="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                            </svg>
                            <span class="text-sm text-green-800 font-medium">PDF 文档已生成</span>
                        </div>
                    </div>
                    <div class="space-y-2">
                        <button onclick="document.querySelector('recall-browser-page').previewActivityPDF('${activity.activityId}')"
                                class="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
                            </svg>
                            预览活动文档
                        </button>
                        <button onclick="document.querySelector('recall-browser-page').downloadActivityPDF('${activity.activityId}')"
                                class="w-full px-4 py-2 bg-white text-blue-600 border border-blue-600 rounded-lg hover:bg-blue-50 transition-colors flex items-center justify-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                            </svg>
                            下载活动文档
                        </button>
                    </div>
                `
                        : status === 'processing'
                          ? `
                    <!-- PDF 生成中状态 -->
                    <div class="bg-amber-50 border border-amber-200 rounded-lg p-4">
                        <div class="flex items-center gap-3 mb-3">
                            <div class="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center">
                                <svg class="w-5 h-5 text-amber-600 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                                </svg>
                            </div>
                            <div>
                                <h4 class="text-sm font-medium text-amber-900">正在生成 PDF 文档...</h4>
                                <p class="text-xs text-amber-700 mt-0.5">正在生成PDF文档,请稍候</p>
                            </div>
                        </div>

                        <div class="flex items-center gap-2 text-xs text-amber-600 font-mono mb-3">
                            <svg class="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <circle cx="12" cy="12" r="10" stroke-width="3" stroke-dasharray="31.4 31.4" />
                            </svg>
                            <span>处理中... 请勿关闭页面</span>
                        </div>

                        <button disabled class="w-full px-4 py-2 bg-gray-200 text-gray-500 rounded-lg cursor-not-allowed text-sm flex items-center justify-center gap-2">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                            </svg>
                            生成完成后可预览
                        </button>
                    </div>
                `
                          : `
                    <!-- 生成 PDF 按钮 -->
                    <button onclick="document.querySelector('recall-browser-page').generateActivityPDF('${activity.activityId}')"
                            class="w-full px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center justify-center gap-2">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
                        </svg>
                        生成活动文档
                    </button>
                `
                }
            </div>
        </div>
        `;
    }

    render() {
        this.innerHTML = `
        <div class="w-full h-full flex overflow-hidden bg-gray-50">
            <!-- 左侧：活动列表（原设计） -->
            <aside id="left-panel" class="border-r border-gray-200 overflow-y-auto bg-white flex-shrink-0" style="width: ${this.leftPanelWidth}px">
                <recall-activity-list></recall-activity-list>
            </aside>

            <!-- 左侧分隔条 -->
            <div id="left-resizer" class="w-1 bg-gray-200 hover:bg-blue-400 cursor-col-resize flex-shrink-0 transition-colors" data-od-no-longpress="1" style="touch-action: none;"></div>

            <!-- 中间：主视图 -->
            <main class="flex-1 flex flex-col overflow-hidden min-w-0">
                <!-- 顶部工具栏 -->
                <header class="h-16 border-b border-gray-200 flex items-center px-6 bg-white gap-4 flex-shrink-0">
                    <!-- 返回按钮 -->
                    <button id="back-button" onclick="document.querySelector('recall-browser-page').goBack()"
                            class="w-10 h-10 rounded-lg hover:bg-gray-100 flex items-center justify-center transition-colors invisible">
                        <svg class="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"/>
                        </svg>
                    </button>

                    <!-- 搜索栏 -->
                    <div class="flex-1 max-w-2xl">
                        <div class="relative">
                            <input id="search-input" type="text" placeholder="搜索活动"
                                   class="w-full h-10 pl-10 pr-4 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-shadow"/>
                            <svg class="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
                            </svg>
                        </div>
                    </div>

                    <!-- 日期选择器 -->
                    <input id="date-picker" type="date" value="${this.selectedDate}"
                           class="h-10 px-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 transition-shadow"/>

                    <!-- 视图切换（仅日视图显示） -->
                    <div id="view-type-buttons" class="flex gap-0 border border-gray-300 rounded-lg overflow-hidden">
                        <button id="view-groups-btn" onclick="document.querySelector('recall-browser-page').changeViewType('groups')"
                                class="px-3 py-2 text-sm bg-blue-500 text-white transition-colors">
                            事件组
                        </button>
                        <button id="view-images-btn" onclick="document.querySelector('recall-browser-page').changeViewType('images')"
                                class="px-3 py-2 text-sm bg-white text-gray-700 hover:bg-gray-100 transition-colors">
                            图片
                        </button>
                    </div>
                </header>

                <!-- 主内容区 -->
                <div id="main-content" class="flex-1 overflow-hidden bg-gradient-to-br from-gray-50 to-gray-100">
                    <!-- Content will be populated dynamically -->
                </div>

                <!-- 底部时间轴 -->
                <div id="timeline-container" class="h-20 border-t border-gray-200 bg-white px-8 py-4 flex-shrink-0">
                </div>
            </main>

            <!-- 右侧分隔条（仅在详情显示时可见） -->
            <div id="right-resizer" class="w-1 bg-gray-200 hover:bg-blue-400 cursor-col-resize flex-shrink-0 transition-colors ${this.showDetail ? '' : 'hidden'}" data-od-no-longpress="1" style="touch-action: none;"></div>

            <!-- 右侧：详情面板（按需显示） -->
            <aside id="detail-panel" class="border-l border-gray-200 overflow-y-auto bg-white flex-shrink-0 hidden" style="width: 0px">
            </aside>
        </div>
        `;
    }
}

customElements.define('recall-browser-page', BrowserPage);
