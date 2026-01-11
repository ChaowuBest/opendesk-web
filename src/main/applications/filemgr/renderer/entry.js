import { AgentOperableHTMLElement } from '../../widget_utils.js';


class FileMgrEntryWidget extends AgentOperableHTMLElement {
    constructor() {
        super();
        this.reloadInterval = null;
    }

    connectedCallback() {
        this.render();
    }

    disconnectedCallback() {
        if (this.reloadInterval) {
            clearInterval(this.reloadInterval);
            this.reloadInterval = null;
        }
    }

    render() {
        this.innerHTML = `
        <div class="w-full h-full flex flex-col bg-gradient-to-br from-slate-50 via-white to-slate-100">
            <header class="pl-6 pr-16 py-4 flex items-center justify-between border-b bg-white/80 backdrop-blur">
                <div>
                    <p class="text-xs uppercase tracking-wide text-gray-400">轻松寻找，管理和组织你的文件</p>
                    <h1 class="text-xl font-semibold text-gray-800">智能文件系统</h1>
                </div>
            </header>

            <div class="flex-1 p-4">
                <div class="flex flex-col w-full h-full">
                    <section id="file-system-status-cards" class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-5">
                        <content-loading-view class="col-span-full rounded-2xl" data-type="lr" data-message="加载文件系统状态..."></content-loading-view>
                    </section>

                    <!-- Main Content Area -->
                    <main class="bg-white rounded-3xl shadow-sm mb-12 border border-[#F0F0F2] overflow-y-auto flex-1 flex flex-col h-full">
                        <!-- Table Header / Actions -->
                        <div class="px-8 py-5 border-b border-[#F0F0F2] flex justify-between items-center bg-[#FAFAFB]">
                            <h2 class="font-semibold text-lg">被索引的文件夹</h2>
                            <div class="flex space-x-2">
                                <button class="p-2 text-[#424245] hover:bg-gray-200 rounded-md transition-colors" title="全量重新扫描">
                                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                    </svg>
                                </button>
                                <button class="p-2 text-[#424245] hover:bg-gray-200 rounded-md transition-colors" title="清理冗余缓存">
                                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                    </svg>
                                </button>
                            </div>
                        </div>

                        <!-- Folder List -->
                        <div class="overflow-x-auto min-h-0 max-h-full flex-1 flex flex-col">
                            <div class="flex-[1_1_0] min-h-0 overflow-y-auto">
                                <table class="w-full text-left border-collapse">
                                <thead>
                                    <tr class="text-[12px] uppercase text-[#86868B] tracking-wider border-b border-[#F0F0F2]">
                                        <th class="px-8 py-4 font-semibold">根目录</th>
                                        <th class="px-8 py-4 font-semibold text-center">文件数量</th>
                                        <th class="px-8 py-4 font-semibold">上次扫描时间</th>
                                        <th class="px-8 py-4 font-semibold text-right">操作点</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-[#F0F0F2]">
                                    <!-- Row 1 -->
                                    <tr class="hover:bg-[#FBFBFB] transition-colors group">
                                        <td class="px-8 py-5">
                                            <div class="flex items-center">
                                                <div class="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center mr-3">
                                                    <svg class="w-5 h-5 text-blue-500" fill="currentColor" viewBox="0 0 20 20 hover:scale-110 transition-transform"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"></path></svg>
                                                </div>
                                                <div>
                                                    <p class="font-medium text-sm">/Users/admin/Documents/Projects</p>
                                                    <p class="text-xs text-[#86868B]">包含 PDF, Markdown, Word</p>
                                                </div>
                                            </div>
                                        </td>
                                        <td class="px-8 py-5 text-center">
                                            <span class="bg-[#F5F5F7] px-2.5 py-1 rounded-full text-xs font-semibold">4,290</span>
                                        </td>
                                        <td class="px-8 py-5 text-sm text-[#424245]">
                                            今天 14:20
                                        </td>
                                        <td class="px-8 py-5 text-right">
                                            <button class="text-blue-600 text-xs font-medium hover:underline">立即同步</button>
                                            <span class="mx-2 text-gray-300">|</span>
                                            <button class="text-red-500 text-xs font-medium hover:underline opacity-0 group-hover:opacity-100 transition-opacity">移除</button>
                                        </td>
                                    </tr>

                                    <!-- Row 2 -->
                                    <tr class="hover:bg-[#FBFBFB] transition-colors group">
                                        <td class="px-8 py-5">
                                            <div class="flex items-center">
                                                <div class="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center mr-3">
                                                    <svg class="w-5 h-5 text-purple-500" fill="currentColor" viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"></path></svg>
                                                </div>
                                                <div>
                                                    <p class="font-medium text-sm">/Volumes/ExternalSSD/KnowledgeBase</p>
                                                    <p class="text-xs text-[#86868B]">包含 Obsidian 库</p>
                                                </div>
                                            </div>
                                        </td>
                                        <td class="px-8 py-5 text-center">
                                            <span class="bg-[#F5F5F7] px-2.5 py-1 rounded-full text-xs font-semibold">8,192</span>
                                        </td>
                                        <td class="px-8 py-5 text-sm text-[#424245]">
                                            2023-10-24 09:15
                                        </td>
                                        <td class="px-8 py-5 text-right">
                                            <button class="text-blue-600 text-xs font-medium hover:underline">立即同步</button>
                                            <span class="mx-2 text-gray-300">|</span>
                                            <button class="text-red-500 text-xs font-medium hover:underline opacity-0 group-hover:opacity-100 transition-opacity">移除</button>
                                        </td>
                                    </tr>

                                    <!-- Row 3 -->
                                    <tr class="hover:bg-[#FBFBFB] transition-colors group">
                                        <td class="px-8 py-5">
                                            <div class="flex items-center">
                                                <div class="w-8 h-8 bg-amber-100 rounded-lg flex items-center justify-center mr-3">
                                                    <svg class="w-5 h-5 text-amber-500" fill="currentColor" viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"></path></svg>
                                                </div>
                                                <div>
                                                    <p class="font-medium text-sm">/Users/admin/Downloads/Research</p>
                                                    <p class="text-xs text-[#86868B]">包含 临时论文</p>
                                                </div>
                                            </div>
                                        </td>
                                        <td class="px-8 py-5 text-center">
                                            <span class="bg-[#F5F5F7] px-2.5 py-1 rounded-full text-xs font-semibold">0</span>
                                        </td>
                                        <td class="px-8 py-5 text-sm text-amber-600 italic">
                                            等待首次扫描...
                                        </td>
                                        <td class="px-8 py-5 text-right">
                                            <button class="text-blue-600 text-xs font-medium hover:underline">开始扫描</button>
                                            <span class="mx-2 text-gray-300">|</span>
                                            <button class="text-red-500 text-xs font-medium hover:underline opacity-0 group-hover:opacity-100 transition-opacity">移除</button>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        <!-- Footer Action Bar -->
                        <div class="px-8 py-4 bg-[#FAFAFB] border-t border-[#F0F0F2] flex justify-between items-center text-xs text-[#86868B]">
                            <p>上次系统检查时间：10 分钟前</p>
                            <div class="flex items-center space-x-4 text-blue-600 font-medium">
                                <button class="hover:text-blue-800 transition-colors">暂停 AI 索引工作流</button>
                                <button class="hover:text-blue-800 transition-colors uppercase tracking-widest text-[10px]">REBUILD DATABASE</button>
                            </div>
                        </div>
                    </main>
                </div>
            </div>
        </div>
        `;
        this.reloadFileSystemStatus();
        this.reloadInterval = setInterval(() => {
            this.reloadFileSystemStatus();
        }, 5000);
    }

