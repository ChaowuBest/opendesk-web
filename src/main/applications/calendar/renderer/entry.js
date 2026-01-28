import { ElasticToolbarWidget } from '../../../../renderer/components/toolbar.ts';


class CalendarEntryWidget extends HTMLElement {
    constructor() {
        super();
        this.currentDate = new Date();
    }

    connectedCallback() {
        this.render();

        // 添加月份切换按钮事件
        const prevMonthBtn = this.querySelector('#prev-month-btn');
        const nextMonthBtn = this.querySelector('#next-month-btn');

        if (prevMonthBtn) {
            prevMonthBtn.addEventListener('click', () => {
                const newDate = new Date(this.currentDate.getFullYear(), this.currentDate.getMonth() - 1, 1);
                const daysInNewMonth = new Date(newDate.getFullYear(), newDate.getMonth() + 1, 0).getDate();
                const day = Math.min(this.currentDate.getDate(), daysInNewMonth);
                this.currentDate = new Date(newDate.getFullYear(), newDate.getMonth(), day);
                this.renderCalendarGrid();
                this.updateMonthHeader();
                this.setCurrentDate();
            });
        }

        if (nextMonthBtn) {
            nextMonthBtn.addEventListener('click', () => {
                const newDate = new Date(this.currentDate.getFullYear(), this.currentDate.getMonth() + 1, 1);
                const daysInNewMonth = new Date(newDate.getFullYear(), newDate.getMonth() + 1, 0).getDate();
                const day = Math.min(this.currentDate.getDate(), daysInNewMonth);
                this.currentDate = new Date(newDate.getFullYear(), newDate.getMonth(), day);
                this.renderCalendarGrid();
                this.updateMonthHeader();
                this.setCurrentDate();
            });
        }

        // 初始化月历和日期
        this.updateMonthHeader();
        this.renderCalendarGrid();
        this.setCurrentDate();
    }

    renderCalendarGrid() {
        const calendarGrid = this.querySelector('#calendar-grid');
        if (!calendarGrid) return;

        const year = this.currentDate.getFullYear();
        const month = this.currentDate.getMonth();

        // 获取当月第一天和最后一天
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const firstDayOfWeek = firstDay.getDay(); // 0 = 星期日
        const daysInMonth = lastDay.getDate();

        // 获取上个月的最后几天
        const prevMonthLastDay = new Date(year, month, 0).getDate();

        let gridHTML = '';

        // 星期标题
        const weekDays = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
        weekDays.forEach(day => {
            gridHTML += `<div class="h-6 flex items-center justify-center text-[10px] font-bold text-slate-400 uppercase tracking-widest">${day}</div>`;
        });

        // 上个月的日期（灰色显示）
        for (let i = firstDayOfWeek - 1; i >= 0; i--) {
            const day = prevMonthLastDay - i;
            gridHTML += `<div class="h-9 flex items-center justify-center text-sm text-slate-300">${day}</div>`;
        }

        // 当月的日期
        const today = new Date();
        const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;
        const selectedDate = this.currentDate.getDate();

        for (let day = 1; day <= daysInMonth; day++) {
            const isToday = isCurrentMonth && day === today.getDate();
            const isSelected = day === selectedDate;

            let classes = 'h-9 flex items-center justify-center text-sm font-medium text-slate-700 hover:bg-white/60 rounded-xl cursor-pointer';

            if (isSelected) {
                classes = 'h-9 flex items-center justify-center text-sm font-bold text-white bg-slate-800 rounded-xl shadow-lg shadow-black/20 ring-1 ring-black/10';
            } else if (isToday) {
                classes += ' ring-2 ring-blue-400';
            }

            gridHTML += `<div class="${classes}" data-day="${day}">${day}</div>`;
        }

        // 下个月的日期（填充剩余格子，灰色显示）
        const totalCells = firstDayOfWeek + daysInMonth;
        const remainingCells = 42 - totalCells; // 6行 x 7列 = 42
        for (let day = 1; day <= remainingCells && day <= 14; day++) {
            gridHTML += `<div class="h-9 flex items-center justify-center text-sm text-slate-300">${day}</div>`;
        }

        calendarGrid.innerHTML = gridHTML;

        // 为日期添加点击事件
        calendarGrid.querySelectorAll('[data-day]').forEach(cell => {
            cell.addEventListener('click', () => {
                const day = parseInt(cell.getAttribute('data-day'));
                this.currentDate = new Date(year, month, day);
                this.setCurrentDate();
                this.renderCalendarGrid();
            });
        });
    }

