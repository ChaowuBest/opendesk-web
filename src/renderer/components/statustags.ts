class TaskStatusTag extends HTMLElement {
    status: 'running' = 'running';

    constructor() {
        super();
        this.status = 'running';
    }

    connectedCallback() {
        this.render();
    }

    render() {
        this.innerHTML = `
        <div class="flex items-center justify-between">
            <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-100 shadow-sm relative overflow-hidden">
                <!-- 呼吸圆点 -->
                <span class="relative flex h-2 w-2 mr-1.5">
                    <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                    <span class="relative inline-flex rounded-full h-2 w-2 bg-blue-600"></span>
                </span>
                进行中
                <!-- 扫光特效粒子 (装饰) -->
                <span class="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/40 to-transparent -translate-x-full animate-[shimmer_2s_infinite]"></span>
            </span>
        </div>
        `
    }
}

if (!customElements.get('task-status-tag')) {
    customElements.define('task-status-tag', TaskStatusTag);
}