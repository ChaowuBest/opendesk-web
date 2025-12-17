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
        <div class="h-full flex flex-col">
            <header class="py-2 flex items-center flex-shrink-0">
                <h1 class="text-lg font-semibold text-gray-800">Flipper Desk</h1>
            </header>

            <div class="py-2 flex flex-col gap-2 flex-shrink-0">
                <button
                    id="create-task-btn"
                    class="w-full flex items-center justify-start gap-2 px-4 py-3 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-xl text-gray-700 font-medium transition-colors duration-200"
                >
                    <span class="text-lg">+</span>
                    <span>新建话题</span>
                </button>
            </div>

            <div id="task-list-container" class="flex-1 overflow-y-auto py-2">
            </div>

            <div class="flex-shrink-0 w-full flex justify-center items-center py-3">
                <div class="flex justify-center items-center">
                    <button id="open-home-btn" class="mx-2 text-gray-500 hover:text-blue-600 text-lg focus:outline-none" title="主页">
                        <i class="fa-solid fa-house"></i>
                    </button>
                    <button id="open-memory-btn" class="mx-2 text-gray-500 hover:text-blue-600 text-lg focus:outline-none" title="记忆">
                        <i class="fa-solid fa-hard-drive"></i>
                    </button>
                    <button id="open-file-system-btn" class="mx-2 text-gray-500 hover:text-blue-600 text-lg focus:outline-none" title="文件系统">
                        <i class="fa-solid fa-folder-open"></i>
                    </button>
                    <button id="open-setting-editor-btn" class="mx-2 text-gray-500 hover:text-blue-600 text-lg focus:outline-none" title="设置">
                        <i class="fa-solid fa-cog"></i>
                    </button>
                    <button id="open-dev-tools-btn" class="mx-2 text-gray-500 hover:text-blue-600 text-lg focus:outline-none" title="开发工具">
                        <i class="fa-solid fa-terminal"></i>
                    </button>
                    <button id="open-log-view-btn" class="mx-2 text-gray-500 hover:text-blue-600 text-lg focus:outline-none" title="日志">
                        <i class="fa-solid fa-file-lines"></i>
                    </button>
                </div>
            </div>
        </div>
        `
    }

    reloadTaskList() {
        let task_list_container = this.querySelector('#task-list-container');
        task_list_container.innerHTML = '';
        for (let task of this.taskList) {
            let task_style = '';
            if (task.task_id === this.currentTaskId) {
                task_style = 'bg-blue-500 text-white';
            } else {
                task_style = 'bg-white text-gray-700';
            }
            task_list_container.innerHTML += `
            <div class="task-item ${task_style} cursor-pointer rounded-xl p-3 mb-2" data-task_id="${task.task_id}">
                <div class="flex items-center justify-between">
                    <p class="text-sm font-semibold">${task.task_name || '未命名任务'}</p>
                    <button
                        class="delete-task-btn ml-2 w-7 h-7 flex items-center justify-center rounded-full bg-gray-200 hover:bg-blue-500 transition-colors duration-200"
                        data-task_id="${task.task_id}"
                        title="删除"
                    >
                        <span class="text-lg font-bold text-gray-600 pointer-events-none group-hover:text-white" style="line-height:1;">×</span>
                    </button>
                </div>
            </div>
            `
        }

        task_list_container.querySelectorAll('.task-item').forEach(item => {
            item.addEventListener('click', (event) => {
                console.info('task item clicked', event.currentTarget.dataset.task_id);
                const taskId = event.currentTarget.dataset.task_id;
                window.globalControlAPI.openTask(taskId);
                this.currentTaskId = taskId;
                // reload task list to update the current task item
                this.reloadTaskList();
            })
        })

        task_list_container.querySelectorAll('.delete-task-btn').forEach(btn => {
            btn.addEventListener('click', async (event) => {
                event.stopPropagation(); // 阻止事件冒泡，避免触发父元素的打开事件
                // 弹出确认框，确认是否删除
                const confirmDelete = window.confirm("确定要删除这个任务吗？删除后无法恢复。");
                if (!confirmDelete) {
                    return;
                }
                console.info('delete task btn clicked', event.currentTarget.dataset.task_id);
                const taskId = event.currentTarget.dataset.task_id;
                if (this.currentTaskId === taskId) {
                    window.globalControlAPI.openTask(null);
                }
                await window.taskManagerAPI.removeTask(taskId);
                // 这里无需手动reload，等接收到taskListUpdate事件时会自动reload
            })
        })
    }
}


customElements.define("main-sidebar", SideBar)