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
 * 活动列表组件
 * 显示：按时间降序的活动块、标签筛选、状态反馈（录制中的活动呼吸灯）
 */
class ActivityList extends HTMLElement {

    constructor() {
        super();
        this.activities = [];
        this.selectedActivityId = null;
        this.selectedTag = '全部'; // 当前选中的标签
        this.availableTags = ['全部']; // 可用标签（从活动数据中提取）
        this.tagObjects = new Map(); // 标签对象映射（从 Tag 表）
        
        // 标签缓存机制
        this._tagsLoaded = false; // 标签是否已加载
        this._tagsCache = null; // 缓存的标签查询结果
    }

    /**
     * 将 hex 颜色转换为对应的 Tailwind 颜色类
     */
    hexToTailwindColor(hexColor) {
        // 简单映射常用颜色到 Tailwind
        const colorMap = {
            '#3B82F6': 'blue',
            '#8B5CF6': 'purple',
            '#10B981': 'green',
            '#F59E0B': 'amber',
            '#EC4899': 'pink',
            '#6366F1': 'indigo',
            '#EF4444': 'red',
            '#14B8A6': 'teal',
            '#F97316': 'orange',
            '#06B6D4': 'cyan'
        };
        return colorMap[hexColor] || 'gray';
    }

    /**
     * 获取标签样式（从 Tag 表中的颜色）
     */
    getTagStyle(tagName) {
        if (tagName === '全部') {
            return { 
                bg: 'bg-gray-100', 
                text: 'text-gray-700', 
                border: 'border-gray-200', 
                hover: 'hover:bg-gray-50', 
                activeColor: '#6B7280' // gray-500
            };
        }
        
        // 从 Tag 表获取颜色
        const tagObject = this.tagObjects.get(tagName);
        if (tagObject && tagObject.tagColor) {
            const color = this.hexToTailwindColor(tagObject.tagColor);
            // 使用完整的类名（避免Tailwind动态类名问题）
            const colorStyles = {
                'blue': { bg: 'bg-blue-100', text: 'text-blue-700', border: 'border-blue-200', hover: 'hover:bg-blue-50', activeColor: '#3B82F6' },
                'purple': { bg: 'bg-purple-100', text: 'text-purple-700', border: 'border-purple-200', hover: 'hover:bg-purple-50', activeColor: '#8B5CF6' },
                'green': { bg: 'bg-green-100', text: 'text-green-700', border: 'border-green-200', hover: 'hover:bg-green-50', activeColor: '#10B981' },
                'amber': { bg: 'bg-amber-100', text: 'text-amber-700', border: 'border-amber-200', hover: 'hover:bg-amber-50', activeColor: '#F59E0B' },
                'pink': { bg: 'bg-pink-100', text: 'text-pink-700', border: 'border-pink-200', hover: 'hover:bg-pink-50', activeColor: '#EC4899' },
                'indigo': { bg: 'bg-indigo-100', text: 'text-indigo-700', border: 'border-indigo-200', hover: 'hover:bg-indigo-50', activeColor: '#6366F1' },
                'red': { bg: 'bg-red-100', text: 'text-red-700', border: 'border-red-200', hover: 'hover:bg-red-50', activeColor: '#EF4444' },
                'teal': { bg: 'bg-teal-100', text: 'text-teal-700', border: 'border-teal-200', hover: 'hover:bg-teal-50', activeColor: '#14B8A6' },
                'orange': { bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-200', hover: 'hover:bg-orange-50', activeColor: '#F97316' },
                'cyan': { bg: 'bg-cyan-100', text: 'text-cyan-700', border: 'border-cyan-200', hover: 'hover:bg-cyan-50', activeColor: '#06B6D4' },
                'gray': { bg: 'bg-gray-100', text: 'text-gray-700', border: 'border-gray-200', hover: 'hover:bg-gray-50', activeColor: '#6B7280' }
            };
            
            return colorStyles[color] || colorStyles['gray'];
        }
        
        // 默认使用灰色
        return { bg: 'bg-gray-100', text: 'text-gray-700', border: 'border-gray-200', hover: 'hover:bg-gray-50', activeColor: '#6B7280' };
    }

    /**
     * 从 Tagging 表提取所有标签（批量查询优化 + 缓存）
     * 注意：此方法只在页面初始化时调用一次
     */
    async extractTagsFromDatabase() {
        // 如果标签已加载，直接使用缓存
        if (this._tagsLoaded && this._tagsCache) {
            this._applyTagsToActivities(this._tagsCache);
            return;
        }

        const tagCountMap = new Map();

        // 如果没有活动，直接返回
        if (!this.activities || this.activities.length === 0) {
            this.availableTags = ['全部'];
            return;
        }

        // 批量获取所有活动的标签
        const activityIds = this.activities.map(a => a.activityId);

        try {
            const startTime = Date.now();
            const result = await window.applicationAPI.call(
                'getActivitiesAggregatedTags',
                activityIds
            );
            const queryTime = Date.now() - startTime;

            // 如果查询时间过长，记录警告
            if (queryTime > 500) {
                console.warn(`[ActivityList] ⚠️ Slow tag query: ${queryTime}ms`);
            }

            if (result && result.success && result.tagsMap) {
                // 缓存查询结果
                this._tagsCache = result;
                this._tagsLoaded = true;
                
                // 应用标签到活动
                this._applyTagsToActivities(result);
            }
        } catch (error) {
            console.error('[ActivityList] ❌ Failed to load tags:', error);
            // 出错时为所有活动设置空标签
            this.activities.forEach(activity => {
                if (!activity._tagObjects) {
                    activity._tagObjects = [];
                }
            });
        }
    }

    /**
     * 应用标签数据到活动列表
     */
    _applyTagsToActivities(result) {
        if (!result || !result.success || !result.tagsMap) {
            return;
        }

        const tagCountMap = new Map();

        // 为每个活动分配标签
        this.activities.forEach(activity => {
            const tagObjects = result.tagObjectsMap?.[activity.activityId] || [];
            activity._tagObjects = tagObjects;

            // 缓存标签对象到全局 Map
            tagObjects.forEach(tagObj => {
                if (!this.tagObjects.has(tagObj.tagName)) {
                    this.tagObjects.set(tagObj.tagName, tagObj);
                }
            });

            // 统计每个标签的使用次数
            tagObjects.forEach(tagObj => {
                const count = tagCountMap.get(tagObj.tagName) || 0;
                tagCountMap.set(tagObj.tagName, count + 1);
            });
        });

        // 按使用次数降序排序
        const sortedTags = Array.from(tagCountMap.entries())
            .sort((a, b) => b[1] - a[1])
            .map(entry => entry[0]);

        // 更新可用标签列表
        this.availableTags = ['全部', ...sortedTags];
    }

    async setActivities(activities) {
        this.activities = activities;

        // 如果已经加载过标签，直接应用缓存
        if (this._tagsLoaded && this._tagsCache) {
            this._applyTagsToActivities(this._tagsCache);
            this.render();
            return;
        }

        // 确保所有活动都有_tagObjects属性（初始化为空数组）
        this.activities.forEach(activity => {
            if (!activity._tagObjects) {
                activity._tagObjects = [];
            }
        });

        // 先立即渲染活动列表（不等待标签）
        this.render();

        // 首次加载时异步查询标签（不阻塞UI）
        this.extractTagsFromDatabase().then(() => {
            // 标签加载完成后重新渲染
            this.render();
        }).catch(error => {
            console.error('[ActivityList] Failed to load tags:', error);
            // 即使标签加载失败，也要显示活动列表
        });
    }

    onActivityClick(activityId) {
        this.selectedActivityId = activityId;
        this.dispatchEvent(new CustomEvent('activitySelected', {
            detail: { activityId: activityId }
        }));
        this.render();
    }

    onTagClick(tag) {
        this.selectedTag = tag;
        this.render();
    }

    getFilteredActivities() {
        if (this.selectedTag === '全部') {
            return this.activities;
        }
        // 过滤带有指定标签的活动（从 _tagObjects 提取标签名）
        return this.activities.filter(activity => {
            const tagObjects = activity._tagObjects || [];
            return tagObjects.some(tagObj => tagObj.tagName === this.selectedTag);
        });
    }

    /**
     * Handle PDF status updates from backend
     */
    handlePDFStatusUpdate(payload) {
        const { activityId, status, pdfPath, keyframeCount, error } = payload;
        
        // Find activity in list
        const activity = this.activities.find(a => a.activityId === activityId);
        if (!activity) {
            console.warn('[ActivityList] ⚠️ Activity not found in list:', activityId?.substring(0, 8));
            console.warn('[ActivityList] Current activities:', this.activities.map(a => a.activityId?.substring(0, 8)));
            return;
        }

        // Update fields
        if (!activity.metadata) activity.metadata = {};

        activity.pdfStatus = status;
        if (pdfPath) activity.pdfPath = pdfPath;
        if (keyframeCount) activity.keyframeCount = keyframeCount;
        if (error) {
            if (!activity.metadata.pdf) activity.metadata.pdf = {};
            activity.metadata.pdf.error = error;
        }

        // Re-render to show updated state
        this.render();
    }

    /**
     * Get tooltip text for PDF button based on status
     */
    getPDFButtonTooltip(status) {
        switch(status) {
            case 'processing': return 'PDF生成中，请稍候...';
            case 'completed': return '预览活动PDF';
            case 'failed': return 'PDF生成失败，点击重试';
            case 'no_keyframes': return '无关键帧，无法生成PDF';
            case null:
            case undefined:
                return '请先在详情页点击"生成PDF"';
            default: return '预览活动PDF';
        }
    }

    /**
     * Regenerate PDF for failed activities
     */
    async regeneratePDF(activityId) {
        try {
            await window.applicationAPI.call('generateActivityPDF', activityId);
        } catch (error) {
            console.error('[ActivityList] Failed to regenerate PDF:', error);
            alert('重新生成PDF失败，请稍后重试');
        }
    }

    /**
     * Cleanup subscriptions when component is removed
     */
    disconnectedCallback() {
        // Cleanup if needed
    }

    render() {
        const filteredActivities = this.getFilteredActivities();
        const activitiesHtml = filteredActivities.map(activity => {
            const isSelected = this.selectedActivityId === activity.activityId;
            const selectedClass = isSelected ? 'bg-blue-50 border-l-4 border-blue-500' : 'border-l-4 border-transparent hover:bg-gray-100/50';
            const tagObjects = activity._tagObjects || [];
            const tags = tagObjects.map(t => t.tagName); // 从 tagObjects 提取标签名
            const durationMinutes = activity.duration ? Math.floor(activity.duration / 1000 / 60) : 0;
            const startTimeStr = activity.startTime ? new Date(activity.startTime).toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            }) : '--';
            const totalSizeMB = activity.totalSize ? (activity.totalSize / 1024 / 1024).toFixed(1) : '0.0';
            
            return `
            <div class="activity-item ${selectedClass} cursor-pointer p-4 border-b border-gray-100 transition-colors"
                 data-activity-id="${activity.activityId}">
                <div class="flex items-start justify-between gap-2">
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center justify-between gap-2">
                            <h3 class="font-medium text-gray-800 truncate text-sm">${activity.activityName || '未命名活动'}</h3>
                            <div class="flex items-center gap-1">
                                ${(() => {
                                    const pdfStatus = activity.pdfStatus;
                                    
                                    const isProcessing = pdfStatus === 'processing';
                                    const isFailed = pdfStatus === 'failed';
                                    const isNoKeyframes = pdfStatus === 'no_keyframes';
                                    const isCompleted = pdfStatus === 'completed';
                                    const isNotGenerated = !pdfStatus; // null 或 undefined

                                    let iconClass = 'fa-file-pdf';
                                    let buttonClass = 'bg-gray-100 hover:bg-amber-100';
                                    let iconColor = 'text-gray-500 group-hover:text-amber-600';
                                    let isDisabled = false;
                                    
                                    if (isProcessing) {
                                        iconClass = 'fa-spinner fa-spin';
                                        isDisabled = true;
                                        buttonClass = 'bg-gray-100 opacity-50 cursor-not-allowed';
                                        iconColor = 'text-blue-500';
                                    } else if (isFailed) {
                                        iconClass = 'fa-exclamation-triangle';
                                        iconColor = 'text-red-500 group-hover:text-red-600';
                                    } else if (isNoKeyframes) {
                                        iconClass = 'fa-info-circle';
                                        iconColor = 'text-gray-400';
                                    } else if (isNotGenerated) {
                                        iconClass = 'fa-file-pdf';
                                        isDisabled = true;
                                        buttonClass = 'bg-gray-50 cursor-not-allowed';
                                        iconColor = 'text-gray-300';
                                    } else if (isCompleted) {
                                        iconClass = 'fa-file-pdf';
                                        iconColor = 'text-green-600 group-hover:text-green-700';
                                    }

                                    return `
                                    <button class="preview-pdf-btn relative flex-shrink-0 w-7 h-7 flex items-center justify-center ${buttonClass} rounded-md transition-colors group"
                                            data-activity-id="${activity.activityId}"
                                            data-status="${pdfStatus || 'null'}"
                                            ${isDisabled ? 'disabled' : ''}
                                            title="${this.getPDFButtonTooltip(pdfStatus)}">
                                        <i class="fa-solid ${iconClass} ${iconColor} text-xs"></i>
                                    </button>
                                    `;
                                })()}
                                <button class="open-folder-btn flex-shrink-0 w-7 h-7 flex items-center justify-center bg-gray-100 hover:bg-blue-100 rounded-md transition-colors group"
                                        data-activity-id="${activity.activityId}"
                                        title="打开文件夹">
                                    <i class="fa-solid fa-folder-open text-gray-500 group-hover:text-blue-600 text-xs"></i>
                                </button>
                                <button class="delete-activity-btn flex-shrink-0 w-7 h-7 flex items-center justify-center bg-gray-100 hover:bg-red-100 rounded-md transition-colors group"
                                        data-activity-id="${activity.activityId}"
                                        title="删除此活动">
                                    <i class="fa-solid fa-trash text-gray-500 group-hover:text-red-600 text-xs"></i>
                                </button>
                            </div>
                        </div>
                        <p class="text-xs text-gray-500 mt-1">${startTimeStr}</p>
                        
                        <!-- 标签显示 -->
                        ${tags.length > 0 ? `
                            <div class="flex gap-1 mt-2 flex-wrap">
                                ${tags.map(tag => {
                                    const style = this.getTagStyle(tag);
                                    return `<span class="inline-flex items-center gap-1 text-xs ${style.bg} ${style.text} px-2 py-0.5 rounded-full">
                                        <i class="fa-solid fa-tag text-[10px]"></i>
                                        ${tag}
                                    </span>`;
                                }).join('')}
                            </div>
                        ` : `
                            <div class="flex gap-1 mt-2">
                                <span class="text-xs text-gray-400 italic">暂无标签</span>
                            </div>
                        `}
                        
                        <!-- 统计信息网格 -->
                        <div class="grid grid-cols-2 gap-1.5 mt-2">
                            <div class="flex items-center gap-1 text-xs bg-purple-50 px-2 py-1 rounded">
                                <i class="fa-solid fa-camera text-purple-500 text-[10px]"></i>
                                <span class="text-purple-700 font-medium">${activity.captureCount || 0}</span>
                                <span class="text-purple-600 text-[10px]">捕获</span>
                            </div>
                            <div class="flex items-center gap-1 text-xs bg-blue-50 px-2 py-1 rounded">
                                <i class="fa-solid fa-images text-blue-500 text-[10px]"></i>
                                <span class="text-blue-700 font-medium">${activity.snapshotCount || 0}</span>
                                <span class="text-blue-600 text-[10px]">快照</span>
                            </div>
                            <div class="flex items-center gap-1 text-xs bg-amber-50 px-2 py-1 rounded">
                                <i class="fa-solid fa-clock text-amber-500 text-[10px]"></i>
                                <span class="text-amber-700 font-medium">${durationMinutes}</span>
                                <span class="text-amber-600 text-[10px]">分钟</span>
                            </div>
                            <div class="flex items-center gap-1 text-xs bg-green-50 px-2 py-1 rounded">
                                <i class="fa-solid fa-database text-green-500 text-[10px]"></i>
                                <span class="text-green-700 font-medium">${totalSizeMB}</span>
                                <span class="text-green-600 text-[10px]">MB</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            `;
        }).join('');

