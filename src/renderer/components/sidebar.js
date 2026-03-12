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

import './statustags';


class SideBar extends HTMLElement {

    constructor() {
        super();

        /**
         * The current task id
         * @type {string | null}
         */
        this.currentTaskId = null;
        this.taskList = [];
    }

    connectedCallback() {
        this.render();
        window.taskManagerAPI.getTaskList().then(taskList => {
            this.taskList = taskList;
            this.reloadTaskList();
            this.setUpEventListeners();
        })
    }

    disconnectedCallback() {
        if (this.unreadCountsUnsubscribe) {
            this.unreadCountsUnsubscribe();
        }
    }

    setUpEventListeners() {
        window.taskManagerAPI.subscribeTaskListUpdate(taskList => {
            console.info('task list updated', taskList)
            this.taskList = taskList;
            this.reloadTaskList();
        })
        this.querySelector('#create-task-btn').addEventListener('click', async () => {
            const taskId = await window.taskManagerAPI.createTask();
            window.globalControlAPI.openTask(taskId);
            this.currentTaskId = taskId;
            this.reloadTaskList();
        })
        this.querySelector('#open-home-btn').addEventListener('click', () => {
            this.currentTaskId = null;
            window.globalControlAPI.openHomePage();
            this.reloadTaskList();
        })
        this.querySelector('#open-memory-btn').addEventListener('click', () => {
            // window.globalControlAPI.openMemory();
        })
        this.querySelector('#open-file-system-btn').addEventListener('click', () => {
            // window.globalControlAPI.openFileSystem();
        })
        this.querySelector('#open-setting-editor-btn').addEventListener('click', () => {
            window.globalControlAPI.openSettingEditor();
        })
        this.querySelector('#open-dev-tools-btn').addEventListener('click', () => {
            window.settingAPI.openDevTools();
        })
        this.querySelector('#open-log-view-btn').addEventListener('click', () => {
            window.globalControlAPI.openLogView();
        })
    }

    render() {
        this.innerHTML = `
        <style>
            [x-cloak] {
                display: none !important;
            }
        </style>

        <div class="h-full flex flex-col" x-data="{ showApps: false }">
            <header class="py-2 px-1 flex flex-row items-start flex-shrink-0">
                <img src="./images/icon_round.png" alt="Fillip Desk Icon" class="w-12 h-12 mr-3"/>
                <div class="flex flex-col items-start">
                    <img src="./images/banner.png" alt="Fillip Desk Banner" class="w-32 h-auto"/>
                    <p class="text-xs mt-1 text-gray-500">一站式智慧办公空间</p>
                </div>
            </header>
            <div class="py-2 flex flex-row gap-2 flex-shrink-0">
                <button
                    id="open-home-btn"
                    class="flex-1 flex items-center justify-center gap-1 px-2 py-3 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-2xl text-gray-700 font-normal text-sm transition-colors duration-200"
                >
                    <i class="fa-solid fa-house"></i>
                    <span>主页</span>
                </button>
                <button
                    id="open-apps-btn"
                    @click="showApps = !showApps"
                        :class="showApps ? 'ring-2 ring-orange-400 bg-orange-50' : ''"
                    class="flex-1 flex items-center justify-center gap-1 px-2 py-3 bg-green-50 hover:bg-green-100 border border-green-200 rounded-2xl text-green-700 font-normal text-sm transition-colors duration-200"
                >
                    <i class="fa-solid fa-th-large"></i>
                    <span>应用</span>
                </button>
                <button
                    id="create-task-btn"
                    class="flex-1 flex items-center justify-center gap-1 px-2 py-3 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-2xl text-blue-700 font-normal text-sm transition-colors duration-200"
                >
                    <i class="fa-solid fa-comments"></i>
                    <span>新任务</span>
                </button>
            </div>

            <div
                x-cloak
                x-show="showApps"
                x-transition:enter="transition ease-out duration-300"
                x-transition:enter-start="opacity-0 transform translate-y-4"
                x-transition:enter-end="opacity-100 transform translate-y-0"
                class="bg-white/90 backdrop-blur-xl rounded-2xl p-4 border border-white/50 shadow-sm my-1"
            >
                <div id="app-container" class="flex flex-wrap gap-y-5 gap-x-2 items-center justify-left">

                </div>
            </div>

            <div id="task-list-container" class="flex-1 overflow-y-auto py-2 pr-2">
            </div>

            <div class="flex-shrink-0 w-full flex justify-center items-center py-3">
                <div class="flex justify-center items-center bg-white/40 backdrop-blur-2xl rounded-full border border-white/40 shadow-2xl px-4 py-1">
                    <button id="open-memory-btn" class="mx-3 text-gray-500 hover:text-blue-600 text-lg focus:outline-none" title="记忆" disabled>
                        <i class="fa-solid fa-hard-drive"></i>
                    </button>
                    <button
                        id="open-file-system-btn"
                        class="mx-3 text-gray-500 hover:text-blue-600 text-lg focus:outline-none"
                        title="文件系统"
                        onclick="window.globalControlAPI.openApplication('filemgr')"
                    >
                        <i class="fa-solid fa-folder-open"></i>
                    </button>
                    <button id="open-setting-editor-btn" class="mx-3 text-gray-500 hover:text-blue-600 text-lg focus:outline-none" title="设置">
                        <i class="fa-solid fa-cog"></i>
                    </button>
                    <button id="open-dev-tools-btn" class="mx-3 text-gray-500 hover:text-blue-600 text-lg focus:outline-none" title="开发工具">
                        <i class="fa-solid fa-terminal"></i>
                    </button>
                    <button id="open-log-view-btn" class="mx-3 text-gray-500 hover:text-blue-600 text-lg focus:outline-none" title="日志">
                        <i class="fa-solid fa-file-lines"></i>
                    </button>
                </div>
            </div>
        </div>
        `
        this.reloadApplicationList();
    }

