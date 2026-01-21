import { z } from 'zod';
import { RendererToolset, RendererTool, AgentOperableHTMLElement } from '../../widget_utils.js';
import { ElasticToolbarWidget } from '../../../../renderer/components/toolbar.js';


class MailBoxEntryWidget extends AgentOperableHTMLElement {
    constructor() {
        super();

        /** @type {Map<string, import('../common.js').EmailHeader>} */
        this.emailHeaderList = new Map();
        /** @type {string | null} */
        this.selectedEmailUid = null;
        /** @type {import('../common.js').EmailHeader | null} */
        this.selectedEmailHeader = null;
        /** @type {import('../common.js').EmailContent | null} */
        this.selectedEmailContent = null;
        /** @type {string} */
        this.currentFilter = 'all'; // 当前选中的过滤器
    }

    connectedCallback() {
        this.render();
        this.loadEmailList();

        // 订阅邮件列表更新事件
        window.applicationAPI.subscribe('emailListUpdated', () => {
            this.loadEmailList();
        });
    }

    async loadEmailList() {
        const emails = await this.getEmailHeaderList();
        this.emailHeaderList.clear();
        for (const email of emails) {
            this.emailHeaderList.set(email.uid, email);
        }
        this.reloadEmailList();
    }

    getAgentInstruct() {
        return '你是一个邮件管理助手，你负责管理用户的邮件，并利用提供的邮件及其他工具来完成用户指定的任务。';
    }

    getToolset() {
        let toolset = new RendererToolset('mailbox');
        if (this.selectedEmailUid !== null) {
            let getSelectedEmailTool = new RendererTool('getSelectedEmail', '获取用户当前正在浏览的邮件内容');
            getSelectedEmailTool.setExecutor(async (args) => {
                let result = '当前用户正在浏览的邮件内容为: \n';
                result += `主题: ${this.selectedEmailHeader.subject}\n`;
                result += `发送至: ${this.selectedEmailHeader.to}\n`;
                result += `发送时间: ${new Date(this.selectedEmailHeader.date).toLocaleString()}\n`;
                result += `邮件内容: ${this.selectedEmailContent.textContent || this.selectedEmailContent.htmlContent}\n`;
                return result;
            });
            toolset.addTool(getSelectedEmailTool);
        }

        let getEmailListTool = new RendererTool('getEmailList', '获取完整的邮件列表');
        getEmailListTool.setExecutor(async (args) => {
            let result = '';
            for (const email of this.emailHeaderList.values()) {
                result += `- 主题: ${email.subject}\n`;
                result += `  - 邮件ID: ${email.uid}\n`;
                result += `  - 发送者: ${email.from}\n`;
                result += `  - 发送至: ${email.to}\n`;
                result += `  - 发送时间: ${new Date(email.date).toLocaleString()}\n`;
            }
            console.info(result);
            return result;
        });

        let getEmailContentTool = new RendererTool('getEmailContent', '打开指定id的邮件并获取其内容');
        getEmailContentTool.setParams(z.object({
            uid: z.string().describe("邮件的ID")
        }))
        getEmailContentTool.setExecutor(async (args) => {
            let result = '';
            try {
                await this.openEmailByUid(args.uid);
                let content = this.selectedEmailContent;
                result = `邮件内容为: <content>${content.textContent || content.htmlContent}</content>\n`;
                await new Promise(resolve => setTimeout(resolve, 1000));
                return result;
            } catch (error) {
                result = `获取邮件内容失败: ${error}\n`;
                return result;
            }
        });

        let markEmailAsReadTool = new RendererTool('markEmailAsRead', '标记多个指定id的邮件为已读');
        markEmailAsReadTool.setParams(z.object({
            uids: z.array(z.string()).describe("邮件的ID列表")
        }))
        markEmailAsReadTool.setExecutor(async (args) => {
            for (const uid of args.uids) {
                await this.markEmailAsRead(uid);
            }
            this.applyCurrentFilter();
            return `已标记邮件为已读: ${args.uids.join(', ')}`;
        });

        toolset.addTools(getEmailListTool, getEmailContentTool, markEmailAsReadTool);
        return toolset;
    }