        this.innerHTML = `
        <div class="p-4 border-b border-gray-200 bg-white sticky top-0 z-10">
            <h2 class="text-sm font-bold text-gray-700 mb-3">活动列表</h2>
            <!-- 标签筛选 -->
            <div class="flex gap-2 flex-wrap">
                ${this.availableTags.map(tag => {
                    const isSelected = tag === this.selectedTag;
                    const style = this.getTagStyle(tag);
                    if (isSelected) {
                        // 选中状态：使用内联样式确保颜色正确
                        return `<button class="text-xs px-2 py-1 rounded-full transition" 
                                        style="background-color: ${style.activeColor}; color: white;" 
                                        data-tag="${tag}">${tag}</button>`;
                    } else {
                        // 未选中状态：使用Tailwind类
                        return `<button class="text-xs px-2 py-1 rounded-full ${style.bg} border ${style.border} ${style.text} ${style.hover} transition" 
                                        data-tag="${tag}">${tag}</button>`;
                    }
                }).join('')}
            </div>
        </div>

        <div class="activity-list-container">
            ${activitiesHtml || '<div class="p-4 text-center text-gray-400 text-sm">暂无活动</div>'}
        </div>
        `;

        // 绑定活动项点击事件
        this.querySelectorAll('.activity-item').forEach(item => {
            item.addEventListener('click', () => {
                this.onActivityClick(item.dataset.activityId);
            });
        });
        