    async reloadFileSystemStatus() {
        const fileSystemStatusCards = this.querySelector('#file-system-status-cards');
        const fileSystemStatus = await window.applicationAPI.sendMessageToApplication('getFileSystemStatus');
        console.info('file system status:', fileSystemStatus);

        var fileSystemStatusHTML = '';
        switch (fileSystemStatus.status) {
            case 'running':
                fileSystemStatusHTML = `
                <div class="w-2.5 h-2.5 bg-green-500 rounded-full mr-2"></div>
                <span class="text-sm font-medium">运行中</span>
                `;
                break;
            case 'idle':
                fileSystemStatusHTML = `
                <div class="w-2.5 h-2.5 bg-red-500 rounded-full mr-2"></div>
                <span class="text-sm font-medium">未启动</span>
                `;
                break;
            default:
                fileSystemStatusHTML = `
                <div class="w-2.5 h-2.5 bg-gray-500 rounded-full mr-2"></div>
                <span class="text-sm font-medium">未知状态</span>
                `;
                break;
        }

        const statusHTML = `
        <div class="bg-white py-6 px-4 rounded-2xl shadow-sm border border-[#F0F0F2]">
            <p class="text-xs font-semibold text-[#86868B] uppercase tracking-wider">文件总数</p>
            <div class="mt-2 flex items-baseline">
                <span class="text-3xl font-bold">${fileSystemStatus.storage.db_size || '--'}</span>
            </div>
        </div>
        <div class="bg-white py-6 px-4 rounded-2xl shadow-sm border border-[#F0F0F2]">
            <p class="text-xs font-semibold text-[#86868B] uppercase tracking-wider">向量索引</p>
            <div class="mt-2 flex items-baseline">
                <span class="text-3xl font-bold">${fileSystemStatus.storage.vecdb_size || '--'}</span>
                <span class="ml-2 text-xs text-[#86868B]">条</span>
            </div>
        </div>
        <div class="bg-white py-6 px-4 rounded-2xl shadow-sm border border-[#F0F0F2]">
            <p class="text-xs font-semibold text-[#86868B] uppercase tracking-wider">向量缓存</p>
            <div class="mt-2 flex items-baseline">
                <span class="text-3xl font-bold">${fileSystemStatus.storage.veccache_size || '--'}</span>
                <span class="ml-2 text-xs text-[#86868B]">条</span>
            </div>
        </div>
        <div class="bg-white py-6 px-4 rounded-2xl shadow-sm border border-[#F0F0F2] flex flex-col justify-between">
            <p class="text-xs font-semibold text-[#86868B] uppercase tracking-wider">系统状态</p>
            <div class="mt-2 flex items-center">
                ${fileSystemStatusHTML}
            </div>
        </div>
        `;
        fileSystemStatusCards.innerHTML = statusHTML;
    }
}

customElements.define('filemgr-entry-widget', FileMgrEntryWidget);