    /**
     * Get the list of email headers from the database
     * @param {import('zod').ZodObject<EmailHeaderQuerySchema> | undefined} query
     * @returns {Promise<EmailHeader[]>}
     */
    async getEmailHeaderList(query) {
        console.info('getting email header list', query);
        const emailHeaderList = await window.applicationAPI.call('getEmailHeaderList', query);
        emailHeaderList.sort((a, b) => new Date(b.date) - new Date(a.date));
        return emailHeaderList;
    }

    /**
     * 将一封邮件的抬头部分渲染为HTML
     * @param {import('../common.js').EmailHeader} email
     * @returns {string}
     */
    renderEmailItem(email) {
        const isSelected = email.uid === this.selectedEmailUid;
        var classes = "email-item p-3 border-b cursor-pointer border-gray-200 border-l-4 ";
        if (isSelected) {
            classes += "bg-indigo-50/50 relative border-l-indigo-600";
        } else {
            classes += "hover:bg-gray-50 transition-colors border-l-transparent";
        }

        var subject_classes = "font-medium text-gray-500";
        if (email.unread) {
            subject_classes = "font-bold text-gray-800";
        }

        return `
        <div class="${classes}" data-uid="${email.uid}">
            <div class="flex justify-between items-start mb-1">
                <span class="${subject_classes}">${email.subject}</span>
                ${email.starred ? '<i class="fa fa-star text-yellow-500"></i>' : ''}
            </div>
            <!-- <p class="text-gray-900 font-medium truncate mb-1 text-[13px]">test</p> -->
            <p class="text-gray-500 line-clamp-2 text-xs leading-relaxed">${new Date(email.date).toLocaleString()}</p>
        </div>
        `
    }

    /**
     * 重新载入邮件列表
     */
    reloadEmailList(emailList = this.emailHeaderList) {
        const emailListContainer = this.querySelector('#email-list');
        emailListContainer.innerHTML = '';
        if (emailList.size === 0) {
            emailListContainer.innerHTML = '<div class="text-gray-500 text-center py-4">暂无符合条件的邮件</div>';
            return;
        }
        for (const email of emailList.values()) {
            emailListContainer.innerHTML += this.renderEmailItem(email);
        }

        this.querySelectorAll('.email-item').forEach(item => {
            item.addEventListener('click', (event) => {
                const uid = item.dataset.uid;
                console.info(uid);
                const email = emailList.get(uid);
                this.openEmail(email);
            });
        });
    }

    async getEmailContent(uid) {
        return await window.applicationAPI.call('getEmailContent', uid);
    }

    async reDownloadEmailContent(uid) {
        return await window.applicationAPI.call('reDownloadEmailContent', uid);
    }

    async markEmailAsRead(uid) {
        console.info('mark email as read', uid);
        await window.applicationAPI.call('markEmailAsRead', uid);
        this.emailHeaderList.get(uid).unread = false;
    }

    async starEmail(uid, starred = true) {
        console.info('star email', uid, starred);
        let starOptions = {
            uid: uid,
            starred: starred
        }
        await window.applicationAPI.call('starEmail', starOptions);
        this.emailHeaderList.get(uid).starred = starred;
        this.applyCurrentFilter();
    }

    async searchEmails(query) {
        const emailList = await window.applicationAPI.call('searchEmails', query);
        this.emailHeaderList.clear();
        for (const email of emailList) {
            this.emailHeaderList.set(email.uid, email);
        }
        this.reloadEmailList();
    }

