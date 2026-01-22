import { z } from 'zod';
import { RendererToolset, RendererTool, AgentOperableHTMLElement } from '../../widget_utils.js';
import { ElasticToolbarWidget } from '../../../../renderer/components/toolbar.js';

// ========== Tagify 导入 ==========
import Tagify from '@yaireo/tagify';
import '@yaireo/tagify/dist/tagify.css';

// ========== SweetAlert2 导入 ==========
import Swal from 'sweetalert2';
import 'sweetalert2/dist/sweetalert2.min.css';

// ========== TinyMCE 7.x 完整导入（避免 license key 弹窗）==========
// 1. 引入核心
import tinymce from 'tinymce/tinymce';

// 2. 引入外观与模型
import 'tinymce/models/dom'; // v7 必须要有
import 'tinymce/themes/silver'; // 主题
import 'tinymce/icons/default'; // 图标

// 3. 引入需要用到的插件
import 'tinymce/plugins/advlist';
import 'tinymce/plugins/anchor';
import 'tinymce/plugins/autolink';
import 'tinymce/plugins/charmap';
import 'tinymce/plugins/code';
import 'tinymce/plugins/fullscreen';
import 'tinymce/plugins/help';
import 'tinymce/plugins/image';
import 'tinymce/plugins/insertdatetime';
import 'tinymce/plugins/link';
import 'tinymce/plugins/lists';
import 'tinymce/plugins/media';
import 'tinymce/plugins/preview';
import 'tinymce/plugins/searchreplace';
import 'tinymce/plugins/table';
import 'tinymce/plugins/visualblocks';
import 'tinymce/plugins/wordcount';

// 4. 【关键】引入皮肤 CSS（避免动态加载）
import 'tinymce/skins/ui/oxide/skin.css';
// 引入内容区域的排版样式
import contentCss from 'tinymce/skins/content/default/content.css?inline';
import contentUiCss from 'tinymce/skins/ui/oxide/content.css?inline';

// 5. 引入中文语言包
import 'tinymce-i18n/langs7/zh_CN.js';
// ========== TinyMCE 7.x 导入结束 ==========

