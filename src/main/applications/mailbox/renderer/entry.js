import { RendererToolset, RendererTool, z, AgentOperableHTMLElement } from '../../widget_utils.js';


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
    }

    connectedCallback() {
        this.render();
        this.getEmailHeaderList().then((emails) => {
            this.emailHeaderList.clear();
            for (const email of emails) {
                this.emailHeaderList.set(email.uid, email);
            }
            this.reloadEmailList();
        })
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
        toolset.addTools(getEmailListTool, getEmailContentTool);
        return toolset;
    }

    /**
     * Get the list of email headers from the database
     * @param {import('zod').ZodObject<EmailHeaderQuerySchema> | undefined} query
     * @returns {Promise<EmailHeader[]>}
     */
    async getEmailHeaderList(query) {
        const emailHeaderList = await window.applicationAPI.sendMessageToApplication('getEmailHeaderList', query);
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
        var classes = "email-item p-3 border-b cursor-pointer border-l-4 ";
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
            </div>
            <!-- <p class="text-gray-900 font-medium truncate mb-1 text-[13px]">test</p> -->
            <p class="text-gray-500 line-clamp-2 text-xs leading-relaxed">${new Date(email.date).toLocaleString()}</p>
        </div>
        `
    }

    /**
     * 重新载入邮件列表
     */
    reloadEmailList() {
        const emailListContainer = this.querySelector('#email-list');
        emailListContainer.innerHTML = '';
        for (const email of this.emailHeaderList.values()) {
            emailListContainer.innerHTML += this.renderEmailItem(email);
        }

        this.querySelectorAll('.email-item').forEach(item => {
            item.addEventListener('click', (event) => {
                const uid = item.dataset.uid;
                console.info(uid);
                const email = this.emailHeaderList.get(uid);
                this.openEmail(email);
            });
        });
    }

    async getEmailContent(uid) {
        return await window.applicationAPI.sendMessageToApplication('getEmailContent', uid);
    }

    async reDownloadEmailContent(uid) {
        return await window.applicationAPI.sendMessageToApplication('reDownloadEmailContent', uid);
    }

    async markEmailAsRead(uid) {
        console.info('mark email as read', uid);
        await window.applicationAPI.sendMessageToApplication('markEmailAsRead', uid);
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
        const mailEditor = new SendEmailWidget();
        emailContent.innerHTML = '';
        emailContent.appendChild(mailEditor);
    }

    async createToolbar(buttons) {
        const topButtonsHTML = buttons.map(button => {
            return `
            <button id='${button.id}' class="group flex items-center px-2 py-2 rounded-full
                        bg-transparent hover:bg-white/60 hover:shadow-md
                        transition-all duration-500 ease-[cubic-bezier(0.23,1,0.32,1)]
                        text-gray-700 hover:text-blue-600">
                <i class="fa-solid ${button.icon}"></i>
                <span class="max-w-0 overflow-hidden opacity-0
                            group-hover:max-w-[120px] group-hover:opacity-100
                            group-hover:ml-2 transition-all duration-500 ease-in-out
                            whitespace-nowrap font-medium tracking-tight text-sm">
                    ${button.label}
                </span>
            </button>
            `
        }).join('');

        let toolbarHTML = `
        <!-- 顶部工具栏 -->
        <header class="h-16 pl-3 pr-16 border-b flex items-center justify-between">
            <div class="flex items-center gap-2 p-1">
                ${topButtonsHTML}
            </div>
        </header>
        `;

        return toolbarHTML;
    }

    async reloadCurrentEmailContent(redownload = false) {
        if (!this.selectedEmailUid) {
            return;
        }

        this.querySelector('#email-content').innerHTML = `<content-loading-view data-message="正在加载邮件内容..."></content-loading-view>`;
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
            { id: 'mailbox-star-button', icon: 'fa-star', label: '收藏', action: () => this.starEmail() },
        ]

        const toolbarHTML = await this.createToolbar(topButtons);

        this.querySelector('#email-content').innerHTML = `
        ${toolbarHTML}

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
        `

        document.querySelector('#email-body-content').attachShadow({ mode: 'open' });
        if (this.selectedEmailContent.htmlContent) {
            document.querySelector('#email-body-content').shadowRoot.innerHTML = this.selectedEmailContent.htmlContent;
        } else {
            let textContent = this.selectedEmailContent.textContent;
            textContent = textContent.replace(/\n/g, '<br>');
            document.querySelector('#email-body-content').shadowRoot.innerHTML = textContent;
        }

        for (const button of topButtons) {
            document.querySelector(`#${button.id}`).addEventListener('click', () => {
                button.action();
            });
        }

        document.querySelectorAll('.mailbox-open-attachment-item').forEach(item => {
            item.addEventListener('click', (event) => {
                const filePath = item.dataset.attachment_path;
                if (!filePath) {
                    return;
                }
                console.info('open attachment', filePath);
                window.fsAPI.openFile(filePath);
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
            this.selectedEmailHeader.unread = false;
        }
        this.reloadEmailList();
    }

    render() {
        this.innerHTML = `
        <div class="flex h-full">
            <!-- 左侧栏：融合了导航和列表 (Width: 400px) -->
            <aside class="w-[350px] bg-white border-r flex flex-col flex-shrink-0">

                <!-- 顶部操作区 -->
                <div class="p-3 space-y-3">
                    <div class="flex items-center justify-between">
                        <h1 class="text-xl font-bold tracking-tight px-1">收件箱</h1>
                        <button class="p-2 bg-indigo-600 text-white rounded-full hover:bg-indigo-700 shadow-lg shadow-indigo-200 transition-all">
                            <i class="fas fa-plus px-1"></i>
                        </button>
                    </div>

                    <!-- 搜索框 -->
                    <div class="relative rounded-2xl">
                        <i class="fas fa-search absolute left-3 top-3 text-gray-400"></i>
                        <input type="text" placeholder="搜索邮件..." class="w-full bg-gray-100 border-none rounded-xl pl-10 pr-4 py-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
                    </div>

                    <!-- 导航标签 (水平排列) -->
                    <div class="flex gap-2 overflow-x-auto pb-1 text-xs no-scrollbar">
                        <button class="whitespace-nowrap px-3 py-1.5 bg-gray-900 text-white rounded-lg">全部</button>
                        <button class="whitespace-nowrap px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-lg font-medium">未读</button>
                        <button class="whitespace-nowrap px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-lg font-medium">收藏</button>
                        <button class="whitespace-nowrap px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-lg font-medium">草稿</button>
                        <button class="whitespace-nowrap px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-lg font-medium">已发送</button>
                    </div>
                </div>

                <!-- 邮件列表区 -->
                <div id="email-list" class="flex-1 overflow-y-auto border-t"></div>
            </aside>

            <!-- 右侧栏：邮件内容 -->
            <main id='email-content' class="flex-1 bg-white flex flex-col overflow-auto"></main>
        </div>
        `
    }
}

class SendEmailWidget extends AgentOperableHTMLElement {
    constructor() {
        super();
    }

    connectedCallback() {
        this.render();
    }

    render() {
        this.innerHTML = `
        <div class="flex-1 overflow-y-auto bg-white">
            <!-- 顶部工具栏 -->
            <header class="h-16 pl-8 pr-16 border-b flex items-center justify-between">
                <div class="flex items-center gap-6">
                    <button id='mailbox-reply-button' class="text-gray-500 hover:text-indigo-600"><i class="fas fa-reply"></i></button>
                    <button id='mailbox-reply-all-button' class="text-gray-500 hover:text-indigo-600"><i class="fas fa-reply-all"></i></button>
                    <button id='mailbox-forward-button' class="text-gray-500 hover:text-indigo-600"><i class="fas fa-share text-sm"></i></button>
                    <span class="h-4 w-px bg-gray-200 mx-2"></span>
                    <button class="text-gray-500 hover:text-red-500"><i class="far fa-trash-alt"></i></button>
                    <button class="text-gray-500 hover:text-amber-500"><i class="far fa-star"></i></button>
                </div>
                <div class="flex items-center gap-4">
                    <!-- <span class="text-xs text-gray-400">1 / 1,240</span> -->
                    <div class="flex border rounded-lg overflow-hidden">
                        <button class="px-3 py-1.5 hover:bg-gray-50 border-r"><i class="fas fa-chevron-left text-xs"></i></button>
                        <button class="px-3 py-1.5 hover:bg-gray-50"><i class="fas fa-chevron-right text-xs"></i></button>
                    </div>
                </div>
            </header>

            <!-- 邮件头部 -->
            <!-- 邮件主体 -->
            <div id="email-body-content" class="prose prose-indigo max-w-none w-full h-full p-2 overflow-x-auto overflow-y-auto">
                <div id="editor—wrapper">
                    <div id="toolbar-container"><!-- 工具栏 --></div>
                    <div id="editor-container"><!-- 编辑器 --></div>
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
        #editor-container {
            height: 500px;
        }
        </style>
        `

        const { createEditor, createToolbar } = window.wangEditor
        const editorConfig = {
            placeholder: 'Type here...',
            onChange(editor) {
              const html = editor.getHtml()
              console.log('editor content', html)
              // 也可以同步到 <textarea>
            },
        }

        const editor = createEditor({
            selector: '#editor-container',
            html: '<p><br></p>',
            config: editorConfig,
            mode: 'default', // or 'simple'
        })

        const toolbarConfig = {}
        const toolbar = createToolbar({
            editor,
            selector: '#toolbar-container',
            config: toolbarConfig,
            mode: 'default', // or 'simple'
        })
    }
}

customElements.define('mailbox-entry-widget', MailBoxEntryWidget);
customElements.define('send-email-widget', SendEmailWidget);