    renderCurrentEmailHeader() {
        const senders = this.selectedEmailHeader.from?.map(sender => {
            return `
            <div class="flex items-center bg-gray-200/60 border border-gray-300 rounded px-1.5 py-0.5 text-xs text-gray-700">
                <span class="font-medium">${sender.name}</span>
                <span class="ml-1 text-gray-400 italic font-normal">&lt;${sender.address}&gt;</span>
                <button class="ml-1 text-gray-400 hover:text-gray-600">
                    <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" /></svg>
                </button>
            </div>
            `
        }).join('');
        const tos = this.selectedEmailHeader.to?.map(to => {
            return `
            <div class="flex items-center bg-blue-100 border border-blue-200 rounded px-1.5 py-0.5 text-xs text-blue-700">
                <span class="font-medium">${to.name}</span>
                <span class="ml-1 text-gray-400 italic font-normal">&lt;${to.address}&gt;</span>
            </div>
            `
        }).join('');
        const ccs = this.selectedEmailHeader.cc?.map(cc => {
            return `
            <div class="flex items-center bg-green-100 border border-green-200 rounded px-1.5 py-0.5 text-xs text-green-700">
                <span class="font-medium">${cc.name}</span>
                <span class="ml-1 text-gray-400 italic font-normal">&lt;${cc.address}&gt;</span>
            </div>
            `
        }).join('');
        const bccs = this.selectedEmailHeader.bcc?.map(bcc => {
            return `
            <div class="flex items-center bg-purple-100 border border-purple-200 rounded px-1.5 py-0.5 text-xs text-purple-700">
                <span class="font-medium">${bcc.name}</span>
                <span class="ml-1 text-gray-400 italic font-normal">&lt;${bcc.address}&gt;</span>
            </div>
            `
        }).join('');

        var addresses = '';
        if (senders && senders.length > 0) {
            addresses += `
            <!-- 发件人行 -->
            <div class="group flex items-center px-1 py-1 hover:bg-gray-50 transition-colors">
                <label class="w-12 text-xs text-gray-400 font-medium">发件人</label>
                <div class="flex-1 flex items-center gap-2">
                    ${senders}
                </div>
            </div>
            `
        }

        if (tos && tos.length > 0) {
            addresses += `
            <!-- 收件人行 -->
            <div class="group flex items-center px-1 py-1 hover:bg-gray-50 transition-colors">
                <label class="w-12 text-xs text-gray-400 font-medium">收件人</label>
                <div class="flex-1 flex flex-wrap gap-2 items-center">
                    ${tos}
                </div>
            </div>
            `
        }

        if (ccs && ccs.length > 0) {
            addresses += ` <!-- 抄送行 -->
            <div class="group flex items-center px-1 py-1 hover:bg-gray-50 transition-colors">
                <label class="w-12 text-xs text-gray-400 font-medium">抄送</label>
                <div class="flex-1 flex flex-wrap gap-2 items-center">
                    ${ccs}
                </div>
            </div>
            `
        }

        var attachments = '';
        for (const attachment of this.selectedEmailContent.attachments) {
            attachments += `
            <div class="mailbox-open-attachment-item flex items-center group cursor-pointer w-fit max-w-sm
                bg-white/70 backdrop-blur-xl
                rounded-xl px-2.5 py-1
                border border-black/[0.08] shadow-sm
                hover:shadow-md hover:bg-white/90 hover:-translate-y-0.5
                transition-all duration-200 ease-out select-none"
                data-attachment_path="${attachment.path}"
            >
                <!-- 文件图标容器 -->
                <i class="fa fa-file-alt text-gray-400 text-sm mr-2"></i>
                <!-- 文件详细信息 -->
                <div class="flex flex-col min-w-0 flex-1 overflow-hidden">
                    <span class="text-[13px] font-medium text-gray-900 truncate tracking-tight font-sans">
                        ${attachment.filename}
                    </span>
                </div>
            </div>
            `
        }

        if (attachments) {
            attachments = `
            <div class="group flex items-center px-1 py-1 hover:bg-gray-50 transition-colors">
                <label class="w-12 text-xs text-gray-400 font-medium">附件</label>
                <div class="flex-1 flex flex-wrap gap-2 items-center">
                    ${attachments}
                </div>
            </div>
            `
        }

        var fullHeader = `
        <div class="mb-2">
            <div class="flex flex-col items-center justify-between">
                <div class="flex flex-col items-left w-full">
                    <div class="group flex flex-col items-left px-1 py-1 hover:bg-gray-50 transition-colors">
                        <span class="text-xs text-gray-400 mr-4 mb-1">${new Date(this.selectedEmailHeader.date).toLocaleString()}</span>
                        <h2 class="text-gray-900 text-lg font-bold leading-tight">${this.selectedEmailHeader.subject}</h2>
                    </div>
                    ${addresses}
                    ${attachments}
                </div>
            </div>
        </div>
        `

        return fullHeader;
    }