    async reloadApplicationList() {
        const app_container = this.querySelector('#app-container');
        app_container.innerHTML = '';
        const appList = await window.applicationRegistryAPI.getApplicationList();
        for (let app of appList) {
            if (app.showIcon === false) continue;
            const isMailbox = app.bundleName === 'mailbox';
            app_container.innerHTML += `
            <div class="flex flex-col items-center group cursor-pointer relative" onclick="window.globalControlAPI.openApplication('${app.bundleName}')" data-bundle-name="${app.bundleName}">
                <div class="rounded-full w-12 h-12 shadow-lg transform transition duration-200 group-hover:brightness-90 group-active:scale-95 flex items-center justify-center relative">
                    <img src="./applications/${app.bundleName}/icon.png" alt="${app.name}" class="w-full h-full object-cover">
                    ${isMailbox ? '<span class="mailbox-unread-badge absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 hidden">0</span>' : ''}
                </div>
                <span class="mt-2 text-xs font-medium text-gray-800 drop-shadow-sm w-16 text-center truncate">${app.name}</span>
            </div>
            `
        }
        // 更新邮箱应用的未读数量标记
        this.updateMailboxBadge();
    }

    async updateMailboxBadge() {
        try {
            const counts = await window.applicationRegistryAPI.call('mailbox', 'getAllNewEmailCounts');
            const total = Object.values(counts || {}).reduce((sum, count) => sum + (count || 0), 0);
            const mailboxApp = this.querySelector('[data-bundle-name="mailbox"]');
            if (mailboxApp) {
                const badge = mailboxApp.querySelector('.mailbox-unread-badge');
                if (badge) {
                    if (total > 0) {
                        badge.textContent = total > 99 ? '99+' : total.toString();
                        badge.classList.remove('hidden');
                    } else {
                        badge.classList.add('hidden');
                    }
                }
            }
        } catch (error) {
            console.error('Failed to update mailbox badge:', error);
        }
    }

    connectedCallback() {
        this.render();
        window.taskManagerAPI.getTaskList().then(taskList => {
            this.taskList = taskList;
            this.reloadTaskList();
            this.setUpEventListeners();
            this.subscribeToUnreadCounts();
        })
    }

    disconnectedCallback() {
        if (this.unreadCountsUnsubscribe) {
            this.unreadCountsUnsubscribe();
        }
    }

    async subscribeToUnreadCounts() {
        // 订阅新邮件数量更新事件
        try {
            this.unreadCountsUnsubscribe = await window.applicationRegistryAPI.subscribeEvent('mailbox', 'newEmailCountsUpdated', (counts) => {
                const total = Object.values(counts || {}).reduce((sum, count) => sum + (count || 0), 0);
                const mailboxApp = this.querySelector('[data-bundle-name="mailbox"]');
                if (mailboxApp) {
                    const badge = mailboxApp.querySelector('.mailbox-unread-badge');
                    if (badge) {
                        if (total > 0) {
                            badge.textContent = total > 99 ? '99+' : total.toString();
                            badge.classList.remove('hidden');
                        } else {
                            badge.classList.add('hidden');
                        }
                    }
                }
            });
            // 初始加载新邮件数量
            this.updateMailboxBadge();
        } catch (error) {
            console.error('Failed to subscribe to new email counts:', error);
        }
    }

