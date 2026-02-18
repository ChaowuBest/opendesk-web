import { AgentOperableHTMLElement, RendererTool, RendererToolset } from '../../widget_utils.js';
import { z } from 'zod';

interface McpServerState {
    id: string;
    name: string;
    transport: 'stdio' | 'sse' | 'streamableHttp';
    enabled: boolean;
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    error?: string;
    tools: { name: string; description: string; inputSchema?: object }[];
}

const TRANSPORT_LABELS: Record<string, string> = {
    stdio: 'STDIO',
    sse: 'SSE',
    streamableHttp: 'Streamable HTTP',
};

const STATUS_CONFIG: Record<string, { dot: string; label: string; color: string }> = {
    connected:    { dot: 'bg-emerald-400', label: '已连接',  color: 'text-emerald-600' },
    connecting:   { dot: 'bg-amber-400 animate-pulse', label: '连接中', color: 'text-amber-600' },
    disconnected: { dot: 'bg-gray-300', label: '未连接',  color: 'text-gray-400' },
    error:        { dot: 'bg-red-400', label: '连接失败', color: 'text-red-500' },
};

function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

class McpMgrEntryWidget extends AgentOperableHTMLElement {
    private servers: McpServerState[] = [];
    private selectedServerId: string | null = null;
    private _onServersUpdated: (() => void) | null = null;

    connectedCallback() {
        this.render();
        this.loadServers();

        this._onServersUpdated = () => this.loadServers();
        window.applicationAPI.subscribe('serversUpdated', this._onServersUpdated);
    }

    disconnectedCallback() {
        if (this._onServersUpdated) {
            window.applicationAPI.unsubscribe('serversUpdated', this._onServersUpdated);
            this._onServersUpdated = null;
        }
    }

    getAgentInstruct(): string {
        return '你是 MCP 服务管理助手。用户可以通过你添加、管理和使用 MCP（Model Context Protocol）服务。'
            + '当前页面展示了用户已注册的所有 MCP 服务及其连接状态和可用工具。';
    }

    getToolset(): RendererToolset {
        const toolset = new RendererToolset('mcpmgr');

        const listTool = new RendererTool(
            'listMcpServers',
            '获取当前已注册的所有 MCP 服务的名称、类型、连接状态和可用工具数量',
            z.object({}),
        );
        listTool.setExecutor(async () => {
            return JSON.stringify(this.servers.map(s => ({
                name: s.name,
                transport: s.transport,
                enabled: s.enabled,
                status: s.status,
                toolCount: s.tools?.length || 0,
                error: s.error,
            })));
        });
        toolset.addTool(listTool);

        if (this.selectedServerId) {
            const server = this.servers.find(s => s.id === this.selectedServerId);
            if (server && server.tools?.length > 0) {
                const detailTool = new RendererTool(
                    'getSelectedServerTools',
                    '获取当前选中 MCP 服务的所有可用工具详情',
                    z.object({}),
                );
                detailTool.setExecutor(async () => {
                    return JSON.stringify(server.tools.map(t => ({
                        name: t.name,
                        description: t.description,
                    })));
                });
                toolset.addTool(detailTool);
            }
        }

        return toolset;
    }

    render() {
        this.innerHTML = `
        <div class="w-full h-full flex flex-col bg-gradient-to-br from-slate-50 via-white to-slate-100 relative">
            <header class="pl-6 pr-16 py-4 flex items-center border-b border-gray-200 bg-white/80 backdrop-blur shrink-0">
                <div class="mr-4">
                    <p class="text-xs uppercase tracking-wide text-gray-400 font-medium">MCP Services</p>
                    <h1 class="text-xl font-semibold text-gray-800">MCP 服务管理</h1>
                </div>
                <div class="flex items-center gap-2">
                    <button id="btn-import" class="px-3 py-2 rounded-xl bg-gray-100 text-gray-600 text-sm font-medium hover:bg-gray-200 transition" title="从 JSON 配置导入">
                        <i class="fa-solid fa-file-import mr-1.5"></i>导入
                    </button>
                    <button id="btn-add" class="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 shadow-sm transition">
                        <i class="fa-solid fa-plus mr-1.5"></i>添加服务
                    </button>
                </div>
            </header>

            <div class="flex-1 flex gap-5 p-5 overflow-hidden min-h-0">
                <div class="w-[340px] shrink-0 flex flex-col gap-3 overflow-y-auto" id="server-list">
                    <div class="flex items-center justify-center h-32 text-gray-400 text-sm">加载中...</div>
                </div>
                <div class="flex-1 overflow-y-auto" id="server-detail">
                    ${this.renderEmptyDetail()}
                </div>
            </div>

            <div id="modal-overlay" class="absolute inset-0 z-50 hidden">
                <div class="absolute inset-0 bg-black/40" id="modal-backdrop"></div>
                <div class="absolute inset-6 flex items-center justify-center pointer-events-none">
                    <div class="bg-white rounded-2xl shadow-2xl w-full max-w-xl pointer-events-auto max-h-full flex flex-col overflow-hidden" id="modal-content"></div>
                </div>
            </div>
        </div>
        `;

        this.querySelector('#btn-add')!.addEventListener('click', () => this.showModal('add'));
        this.querySelector('#btn-import')!.addEventListener('click', () => this.showImportModal());
        this.querySelector('#modal-backdrop')!.addEventListener('click', () => this.hideModal());
    }