    async createNewEmail() {
        // 这里可以直接 new 一个邮件编辑控件并赋值给 #email-content
        const emailContent = this.querySelector('#email-content');
        const editor = new MailEditorWidget();
        editor.classList.add('flex-1', 'overflow-y-auto', 'bg-white');
        emailContent.innerHTML = '';
        emailContent.appendChild(editor);
        editor.addEventListener('cancel', () => {
            this.reloadCurrentEmailContent();
        });
    }

    handleFilter(filter) {
        console.info('handle filter', filter);
        this.currentFilter = filter; // 保存当前过滤器状态
        switch (filter) {
            case 'all':
                this.reloadEmailList();
                break;
            case 'unread':
                const unreadEmailList = new Map([...this.emailHeaderList].filter(([_, email]) => email.unread));
                this.reloadEmailList(unreadEmailList);
                break;
            case 'starred':
                const starredEmailList = new Map([...this.emailHeaderList].filter(([_, email]) => email.starred));
                this.reloadEmailList(starredEmailList);
                break;
            case 'draft':
                this.reloadEmailList(new Map());
                break;
            case 'sent':
                this.reloadEmailList(new Map());
                break;
        }
    }

    async reloadCurrentEmailContent(redownload = false) {
        if (!this.selectedEmailUid) {
            return;
        }

        this.querySelector('#email-content').innerHTML = `
        <content-loading-view class="w-full h-full" data-message="正在加载邮件内容..."></content-loading-view>
        `;
        this.selectedEmailHeader = this.emailHeaderList.get(this.selectedEmailUid);

        if (redownload) {
            this.selectedEmailContent = await this.reDownloadEmailContent(this.selectedEmailUid);
        } else {
            this.selectedEmailContent = await this.getEmailContent(this.selectedEmailUid);
        }

        if (!this.selectedEmailContent) {
            return;
        }

        const topButtons = [
            { id: 'mailbox-reply-button', icon: 'fa-reply', label: '回复', action: () => this.createNewEmail() },
            { id: 'mailbox-reply-all-button', icon: 'fa-reply-all', label: '回复全部', action: () => this.createNewEmail() },
            { id: 'mailbox-forward-button', icon: 'fa-share', label: '转发', action: () => this.createNewEmail() },
            { id: 'mailbox-reload-button', icon: 'fa-redo-alt', label: '重新下载', action: () => this.openEmailByUid(this.selectedEmailUid, true) },
            { id: 'mailbox-trash-button', icon: 'fa-trash-alt', label: '删除', action: () => this.deleteEmail() },
            { id: 'mailbox-star-button', icon: 'fa-star', label: '收藏', action: () => this.starEmail(this.selectedEmailUid, !this.selectedEmailHeader.starred) },
        ]

        const toolbar = new ElasticToolbarWidget(topButtons);
        toolbar.classList.add('pl-3', 'pr-16')

        this.querySelector('#email-content').innerHTML = '';
        this.querySelector('#email-content').appendChild(toolbar);

        /* 不要直接操作innerHTML，因为可能会导致样式错乱 */
        this.querySelector('#email-content').insertAdjacentHTML('beforeend', `
        <!-- 邮件阅读区 -->
        <div class="flex-1 overflow-y-auto p-4 bg-white">
            <div class="max-w-4xl mx-auto">
                <!-- 邮件头部 -->
                ${this.renderCurrentEmailHeader()}
                <!-- 邮件主体 -->
                <div id="email-body-content" class="prose prose-indigo max-w-none w-full break-words overflow-x-auto overflow-y-auto">
                </div>
            </div>
        </div>
        `);

        document.querySelector('#email-body-content').attachShadow({ mode: 'open' });
        if (this.selectedEmailContent.htmlContent) {
            document.querySelector('#email-body-content').shadowRoot.innerHTML = this.selectedEmailContent.htmlContent;
        } else {
            let textContent = this.selectedEmailContent.textContent;
            textContent = textContent.replace(/\n/g, '<br>');
            document.querySelector('#email-body-content').shadowRoot.innerHTML = textContent;
        }

        document.querySelectorAll('.mailbox-open-attachment-item').forEach(item => {
            item.addEventListener('click', (event) => {
                const filePath = item.dataset.attachment_path;
                if (!filePath) {
                    return;
                }
                console.info('open attachment', filePath);
                window.fsAPI.openPath(filePath);
            });
        });
    }