    updateMonthHeader() {
        const monthHeader = this.querySelector('#month-header');
        if (!monthHeader) return;

        const year = this.currentDate.getFullYear();
        const month = this.currentDate.getMonth() + 1;
        monthHeader.textContent = `${year}年 ${month}月`;
    }

    async setCurrentDate(dateString = undefined) {
        if (dateString) {
            this.currentDate = new Date(dateString);
        }

        var date = this.currentDate;
        const weekdayNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const dayOfWeek = weekdayNames[date.getDay()];
        const currentDateString = date.toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        }) + ' ' + dayOfWeek;

        const scheduleElement = this.querySelector('#calendar-current-day-schedule');
        var scheduleHTML = '';
        scheduleHTML += `
        <div class="flex items-center justify-between mb-2">
            <span class="text-[11px] font-bold text-gray-500 uppercase tracking-[0.15em]">${currentDateString}</span>
            <span class="w-8 h-8 rounded-full bg-white/40 flex items-center justify-center text-blue-600 font-bold">+</span>
        </div>
        `;

        const calendarItems = await window.applicationAPI.call('getCalendarItems', date.toLocaleDateString());

        for (let i = 0; i < calendarItems.length; i++) {
            const item = calendarItems[i];
            const startTime = new Date(item.startTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            scheduleHTML += `
            <div class="calendar-item flex gap-4 cursor-pointer" data-item-index="${i}">
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

        // 为每个日历条目添加点击事件
        scheduleElement.querySelectorAll('.calendar-item').forEach((element, index) => {
            element.addEventListener('click', () => {
                this.showCalendarItem(calendarItems[index]);
            });
        });

        // 更新月历网格和头部
        this.renderCalendarGrid();
        this.updateMonthHeader();
        this.clearCalendarItem();
    }

    async clearCalendarItem() {
        const rightPanel = this.querySelector('#rightPanel');
        rightPanel.innerHTML = `
        <div class="w-full flex flex-col items-center justify-center text-center p-12 overflow-hidden relative">
            <!-- 装饰性背景光晕 -->
            <div class="absolute inset-0 overflow-hidden pointer-events-none">
                <div class="absolute -top-24 -left-24 w-64 h-64 bg-blue-100/30 rounded-full blur-3xl text-blue-100"></div>
                <div class="absolute -bottom-24 -right-24 w-64 h-64 bg-purple-100/30 rounded-full blur-3xl"></div>
            </div>

            <!-- 核心占位图形 -->
            <div class="relative mb-8">
                <!-- 底层阴影环 -->
                <div class="absolute inset-0 bg-gray-200/50 rounded-full blur-xl animate-pulse-soft"></div>

                <!-- 大图标 -->
                <div class="relative w-24 h-24 bg-white/60 rounded-3xl shadow-inner flex items-center justify-center border border-white/80">
                    <i class="fa-solid fa-calendar-day text-5xl icon-gradient"></i>
                </div>

                <!-- 浮动装饰小图标 -->
                <div class="absolute -right-2 -top-2 w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center text-white text-xs shadow-lg shadow-blue-200 border-2 border-white animate-bounce-slow">
                    <i class="fa-solid fa-plus"></i>
                </div>
            </div>

            <!-- 文字说明 -->
            <div class="relative z-10">
                <h3 class="text-xl font-semibold text-gray-800 mb-2">未选择日程</h3>
                <p class="text-sm text-gray-500 max-w-[260px] leading-relaxed mx-auto">
                    从左侧列表中选择一个项目以查看其详细内容，或者点击下方按钮创建新安排。
                </p>
            </div>

            <!-- 快速操作按钮 -->
            <div class="mt-10 flex gap-4">
                <button class="px-6 py-2 bg-white/80 hover:bg-white text-gray-700 text-sm font-medium rounded-lg border border-gray-200 shadow-sm transition-all active:scale-95">
                    浏览日历
                </button>
                <button class="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white text-sm font-medium rounded-lg shadow-md shadow-blue-100 transition-all active:scale-95">
                    立即添加
                </button>
            </div>
        </div>
        `;
    }

    async showCalendarItem(item) {
        const rightPanel = this.querySelector('#rightPanel');

        // 格式化日期和时间
        const startDate = new Date(item.startTime);
        const endDate = item.endTime ? new Date(item.endTime) : null;
        const startTimeStr = startDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        const endTimeStr = endDate ? endDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
        const timeRange = endTimeStr ? `${startTimeStr} — ${endTimeStr}` : startTimeStr;

        const dateStr = startDate.toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        const weekdayNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const dayOfWeek = weekdayNames[startDate.getDay()];
        const fullDateStr = `${dateStr} ${dayOfWeek}`;

        const monthName = startDate.toLocaleDateString('zh-CN', { month: 'long' });
        const dayNum = startDate.getDate();

        rightPanel.innerHTML = `
        <div class="glass-panel w-full overflow-hidden animate-in fade-in zoom-in duration-300">

            <!-- 顶部工具栏 -->
            <div id='calendar-item-toolbar' class="pl-3 pr-16 flex justify-between items-center section-divider">

            </div>

            <!-- 内容主体 -->
            <div class="p-8">
                <!-- 标题与状态 -->
                <div class="mb-8">
                    <div class="flex items-center gap-3 mb-2">
                        <span class="w-3 h-3 rounded-full bg-blue-500"></span>
                        <span class="text-xs font-bold text-blue-600 uppercase tracking-widest">日程</span>
                    </div>
                    <h1 class="text-3xl font-bold text-gray-900 tracking-tight">${item.subject || '无标题'}</h1>
                </div>

                <!-- 时间信息卡片 -->
                <div class="flex items-start gap-6 mb-8 p-4 bg-white/30 rounded-xl border border-white/40">
                    <div class="flex flex-col items-center justify-center bg-white rounded-lg shadow-sm w-16 h-16 border border-gray-100">
                        <span class="text-[10px] font-bold text-red-500 uppercase">${monthName}</span>
                        <span class="text-2xl font-bold text-gray-800 leading-none">${dayNum}</span>
                    </div>
                    <div class="space-y-1">
                        <div class="flex items-center text-gray-800 font-medium">
                            <i class="fa-regular fa-clock w-6 text-gray-400"></i>
                            ${timeRange}
                        </div>
                        <div class="flex items-center text-gray-500 text-sm">
                            <i class="fa-regular fa-calendar-check w-6 text-gray-400"></i>
                            ${fullDateStr}
                        </div>
                        ${item.location ? `
                        <div class="flex items-center text-gray-500 text-sm">
                            <i class="fa-solid fa-location-dot w-6 text-gray-400"></i>
                            ${item.location}
                        </div>
                        ` : ''}
                    </div>
                </div>

                <!-- 详细内容描述 -->
                <div class="space-y-6">
                    ${item.description ? `
                    <section>
                        <h4 class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">日程描述</h4>
                        <div class="text-gray-700 leading-relaxed bg-white/20 p-4 rounded-xl border border-black/5">
                            ${item.description}
                        </div>
                    </section>
                    ` : ''}

                    ${item.attendees && item.attendees.length > 0 ? `
                    <section>
                        <h4 class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3">参与人员 (${item.attendees.length})</h4>
                        <div class="flex flex-wrap gap-2">
                            ${item.attendees.map((attendee, idx) => `
                            <div class="flex items-center bg-white/50 border border-gray-200 py-1 px-3 rounded-full shadow-sm">
                                <img src="https://i.pravatar.cc/100?u=${idx}" class="w-5 h-5 rounded-full mr-2">
                                <span class="text-xs font-medium text-gray-700">${attendee}</span>
                            </div>
                            `).join('')}
                        </div>
                    </section>
                    ` : ''}
                </div>
            </div>
        </div>
        `;

        const buttons = [
            { id: 'calendar-item-back-button', icon: 'fa-circle-arrow-left', label: '返回', action: () => {
                this.clearCalendarItem();
            }},
            { id: 'calendar-item-edit-button', icon: 'fa-edit', label: '编辑', action: () => {
                console.log('编辑日程', item);
            }},
            { id: 'calendar-item-delete-button', icon: 'fa-trash-alt', label: '删除', action: () => {
                console.log('删除日程', item);
            }},
        ];
        const headerToolbar = new ElasticToolbarWidget(buttons);
        this.querySelector('#calendar-item-toolbar').appendChild(headerToolbar);
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
                                <h2 id="month-header" class="text-lg font-bold text-gray-800 tracking-tight">2026年 1月</h2>
                            </div>
                            <div class="flex gap-1">
                                <button id="prev-month-btn" class="p-1.5 hover:bg-white/40 rounded-full transition-all active:scale-90">
                                    <svg class="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7" /></svg>
                                </button>
                                <button id="next-month-btn" class="p-1.5 hover:bg-white/40 rounded-full transition-all active:scale-90">
                                    <svg class="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7" /></svg>
                                </button>
                            </div>
                        </div>

                        <!-- 完整月历网格 -->
                        <div id="calendar-grid" class="grid grid-cols-7 gap-x-4 gap-y-1 text-center">
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
            </div>
        </splitter-widget>
        `;
    }
}

customElements.define('calendar-entry-widget', CalendarEntryWidget);