    renderEmptyDetail(): string {
        return `
        <div class="h-full flex flex-col items-center justify-center text-gray-400 gap-3">
            <i class="fa-solid fa-plug-circle-bolt text-4xl text-gray-300"></i>
            <p class="text-sm">选择一个服务查看详情</p>
            <p class="text-xs text-gray-300">或点击右上角「添加服务」开始使用</p>
        </div>`;
    }

    async loadServers() {
        try {
            this.servers = await window.applicationAPI.call('getServers') as McpServerState[];
        } catch (e: any) {
            this.servers = [];
        }
        this.renderServerList();
        this.renderServerDetail();
    }

    renderServerList() {
        const list = this.querySelector('#server-list');
        if (!list) return;

        if (this.servers.length === 0) {
            list.innerHTML = `
            <div class="flex flex-col items-center justify-center py-16 text-gray-400 gap-3">
                <i class="fa-solid fa-server text-3xl text-gray-300"></i>
                <p class="text-sm">暂无 MCP 服务</p>
                <p class="text-xs text-gray-300">点击「添加服务」来注册你的第一个 MCP 服务</p>
            </div>`;
            return;
        }

        list.innerHTML = this.servers.map(server => {
            const st = STATUS_CONFIG[server.status] || STATUS_CONFIG.disconnected;
            const isSelected = server.id === this.selectedServerId;
            const transportLabel = TRANSPORT_LABELS[server.transport] || server.transport;
            const toolCount = server.tools?.length || 0;
            const desc = server.transport === 'stdio'
                ? `${server.command || ''} ${(server.args || []).join(' ')}`.trim()
                : server.url || '';

            return `
            <div class="group bg-white rounded-2xl p-4 border-2 cursor-pointer transition-all duration-200 hover:shadow-md
                ${isSelected ? 'border-blue-400 shadow-md ring-2 ring-blue-100' : 'border-[#F0F0F2] hover:border-blue-200'}"
                data-server-id="${server.id}">
                <div class="flex items-start justify-between gap-3">
                    <div class="flex items-center gap-2.5 min-w-0">
                        <div class="w-2 h-2 rounded-full shrink-0 ${st.dot}"></div>
                        <h3 class="font-semibold text-gray-800 text-sm truncate">${escapeHtml(server.name)}</h3>
                    </div>
                    <label class="toggle-wrap relative inline-flex items-center cursor-pointer shrink-0" title="${server.enabled ? '点击禁用' : '点击启用'}">
                        <input type="checkbox" class="sr-only peer toggle-server" data-toggle-id="${server.id}" ${server.enabled ? 'checked' : ''}>
                        <div class="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full
                            peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px]
                            after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4
                            after:transition-all peer-checked:bg-blue-500"></div>
                    </label>
                </div>
                <div class="mt-2 flex items-center gap-2 text-xs">
                    <span class="px-1.5 py-0.5 rounded font-medium
                        ${server.transport === 'stdio' ? 'bg-purple-50 text-purple-600' :
                          server.transport === 'sse' ? 'bg-sky-50 text-sky-600' :
                          'bg-emerald-50 text-emerald-600'}">${transportLabel}</span>
                    <span class="${st.color} font-medium">${st.label}</span>
                    ${toolCount > 0 ? `<span class="text-gray-400">${toolCount} 个工具</span>` : ''}
                </div>
                ${desc ? `<p class="mt-1.5 text-xs text-gray-400 truncate font-mono">${escapeHtml(desc)}</p>` : ''}
                ${server.error ? `<p class="mt-1.5 text-xs text-red-400 truncate"><i class="fa-solid fa-circle-exclamation mr-1"></i>${escapeHtml(server.error)}</p>` : ''}
            </div>`;
        }).join('');

        list.querySelectorAll('.toggle-wrap').forEach(label => {
            label.addEventListener('click', (e) => {
                console.info(label);
                e.stopPropagation();
                e.preventDefault();
                const input = label.querySelector('.toggle-server') as HTMLInputElement | null;
                if (!input) return;
                const id = input.dataset.toggleId!;
                const server = this.servers.find(s => s.id === id);
                if (!server) return;
                this.handleToggleServer(id, !server.enabled);
            });
        });

        list.querySelectorAll('[data-server-id]').forEach(card => {
            card.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).closest('.toggle-wrap')) return;
                this.selectedServerId = (card as HTMLElement).dataset.serverId!;
                this.renderServerList();
                this.renderServerDetail();
            });
        });
    }

    renderServerDetail() {
        const detail = this.querySelector('#server-detail');
        if (!detail) return;

        if (!this.selectedServerId) {
            detail.innerHTML = this.renderEmptyDetail();
            return;
        }

        const server = this.servers.find(s => s.id === this.selectedServerId);
        if (!server) {
            this.selectedServerId = null;
            detail.innerHTML = this.renderEmptyDetail();
            return;
        }

        const st = STATUS_CONFIG[server.status] || STATUS_CONFIG.disconnected;
        const transportLabel = TRANSPORT_LABELS[server.transport] || server.transport;
        const tools = server.tools || [];

        const envEntries = Object.entries(server.env || {});
        const headerEntries = Object.entries(server.headers || {});

        detail.innerHTML = `
        <div class="bg-white rounded-2xl border border-[#F0F0F2] shadow-sm overflow-hidden">
            <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-xl flex items-center justify-center
                        ${server.transport === 'stdio' ? 'bg-purple-50 text-purple-500' :
                          server.transport === 'sse' ? 'bg-sky-50 text-sky-500' :
                          'bg-emerald-50 text-emerald-500'}">
                        <i class="fa-solid ${server.transport === 'stdio' ? 'fa-terminal' : 'fa-globe'} text-lg"></i>
                    </div>
                    <div>
                        <h2 class="text-lg font-semibold text-gray-800">${escapeHtml(server.name)}</h2>
                        <div class="flex items-center gap-2 text-xs mt-0.5">
                            <span class="px-1.5 py-0.5 rounded font-medium
                                ${server.transport === 'stdio' ? 'bg-purple-50 text-purple-600' :
                                  server.transport === 'sse' ? 'bg-sky-50 text-sky-600' :
                                  'bg-emerald-50 text-emerald-600'}">${transportLabel}</span>
                            <span class="flex items-center gap-1 ${st.color}">
                                <span class="w-1.5 h-1.5 rounded-full ${st.dot}"></span>
                                ${st.label}
                            </span>
                        </div>
                    </div>
                </div>
                <div class="flex items-center gap-1.5">
                    ${server.status === 'connected' || server.status === 'error' ? `
                    <button class="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition" id="btn-reconnect" title="重新连接">
                        <i class="fa-solid fa-rotate"></i>
                    </button>` : ''}
                    <button class="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition" id="btn-edit" title="编辑">
                        <i class="fa-solid fa-pen-to-square"></i>
                    </button>
                    <button class="p-2 rounded-lg hover:bg-red-50 text-red-400 hover:text-red-500 transition" id="btn-delete" title="删除">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>

            ${server.error ? `
            <div class="mx-6 mt-4 p-3 rounded-xl bg-red-50 border border-red-100 text-red-600 text-xs">
                <i class="fa-solid fa-circle-exclamation mr-1.5"></i>${escapeHtml(server.error)}
            </div>` : ''}

            <div class="p-6 space-y-4">
                <div class="grid grid-cols-2 gap-4 text-sm">
                    ${server.transport === 'stdio' ? `
                    <div>
                        <p class="text-xs text-gray-400 mb-1">命令</p>
                        <p class="font-mono text-gray-700 bg-gray-50 px-3 py-1.5 rounded-lg text-xs">${escapeHtml(server.command || '-')}</p>
                    </div>
                    <div>
                        <p class="text-xs text-gray-400 mb-1">参数</p>
                        <p class="font-mono text-gray-700 bg-gray-50 px-3 py-1.5 rounded-lg text-xs">${escapeHtml((server.args || []).join(' ') || '-')}</p>
                    </div>
                    ${server.cwd ? `
                    <div class="col-span-2">
                        <p class="text-xs text-gray-400 mb-1">工作目录</p>
                        <p class="font-mono text-gray-700 bg-gray-50 px-3 py-1.5 rounded-lg text-xs">${escapeHtml(server.cwd)}</p>
                    </div>` : ''}
                    ` : `
                    <div class="col-span-2">
                        <p class="text-xs text-gray-400 mb-1">URL</p>
                        <p class="font-mono text-gray-700 bg-gray-50 px-3 py-1.5 rounded-lg text-xs break-all">${escapeHtml(server.url || '-')}</p>
                    </div>
                    `}
                </div>

                ${envEntries.length > 0 ? `
                <div>
                    <p class="text-xs text-gray-400 mb-2">环境变量</p>
                    <div class="space-y-1">
                        ${envEntries.map(([k, v]) => `
                        <div class="flex gap-2 text-xs font-mono">
                            <span class="text-purple-600 bg-purple-50 px-2 py-0.5 rounded">${escapeHtml(k)}</span>
                            <span class="text-gray-500">=</span>
                            <span class="text-gray-600 truncate">${escapeHtml(v.length > 32 ? v.slice(0, 8) + '••••' + v.slice(-4) : v)}</span>
                        </div>`).join('')}
                    </div>
                </div>` : ''}

                ${headerEntries.length > 0 ? `
                <div>
                    <p class="text-xs text-gray-400 mb-2">请求头</p>
                    <div class="space-y-1">
                        ${headerEntries.map(([k, v]) => `
                        <div class="flex gap-2 text-xs font-mono">
                            <span class="text-sky-600 bg-sky-50 px-2 py-0.5 rounded">${escapeHtml(k)}</span>
                            <span class="text-gray-500">:</span>
                            <span class="text-gray-600 truncate">${escapeHtml(v.length > 32 ? v.slice(0, 8) + '••••' + v.slice(-4) : v)}</span>
                        </div>`).join('')}
                    </div>
                </div>` : ''}
            </div>

            <div class="border-t border-gray-100">
                <div class="px-6 py-3 flex items-center justify-between">
                    <h3 class="text-sm font-semibold text-gray-700">
                        <i class="fa-solid fa-wrench mr-1.5 text-gray-400"></i>可用工具
                        <span class="text-gray-400 font-normal ml-1">(${tools.length})</span>
                    </h3>
                </div>
                <div class="px-6 pb-5">
                    ${tools.length === 0 ? `
                    <div class="text-center py-8 text-gray-400 text-sm">
                        ${server.status === 'connected' ? '此服务未提供任何工具' :
                          server.status === 'connecting' ? '<i class="fa-solid fa-rotate fa-spin mr-1.5"></i>正在发现工具...' :
                          '连接服务后可查看可用工具'}
                    </div>` : `
                    <div class="space-y-2">
                        ${tools.map(tool => {
                            const schema = tool.inputSchema as any;
                            const props = schema?.properties || {};
                            const required = schema?.required || [];
                            const paramEntries = Object.entries(props);
                            return `
                            <div class="group/tool rounded-xl border border-gray-100 hover:border-blue-200 transition p-3">
                                <div class="flex items-start gap-2">
                                    <span class="shrink-0 w-6 h-6 rounded-lg bg-blue-50 text-blue-500 flex items-center justify-center text-xs mt-0.5">
                                        <i class="fa-solid fa-screwdriver-wrench"></i>
                                    </span>
                                    <div class="min-w-0">
                                        <p class="text-sm font-semibold text-gray-800 font-mono">${escapeHtml(tool.name)}</p>
                                        ${tool.description ? `<p class="text-xs text-gray-500 mt-0.5 leading-relaxed">${escapeHtml(tool.description)}</p>` : ''}
                                        ${paramEntries.length > 0 ? `
                                        <div class="mt-2 flex flex-wrap gap-1.5">
                                            ${paramEntries.map(([pName, pSchema]: [string, any]) => {
                                                const isRequired = required.includes(pName);
                                                const pType = pSchema?.type || 'any';
                                                return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono
                                                    ${isRequired ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-gray-50 text-gray-500 border border-gray-200'}">
                                                    ${escapeHtml(pName)}<span class="opacity-50">: ${pType}</span>
                                                    ${isRequired ? '<span class="text-red-400">*</span>' : ''}
                                                </span>`;
                                            }).join('')}
                                        </div>` : ''}
                                    </div>
                                </div>
                            </div>`;
                        }).join('')}
                    </div>`}
                </div>
            </div>
        </div>`;

        detail.querySelector('#btn-edit')?.addEventListener('click', () => this.showModal('edit', server));
        detail.querySelector('#btn-delete')?.addEventListener('click', () => this.handleDeleteServer(server.id));
        detail.querySelector('#btn-reconnect')?.addEventListener('click', () => this.handleReconnectServer(server.id));
    }

    showModal(mode: 'add' | 'edit', server?: McpServerState) {
        const overlay = this.querySelector('#modal-overlay') as HTMLElement;
        const content = this.querySelector('#modal-content') as HTMLElement;
        if (!overlay || !content) return;

        const title = mode === 'add' ? '添加 MCP 服务' : '编辑 MCP 服务';
        const transport = server?.transport || 'stdio';
        const envPairs = Object.entries(server?.env || {});
        const headerPairs = Object.entries(server?.headers || {});

        content.innerHTML = `
        <form id="server-form" class="flex flex-col flex-1 min-h-0">
            <div class="px-6 pt-6 pb-4 flex items-center justify-between shrink-0 border-b border-gray-100">
                <h2 class="text-lg font-semibold text-gray-800">${title}</h2>
                <button type="button" id="btn-modal-close" class="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition">
                    <i class="fa-solid fa-xmark text-lg"></i>
                </button>
            </div>

            <div class="px-6 py-5 space-y-5 overflow-y-auto min-h-0 flex-1">
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1.5">服务名称 <span class="text-red-400">*</span></label>
                    <input type="text" id="f-name" value="${escapeHtml(server?.name || '')}" placeholder="例如 fetch-server"
                        class="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none transition">
                </div>

                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-2">传输方式</label>
                    <div class="flex gap-2">
                        ${(['stdio', 'sse', 'streamableHttp'] as const).map(t => `
                        <label class="flex-1 cursor-pointer">
                            <input type="radio" name="transport" value="${t}" class="sr-only peer" ${transport === t ? 'checked' : ''}>
                            <div class="text-center py-2 px-3 rounded-xl border-2 text-sm font-medium transition
                                peer-checked:border-blue-400 peer-checked:bg-blue-50 peer-checked:text-blue-700
                                border-gray-200 text-gray-500 hover:border-gray-300">
                                ${TRANSPORT_LABELS[t]}
                            </div>
                        </label>`).join('')}
                    </div>
                </div>

                <div id="fields-stdio" class="space-y-3 ${transport !== 'stdio' ? 'hidden' : ''}">
                    <div>
                        <label class="block text-xs font-medium text-gray-500 mb-1">命令 <span class="text-red-400">*</span></label>
                        <input type="text" id="f-command" value="${escapeHtml(server?.command || '')}" placeholder="例如 npx, uvx, node, python"
                            class="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm font-mono focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none transition">
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-500 mb-1">参数 <span class="text-gray-400">(每行一个)</span></label>
                        <textarea id="f-args" rows="3" placeholder="-y&#10;mcp-server-fetch"
                            class="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm font-mono focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none transition resize-none">${escapeHtml((server?.args || []).join('\n'))}</textarea>
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-500 mb-1">工作目录 <span class="text-gray-400">(可选)</span></label>
                        <input type="text" id="f-cwd" value="${escapeHtml(server?.cwd || '')}" placeholder="留空则使用默认目录"
                            class="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm font-mono focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none transition">
                    </div>
                </div>

                <div id="fields-http" class="space-y-3 ${transport === 'stdio' ? 'hidden' : ''}">
                    <div>
                        <label class="block text-xs font-medium text-gray-500 mb-1">URL <span class="text-red-400">*</span></label>
                        <input type="text" id="f-url" value="${escapeHtml(server?.url || '')}" placeholder="https://example.com/mcp"
                            class="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm font-mono focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none transition">
                    </div>
                    <div>
                        <label class="block text-xs font-medium text-gray-500 mb-1">请求头 <span class="text-gray-400">(每行一个, 格式: Key: Value)</span></label>
                        <textarea id="f-headers" rows="2" placeholder="Authorization: Bearer token&#10;X-Custom: value"
                            class="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm font-mono focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none transition resize-none">${escapeHtml(headerPairs.map(([k, v]) => `${k}: ${v}`).join('\n'))}</textarea>
                    </div>
                </div>

                <div>
                    <label class="block text-xs font-medium text-gray-500 mb-1">环境变量 <span class="text-gray-400">(每行一个, 格式: KEY=VALUE)</span></label>
                    <textarea id="f-env" rows="2" placeholder="API_KEY=sk-xxx&#10;DEBUG=true"
                        class="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm font-mono focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none transition resize-none">${escapeHtml(envPairs.map(([k, v]) => `${k}=${v}`).join('\n'))}</textarea>
                </div>

                <div id="form-error" class="hidden p-3 rounded-xl bg-red-50 border border-red-100 text-red-600 text-xs"></div>
            </div>

            <div class="px-6 py-4 flex justify-end gap-2 shrink-0 border-t border-gray-100">
                <button type="button" id="btn-cancel" class="px-4 py-2 rounded-xl bg-gray-100 text-gray-600 text-sm font-medium hover:bg-gray-200 transition">
                    取消
                </button>
                <button type="submit" class="px-5 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 shadow-sm transition">
                    ${mode === 'add' ? '添加' : '保存'}
                </button>
            </div>
        </form>`;

        overlay.classList.remove('hidden');

        content.querySelector('#btn-modal-close')!.addEventListener('click', () => this.hideModal());
        content.querySelector('#btn-cancel')!.addEventListener('click', () => this.hideModal());

        content.querySelectorAll('input[name="transport"]').forEach(radio => {
            radio.addEventListener('change', () => {
                const val = (radio as HTMLInputElement).value;
                const stdioFields = content.querySelector('#fields-stdio') as HTMLElement;
                const httpFields = content.querySelector('#fields-http') as HTMLElement;
                if (val === 'stdio') {
                    stdioFields.classList.remove('hidden');
                    httpFields.classList.add('hidden');
                } else {
                    stdioFields.classList.add('hidden');
                    httpFields.classList.remove('hidden');
                }
            });
        });

        content.querySelector('#server-form')!.addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleSaveServer(mode, server?.id);
        });
    }

    showImportModal() {
        const overlay = this.querySelector('#modal-overlay') as HTMLElement;
        const content = this.querySelector('#modal-content') as HTMLElement;
        if (!overlay || !content) return;

        content.innerHTML = `
        <form id="import-form" class="flex flex-col flex-1 min-h-0">
            <div class="px-6 pt-6 pb-4 flex items-center justify-between shrink-0 border-b border-gray-100">
                <h2 class="text-lg font-semibold text-gray-800">导入 MCP 配置</h2>
                <button type="button" id="btn-modal-close" class="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 transition">
                    <i class="fa-solid fa-xmark text-lg"></i>
                </button>
            </div>

            <div class="px-6 py-5 space-y-5 overflow-y-auto min-h-0 flex-1">
                <p class="text-xs text-gray-500 leading-relaxed">
                    粘贴来自 Claude Desktop、Cursor 等工具的 MCP 配置 JSON。支持以下格式：
                </p>
                <pre class="text-[11px] text-gray-400 bg-gray-50 rounded-xl p-3 font-mono overflow-x-auto leading-relaxed">{ "mcpServers": { "server-name": { "command": "npx", "args": [...], "env": {...} } } }</pre>
                <div>
                    <textarea id="f-import-json" rows="8" placeholder='在此粘贴 JSON 配置...'
                        class="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm font-mono focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none transition resize-none"></textarea>
                </div>
                <div id="import-error" class="hidden p-3 rounded-xl bg-red-50 border border-red-100 text-red-600 text-xs"></div>
            </div>

            <div class="px-6 py-4 flex justify-end gap-2 shrink-0 border-t border-gray-100">
                <button type="button" id="btn-cancel" class="px-4 py-2 rounded-xl bg-gray-100 text-gray-600 text-sm font-medium hover:bg-gray-200 transition">取消</button>
                <button type="submit" class="px-5 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 shadow-sm transition">
                    <i class="fa-solid fa-file-import mr-1.5"></i>导入
                </button>
            </div>
        </form>`;

        overlay.classList.remove('hidden');

        content.querySelector('#btn-modal-close')!.addEventListener('click', () => this.hideModal());
        content.querySelector('#btn-cancel')!.addEventListener('click', () => this.hideModal());

        content.querySelector('#import-form')!.addEventListener('submit', async (e) => {
            e.preventDefault();
            const jsonStr = (this.querySelector('#f-import-json') as HTMLTextAreaElement).value.trim();
            const errDiv = this.querySelector('#import-error') as HTMLElement;
            if (!jsonStr) {
                errDiv.textContent = '请粘贴 JSON 配置';
                errDiv.classList.remove('hidden');
                return;
            }
            try {
                await window.applicationAPI.callMainWorld('importFromJson', jsonStr);
                this.hideModal();
            } catch (err: any) {
                errDiv.textContent = err.message || '导入失败';
                errDiv.classList.remove('hidden');
            }
        });
    }

    hideModal() {
        const overlay = this.querySelector('#modal-overlay') as HTMLElement;
        if (overlay) overlay.classList.add('hidden');
    }

    private parseKvLines(text: string, sep: string): Record<string, string> {
        const result: Record<string, string> = {};
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const idx = trimmed.indexOf(sep);
            if (idx > 0) {
                result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + sep.length).trim();
            }
        }
        return result;
    }

    async handleSaveServer(mode: 'add' | 'edit', existingId?: string) {
        const errDiv = this.querySelector('#form-error') as HTMLElement;
        const name = (this.querySelector('#f-name') as HTMLInputElement).value.trim();
        const transport = (this.querySelector('input[name="transport"]:checked') as HTMLInputElement)?.value as any;

        if (!name) {
            errDiv.textContent = '请输入服务名称';
            errDiv.classList.remove('hidden');
            return;
        }

        const config: any = { name, transport, enabled: true };

        if (transport === 'stdio') {
            const command = (this.querySelector('#f-command') as HTMLInputElement).value.trim();
            if (!command) {
                errDiv.textContent = '请输入命令';
                errDiv.classList.remove('hidden');
                return;
            }
            config.command = command;
            config.args = (this.querySelector('#f-args') as HTMLTextAreaElement).value
                .split('\n').map((s: string) => s.trim()).filter(Boolean);
            const cwd = (this.querySelector('#f-cwd') as HTMLInputElement).value.trim();
            if (cwd) config.cwd = cwd;
        } else {
            const url = (this.querySelector('#f-url') as HTMLInputElement).value.trim();
            if (!url) {
                errDiv.textContent = '请输入 URL';
                errDiv.classList.remove('hidden');
                return;
            }
            config.url = url;
            const headers = this.parseKvLines(
                (this.querySelector('#f-headers') as HTMLTextAreaElement).value, ':');
            if (Object.keys(headers).length > 0) config.headers = headers;
        }

        const env = this.parseKvLines(
            (this.querySelector('#f-env') as HTMLTextAreaElement).value, '=');
        if (Object.keys(env).length > 0) config.env = env;

        try {
            if (mode === 'add') {
                await window.applicationAPI.callMainWorld('addServer', config);
            } else {
                await window.applicationAPI.callMainWorld('updateServer', existingId, config);
            }
            this.hideModal();
        } catch (err: any) {
            errDiv.textContent = err.message || '操作失败';
            errDiv.classList.remove('hidden');
        }
    }

    async handleDeleteServer(id: string) {
        const server = this.servers.find(s => s.id === id);
        if (!server) return;
        if (!confirm(`确定要删除服务「${server.name}」吗？`)) return;

        try {
            await window.applicationAPI.callMainWorld('deleteServer', id);
            if (this.selectedServerId === id) this.selectedServerId = null;
        } catch (err: any) {
            alert(`删除失败: ${err.message}`);
        }
    }

    async handleToggleServer(id: string, enabled: boolean) {
        const server = this.servers.find(s => s.id === id);
        if (server) {
            server.enabled = enabled;
            this.renderServerList();
            this.renderServerDetail();
        }
        try {
            await window.applicationAPI.callMainWorld('toggleServer', id, enabled);
        } catch (err: any) {
            if (server) server.enabled = !enabled;
            this.renderServerList();
            this.renderServerDetail();
            alert(`操作失败: ${err.message}`);
        }
    }

    async handleReconnectServer(id: string) {
        try {
            await window.applicationAPI.call('reconnectServer', id);
        } catch (err: any) {
            alert(`重连失败: ${err.message}`);
        }
    }
}

customElements.define('mcpmgr-entry-widget', McpMgrEntryWidget);