    async openEmail(email, redownload = false) {
        await this.openEmailByUid(email.uid, redownload);
    }

    async openEmailByUid(uid, redownload = false) {
        this.selectedEmailUid = uid;
        await this.reloadCurrentEmailContent(redownload);
        if (this.selectedEmailHeader.unread) {
            await this.markEmailAsRead(uid);
        }
        this.applyCurrentFilter();
    }

    /**
     * 应用当前选中的过滤器
     */
    applyCurrentFilter() {
        this.handleFilter(this.currentFilter);
    }

    render() {
        this.innerHTML = `
        <div class="flex h-full">
            <!-- 左侧栏：融合了导航和列表 (Width: 400px) -->
            <aside class="w-[350px] bg-white border-r border-gray-200 flex flex-col flex-shrink-0">

                <!-- 顶部操作区 -->
                <div class="p-3 space-y-3">
                    <div class="flex items-center justify-between">
                        <h1 class="text-xl font-bold tracking-tight px-1">收件箱</h1>
                        <button id='mailbox-new-email-button' class="group flex items-center px-2 py-2 rounded-full
                                    bg-transparent hover:bg-white/60 hover:shadow-md
                                    transition-all duration-500 ease-[cubic-bezier(0.23,1,0.32,1)]
                                    text-gray-700 hover:text-blue-600">
                            <i class="fa-solid fa-plus"></i>
                            <span class="max-w-0 overflow-hidden opacity-0
                                        group-hover:max-w-[120px] group-hover:opacity-100
                                        group-hover:ml-2 transition-all duration-500 ease-in-out
                                        whitespace-nowrap font-medium tracking-tight text-sm">
                                写邮件
                            </span>
                        </button>
                    </div>

                    <!-- 搜索框 -->
                    <div class="relative rounded-2xl">
                        <i class="fas fa-search absolute left-3 top-3 text-gray-400"></i>
                        <input type="text" id="mailbox-search-input" placeholder="搜索邮件..." class="w-full bg-gray-100 border-none rounded-xl pl-10 pr-4 py-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
                    </div>

                    <!-- 导航标签 (水平排列) -->
                    <div class="flex gap-2 overflow-x-auto pb-1 text-xs no-scrollbar" id="mailbox-tabs">
                        <button class="whitespace-nowrap px-3 py-1.5 bg-gray-900 text-white rounded-lg active" id="mailbox-all-email-button">全部</button>
                        <button class="whitespace-nowrap px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-lg font-medium" id="mailbox-unread-email-button">未读</button>
                        <button class="whitespace-nowrap px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-lg font-medium" id="mailbox-star-email-button">收藏</button>
                        <button class="whitespace-nowrap px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-lg font-medium" id="mailbox-draft-email-button">草稿</button>
                        <button class="whitespace-nowrap px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-lg font-medium" id="mailbox-sent-email-button">已发送</button>
                    </div>
                </div>

                <!-- 邮件列表区 -->
                <div id="email-list" class="flex-1 overflow-y-auto border-t border-gray-200"></div>
            </aside>

            <!-- 右侧栏：邮件内容 -->
            <main id='email-content' class="flex-1 bg-white flex flex-col overflow-auto"></main>
        </div>
        `

        const tabsContainer = document.getElementById('mailbox-tabs');
        const tabButtons = tabsContainer.querySelectorAll('button');
        tabsContainer.addEventListener('click', function(e) {
            if (e.target.tagName === 'BUTTON') {
                // 重置所有按钮样式
                tabButtons.forEach(btn => {
                    btn.className = 'whitespace-nowrap px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-lg font-medium';
                });
                // 设置当前按钮为激活状态
                e.target.className = 'whitespace-nowrap px-3 py-1.5 bg-gray-900 text-white rounded-lg active';
            }
        });

        document.querySelector('#mailbox-new-email-button').addEventListener('click', () => {
            this.createNewEmail();
        });
        document.getElementById('mailbox-all-email-button').addEventListener('click', () => {
            this.handleFilter('all');
        });
        document.getElementById('mailbox-unread-email-button').addEventListener('click', () => {
            this.handleFilter('unread');
        });
        document.getElementById('mailbox-star-email-button').addEventListener('click', () => {
            this.handleFilter('starred');
        });
        document.getElementById('mailbox-draft-email-button').addEventListener('click', () => {
            this.handleFilter('draft');
        });
        document.getElementById('mailbox-sent-email-button').addEventListener('click', () => {
            this.handleFilter('sent');
        });

        // 搜索功能
        const searchInput = document.getElementById('mailbox-search-input');
        let searchTimeout = null;
        searchInput.addEventListener('input', (e) => {
            clearTimeout(searchTimeout);
            const query = e.target.value.trim();
            if (query === '') {
                // 如果搜索框为空，恢复显示所有邮件
                this.loadEmailList();
                return;
            }
            // 防抖：延迟500ms执行搜索
            searchTimeout = setTimeout(() => {
                this.performSearch(query);
            }, 500);
        });

        // 支持回车键立即搜索
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                clearTimeout(searchTimeout);
                const query = e.target.value.trim();
                if (query !== '') {
                    this.performSearch(query);
                }
            }
        });
    }

    /**
     * 解析搜索查询字符串，支持多种搜索格式
     * @param {string} queryString
     * @returns {Object}
     */
    parseSearchQuery(queryString) {
        const query = {};

        // 解析特殊格式的搜索
        // from:xxx, to:xxx, subject:xxx, body:xxx, date:YYYY-MM-DD
        const patterns = [
            { key: 'from', regex: /from:([^\s]+)/i },
            { key: 'to', regex: /to:([^\s]+)/i },
            { key: 'subject', regex: /subject:([^\s]+)/i },
            { key: 'body', regex: /body:([^\s]+)/i },
            { key: 'date', regex: /date:([^\s]+)/i },
        ];

        let remainingQuery = queryString;

        for (const pattern of patterns) {
            const match = queryString.match(pattern.regex);
            if (match) {
                query[pattern.key] = match[1];
                remainingQuery = remainingQuery.replace(pattern.regex, '').trim();
            }
        }

        // 如果没有指定特定字段，默认搜索主题、正文或发件人
        if (remainingQuery && !query.subject && !query.body && !query.from && !query.to) {
            query.general = remainingQuery; // 使用 general 字段表示通用搜索（主题、正文或发件人）
        } else if (remainingQuery) {
            // 如果还有其他文本，也添加到主题搜索中
            if (!query.subject) {
                query.subject = remainingQuery;
            }
        }

        return query;
    }

    /**
     * 执行搜索
     * @param {string} queryString
     */
    async performSearch(queryString) {
        const query = this.parseSearchQuery(queryString);

        // 处理日期范围
        if (query.date) {
            // 支持单个日期或日期范围
            if (query.date.includes('~')) {
                const [startDate, endDate] = query.date.split('~').map(d => d.trim());
                query.startDate = startDate;
                query.endDate = endDate || startDate;
            } else {
                query.startDate = query.date;
                query.endDate = query.date;
            }
            delete query.date;
        }

        this.searchEmails(query);
    }
}