        // 绑定打开文件夹按钮点击事件
        this.querySelectorAll('.open-folder-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation(); 
                const activityId = btn.dataset.activityId;
                try {
                    const result = await window.applicationAPI.call('getHistoryActivityById', activityId);
                    if (result && result.success && result.activity) {
                        await window.applicationAPI.callMainWorld('openActivityFolder', result.activity.activityPath);
                    } else {
                        console.error('[ActivityList] Failed to get activity or activity data is invalid:', result);
                    }
                } catch (error) {
                    console.error('[ActivityList] Error while fetching activity data:', error);
                }
            });
        });

        // 绑定PDF预览按钮点击事件
        this.querySelectorAll('.preview-pdf-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation(); // 阻止冒泡，避免触发活动项点击
                const activityId = btn.dataset.activityId;
                const status = btn.dataset.status;

                // Don't respond to clicks on disabled button
                if (status === 'processing' || status === 'pending') {
                    return; // Silently ignore
                }

                // Handle failed state - offer regeneration
                if (status === 'failed') {
                    if (confirm('PDF生成失败，是否重新生成？')) {
                        await this.regeneratePDF(activityId);
                    }
                    return;
                }

                // Handle no_keyframes state
                if (status === 'no_keyframes') {
                    alert('此活动没有足够的关键帧，无法生成PDF');
                    return;
                }

                try {
                    const result = await window.applicationAPI.call('getActivityPDFPath', activityId);
                    if (result && result.success && result.pdfPath) {
                        // 打开文件管理器到PDF位置
                        const previewResult = await window.applicationAPI.callMainWorld('previewActivityPDF', result.pdfPath);
                        // 检查业务逻辑错误
                        if (previewResult && previewResult.success === false) {
                            const errorMessage = previewResult.message || '无法打开PDF，请先生成PDF文档';
                            console.warn('[ActivityList] PDF preview failed:', errorMessage);
                            alert(errorMessage);
                        }
                    }
                } catch (error) {
                    console.error('[ActivityList] Failed to preview PDF:', error);
                    alert('预览PDF时出现错误，请重试');
                }
            });
        });

        // 绑定删除按钮点击事件
        this.querySelectorAll('.delete-activity-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // 防止触发活动项的点击事件
                const activityId = btn.dataset.activityId;
                const activity = this.activities.find(a => a.activityId === activityId);
                const confirmDelete = window.confirm(`确定要删除活动"${activity?.activityName || '未命名活动'}"吗？删除后无法恢复。`);
                if (confirmDelete) {
                    // 触发删除事件
                    this.dispatchEvent(new CustomEvent('activityDeleted', {
                        detail: { activityId: activityId }
                    }));
                    // 从列表中移除
                    this.activities = this.activities.filter(a => a.activityId !== activityId);
                    this.render();
                }
            });
        });
        
        // 绑定标签按钮点击事件
        this.querySelectorAll('button[data-tag]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.onTagClick(btn.dataset.tag);
            });
        });
    }
}

customElements.define('recall-activity-list', ActivityList);
