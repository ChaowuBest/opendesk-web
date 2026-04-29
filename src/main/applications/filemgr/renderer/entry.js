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

import { AgentOperableHTMLElement } from '../../widget_utils.js';
import { ElasticToolbarWidget } from '../../../../renderer/components/toolbar.ts';

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
            <header class="pl-6 pr-16 py-4 flex items-center justify-between border-b border-gray-200 bg-white/80 backdrop-blur">
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
                        <div class="px-8 py-0 border-b border-[#F0F0F2] flex justify-between items-center bg-[#FAFAFB]">
                            <h2 class="font-semibold text-lg">当前已添加的数据源</h2>
                            <div id="filemgr-main-toolbar" class="flex space-x-2">
                            </div>
                        </div>

                        <!-- Folder List -->
                        <div class="overflow-x-auto min-h-0 max-h-full flex-1 flex flex-col">
                            <div class="flex-[1_1_0] min-h-0 overflow-y-auto">
                                <table class="w-full text-left border-collapse">
                                <thead>
                                    <tr class="text-[12px] uppercase text-[#86868B] tracking-wider border-b border-[#F0F0F2]">
                                        <th class="px-8 py-4 font-semibold">数据源</th>
                                        <th class="px-8 py-4 font-semibold text-center">最近全量扫描时间</th>
                                        <th class="px-8 py-4 font-semibold text-right">操作</th>
                                    </tr>
                                </thead>
                                <tbody id='filemgr-source-list' class="divide-y divide-[#F0F0F2]">

                                </tbody>
                            </table>
                        </div>

                        <!-- Footer Action Bar -->
                        <div class="px-8 py-4 bg-[#FAFAFB] border-t border-[#F0F0F2] flex justify-between items-center text-xs text-[#86868B]">
                            <p>......</p>
                            <div class="flex items-center space-x-4 text-blue-600 font-medium">
                                test
                            </div>
                        </div>
                    </main>
                </div>
            </div>
        </div>
        `;

        const toolbarButtons = [
            {
                id: 'filemgr-reset-btn',
                icon: 'fa-redo-alt',
                label: '重置文件系统',
                action: async () => {
                    if (confirm('请确认是否要重置存储系统？这将清空现有的索引')) {
                        await window.applicationAPI.call('resetFileSystemStorage');
                        await this.reloadFileSystemStatus();
                    }
                }
            }
        ];

        this.querySelector('#filemgr-main-toolbar').appendChild(new ElasticToolbarWidget(toolbarButtons));

        this.reloadFileSystemStatus();
        this.reloadInterval = setInterval(() => {
            this.reloadFileSystemStatus();
        }, 5000);
    }

    async reloadFileSystemStatus() {
        const fileSystemStatusCards = this.querySelector('#file-system-status-cards');
        const fileSystemStatus = await window.applicationAPI.call('getFileSystemStatus');

        let fileSystemStatusHTML = '';
        switch (fileSystemStatus.status) {
            case 'running':
                fileSystemStatusHTML = `
                <div class="w-2.5 h-2.5 bg-green-500 rounded-full mr-2"></div>
                <span class="text-sm font-medium">运行中</span>
                `;
                break;
            case 'scanning':
                fileSystemStatusHTML = `
                <div class="w-2.5 h-2.5 bg-green-500 rounded-full animate-pulse mr-2"></div>
                <span class="text-sm font-medium">扫描中</span>
                `;
                break;
            case 'idle':
                fileSystemStatusHTML = `
                <div class="w-2.5 h-2.5 bg-red-500 rounded-full mr-2"></div>
                <span class="text-sm font-medium">未启动</span>
                `;
                break;
            case 'error':
                fileSystemStatusHTML = `
                <div class="w-2.5 h-2.5 bg-red-500 rounded-full mr-2"></div>
                <span class="text-sm font-medium">错误</span>
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
                <span class="text-3xl font-bold">${fileSystemStatus?.storage?.db_size || '--'}</span>
            </div>
        </div>
        <div class="bg-white py-6 px-4 rounded-2xl shadow-sm border border-[#F0F0F2]">
            <p class="text-xs font-semibold text-[#86868B] uppercase tracking-wider">向量索引</p>
            <div class="mt-2 flex items-baseline">
                <span class="text-3xl font-bold">${fileSystemStatus?.storage?.vecdb_size || '--'}</span>
                <span class="ml-2 text-xs text-[#86868B]">条</span>
            </div>
        </div>
        <div class="bg-white py-6 px-4 rounded-2xl shadow-sm border border-[#F0F0F2]">
            <p class="text-xs font-semibold text-[#86868B] uppercase tracking-wider">内容 Chunks</p>
            <div class="mt-2 flex items-baseline">
                <span class="text-3xl font-bold">${fileSystemStatus?.storage?.chunk_size || '--'}</span>
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

        const sourceList = this.querySelector('#filemgr-source-list');
        let sourceListHTML = '';
        console.info(fileSystemStatus);
        for (const scanner of fileSystemStatus.scanners) {
            let lastFullScanTime = '--';
            const now = Date.now();
            const last = scanner.lastFullScan;
            if (last) {
                const diffMs = now - last;
                const diffMinutes = Math.floor(diffMs / (60 * 1000));
                if (diffMinutes < 1) {
                    lastFullScanTime = '刚刚';
                } else if (diffMinutes < 60) {
                    lastFullScanTime = `${diffMinutes}分钟前`;
                } else {
                    const diffHours = Math.floor(diffMinutes / 60);
                    lastFullScanTime = `${diffHours}小时前`;
                }
            }

            sourceListHTML += `
            <tr class="hover:bg-[#FBFBFB] transition-colors group">
                <td class="px-8 py-5">
                    <div class="flex items-center">
                        <div class="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center mr-3">
                            <i class="fa fa-folder text-lg text-blue-500"></i>
                        </div>
                        <div>
                            <p class="font-medium text-sm">${scanner.entry.root}</p>
                            <p class="text-xs text-[#86868B]">包含${scanner.totalFiles}个文件</p>
                        </div>
                    </div>
                </td>
                <td class="px-8 py-5 text-center">
                    <span class="bg-[#F5F5F7] px-2.5 py-1 rounded-full text-xs font-semibold">${lastFullScanTime}</span>
                </td>
                <td class="px-8 py-5 text-right">
                </td>
            </tr>
            `;
        }
        sourceList.innerHTML = sourceListHTML;
    }
}

customElements.define('filemgr-entry-widget', FileMgrEntryWidget);
