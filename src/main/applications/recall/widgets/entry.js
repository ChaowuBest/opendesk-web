class RecallEntryWidget extends HTMLElement {

    constructor() {
        super();

        /** @type {'idle' | 'recording'} */
        this.currentStatus = 'idle';
        /** @type {RecallActivity | null} */
        this.currentActivity = null;
        /** @type {NodeJS.Timeout | null} */
        this.reloadThumbnailInterval = null;
        /** @type {number} */
        this.reloadThumbnailIntervalMs = 5000;
    }

    connectedCallback() {
        this.render();
        this.reload();
    }

    async reload() {
        const recallStatus = await this.getRecallStatus();
        this.currentStatus = recallStatus.status;
        this.currentActivity = recallStatus.activity;
        this.reloadHistoryActivities();

        if (recallStatus.status === 'idle') {
            // 首先暂停预览的实时更新
            if (this.reloadThumbnailInterval) {
                clearInterval(this.reloadThumbnailInterval);
                this.reloadThumbnailInterval = null;
            }
            // 然后更新UI
            this.querySelector('#recall-status-recording').style.display = 'none';
            this.querySelector('#recall-status-idle').style.display = 'flex';
            const currentActivityHtml = `
            <div class="flex flex-col items-center justify-center w-full h-full gap-6 bg-gray-50 rounded-2xl shadow-inner">
                <div class="flex flex-col items-center">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12 text-gray-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <circle cx="12" cy="12" r="10" stroke-width="2" stroke="currentColor" fill="white"/>
                        <circle cx="12" cy="12" r="5" fill="#d1d5db"/>
                        <rect x="9" y="9" width="6" height="6" rx="2" fill="#ef4444"/>
                    </svg>
                    <div class="text-xl font-semibold text-gray-700 mb-2">当前没有录制中的活动</div>
                    <div class="text-sm text-gray-500 mb-4">点击下方按钮开始记录您的屏幕活动</div>
                </div>
                <button
                    id="start-recall-capture-btn"
                    class="px-6 py-2 rounded-full bg-rose-500 hover:bg-rose-700 text-white font-medium text-base shadow transition flex justify-center items-center"
                >
                    <span class="inline-flex items-center gap-2">
                        <svg class="h-5 w-5 text-white animate-pulse" fill="currentColor" viewBox="0 0 20 20"><circle cx="10" cy="10" r="6"/></svg>
                        开始录制
                    </span>
                </button>
            </div>
            `;
            document.startViewTransition(() => {
                this.querySelector('#recall-current-activity').innerHTML = currentActivityHtml;
                this.querySelector('#start-recall-capture-btn').onclick = () => {
                    const currentTime = new Date();
                    const activityName = `在${currentTime.getMonth() + 1}月${currentTime.getDate()}日${currentTime.getHours()}点${currentTime.getMinutes()}分开始的活动`;
                    this.startRecallCapture(activityName);
                }
            });
        } else if (recallStatus.status === 'recording') {
            this.querySelector('#recall-status-recording').style.display = 'flex';
            this.querySelector('#recall-status-idle').style.display = 'none';

            const currentActivityHtml = `
            <div class="w-full h-full flex flex-row gap-6 items-center">
                <!-- 录制预览区（左侧） -->
                <div class="flex-1 flex items-center justify-center h-full bg-gray-100 rounded-2xl border border-gray-200 shadow-inner overflow-hidden">
                    <!-- 后续可在此插入截图或录制内容的实时预览 -->
                    <div id='recall-current-activity-preview' class="flex items-center justify-center h-[56px]">

                    </div>
                </div>
                <!-- 活动信息与控制区（右侧） -->
                <div class="w-[340px] h-full flex flex-col bg-white/80 rounded-2xl border border-gray-100 shadow p-5 gap-3">
                    <div>
                        <div class="text-lg font-bold text-rose-600 break-all">
                            ${recallStatus.activity?.activityName}
                        </div>
                    <div class="text-xs text-gray-400 mt-1 select-all break-all">
                        ${recallStatus.activity?.activityId}
                    </div>
                    </div>
                    <div class="flex flex-col gap-2 text-sm text-gray-600">
                        <div>
                            <span class="font-medium text-gray-500">开始时间：</span>
                            <span id="recall-recording-start-time">
                                ${new Date(recallStatus.activity?.activityStartTime).toLocaleString()}
                            </span>
                        </div>
                        <div>
                            <span class="font-medium text-gray-500">已持续：</span>
                            <span id="recall-recording-duration">--:--</span>
                        </div>
                    </div>
                    <div>
                        <div class="text-gray-400 italic text-sm">自动记录屏幕活动和截图全过程，便于回顾和检索。</div>
                    </div>
                    <button
                        id="stop-recall-capture-btn"
                        class="mt-4 py-2 w-full rounded-xl bg-gray-700 hover:bg-gray-900 text-white font-medium text-base shadow transition"
                    >
                        <span class="inline-flex items-center gap-2">
                            <svg class="h-5 w-5 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="white" stroke="#ef4444"/></svg>
                            停止录制
                        </span>
                    </button>
                </div>
            </div>
            `;

            document.startViewTransition(() => {
                this.querySelector('#recall-current-activity').innerHTML = currentActivityHtml;
                this.querySelector('#stop-recall-capture-btn').onclick = () => {
                    this.stopRecallCapture();
                }
                // 然后开始实时更新预览
                this.loadLatestThumbnail();
                this.updateRecordingDuration();
                this.reloadThumbnailInterval = setInterval(() => {
                    this.loadLatestThumbnail();
                    this.updateRecordingDuration();
                }, this.reloadThumbnailIntervalMs);
            });
        }
    }

    async reloadHistoryActivities() {
        const historyActivities = await window.applicationAPI.sendMessageToApplication('getHistoryActivities', 0, Date.now());
        const historyActivitiesHtml = historyActivities.map(activity => `
        <div class="history-activity-item flex-none w-56 group cursor-pointer" data-activity_id="${activity.activityId}">
            <div class="relative aspect-video rounded-lg overflow-hidden border border-zinc-200 group-hover:border-blue-400 transition-colors shadow-sm bg-white">
                <img src="https://images.unsplash.com/photo-1555066931-4365d14bab8c?auto=format&fit=crop&q=40&w=300" class="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity">
                <!-- 删除图标（右上角） -->
                <button
                    class="delete-history-activity-btn absolute top-2 right-2 h-6 w-6 flex items-center justify-center bg-white/80 rounded-full cursor-pointer shadow hover:bg-red-500 hover:text-white transition group/delete"
                    title="删除此回顾"
                    style="z-index:1"
                    data-activity_id="${activity.activityId}"
                >
                    <i class="fa-solid fa-trash h-4 w-4 text-xs"></i>
                </button>
                <div class="absolute bottom-2 right-2 bg-white/70 backdrop-blur px-1.5 py-0.5 rounded text-[10px] font-mono text-gray-800 shadow">
                    ${Math.floor(activity.activityDuration / 1000 / 60)} 分钟
                </div>
            </div>
            <div class="mt-2 flex items-start gap-2">
                <i class="fa-solid fa-video text-red-500 mt-1 flex-shrink-0"></i>
                <div class="min-w-0 flex-1">
                    <p class="text-sm font-medium group-hover:text-blue-500 transition-colors text-gray-800 overflow-hidden text-ellipsis whitespace-nowrap">
                        ${activity.activityName}
                    </p>
                    <p class="text-[11px] text-gray-500 overflow-hidden text-ellipsis whitespace-nowrap">
                        ${new Date(activity.activityStartTime).toLocaleString()}
                    </p>
                </div>
            </div>
        </div>
        `).join('');

        document.querySelector('#recall-history-activity-list').innerHTML = historyActivitiesHtml;
        document.querySelectorAll('.delete-history-activity-btn').forEach(btn => {
            btn.onclick = async () => {
                const activityId = btn.dataset.activity_id;
                const confirmDelete = window.confirm('确定要删除这个回顾吗？删除后无法恢复。');
                if (!confirmDelete) {
                    return;
                }
                await window.applicationAPI.sendMessageToApplication('deleteHistoryActivity', activityId);
                this.reloadHistoryActivities();
            }
        });
        document.querySelectorAll('.history-activity-item').forEach(item => {
            item.onclick = () => {
                const activityId = item.dataset.activity_id;
                window.applicationAPI.sendMessageToApplication('openHistoryActivity', activityId);
            }
        });
    }

    async getRecallStatus() {
        const recallStatus = await window.applicationAPI.sendMessageToApplication('getRecallStatus');
        console.info('current recall status:', recallStatus);
        return recallStatus;
    }

    async startRecallCapture(activityName) {
        const recallStatus = await window.applicationAPI.sendMessageToApplication('startRecallCapture', activityName);
        this.reload();
    }

    async stopRecallCapture() {
        const recallStatus = await window.applicationAPI.sendMessageToApplication('stopRecallCapture');
        this.reload();
    }

    async updateRecordingDuration() {
        if (this.currentStatus != 'recording') {
            console.warn('not recording, skipping duration update');
            return;
        }

        let durationMs = Date.now() - this.currentActivity.activityStartTime;
        let durationHours = Math.floor(durationMs / 3600000);
        let durationMinutes = Math.floor((durationMs % 3600000) / 60000);
        let durationSeconds = Math.floor((durationMs % 60000) / 1000);

        let durationString = `${durationSeconds}秒`
        if (durationMinutes > 0) { durationString = `${durationMinutes}分钟` + durationString; }
        if (durationHours > 0) { durationString = `${durationHours}小时` + durationString; }

        document.querySelector('#recall-recording-duration').innerHTML = durationString;
    }

    async loadLatestThumbnail() {
        if (this.currentStatus != 'recording') {
            console.warn('not recording, skipping thumbnail load');
            return;
        }

        const latestThumbnail = await window.applicationAPI.sendMessageToApplication('getLatestThumbnail');
        document.querySelector('#recall-current-activity-preview').innerHTML = `
        <div class="flex items-center justify-center h-[56px]">
            <img src="${latestThumbnail.thumbnails[1]}" alt="latest thumbnail">
        </div>
        `;
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
                    <h1 class="font-medium text-md tracking-tight text-center">活动记录</h1>
                </div>
            </header>

            <!-- 上半部分：当前屏幕预览区 -->
            <main id='recall-current-activity' class="flex-1 relative flex items-center justify-center px-7 py-8 overflow-hidden">
            </main>

            <!-- 下半部分：水平历史列表 -->
            <footer class="h-70 bg-white/50 backdrop-blur-2xl border-t border-gray-200 px-6 py-4 flex flex-col">
                <div class="flex items-center justify-between mb-2">
                <div class="flex items-center gap-3">
                    <span class="text-xs font-bold text-gray-400 uppercase tracking-widest">您已经记录的活动</span>
                    <div class="px-2 py-0.5 bg-gray-200 rounded text-[10px] text-gray-600 font-bold tracking-tight">TODAY</div>
                </div>
                <div class="flex gap-2">
                    <button class="p-1.5 hover:bg-gray-200 rounded-md text-gray-400"><i class="fa-solid fa-chevron-left text-xs"></i></button>
                    <button class="p-1.5 hover:bg-gray-200 rounded-md text-gray-400"><i class="fa-solid fa-chevron-right text-xs"></i></button>
                </div>
                </div>

                <!-- 水平时间轴项 -->
                <div id='recall-history-activity-list' class="flex gap-5 overflow-x-auto pb-6 no-scrollbar h-full items-start">

                    <!-- 过去活动 1 -->
                    <div class="flex-none w-48 group">
                        <div class="relative aspect-video rounded-xl border-2 border-transparent transition-all group-hover:shadow-lg group-hover:scale-[1.02] cursor-pointer bg-white mb-2 overflow-hidden ring-1 ring-gray-200">
                        <img src="https://images.unsplash.com/photo-1542831371-29b0f74f9713?auto=format&fit=crop&q=40&w=300" class="w-full h-full object-cover grayscale-[0.3] group-hover:grayscale-0">
                        <div class="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent"></div>
                        <span class="absolute bottom-1.5 left-2 text-[9px] font-bold text-white uppercase opacity-0 group-hover:opacity-100 transition-opacity">14:20 PM</span>
                        </div>
                        <div class="flex items-center gap-2 px-1">
                        <div class="w-5 h-5 rounded shadow-sm flex items-center justify-center bg-white border border-gray-100">
                            <i class="fa-brands fa-chrome text-blue-500 text-[10px]"></i>
                        </div>
                        <span class="text-xs font-semibold text-gray-600 truncate">GitHub PR Review</span>
                        </div>
                    </div>

                    <!-- 过去活动 2 (当前选中点) -->
                    <div class="flex-none w-48 group">
                        <div class="relative aspect-video rounded-xl border-2 border-blue-500 shadow-xl shadow-blue-100 cursor-pointer bg-white mb-2 overflow-hidden transform scale-105 z-10">
                        <img src="https://images.unsplash.com/photo-1587620962725-abab7fe55159?auto=format&fit=crop&q=40&w=300" class="w-full h-full object-cover">
                        <div class="absolute top-1 right-1 bg-blue-500 text-white text-[8px] px-1.5 py-0.5 rounded-full font-bold">CURRENT</div>
                        </div>
                        <div class="flex items-center gap-2 px-1">
                        <div class="w-5 h-5 rounded shadow-sm flex items-center justify-center bg-white border border-gray-100">
                            <i class="fa-solid fa-code text-gray-700 text-[10px]"></i>
                        </div>
                        <span class="text-xs font-bold text-blue-600 truncate">VS Code Editor</span>
                        </div>
                    </div>

                    <!-- 过去活动 3 -->
                    <div class="flex-none w-48 group opacity-70 hover:opacity-100">
                        <div class="relative aspect-video rounded-xl border-2 border-transparent hover:ring-1 ring-gray-300 transition-all cursor-pointer bg-white mb-2 overflow-hidden ring-1 ring-gray-200">
                        <img src="https://images.unsplash.com/photo-1611162616305-c69b3fa7fbe0?auto=format&fit=crop&q=40&w=300" class="w-full h-full object-cover grayscale">
                        </div>
                        <div class="flex items-center gap-2 px-1">
                        <div class="w-5 h-5 rounded shadow-sm flex items-center justify-center bg-white border border-gray-100">
                            <i class="fa-brands fa-slack text-purple-500 text-[10px]"></i>
                        </div>
                        <span class="text-xs font-semibold text-gray-600 truncate">Messaging (Internal)</span>
                        </div>
                    </div>

                    <!-- 更多重复占位... -->
                    <div class="flex-none w-48 group opacity-50">
                        <div class="relative aspect-video rounded-xl border border-dashed border-gray-300 bg-gray-100/50 mb-2 flex items-center justify-center">
                            <i class="fa-solid fa-image text-gray-300"></i>
                        </div>
                        <div class="h-3 w-2/3 bg-gray-200 rounded mx-1"></div>
                    </div>

                    <div class="flex-none w-48 group opacity-50">
                        <div class="relative aspect-video rounded-xl border border-dashed border-gray-300 bg-gray-100/50 mb-2 flex items-center justify-center">
                            <i class="fa-solid fa-image text-gray-300"></i>
                        </div>
                        <div class="h-3 w-2/3 bg-gray-200 rounded mx-1"></div>
                    </div>

                </div>
            </footer>
        </div>
        `;
    }
}

customElements.define('recall-entry-widget', RecallEntryWidget);