class MailEditorWidget extends AgentOperableHTMLElement {
    constructor() {
        super();
    }

    connectedCallback() {
        this.render();
    }

    cancel() {
        console.info('cancel');
        this.dispatchEvent(new CustomEvent('cancel'), { bubbles: true });
    }

    send() {
        this.dispatchEvent(new CustomEvent('send', { bubbles: true }));
    }

    render() {
        const buttons = [
            { id: 'send-email-cancel-button', icon: 'fa-circle-arrow-left', label: '取消', action: () => this.cancel() },
            { id: 'send-email-send-button', icon: 'fa-paper-plane', label: '发送', action: () => this.send() },
        ]
        const headerToolbar = new ElasticToolbarWidget(buttons);

        this.innerHTML = '';
        this.appendChild(headerToolbar);

        this.insertAdjacentHTML('beforeend', `
        <!-- 邮件阅读区 -->
        <div class="flex-1 overflow-y-auto p-4 bg-white">
            <div class="max-w-4xl mx-auto">
                <!-- 邮件头部 -->
                <div class="mb-2">
                    <div class="flex flex-col items-center justify-between">
                        <div class="flex flex-col items-left w-full">
                            <div class="group flex flex-col items-left px-1 py-1 hover:bg-gray-50 transition-colors">
                                <span class="text-xs text-gray-400 mr-4 mb-1">${new Date().toLocaleString()}</span>
                                <input type="text" class="text-gray-900 text-lg font-bold leading-tight" placeholder="邮件主题" value="foo bar">
                            </div>

                            <!-- 收件人行 -->
                            <div class="group flex items-center px-1 py-1 hover:bg-gray-50 transition-colors">
                                <label class="w-12 text-xs text-gray-400 font-medium">收件人</label>
                                <div class="flex-1 flex flex-wrap gap-2 items-center">
                                    <div class="flex items-center bg-blue-100 border border-blue-200 rounded px-0.5 py-0.5 text-xs text-blue-700">
                                        <input type="text" class="text-gray-400 font-normal" placeholder="名字或邮箱地址">
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 邮件主体 -->
                <div id="email-body-content" class="prose prose-indigo max-w-none w-full h-full p-2 overflow-x-auto overflow-y-auto">
                    <div id="editor—wrapper">
                        <div id="toolbar-container"><!-- 工具栏 --></div>
                        <div id="editor-container"><!-- 编辑器 --></div>
                    </div>
                </div>
            </div>
        </div>

        <style>
        #editor—wrapper {
            border: 1px solid #ccc;
            z-index: 100; /* 按需定义 */
        }
        #toolbar-container {
            border-bottom: 1px solid #ccc;
        }
        </style>
        `);

        const editorConfig = {
            placeholder: 'Type here...',
            onChange(editor) {
              const html = editor.getHtml()
              // 也可以同步到 <textarea>
            },
        }

        const editor = window.wangEditor.createEditor({
            selector: '#editor-container',
            html: '<p><br></p>',
            config: editorConfig,
            mode: 'default', // or 'simple'
        })

        const toolbarConfig = {}
        const toolbar = window.wangEditor.createToolbar({
            editor,
            selector: '#toolbar-container',
            config: toolbarConfig,
            mode: 'default', // or 'simple'
        })
    }
}

customElements.define('mailbox-entry-widget', MailBoxEntryWidget);
customElements.define('mail-editor-widget', MailEditorWidget);

console.info('mailbox/renderer/entry.js loaded');