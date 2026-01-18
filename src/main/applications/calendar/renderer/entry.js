class CalendarEntryWidget extends HTMLElement {
    constructor() {
        super();
        this.currentDate = new Date();
    }

    connectedCallback() {
        this.render();
        this.setCurrentDate();
    }

    async setCurrentDate(dateString = undefined) {
        var date = dateString ? new Date(dateString) : new Date();
        const weekdayNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const dayOfWeek = weekdayNames[date.getDay()];
        const currentDateString = date.toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        }) + ' ' + dayOfWeek;

        const scheduleElement = this.querySelector('#calendar-current-day-schedule');
        scheduleElement.innerHTML = `
        <content-loading-view class="col-span-full rounded-2xl" data-type="lr" data-message="刷新日程状态..."></content-loading-view>
        `;

        var scheduleHTML = '';
        scheduleHTML += `
        <div class="flex items-center justify-between mb-2">
            <span class="text-[11px] font-bold text-gray-500 uppercase tracking-[0.15em]">${currentDateString}</span>
            <span class="w-8 h-8 rounded-full bg-white/40 flex items-center justify-center text-blue-600 font-bold">+</span>
        </div>
        `;

        const calendarItems = await window.applicationAPI.sendMessageToApplication('getCalendarItems', date.toLocaleDateString());

        for (const item of calendarItems) {
            const startTime = new Date(item.startTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            scheduleHTML += `
            <div class="flex gap-4">
                <div class="flex flex-col items-center">
                    <span class="text-[11px] font-bold text-slate-500">${startTime}</span>
                    <div class="w-px h-full bg-slate-300 mt-2"></div>
                </div>
                <div class="flex-1 bg-white/50 border border-white/60 backdrop-blur-md rounded-[24px] p-5 shadow-sm hover:shadow-md transition-shadow">
                    <div class="flex justify-between items-start">
                        <div>
                            <h4 class="text-[15px] font-bold text-slate-800">${item.subject}</h4>
                            <p class="text-xs text-slate-500 mt-1">${item.location || '无地点信息'}</p>
                        </div>
                        <div class="bg-indigo-500 w-2.5 h-2.5 rounded-full ring-4 ring-indigo-500/20"></div>
                    </div>
                    <div class="mt-4 flex items-center text-[10px] text-indigo-600 font-bold bg-indigo-50 w-fit px-2 py-1 rounded-md">
                        <i class="fa fa-video-camera w-3 h-3 mr-1" style="font-size: 0.9em;"></i>
                        接入会议
                    </div>
                </div>
            </div>
            `;
        }

        scheduleElement.innerHTML = scheduleHTML;
    }

    render() {
        this.innerHTML = `
        <splitter-widget class="w-full h-full bg-white to-pink-200">
            <!-- 左侧面板 -->
            <div id="leftPanel" slot="left" class="p-2 overflow-auto w-full h-full">
                <div class="flex flex-col w-full h-full bg-white to-pink-200">
                    <div class="p-5 pt-7">
                        <!-- 头部控制 -->
                        <div class="flex items-center justify-between mb-4 px-1">
                            <div class="flex flex-col">
                                <h2 class="text-lg font-bold text-gray-800 tracking-tight">2026年 1月</h2>
                            </div>
                            <div class="flex gap-1">
                                <button class="p-1.5 hover:bg-white/40 rounded-full transition-all active:scale-90">
                                    <svg class="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7" /></svg>
                                </button>
                                <button class="p-1.5 hover:bg-white/40 rounded-full transition-all active:scale-90">
                                    <svg class="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7" /></svg>
                                </button>
                            </div>
                        </div>

                        <!-- 完整月历网格 -->
                        <div class="grid grid-cols-7 gap-x-4 gap-y-1 text-center">
                            <!-- 星期标题 -->
                            <div class="h-6 flex items-center justify-center text-[10px] font-bold text-slate-400 uppercase tracking-widest">S</div>
                            <div class="h-6 flex items-center justify-center text-[10px] font-bold text-slate-400 uppercase tracking-widest">M</div>
                            <div class="h-6 flex items-center justify-center text-[10px] font-bold text-slate-400 uppercase tracking-widest">T</div>
                            <div class="h-6 flex items-center justify-center text-[10px] font-bold text-slate-400 uppercase tracking-widest">W</div>
                            <div class="h-6 flex items-center justify-center text-[10px] font-bold text-slate-400 uppercase tracking-widest">T</div>
                            <div class="h-6 flex items-center justify-center text-[10px] font-bold text-slate-400 uppercase tracking-widest">F</div>
                            <div class="h-6 flex items-center justify-center text-[10px] font-bold text-slate-400 uppercase tracking-widest">S</div>

                            <!-- 第一行 -->
                            <div class="h-9 flex items-center justify-center text-sm text-slate-300">24</div>
                            <div class="h-9 flex items-center justify-center text-sm text-slate-300">25</div>
                            <div class="h-9 flex items-center justify-center text-sm text-slate-300">26</div>
                            <div class="h-9 flex items-center justify-center text-sm text-slate-300">27</div>
                            <div class="h-9 flex items-center justify-center text-sm text-slate-300">28</div>
                            <div class="h-9 flex items-center justify-center text-sm text-slate-300">29</div>
                            <div class="h-9 flex items-center justify-center text-sm text-slate-300">30</div>

                            <!-- 10月数据 -->
                            <div class="h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer">1</div>
                            <div class="h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer relative">
                                2 <span class="absolute bottom-1 w-1 h-1 bg-rose-400 rounded-full"></span>
                            </div>
                            <!-- 选中状态：液态深色 -->
                            <div class="h-9 flex items-center justify-center text-sm font-bold text-white bg-slate-800 rounded-xl shadow-lg shadow-black/20 ring-1 ring-black/10">3</div>
                            <div class="h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer">4</div>
                            <div class="h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer">5</div>
                            <div class="h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer relative">
                                6 <span class="absolute bottom-1 w-1 h-1 bg-sky-400 rounded-full"></span>
                            </div>
                            <div class="h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer">7</div>

                            <!-- 循环行示例 -->
                            <div class="h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer">8</div>
                            <div class="h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer">9</div>
                            <div class="h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer">10</div>
                            <div class="h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer">11</div>
                            <div class="h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer">12</div>
                            <div class="h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer relative">
                                13 <span class="absolute bottom-1 w-1 h-1 bg-amber-400 rounded-full"></span>
                            </div>
                            <div class="h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer">14</div>

                            <!-- ... 更多行省略，保持视觉比例正确 -->
                            <div class="h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer">...</div>
                            <div class="h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer">29</div>
                            <div class="h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer">30</div>
                            <div class="h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer">31</div>
                        </div>
                    </div>

                    <!-- 下部分：日程表 (占据大部) -->
                    <div id="calendar-current-day-schedule" class="flex-1 overflow-y-auto bg-white/10 rounded-t-[32px] p-6 space-y-5">

                    </div>

                    <!-- 底部 Home Indicator (iOS/macOS 全屏常用) -->
                    <div class="h-8 flex justify-center items-center">
                        <div class="w-16 h-1 w-24 bg-black/10 rounded-full"></div>
                    </div>
                </div>
            </div>

            <!-- 右侧面板 -->
            <div id="rightPanel" slot="right" class="bg-white p-0 overflow-auto w-full h-full">
                abc
            </div>
        </splitter-widget>
        `;
    }
}

customElements.define('calendar-entry-widget', CalendarEntryWidget);