    buildTaskRenderList() {
        const childrenByParent = new Map();
        const rootTasks = [];

        for (const task of this.taskList) {
            if (task.parent_id) {
                if (!childrenByParent.has(task.parent_id)) {
                    childrenByParent.set(task.parent_id, []);
                }
                childrenByParent.get(task.parent_id).push(task);
            } else {
                rootTasks.push(task);
            }
        }

        const renderList = [];
        const visited = new Set();
        const appendTask = (task, depth) => {
            if (!task || visited.has(task.task_id)) return;
            visited.add(task.task_id);
            renderList.push({ task, depth });
            const children = childrenByParent.get(task.task_id) || [];
            for (const child of [...children].reverse()) {
                appendTask(child, depth + 1);
            }
        };

        for (const rootTask of [...rootTasks].reverse()) {
            appendTask(rootTask, 0);
        }

        for (const task of [...this.taskList].reverse()) {
            if (!visited.has(task.task_id)) {
                appendTask(task, 0);
            }
        }

        return renderList;
    }

    reloadTaskList() {
        const standardClass = 'cursor-pointer rounded-xl pr-2 py-2 mb-2 transition-colors duration-200';
        const taskListContainer = this.querySelector('#task-list-container');
        taskListContainer.innerHTML = '';

        const renderList = this.buildTaskRenderList();
        for (const item of renderList) {
            const task = item.task;
            const depth = item.depth;
            const indentPx = 12 + Math.min(depth, 5) * 14;

            let taskStyle = '';
            if (task.task_id === this.currentTaskId) {
                taskStyle = 'bg-[#C94C40] text-white font-semibold';
            } else if (depth > 0) {
                taskStyle = 'bg-gray-50 text-gray-700 hover:bg-gray-100 border-l-2 border-l-gray-200';
            } else {
                taskStyle = 'bg-white text-gray-700 hover:shadow-sm hover:border-l-2 hover:border-l-[#C94C40]';
            }

            const subTaskBadge = depth > 0
                ? '<span class="ml-2 text-[10px] px-2 py-0.5 rounded-full bg-gray-200 text-gray-700">子任务</span>'
                : '';

            taskListContainer.innerHTML += `
            <div
                class="task-item ${taskStyle} ${standardClass}"
                style="padding-left:${indentPx}px"
                data-task_id="${task.task_id}"
                data-parent_id="${task.parent_id || ''}"
                data-depth="${depth}"
            >
                <div class="flex items-center justify-between">
                    <p class="text-sm truncate">${task.task_name || '未命名任务'}</p>
                    ${subTaskBadge}
                    ${task.task_status === 'running' ? '<task-status-tag class="ml-2"></task-status-tag>' : ''}
                    <button
                        class="delete-task-btn ml-auto w-5 h-5 flex items-center justify-center rounded-full bg-white hover:bg-[#FFF8E7] transition-colors duration-200"
                        data-task_id="${task.task_id}"
                        title="删除"
                    >
                        <span class="text-sm text-gray-600 pointer-events-none hover:text-white transition-colors duration-200" style="line-height:1;">×</span>
                    </button>
                </div>
            </div>
            `;
        }

        if (this.taskList.length > 0) {
            taskListContainer.innerHTML += `
            <div id="delete-all-tasks-btn" class="${standardClass} bg-white text-sm text-gray-700 hover:bg-[#C94C40] hover:text-white flex items-center justify-center gap-2">
                <i class="fa-solid fa-trash"></i>
                <span>全部删除</span>
            </div>
            `;
        }

        taskListContainer.querySelectorAll('.task-item').forEach(item => {
            item.addEventListener('click', (event) => {
                const taskId = event.currentTarget.dataset.task_id;
                window.globalControlAPI.openTask(taskId);
                this.currentTaskId = taskId;
                this.reloadTaskList();
            });
        });

        this.querySelector('#delete-all-tasks-btn')?.addEventListener('click', async (event) => {
            event.stopPropagation();
            if (!window.confirm('确定要删除所有任务吗？删除后无法恢复。')) return;
            window.globalControlAPI.openHomePage();
            this.currentTaskId = null;
            await window.taskManagerAPI.clearAllTasks();
            this.reloadTaskList();
        });

        taskListContainer.querySelectorAll('.delete-task-btn').forEach(btn => {
            btn.addEventListener('click', async (event) => {
                event.stopPropagation();
                const confirmDelete = window.confirm('确定要删除这个任务吗？删除后无法恢复。');
                if (!confirmDelete) return;

                const taskId = event.currentTarget.dataset.task_id;
                if (this.currentTaskId === taskId) {
                    window.globalControlAPI.openTask(null);
                }
                await window.taskManagerAPI.removeTask(taskId);
            });
        });
    }
}


customElements.define("main-sidebar", SideBar)