const MailOperations = Object.freeze({
    SEND: 'send',
    REPLY: 'reply',
    REPLYALL: 'replyall',
    FORWARD: 'forward',
    POLISH: 'polish'
});

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
        /** @type {number} */
        this.currentOffset = 0; // 当前加载的邮件偏移量
        /** @type {number} */
        this.emailPerPage = 20; // 每页加载的邮件数量 
        /** @type {boolean} */
        this.isLoading = false; // 是否正在加载邮件
        /** @type {boolean} */
        this.hasMoreEmails = true; // 是否还有更多邮件可加载
        /** @type {string | null} */
        this.loadingError = null; // 加载错误信息
        /** @type {boolean} */
        this.isHeadersExpanded = false; // 邮件头是否展开
    }

    connectedCallback() {
        this.render();
        this.loadEmailList();

        // 订阅邮件列表更新事件
        window.applicationAPI.subscribe('emailListUpdated', () => {
            this.loadEmailList();
        });

        // 添加滚动事件监听
        this.setupScrollListener();
    }

    /**
     * 设置滚动事件监听
     */
    setupScrollListener() {
        const emailListContainer = this.querySelector('#email-list');
        if (!emailListContainer) return;

        // 节流函数，优化滚动事件处理
        const throttle = (func, delay) => {
            let inThrottle;
            return function() {
                const args = arguments;
                const context = this;
                if (!inThrottle) {
                    func.apply(context, args);
                    inThrottle = true;
                    setTimeout(() => inThrottle = false, delay);
                }
            }
        };

        // 滚动事件处理函数
        const handleScroll = throttle(() => {
            if (this.isLoading || !this.hasMoreEmails) return;

            const { scrollTop, scrollHeight, clientHeight } = emailListContainer;
            // 当滚动到距离底部 100px 时触发加载
            if (scrollHeight - scrollTop - clientHeight < 100) {
                this.loadMoreEmails();
            }
        }, 100);

        emailListContainer.addEventListener('scroll', handleScroll);
    }

    async loadEmailList() {
        // 重置状态变量
        this.currentOffset = 0;
        this.hasMoreEmails = true;
        this.loadingError = null;
        
        const emails = await this.getEmailHeaderList(this.currentOffset, this.emailPerPage);
        this.emailHeaderList.clear();
        for (const email of emails) {
            this.emailHeaderList.set(email.uid, email);
        }
        this.currentOffset += emails.length;
        
        // 检查是否还有更多邮件
        if (emails.length < this.emailPerPage) {
            this.hasMoreEmails = false;
        }
        
        this.reloadEmailList();
        this.applyCurrentFilter();
    }

    /**
     * Load more emails incrementally
     */
    async loadMoreEmails() {
        if (this.isLoading || !this.hasMoreEmails) return;
        
        this.isLoading = true;
        this.loadingError = null;
        
        // 更新加载状态 UI
        this.updateLoadingStatusUI();
        
        try {
            const emails = await this.getEmailHeaderList(this.currentOffset, this.emailPerPage);
            
            // 检查是否还有更多邮件
            if (emails.length < this.emailPerPage) {    
                this.hasMoreEmails = false;
            }
            
            // 添加新邮件到现有列表
            for (const email of emails) {
                this.emailHeaderList.set(email.uid, email);
            }
            this.currentOffset += emails.length;
            
            // 重新渲染邮件列表
            this.reloadEmailList();
        } catch (error) {
            console.error('Error loading more emails:', error);
            this.loadingError = '加载邮件失败，请重试';
        } finally {
            this.isLoading = false;
            // 更新加载状态 UI
            this.updateLoadingStatusUI();
        }
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
        let writeEmailTool = new RendererTool('writeEmail', '撰写邮件,邮件正文内容由你自动生成');
        writeEmailTool.setParams(z.object({
            to: z.array(z.string()).describe("收件人列表"),
            cc: z.array(z.string()).describe("抄送人列表,如果为提供则为空"),
            subject: z.string().describe("主题"),
            content: z.string().describe("邮件正文内容,html格式")
        }))
        writeEmailTool.setExecutor(async (args) => {
            let to = [];
            let cc = [];
            for (const item of args.to) {
                to.push({user: '', address: item});
            }
            for (const item of args.cc) {
                cc.push({user: '', address: item});
            }
            let mailHeader = {subject: args.subject, to: to, cc: cc};
            let mailContent = {htmlContent: args.content, textContent: args.content};
            this.createNewEmail(MailOperations.SEND, mailHeader, mailContent);
            return "邮件已撰写完成";
        })

        let replyEmailTool = new RendererTool('replyEmail', '回复邮件,回复内容由你根据指定邮件内容自动生成');
        replyEmailTool.setParams(z.object({
            replyContent: z.string().describe("回复内容,html格式")
        }))
        replyEmailTool.setExecutor(async (args) => {
            if (!this.selectedEmailUid) {
                return "请选择一封具体的邮件让我回复";
            }
            this.createNewEmail(MailOperations.REPLY, this.selectedEmailHeader, this.selectedEmailContent, args.replyContent);
            return "邮件回复完成";
        })

        let getEditEmailTool = new RendererTool('getEditEmail', '获取当前正在编辑的邮件内容');
        getEditEmailTool.setExecutor(async (args) => {
            const emailContent = this.querySelector('#email-content');
            return emailContent.innerHTML;
        });

        let PolishEmailTool = new RendererTool('polishEmail', '邮件校对和润色');
        PolishEmailTool.setParams(z.object({
            content: z.string().describe("校对润色后的邮件正文内容,html格式")
        }))
        PolishEmailTool.setExecutor(async (args) => {
            const editor = document.querySelector('#editor');
            await editor.setMailContent(MailOperations.POLISH, {}, args.content)
            return `已完成邮件润色`;
        });

        toolset.addTools(getEmailListTool, getEmailContentTool, markEmailAsReadTool, writeEmailTool, replyEmailTool, getEditEmailTool, PolishEmailTool);
        return toolset;
    }

    /**
     * Get the list of email headers from the database
     * @param {number} offset - The offset to start from
     * @param {number} pageSize - The page size of emails to return
     * @returns {Promise<EmailHeader[]>}
     */
    async getEmailHeaderList(offset = this.currentOffset, pageSize = this.emailPerPage) {
        console.info('getting email header list', { offset, pageSize });
        
        const emailHeaderList = await window.applicationAPI.call('getEmailHeaderList', offset, pageSize);
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
        
        // 添加加载状态 UI
        this.updateLoadingStatusUI();
        
        this.querySelectorAll('.email-item').forEach(item => {
            item.addEventListener('click', (event) => {
                const uid = item.dataset.uid;
                console.info(uid);
                const email = emailList.get(uid);
                this.openEmail(email);
            });
        });
    }

    /**
     * 更新加载状态 UI
     */
    updateLoadingStatusUI() {
        const emailListContainer = this.querySelector('#email-list') || this.querySelector('.email-list-container');
        if (!emailListContainer) {
            console.warn('Email list container not found');
            return;
        }
        
        // 复用或创建加载状态元素
        let loadingElement = emailListContainer.querySelector('.loading-status');
        if (!loadingElement) {
            loadingElement = document.createElement('div');
            loadingElement.className = 'loading-status';
            emailListContainer.appendChild(loadingElement);
        }
        
        // 根据状态更新内容
        let content = '';
        if (this.isLoading) {
            content = `
                <div class="text-gray-500 text-center py-4 animate-pulse">
                    加载中...
                </div>
            `;
        } else if (!this.hasMoreEmails && this.emailHeaderList.size > 0) {
            content = `
                <div class="text-gray-500 text-center py-4">
                    已加载全部邮件
                </div>
            `;
        } else if (this.loadingError) {
            // HTML 转义错误信息
            const escapedError = this.loadingError.replace(/[&<>"']/g, (char) => {
                const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
                return entities[char];
            });
            content = `
                <div class="text-red-500 text-center py-4">
                    ${escapedError}
                    <button class="ml-2 text-blue-500 hover:underline retry-button">
                        重试
                    </button>
                </div>
            `;
        }
        
        // 只在内容变化时更新
        if (loadingElement.innerHTML !== content) {
            loadingElement.innerHTML = content;
            
            // 绑定重试按钮事件
            const retryButton = loadingElement.querySelector('.retry-button');
            if (retryButton) {
                retryButton.onclick = () => {
                    this.loadMoreEmails();
                };
            }
        }
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
        if (this.selectedEmailUid === uid) {
            this.selectedEmailHeader.unread = false;
            this.updateReadUnreadButton();
        }
        this.applyCurrentFilter();
    }

    async markEmailAsUnread(uid) {
        console.info('mark email as unread', uid);
        await window.applicationAPI.call('markEmailAsUnread', uid);
        this.emailHeaderList.get(uid).unread = true;
        if (this.selectedEmailUid === uid) {
            this.selectedEmailHeader.unread = true;
            this.updateReadUnreadButton();
        }
        this.applyCurrentFilter();
    }

    updateReadUnreadButton() {
        // 查找工具栏中的已读/未读按钮（通过 ID 前缀匹配，因为 ElasticToolbarWidget 会给 ID 添加 uid 后缀）
        const toolbar = this.querySelector('elastic-toolbar-widget');
        if (!toolbar) {
            return;
        }
        const allButtons = toolbar.querySelectorAll('button');
        let readUnreadButton = null;
        for (const button of allButtons) {
            if (button.id.includes('mailbox-mark-read-button') || button.id.includes('mailbox-mark-unread-button')) {
                readUnreadButton = button;
                break;
            }
        }

        if (!readUnreadButton) {
            return;
        }
        const icon = readUnreadButton.querySelector('i');
        const label = readUnreadButton.querySelector('span');
        const newIdPrefix = this.selectedEmailHeader.unread ? 'mailbox-mark-read-button' : 'mailbox-mark-unread-button';
        const newId = `${newIdPrefix}-${toolbar.uid}`;
        if (this.selectedEmailHeader.unread) {
            readUnreadButton.id = newId;
            if (icon) icon.className = 'fa-solid fa-envelope-open';
            if (label) label.textContent = '标为已读';
        } else {
            readUnreadButton.id = newId;
            if (icon) icon.className = 'fa-solid fa-envelope';
            if (label) label.textContent = '标为未读';
        }

        const newButton = readUnreadButton.cloneNode(true);
        readUnreadButton.parentNode.replaceChild(newButton, readUnreadButton);
        if (this.selectedEmailHeader.unread) {
            newButton.addEventListener('click', () => this.markEmailAsRead(this.selectedEmailUid));
        } else {
            newButton.addEventListener('click', () => this.markEmailAsUnread(this.selectedEmailUid));
        }
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

    /**
     * 立即同步邮件
     */
    async syncEmails() {
        const syncButton = document.querySelector('#mailbox-sync-email-button');
        const icon = syncButton.querySelector('i');

        // 添加旋转动画
        icon.classList.add('fa-spin');
        syncButton.disabled = true;

        try {
            await window.applicationAPI.call('syncEmails');
            await new Promise(resolve => setTimeout(resolve, 1000));
            await this.loadEmailList();
        } catch (error) {
            console.error('同步邮件失败:', error);
        } finally {
            icon.classList.remove('fa-spin');
            syncButton.disabled = false;
        }
    }

    async sendEmail(sendEmailSchema) {
        await window.applicationAPI.call('sendEmail', sendEmailSchema);
        this.reloadCurrentEmailContent();
    }

    renderCurrentEmailHeader() {
        // 渲染单个邮箱地址
        const renderEmailAddress = (address, type) => {
            let bgColor, borderColor, textColor;
            switch (type) {
                case 'from':
                    bgColor = 'bg-gray-200/60';
                    borderColor = 'border-gray-300';
                    textColor = 'text-gray-700';
                    break;
                case 'to':
                    bgColor = 'bg-blue-100';
                    borderColor = 'border-blue-200';
                    textColor = 'text-blue-700';
                    break;
                case 'cc':
                    bgColor = 'bg-green-100';
                    borderColor = 'border-green-200';
                    textColor = 'text-green-700';
                    break;
                case 'bcc':
                    bgColor = 'bg-purple-100';
                    borderColor = 'border-purple-200';
                    textColor = 'text-purple-700';
                    break;
                default:
                    bgColor = 'bg-gray-200/60';
                    borderColor = 'border-gray-300';
                    textColor = 'text-gray-700';
            }
            
            return `
            <div class="flex items-center ${bgColor} border ${borderColor} rounded px-1.5 py-0.5 text-xs ${textColor}">
                <span class="font-medium">${address.name}</span>
                <span class="ml-1 text-gray-400 italic font-normal">&lt;${address.address}&gt;</span>
                ${type === 'from' ? `
                <button class="ml-1 text-gray-400 hover:text-gray-600">
                    <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" /></svg>
                </button>
                ` : ''}
            </div>
            `;
        };
        
        // 检查是否需要显示展开/收起按钮
        const needsExpandButton = () => {
            const totalAddresses = 
                (this.selectedEmailHeader.to?.length || 0) +
                (this.selectedEmailHeader.cc?.length || 0) +
                (this.selectedEmailHeader.bcc?.length || 0);
            return totalAddresses > 3;
        };
        
        var addresses = '';
        
        // 渲染发件人，右侧添加展开/收起按钮
        if (this.selectedEmailHeader.from && this.selectedEmailHeader.from.length > 0) {
            const senderHtml = this.selectedEmailHeader.from.map(addr => renderEmailAddress(addr, 'from')).join('');
            
            let expandButton = '';
            if (needsExpandButton()) {
                expandButton = `
                <button class="email-expand-toggle bg-white border border-gray-300 rounded px-1.5 py-0.5 text-xs text-gray-600 hover:bg-gray-50 focus:outline-none focus:ring-1 focus:ring-gray-300 ml-2" 
                        data-expanded="${this.isHeadersExpanded}">
                    ${this.isHeadersExpanded ? '收起' : '展开'}
                </button>
                `;
            }
            
            addresses += `
            <!-- 发件人行 -->
            <div class="group flex items-start px-1 py-1 hover:bg-gray-50 transition-colors">
                <label class="w-12 text-xs text-gray-400 font-medium pt-0.5">发件人</label>
                <div class="flex-1 flex flex-wrap gap-2 items-center">
                    ${senderHtml}
                    ${expandButton}
                </div>
            </div>
            `;
        }
        
        // 渲染收件人，默认显示前3个
        if (this.selectedEmailHeader.to && this.selectedEmailHeader.to.length > 0) {
            const maxVisible = this.isHeadersExpanded ? this.selectedEmailHeader.to.length : 3;
            const displayTos = this.selectedEmailHeader.to.slice(0, maxVisible);
            const toHtml = displayTos.map(addr => renderEmailAddress(addr, 'to')).join('');
            
            addresses += `
            <!-- 收件人行 -->
            <div class="group flex items-start px-1 py-1 hover:bg-gray-50 transition-colors">
                <label class="w-12 text-xs text-gray-400 font-medium pt-0.5">收件人</label>
                <div class="flex-1 flex flex-wrap gap-2">
                    ${toHtml}
                </div>
            </div>
            `;
        }
        
        // 渲染抄送，展开时显示
        if (this.selectedEmailHeader.cc && this.selectedEmailHeader.cc.length > 0 && this.isHeadersExpanded) {
            const ccHtml = this.selectedEmailHeader.cc.map(addr => renderEmailAddress(addr, 'cc')).join('');
            addresses += ` <!-- 抄送行 -->
            <div class="group flex items-start px-1 py-1 hover:bg-gray-50 transition-colors">
                <label class="w-12 text-xs text-gray-400 font-medium pt-0.5">抄送</label>
                <div class="flex-1 flex flex-wrap gap-2">
                    ${ccHtml}
                </div>
            </div>
            `;
        }
        
        // 渲染密送，展开时显示
        if (this.selectedEmailHeader.bcc && this.selectedEmailHeader.bcc.length > 0 && this.isHeadersExpanded) {
            const bccHtml = this.selectedEmailHeader.bcc.map(addr => renderEmailAddress(addr, 'bcc')).join('');
            addresses += ` <!-- 密送行 -->
            <div class="group flex items-start px-1 py-1 hover:bg-gray-50 transition-colors">
                <label class="w-12 text-xs text-gray-400 font-medium pt-0.5">密送</label>
                <div class="flex-1 flex flex-wrap gap-2">
                    ${bccHtml}
                </div>
            </div>
            `;
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

    async createNewEmail(operation, mailHeader, mailContent, replyContent) {
        // 这里可以直接 new 一个邮件编辑控件并赋值给 #email-content
        const emailContent = this.querySelector('#email-content');
        const editor = new MailEditorWidget();
        editor.classList.add('flex-1', 'overflow-y-auto', 'bg-white');
        editor.id = 'editor';
        emailContent.innerHTML = '';
        emailContent.appendChild(editor);
        editor.addEventListener('cancel', () => {
            this.reloadCurrentEmailContent();
        });
        editor.addEventListener('send', async() => {
            const mailSchema = await editor.getMailContent()
            this.sendEmail(mailSchema);
        });
        editor.setMailContent(operation, mailHeader, mailContent, replyContent)
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
            this.querySelector('#email-content').replaceChildren();
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

        // 根据邮件状态动态设置已读/未读按钮
        const readUnreadButton = this.selectedEmailHeader.unread
            ? { id: 'mailbox-mark-read-button', icon: 'fa-envelope-open', label: '标为已读', action: () => this.markEmailAsRead(this.selectedEmailUid) }
            : { id: 'mailbox-mark-unread-button', icon: 'fa-envelope', label: '标为未读', action: () => this.markEmailAsUnread(this.selectedEmailUid) };

        const topButtons = [
            { id: 'mailbox-reply-button', icon: 'fa-reply', label: '回复', action: () => this.createNewEmail(MailOperations.REPLY, this.selectedEmailHeader, this.selectedEmailContent) },
            { id: 'mailbox-reply-all-button', icon: 'fa-reply-all', label: '回复全部', action: () => this.createNewEmail(MailOperations.REPLYALL, this.selectedEmailHeader, this.selectedEmailContent) },
            { id: 'mailbox-forward-button', icon: 'fa-share', label: '转发', action: () => this.createNewEmail(MailOperations.FORWARD, this.selectedEmailHeader, this.selectedEmailContent) },
            { id: 'mailbox-reload-button', icon: 'fa-redo-alt', label: '重新下载', action: () => this.openEmailByUid(this.selectedEmailUid, true) },
            { id: 'mailbox-trash-button', icon: 'fa-trash-alt', label: '删除', action: () => this.handleDelete(this.selectedEmailUid) },
            { id: 'mailbox-star-button', icon: 'fa-star', label: '收藏', action: () => this.starEmail(this.selectedEmailUid, !this.selectedEmailHeader.starred) },
            readUnreadButton,

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

        // 添加展开/收起按钮事件监听器
        const expandButton = document.querySelector('.email-expand-toggle');
        if (expandButton) {
            expandButton.addEventListener('click', () => {
                this.isHeadersExpanded = !this.isHeadersExpanded;
                this.reloadCurrentEmailContent();
            });
        }
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

    async handleDelete(uid, redownload = false) {
    // 1. 弹出询问框（UI 逻辑）
        const result = await Swal.fire({
            title: '确定要删除这封邮件吗？',
            text: "此操作无法撤销",
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#d33', 
            cancelButtonColor: '#3085d6',
            confirmButtonText: '确定',
            cancelButtonText: '取消',
            didOpen: (popup) => {
                popup.style.fontSize = '0.8rem'; // 设置为原大小的 80%
            },
        });
        // 2. 判断用户选择
        if (result.isConfirmed) {
            try {
                // 3. 执行核心删除逻辑（业务逻辑）
                // 注意：这里调用的是你原来的 deleteEmail
                console.info('deleting email', uid);
                await this.deleteEmail(uid, redownload);
                console.info('email deleted', uid);
            } catch (error) {
                console.info(error);
                // 5. 错误提示
                Swal.fire({
                    title: '删除失败',
                    text: error.message || '删除邮件时发生错误，请稍后重试。',
                    icon: 'error'
                });
            }
        }   
    }

    async deleteEmail(uid, redownload = false) {
        const keys = Array.from(this.emailHeaderList.keys());
        const index = keys.indexOf(uid);
        const nextuid = keys[index + 1];
        await window.applicationAPI.call('deleteEmail', uid);
        this.emailHeaderList.delete(uid);
        this.selectedEmailUid = nextuid;
        this.reloadEmailList();
        await this.reloadCurrentEmailContent(redownload);
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
                        <div class="flex items-center gap-2">
                            <button id='mailbox-sync-email-button' class="group flex items-center px-2 py-2 rounded-full
                                        bg-transparent hover:bg-white/60 hover:shadow-md
                                        transition-all duration-500 ease-[cubic-bezier(0.23,1,0.32,1)]
                                        text-gray-700 hover:text-blue-600" title="同步邮件">
                                <i class="fa-solid fa-sync-alt"></i>
                                <span class="max-w-0 overflow-hidden opacity-0
                                            group-hover:max-w-[120px] group-hover:opacity-100
                                            group-hover:ml-2 transition-all duration-500 ease-in-out
                                            whitespace-nowrap font-medium tracking-tight text-sm">
                                    同步
                                </span>
                            </button>
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
            this.createNewEmail(MailOperations.SEND);
        });
        document.querySelector('#mailbox-sync-email-button').addEventListener('click', () => {
            this.syncEmails();
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
        this.attachments = [];
        this.editorReady = new Promise((resolve) => {
            this.resolveEditor = resolve;
        });
        // 保存 Tagify 实例
        this.tagifyInstances = {
            to: null,
            cc: null,
            bcc: null
        };
    }

    /**
     * 从 Tagify 输入框中获取邮箱地址数组
     * @param {string} inputId - input 元素的 id ('to', 'cc', 'bcc')
     * @returns {Array<string>} 邮箱地址字符串数组（适配 nodemailer）
     */
    getTagValue(inputId) {
        const tagifyInstance = this.tagifyInstances[inputId];
        if (!tagifyInstance) {
            console.warn(`Tagify instance for ${inputId} not found`);
            return [];
        }
        const tags = tagifyInstance.value || [];
        console.log(`Getting tags for ${inputId}:`, tags);
        return tags.map(tag => typeof tag === 'string' ? tag : tag.value);
    }

    /**
     * 渲染附件列表UI
     */
    renderAttachmentList() {
        const container = document.getElementById('attachment-list-container');
        if (!container) return;

        if (this.attachments.length === 0) {
            container.innerHTML = '';
            container.classList.add('hidden');
            return;
        }

        container.classList.remove('hidden');
        
        const attachmentsHTML = this.attachments.map((attachment, index) => {
            const ext = attachment.filename.split('.').pop().toLowerCase();
            let iconClass = 'fa-file';
            let iconColor = 'text-gray-500';
            
            if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'].includes(ext)) {
                iconClass = 'fa-file-image';
                iconColor = 'text-blue-500';
            } else if (['pdf'].includes(ext)) {
                iconClass = 'fa-file-pdf';
                iconColor = 'text-red-500';
            } else if (['doc', 'docx'].includes(ext)) {
                iconClass = 'fa-file-word';
                iconColor = 'text-blue-600';
            } else if (['xls', 'xlsx'].includes(ext)) {
                iconClass = 'fa-file-excel';
                iconColor = 'text-green-600';
            } else if (['ppt', 'pptx'].includes(ext)) {
                iconClass = 'fa-file-powerpoint';
                iconColor = 'text-orange-500';
            } else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
                iconClass = 'fa-file-archive';
                iconColor = 'text-yellow-600';
            } else if (['txt', 'md'].includes(ext)) {
                iconClass = 'fa-file-alt';
                iconColor = 'text-gray-600';
            } else if (['mp4', 'avi', 'mov', 'wmv', 'flv'].includes(ext)) {
                iconClass = 'fa-file-video';
                iconColor = 'text-purple-500';
            } else if (['mp3', 'wav', 'flac', 'aac'].includes(ext)) {
                iconClass = 'fa-file-audio';
                iconColor = 'text-pink-500';
            }

            return `
                <div class="attachment-item group flex items-center gap-3 px-3 py-2.5 
                            bg-gradient-to-r from-gray-50 to-white
                            border border-gray-200 rounded-lg
                            hover:shadow-md hover:border-blue-300 hover:from-blue-50 hover:to-white
                            transition-all duration-200" 
                     data-index="${index}">
                    <!-- 文件图标 -->
                    <div class="flex-shrink-0 w-10 h-10 flex items-center justify-center 
                                bg-white rounded-lg border border-gray-200 
                                group-hover:border-blue-300 transition-colors">
                        <i class="fas ${iconClass} ${iconColor} text-lg"></i>
                    </div>
                    
                    <!-- 文件信息 -->
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-medium text-gray-900 truncate">
                            ${attachment.filename}
                        </div>
                        <div class="text-xs text-gray-500 truncate mt-0.5">
                            ${attachment.path}
                        </div>
                    </div>
                    
                    <!-- 删除按钮 -->
                    <button class="remove-attachment flex-shrink-0 w-7 h-7 
                                   flex items-center justify-center
                                   rounded-full bg-white border border-gray-200
                                   hover:bg-red-50 hover:border-red-300
                                   opacity-0 group-hover:opacity-100
                                   transition-all duration-200"
                            data-index="${index}"
                            title="删除附件">
                        <i class="fas fa-times text-gray-400 hover:text-red-500 text-xs"></i>
                    </button>
                </div>
            `;
        }).join('');

        container.innerHTML = `
            <div class="px-4 py-2 bg-gray-50 border-t border-gray-200">
                <div class="flex items-center gap-2 mb-2">
                    <i class="fas fa-paperclip text-gray-500 text-sm"></i>
                    <span class="text-sm font-medium text-gray-700">附件 (${this.attachments.length})</span>
                </div>
                <div class="space-y-2 pb-2">
                    ${attachmentsHTML}
                </div>
            </div>
        `;

        // 绑定删除按钮事件
        container.querySelectorAll('.remove-attachment').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const index = parseInt(btn.dataset.index);
                this.removeAttachment(index);
            });
        });
    }

    /**
     * 删除附件
     * @param {number} index - 附件索引
     */
    removeAttachment(index) {
        this.attachments.splice(index, 1);
        this.renderAttachmentList();
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

    composeContent(selectedEmailHeader, originEmailContent, replyContent) {
        const sender = selectedEmailHeader.from && selectedEmailHeader.from[0] ? selectedEmailHeader.from[0].address : '未知发件人';
        const sendTime = new Date(selectedEmailHeader.date).toLocaleString();
        const receivers = selectedEmailHeader.to ? selectedEmailHeader.to.map(t => t.address).join(', ') : '';
        const ccReceivers = selectedEmailHeader.cc && selectedEmailHeader.cc.length > 0 
            ? selectedEmailHeader.cc.map(c => c.address).join(', ') 
            : null;
        const htmlTemplate = `
            ${replyContent ? `<div>${replyContent}</div>` : ''}
            
            <br><br>
            
            <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 20px 0;">

            <div style="background-color: #f3f4f6; padding: 16px; border-radius: 8px; font-size: 13px; font-family: 'Segoe UI', Arial, sans-serif; color: #374151; margin-bottom: 20px;">
                
                <div style="font-weight: bold; font-size: 14px; margin-bottom: 12px; color: #111827; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px;">
                    ----- 原始邮件 -----
                </div>

                <div style="margin-bottom: 6px;">
                    <span style="color: #6b7280; font-weight: bold; display: inline-block; width: 70px;">发件人:</span>
                    <span style="color: #1f2937; font-weight: 500;">${sender}</span>
                </div>
                
                <div style="margin-bottom: 6px;">
                    <span style="color: #6b7280; font-weight: bold; display: inline-block; width: 70px;">发送时间:</span>
                    <span style="color: #374151;">${sendTime}</span>
                </div>
                
                <div style="margin-bottom: 6px;">
                    <span style="color: #6b7280; font-weight: bold; display: inline-block; width: 70px;">收件人:</span>
                    <span style="color: #374151;">${receivers}</span>
                </div>
                
                ${ccReceivers ? `
                <div style="margin-bottom: 6px;">
                    <span style="color: #6b7280; font-weight: bold; display: inline-block; width: 70px;">抄送:</span>
                    <span style="color: #374151;">${ccReceivers}</span>
                </div>
                ` : ''}
                
                <div>
                    <span style="color: #6b7280; font-weight: bold; display: inline-block; width: 70px;">主题:</span>
                    <span style="color: #374151;">${selectedEmailHeader.subject}</span>
                </div>

            </div>

            <div style="font-size: 14px; line-height: 1.6;">
                ${originEmailContent}
            </div>
        `;

        return htmlTemplate;
    }

    async getMailContent() {
        const to = this.getTagValue('to');
        const ccList = this.getTagValue('cc');
        const bccList = this.getTagValue('bcc');
        const subject = document.getElementById('subject').value;
        const editor = await this.editorReady;
        const content = editor.getContent();
        const attachments = this.attachments;
        const sendEmailSchema = {to: to, cc: ccList, bcc: bccList, subject: subject, html: content, attachments: attachments};
        return sendEmailSchema;
    }

    async setMailContent(operation, mailHeader, mailContent, replyContent) {
        if (!mailHeader && !mailContent) {
            return;
        }
        const editor = await this.editorReady;
        if (operation == MailOperations.POLISH) {
            editor.setContent(mailContent)
            return;
        }
        if (operation == MailOperations.REPLY || operation == MailOperations.REPLYALL) {
            document.getElementById('to').value = mailHeader.from[0].address;
            document.getElementById('subject').value = '答复:' + mailHeader.subject;
        } else if (operation == MailOperations.FORWARD) {
            document.getElementById('subject').value = '转发:' + mailHeader.subject;
        } else if (operation == MailOperations.SEND) {
            document.getElementById('subject').value = mailHeader.subject;
            document.getElementById('to').value = mailHeader.to.map(to => to.address).join(',')
        }

        let originContent = mailContent.htmlContent ? mailContent.htmlContent : mailContent.textContent.replace(/\n/g, '<br>')
        if (operation == MailOperations.SEND) {
            editor.setContent(originContent)
        } else {
            let combileContent = this.composeContent(mailHeader, originContent, replyContent)
            editor.setContent(combileContent)
        }
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
        <div class="flex-1 overflow-y-auto p-4 bg-white flex flex-col">
            <div class="w-full max-w-5xl mx-auto flex-1 flex flex-col">
                <div class="w-full bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden font-sans mb-3">

                    <div class="flex items-center px-4 border-b border-gray-100 min-h-[46px]">
                        <span class="text-sm text-gray-600 font-medium w-14 flex-shrink-0 cursor-default">收件人</span>
                        
                        <div class="flex-1 ml-2 mr-4">
                            <input id="to" value="" class="w-full" placeholder="">
                        </div>

                        <div class="text-xs text-gray-400 space-x-2 flex-shrink-0 select-none">
                            <span id="btn-cc" onclick="toggleRow('cc')" class="cursor-pointer hover:text-gray-800 transition-colors">抄送</span>
                            <span id="btn-bcc" onclick="toggleRow('bcc')" class="cursor-pointer hover:text-gray-800 transition-colors">密送</span>
                        </div>
                    </div>

                    <div id="row-cc" class="hidden flex items-center px-4 border-b border-gray-100 min-h-[46px]">
                        <span class="text-sm text-gray-600 font-medium w-14 flex-shrink-0 cursor-default">抄送</span>
                        <div class="flex-1 ml-2 mr-4">
                            <input id="cc" value="" class="w-full" placeholder="">
                        </div>
                        <button id="close-cc" onclick="closeRow('cc')" 
                                class="w-5 h-5 flex items-center justify-center rounded-full 
                                       hover:bg-gray-200 transition-colors mr-2 flex-shrink-0"
                                title="关闭抄送">
                            <i class="fas fa-times text-gray-400 hover:text-gray-600 text-xs"></i>
                        </button>
                    </div>

                    <div id="row-bcc" class="hidden flex items-center px-4 border-b border-gray-100 min-h-[46px]">
                        <span class="text-sm text-gray-600 font-medium w-14 flex-shrink-0 cursor-default">密送</span>
                        <div class="flex-1 ml-2 mr-4">
                            <input id="bcc" value="" class="w-full" placeholder="">
                        </div>
                        <button id="close-bcc" onclick="closeRow('bcc')" 
                                class="w-5 h-5 flex items-center justify-center rounded-full 
                                       hover:bg-gray-200 transition-colors mr-2 flex-shrink-0"
                                title="关闭密送">
                            <i class="fas fa-times text-gray-400 hover:text-gray-600 text-xs"></i>
                        </button>
                    </div>

                    <div class="flex items-center px-4 min-h-[50px]">
                        <div class="text-sm text-gray-600 font-medium w-14 flex justify-between cursor-default mr-2">
                            <span>主&nbsp题</span>
                        </div>
                        <input type="text" id="subject" 
                            class="flex-1 bg-transparent outline-none text-sm font-medium text-gray-900 h-9 placeholder-gray-400" 
                            placeholder="" value="">
                        <span class="text-xs text-gray-300 font-light ml-2 whitespace-nowrap">
                            ${new Date().toLocaleString()}
                        </span>
                    </div>

                </div>

                <!-- 邮件主体 -->
                <div id="email-body-content" class="prose prose-indigo max-w-none w-full flex-1 overflow-x-auto overflow-y-auto">
                    <div id="editor—wrapper">
                        <textarea id="email-editor"></textarea>
                    </div>
                </div>
                
                <!-- 附件列表容器 -->
                <div id="attachment-list-container" class="hidden"></div>
            </div>
        </div>

        <style>
        #editor—wrapper {
            border: none;
            z-index: 100;
        }
        
        #toolbar-container {
            border-bottom: 1px solid #ccc;
        }
        #editor-container {
            font-size: 12px;
            line-height: 1;
            margin: 10px 0;
        }

        .tagify {
            border: none !important;
            --tags-border-color: transparent;
            --tags-focus-border-color: transparent;
            align-items: center;
            padding: 0;
            flex-wrap: wrap !important;
            max-height: 80px;
            overflow-y: auto;
            font-size: 14px !important;
            font-weight: 500 !important;
            color: #111827 !important;
        }
        .tagify__input {
            min-width: 50px !important; 
            margin: 0 !important;
            font-size: 14px !important;
            font-weight: 500 !important;
        }
        
        .tagify__input::before {
            font-size: 14px !important;
            font-weight: 400 !important;
            color: #9ca3af !important;
        }
        </style>
        `);

        // 初始化 Tagify
        const commonConfig = {
            pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
            delimiters: ",|;| ",
            keepInvalidTags: false,
            dropdown: { enabled: 0 },
            trim: true
        };

        const inputTo = document.getElementById('to');
        if (inputTo) {
            this.tagifyInstances.to = new Tagify(inputTo, commonConfig);
        }
        
        ['cc', 'bcc'].forEach(type => {
            const inputEl = document.getElementById(type);
            if (inputEl) {
                this.tagifyInstances[type] = new Tagify(inputEl, commonConfig);
            }
        });

        if (window.tinymce) {
            tinymce.remove('#email-editor'); 
        }

        tinymce.init({
            selector: '#email-editor',
            height: 'calc(100vh - 200px)',
            menubar: false,
            branding: false,
            statusbar: false,
            resize: true,
            language: 'zh_CN',  // 设置中文语言
            
            // 【关键配置】TinyMCE 7.x 需要的配置
            skin: false,  // 不动态加载皮肤（已在顶部 import）
            content_css: false,  // 不动态加载内容样式（已在顶部 import）
            license_key: 'gpl',  // 声明为 GPL 开源使用（避免弹窗）
            highlight_on_focus: false,
            
            plugins: [
                'advlist', 'autolink', 'lists', 'link', 'image', 'charmap', 'preview',
                'anchor', 'searchreplace', 'visualblocks', 'code', 'fullscreen',
                'insertdatetime', 'media', 'table', 'wordcount'
            ],
            toolbar: 'addAttachment | fontfamily fontsize | bold italic underline strikethrough | forecolor backcolor | bullist numlist | alignleft aligncenter alignright alignjustify | removeformat lineheight hr blockquote code',
            toolbar_mode: 'sliding',
            line_height_formats: '1 1.2 1.4 1.5 2 3',
            font_family_formats: '微软雅黑=Microsoft YaHei,Helvetica Neue,PingFang SC,sans-serif;苹果苹方=PingFang SC,Microsoft YaHei,sans-serif;宋体=simsun,serif;Arial=arial,helvetica,sans-serif;',
            font_size_formats: '12px 14px 16px 18px 24px 36px 48px',
            setup: (editor) => {
                editor.ui.registry.addIcon('paperclip', '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5a2.5 2.5 0 0 0 5 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z" fill="currentColor"/></svg>');
                const self = this;
                editor.ui.registry.addButton('addAttachment', {
                    icon: 'paperclip',
                    tooltip: '添加附件',
                    onAction: async () => {
                        try {
                            const paths = await window.fsAPI.selectFile();
                            if (paths && paths.length > 0) {
                                paths.forEach(fullPath => {
                                    const filename = fullPath.split(/[/\\]/).pop();
                                    self.attachments.push({
                                        filename: filename,
                                        path: fullPath
                                    });
                                });
                                self.renderAttachmentList();
                            }
                        } catch (error) {
                            console.error('选择附件失败:', error);
                            alert('选择附件失败: ' + error.message);
                        }
                    }
                });
            },

            // 回调
            init_instance_callback: (editor) => {
                console.log("编辑器加载完成！");
                this.resolveEditor(editor);
            }
        });
        window.toggleRow = function(type) {

            const row = document.getElementById('row-' + type);
            const btn = document.getElementById('btn-' + type);

            if (row) row.classList.remove('hidden');
            if (btn) btn.style.display = 'none';
        };
        window.closeRow = function(type) {
            const row = document.getElementById('row-' + type);
            const btn = document.getElementById('btn-' + type);
            const input = document.getElementById(type);

            if (row) row.classList.add('hidden');
            if (btn) btn.style.display = '';
            if (input && window.tagifyInstances && window.tagifyInstances[type]) {
                window.tagifyInstances[type].removeAllTags();
            }
        };
        window.tagifyInstances = this.tagifyInstances;

        console.log("Tagify (To, Cc, Bcc) 初始化完成！");
    }
}

customElements.define('mailbox-entry-widget', MailBoxEntryWidget);
customElements.define('mail-editor-widget', MailEditorWidget);

console.info('mailbox/renderer/entry.js loaded');