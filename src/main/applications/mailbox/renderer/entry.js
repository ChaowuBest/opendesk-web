import { RendererToolset, RendererTool, z } from '../../widget_utils.js';


class MailBoxEntryWidget extends HTMLElement {
    constructor() {
        super();
        this.emailHeaderList = new Map();
        this.selectedEmailUid = null;
        this.selectedEmailHeader = null;
        this.selectedEmailContent = null;
    }

    connectedCallback() {
        this.render();
        this.getEmailHeaderList().then((emails) => {
            console.info(emails);
            for (const email of emails) {
                this.emailHeaderList.set(email.uid, email);
            }
            this.reloadEmailList();
        })
    }

    getToolset() {
        let toolset = new RendererToolset('mailbox');
        if (this.selectedEmailUid !== null) {
            let getSelectedEmailTool = new RendererTool('getSelectedEmail', '获取当前用户选中正在浏览的邮件信息');
            getSelectedEmailTool.setExecutor(async (args) => {
                let result = '当前用户选中正在浏览的邮件信息为: \n';
                result += `主题: ${this.selectedEmailHeader.subject}\n`;
                result += `发送至: ${this.selectedEmailHeader.to}\n`;
                result += `发送时间: ${new Date(this.selectedEmailHeader.date).toLocaleString()}\n`;
                result += `邮件内容: ${this.selectedEmailContent.textContent || this.selectedEmailContent.htmlContent}\n`;
                return result;
            });
            toolset.addTool(getSelectedEmailTool);
        }
        let getEmailListTool = new RendererTool('getEmailList', '获取邮件列表');
        getEmailListTool.setExecutor(async (args) => {
            let result = '';
            for (const email of this.emailHeaderList.values()) {
                result += `- 主题: ${email.subject}\n`;
                result += `  - 邮件ID: ${email.uid}\n`;
                result += `  - 发送者: ${email.from}\n`;
                result += `  - 发送至: ${email.to}\n`;
                result += `  - 发送时间: ${new Date(email.date).toLocaleString()}\n`;
                result += `  - 邮件内容: ${email.textContent || email.htmlContent}\n`;
            }
            console.info(result);
            return result;
        });
        toolset.addTool(getEmailListTool);
        return toolset;
    }

    async getEmailHeaderList() {
        const emailHeaderList = await window.applicationAPI.sendMessageToApplication('getEmailHeaderList');
        emailHeaderList.sort((a, b) => new Date(b.date) - new Date(a.date));
        return emailHeaderList.slice(0, 200);
    }

    renderEmailItem(email) {
        const isSelected = email.uid === this.selectedEmailUid;
        var classes = "email-item p-3 border-b cursor-pointer border-l-4 ";
        if (isSelected) {
            classes += "bg-indigo-50/50 relative border-l-indigo-600";
        } else {
            classes += "hover:bg-gray-50 transition-colors border-l-transparent";
        }

        return `
        <div class="${classes}" data-uid="${email.uid}">
            <div class="flex justify-between items-start mb-1">
                <span class="font-bold text-gray-800">${email.subject}</span>
                <!-- <span class="text-xs text-gray-400"></span> -->
            </div>
            <!-- <p class="text-gray-900 font-medium truncate mb-1 text-[13px]">test</p> -->
            <p class="text-gray-500 line-clamp-2 text-xs leading-relaxed">${new Date(email.date).toLocaleString()}</p>
        </div>
        `
    }

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

    async reloadCurrentEmailContent() {
        if (this.selectedEmailUid === null) {
            return;
        }
        this.selectedEmailHeader = this.emailHeaderList.get(this.selectedEmailUid);
        this.selectedEmailContent = await window.applicationAPI.sendMessageToApplication('getEmailContent', this.selectedEmailUid);

        if (!this.selectedEmailContent) {
            return;
        }

        this.querySelector('#email-content').innerHTML = `
        <!-- 顶部工具栏 -->
        <header class="h-16 pl-8 pr-16 border-b flex items-center justify-between">
            <div class="flex items-center gap-6">
                <button class="text-gray-500 hover:text-indigo-600"><i class="fas fa-reply"></i></button>
                <button class="text-gray-500 hover:text-indigo-600"><i class="fas fa-reply-all"></i></button>
                <button class="text-gray-500 hover:text-indigo-600"><i class="fas fa-share text-sm"></i></button>
                <span class="h-4 w-px bg-gray-200 mx-2"></span>
                <button class="text-gray-500 hover:text-red-500"><i class="far fa-trash-alt"></i></button>
                <button class="text-gray-500 hover:text-amber-500"><i class="far fa-star"></i></button>
            </div>
            <div class="flex items-center gap-4">
                <span class="text-xs text-gray-400">1 / 1,240</span>
                <div class="flex border rounded-lg overflow-hidden">
                    <button class="px-3 py-1.5 hover:bg-gray-50 border-r"><i class="fas fa-chevron-left text-xs"></i></button>
                    <button class="px-3 py-1.5 hover:bg-gray-50"><i class="fas fa-chevron-right text-xs"></i></button>
                </div>
            </div>
        </header>

        <!-- 邮件阅读区 -->
        <div class="flex-1 overflow-y-auto px-6 py-6 bg-white">
            <div class="max-w-4xl mx-auto">
                <!-- 邮件头部 -->
                <div class="mb-10">
                    <h2 id="email-header-subject" class="text-2xl font-extrabold text-gray-900 mb-6 leading-tight"></h2>
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-4">
                            <div class="w-12 h-12 rounded-full bg-gray-900 flex items-center justify-center text-white">
                                <i class="fab fa-mail text-2xl"></i>
                            </div>
                            <div>
                                <h4 class="font-bold text-gray-900">${this.selectedEmailHeader.subject}</h4>
                                <p class="text-xs text-gray-500">发送至: ${this.selectedEmailHeader.to}</p>
                            </div>
                        </div>
                        <div class="text-right">
                            <p class="text-sm font-medium text-gray-900">${new Date(this.selectedEmailHeader.date).toLocaleString()}</p>
                            <p class="text-xs text-gray-400">12:30 (10小时前)</p>
                        </div>
                    </div>
                </div>

                <!-- 邮件主体 -->
                <div id="email-body-content" class="prose prose-indigo max-w-none w-full overflow-x-auto overflow-y-auto">
                </div>
            </div>
        </div>
        `

        document.querySelector('#email-body-content').attachShadow({ mode: 'open' });
        document.querySelector('#email-body-content').shadowRoot.innerHTML = this.selectedEmailContent.htmlContent;
    }

    openEmail(email) {
        this.selectedEmailUid = email.uid;
        this.reloadEmailList();
        this.reloadCurrentEmailContent();
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

                <!-- 底部个人信息与导航
                <div class="p-4 bg-gray-50 border-t flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <img class="w-8 h-8 rounded-full border border-gray-200" src="https://ui-avatars.com/api/?name=Alex+Zhang&background=6366f1&color=fff" alt="">
                        <span class="font-semibold text-xs">Alex Zhang</span>
                    </div>
                    <div class="flex gap-3 text-gray-400">
                        <button class="hover:text-indigo-600 transition-colors"><i class="fas fa-cog"></i></button>
                        <button class="hover:text-indigo-600 transition-colors"><i class="fas fa-question-circle"></i></button>
                    </div>
                </div> -->
            </aside>

            <!-- 右侧栏：邮件内容 (Responsive Flex-1) -->
            <main id='email-content' class="flex-1 bg-white flex flex-col overflow-auto"></main>
        </div>
        `
    }
}

customElements.define('mailbox-entry-widget', MailBoxEntryWidget);