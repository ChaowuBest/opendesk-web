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

import { escapeHtml } from '../../../../common/utils/escape.js';
import { z } from 'zod';
import { RendererToolset, RendererTool, AgentOperableHTMLElement } from '../../widget_utils.js';
import { ElasticToolbarWidget } from '../../../../renderer/components/toolbar.ts';
import { EmailHeader, EmailContent } from '../common.js';

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
        /** @type {object | null} */
        this.currentSearchQuery = null; // 当前搜索/筛选查询条件

        // 多账号支持
        this.accounts = [];
        this.currentAccount = null;
    }

    async connectedCallback() {
        this.render();
        this.setupAccountSelectorListeners();
        this.setupScrollListener();

        // 通知后端用户已进入邮箱应用
        await window.applicationAPI.call('notifyMailboxOpened');

        // 初始化加载
        try {
            await this.loadAccounts();
            this.updateAccountSelectorUI();

            if (this.currentAccount) {
                await this.loadEmailList();
            } else {
                const list = this.querySelector('#email-list');
                if (list) {
                    list.innerHTML = '<div class="text-gray-500 text-center py-4">请先在配置文件中配置邮箱账号</div>';
                }
            }
        } catch (error) {
            console.error('Initialization error:', error);
        }

        // 订阅邮件列表更新事件 (保持不变)
        window.applicationAPI.subscribe('emailListUpdated', () => {
            this.loadEmailList();
        });

        // 【核心修改】订阅账号列表更新事件
        window.applicationAPI.subscribe('accountsUpdated', async () => {
            console.log('配置更新检测到，正在强制重载...');

            // 1. 重新获取最新的账号列表
            await this.loadAccounts();
            this.updateAccountSelectorUI();

            // 2. 无论之前是否有数据，配置变了必须强制刷新
            if (this.currentAccount) {
                // 清空本地缓存的数据
                this.emailHeaderList.clear();
                this.currentOffset = 0;
                this.hasMoreEmails = true;

                // 清空视图
                this.reloadEmailList();

                // 重新从后端拉取数据
                await this.loadEmailList();
            } else {
                // 如果配置全删了，没账号了，清空列表显示提示
                const list = this.querySelector('#email-list');
                if (list) list.innerHTML = '<div class="text-gray-500 text-center py-4">暂无可用账号</div>';
                this.emailHeaderList.clear();
            }
        });
    }

    /**
     * 加载账号列表
     */
    async loadAccounts() {
        try {
            this.accounts = await window.applicationAPI.call('getAccountList');
            if (this.accounts && this.accounts.length > 0) {
                // 找到当前活跃的账号，如果没有则默认第一个
                this.currentAccount = this.accounts.find((a) => a.active) || this.accounts[0];
                // 无论后端是否有 active 账号，都调用 switchAccount 来确保状态同步
                // 这样可以确保 currentProfileId 被设置，并清除新邮件标记
                await this.switchAccount(this.currentAccount.email);
            } else {
                this.accounts = [];
                this.currentAccount = null;
            }
        } catch (error) {
            console.error('Error loading accounts:', error);
            this.accounts = [];
        }
    }

    /**
     * 切换账号
     * @param {string} email
     */
    async switchAccount(email) {
        try {
            await window.applicationAPI.call('switchAccount', email);

            // 更新本地状态
            this.currentAccount = this.accounts.find((a) => a.email === email);
            this.accounts.forEach((a) => (a.active = a.email === email));

            // 重置所有列表状态
            this.currentOffset = 0;
            this.hasMoreEmails = true;
            this.isLoading = false;
            this.loadingError = null;
            this.emailHeaderList.clear();

            // 重置选中状态
            this.selectedEmailUid = null;
            this.selectedEmailHeader = null;
            this.selectedEmailContent = null;

            // 清空右侧内容区
            const contentArea = this.querySelector('#email-content');
            if (contentArea) contentArea.innerHTML = '';

            // 刷新UI中的账号显示
            this.updateAccountSelectorUI();

            // 重新加载邮件
            this.reloadEmailList(); // 先清空视图
            await this.loadEmailList(); // 再请求数据
        } catch (error) {
            console.error('Switch account failed:', error);
            Swal.fire({
                title: '切换账号失败',
                text: error.message,
                icon: 'error'
            });
        }
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
            return function () {
                const args = arguments;
                const context = this;
                if (!inThrottle) {
                    func.apply(context, args);
                    inThrottle = true;
                    setTimeout(() => (inThrottle = false), delay);
                }
            };
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
        this.currentSearchQuery = null;

        const query = this.buildFilterQuery();
        if (query) {
            await this.loadFilteredEmails(query, true);
        } else {
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

            // 初始加载时，完全重新加载列表
            this.reloadEmailList(this.emailHeaderList, true);
        }
    }

    buildFilterQuery() {
        switch (this.currentFilter) {
            case 'all':
                return null; // 返回 null 表示加载所有邮件
            case 'unread':
                return { unread: true, limit: this.emailPerPage, offset: 0 };
            case 'starred':
                return { starred: true, limit: this.emailPerPage, offset: 0 };
            case 'draft':
                return { type: 'draft', limit: this.emailPerPage, offset: 0 };
            case 'sent':
                return { type: 'sent', limit: this.emailPerPage, offset: 0 };
            default:
                return null;
        }
    }

    async loadFilteredEmails(query, reset = false) {
        if (reset) {
            this.currentOffset = 0;
            this.hasMoreEmails = true;
            this.currentSearchQuery = query;
        }

        const searchQuery = { ...query, offset: this.currentOffset, limit: this.emailPerPage };

        try {
            const emails = await window.applicationAPI.call('searchEmails', searchQuery);

            if (reset) {
                this.emailHeaderList.clear();
            }

            for (const email of emails) {
                this.emailHeaderList.set(email.uid, email);
            }
            this.currentOffset += emails.length;
            if (emails.length < this.emailPerPage) {
                this.hasMoreEmails = false;
            }

            if (reset) {
                this.reloadEmailList(this.emailHeaderList, true);
            } else {
                this.appendEmailItems(emails);
            }
        } catch (error) {
            console.error('Error loading filtered emails:', error);
            this.loadingError = '加载邮件失败，请重试';
            if (reset) {
                this.reloadEmailList(new Map(), true);
            }
        }
    }

    async loadMoreEmails() {
        if (this.isLoading || !this.hasMoreEmails) return;

        this.isLoading = true;
        this.loadingError = null;

        // 更新加载状态 UI
        this.updateLoadingStatusUI();

        try {
            if (this.currentSearchQuery) {
                await this.loadFilteredEmails(this.currentSearchQuery, false);
            } else {
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

                // 只追加新邮件，不重新渲染整个列表
                this.appendEmailItems(emails);
            }
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
        return `
        你是一个邮件管理助手，你负责管理用户的邮件，并利用提供的邮件及其他工具来完成用户指定的任务。

        **重要规则**
        1. 不要假设你已经知道邮件内容，每次必须通过工具获取;
        2. 当用户请求总结邮件内容、分析邮件、提取邮件信息或任何需要了解邮件内容的操作时，你必须首先调用 getSelectedEmailTool 工具来获取当前选中的邮件内容;
        3. 如果用户说"总结这封邮件"、"这封邮件说了什么"、"分析这封邮件"等类似请求，立即调用 getSelectedEmailTool;
        4. 在邮件回复或编写邮件时，如果涉及到日程，文件等事实性信息，必须通过工具查询相关内容，如果无法获取到信息时需要向用户询问。
            不能编造数据，必须真实可靠;
        `;
    }

    getToolset() {
        const toolset = new RendererToolset('mailbox');
        if (this.selectedEmailUid !== null) {
            const getSelectedEmailTool = new RendererTool(
                'getSelectedEmail',
                '获取用户当前正在浏览的邮件内容',
                z.object({})
            );
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

        const getEmailListTool = new RendererTool('getEmailList', '获取完整的邮件列表', z.object({}));
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

        const getEmailContentTool = new RendererTool(
            'getEmailContent',
            '打开指定id的邮件并获取其内容',
            z.object({
                uid: z.string().describe('邮件的ID')
            })
        );
        getEmailContentTool.setExecutor(async (args) => {
            let result = '';
            try {
                await this.openEmailByUid(args.uid);
                const content = this.selectedEmailContent;
                result = `邮件内容为: <content>${content.textContent || content.htmlContent}</content>\n`;
                await new Promise((resolve) => setTimeout(resolve, 1000));
                return result;
            } catch (error) {
                result = `获取邮件内容失败: ${error}\n`;
                return result;
            }
        });

        const markEmailAsReadTool = new RendererTool(
            'markEmailAsRead',
            '标记多个指定id的邮件为已读',
            z.object({
                uids: z.array(z.string()).describe('邮件的ID列表')
            })
        );
        markEmailAsReadTool.setExecutor(async (args) => {
            for (const uid of args.uids) {
                await this.markEmailAsRead(uid);
            }
            return `已标记邮件为已读: ${args.uids.join(', ')}`;
        });

        const writeEmailTool = new RendererTool(
            'writeEmail',
            '撰写邮件,邮件正文内容由你自动生成',
            z.object({
                to: z.array(z.string()).describe('收件人列表'),
                cc: z.array(z.string()).describe('抄送人列表'),
                bcc: z.array(z.string()).describe('密送人列表'),
                subject: z.string().describe('主题'),
                content: z.string().describe('邮件正文内容,html格式')
            })
        );
        writeEmailTool.setExecutor(async (args) => {
            const to = [];
            const cc = [];
            const bcc = [];
            if (args.to) {
                args.to.map((item) => {
                    to.push({ name: '', address: item });
                });
            }
            if (args.cc) {
                args.cc.map((item) => {
                    cc.push({ name: '', address: item });
                });
            }
            if (args.bcc) {
                args.bcc.map((item) => {
                    bcc.push({ name: '', address: item });
                });
            }
            const mailHeader = { subject: args.subject, to: to, cc: cc, bcc: bcc };
            const mailContent = { htmlContent: args.content, textContent: args.content };
            this.createNewEmail(MailOperations.SEND, mailHeader, mailContent);
            return '邮件已撰写完成';
        });

        const replyEmailTool = new RendererTool(
            'replyEmail',
            '回复邮件,回复内容由你根据指定邮件内容自动生成',
            z.object({
                replyContent: z.string().describe('回复内容,html格式')
            })
        );
        replyEmailTool.setExecutor(async (args) => {
            if (!this.selectedEmailUid) {
                return '请选择一封具体的邮件让我回复';
            }
            this.createNewEmail(
                MailOperations.REPLY,
                this.selectedEmailHeader,
                this.selectedEmailContent,
                args.replyContent
            );
            return '邮件回复完成';
        });

        const getEditEmailTool = new RendererTool('getEditEmail', '获取当前正在编辑的邮件内容', z.object({}));
        getEditEmailTool.setExecutor(async (args) => {
            const editor = document.querySelector('#editor');
            const mailElement = await editor.getMailContent();
            return mailElement.html;
        });

        const PolishEmailTool = new RendererTool(
            'polishEmail',
            '邮件校对和润色',
            z.object({
                content: z.string().describe('校对润色后的邮件正文内容,html格式')
            })
        );
        PolishEmailTool.setParams(
            z.object({
                content: z.string().describe('校对润色后的邮件正文内容,html格式')
            })
        );
        PolishEmailTool.setExecutor(async (args) => {
            const editor = document.querySelector('#editor');
            await editor.setMailContent(MailOperations.POLISH, {}, args.content);
            return `已完成邮件润色`;
        });

        toolset.addTools(
            getEmailListTool,
            getEmailContentTool,
            markEmailAsReadTool,
            writeEmailTool,
            replyEmailTool,
            getEditEmailTool,
            PolishEmailTool
        );
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
     * 渲染单个邮件项，根据邮件类型显示不同的标识
     * @param {import('../common.js').EmailHeader} email
     * @returns {string}
     */
    renderEmailItem(email) {
        const isSelected = email.uid === this.selectedEmailUid;
        let classes = 'email-item p-3 border-b cursor-pointer border-gray-200 border-l-4 ';
        if (isSelected) {
            classes += 'bg-indigo-50/50 relative border-l-indigo-600';
        } else {
            classes += 'hover:bg-gray-50 transition-colors border-l-transparent';
        }

        let subject_classes = 'font-medium text-gray-500';
        if (email.unread) {
            subject_classes = 'font-bold text-gray-800';
        }

        // 根据邮件类型显示不同的图标
        let typeIcon = '';
        if (email.type === 'draft') {
            typeIcon = '<i class="fa fa-file-alt text-gray-400 mr-1" title="草稿"></i>';
        } else if (email.type === 'sent') {
            typeIcon = '<i class="fa fa-paper-plane text-blue-400 mr-1" title="已发送"></i>';
        }

        // 显示收件人或发件人和日期
        let infoLine = '';
        if (email.type === 'sent' || email.type === 'draft') {
            // 已发送和草稿显示收件人
            const toAddresses =
                email.to && email.to.length > 0 ? email.to.map((t) => t.name || t.address).join(', ') : '无收件人';
            infoLine = `<p class="text-gray-500 text-xs truncate mb-1">收件人: ${toAddresses}</p>`;
        } else {
            // 收件箱显示发件人
            const fromAddress =
                email.from && email.from.length > 0 ? email.from[0].name || email.from[0].address : '未知发件人';
            infoLine = `<p class="text-gray-500 text-xs truncate mb-1">发件人: ${fromAddress}</p>`;
        }

        return `
        <div class="${classes}" data-uid="${email.uid}">
            <div class="flex justify-between items-start mb-1">
                <span class="${subject_classes}">${typeIcon}${email.subject || '(无主题)'}</span>
                ${email.starred ? '<i class="fa fa-star text-yellow-500"></i>' : ''}
            </div>
            ${infoLine}
            <p class="text-gray-400 text-xs">${new Date(email.date).toLocaleString()}</p>
        </div>
        `;
    }

    createEmailItemElement(email) {
        const div = document.createElement('div');
        div.innerHTML = this.renderEmailItem(email);
        const element = div.firstElementChild;

        // 添加点击事件
        element.addEventListener('click', () => {
            const email = this.emailHeaderList.get(element.dataset.uid);
            if (email) {
                this.openEmail(email);
            }
        });

        return element;
    }

    updateEmailItem(uid) {
        const email = this.emailHeaderList.get(uid);
        if (!email) return;

        const emailListContainer = this.querySelector('#email-list');
        if (!emailListContainer) return;

        const existingItem = emailListContainer.querySelector(`[data-uid="${uid}"]`);
        if (!existingItem) {
            if (this.shouldShowEmail(email)) {
                this.insertEmailItemInOrder(emailListContainer, email);
            }
            return;
        }

        const shouldShow = this.shouldShowEmail(email);
        const isVisible = existingItem.parentElement === emailListContainer;

        if (!shouldShow && isVisible) {
            existingItem.remove();
            return;
        }

        if (shouldShow && !isVisible) {
            this.insertEmailItemInOrder(emailListContainer, email);
            existingItem.remove();
            return;
        }

        if (!shouldShow) {
            return;
        }

        // 完全重新渲染该邮件项，避免部分更新导致的布局问题
        const newElement = this.createEmailItemElement(email);
        existingItem.replaceWith(newElement);
    }

    shouldShowEmail(email) {
        if (email.deleted) {
            return false;
        }
        return true;
    }

    insertEmailItemInOrder(container, email) {
        const newElement = this.createEmailItemElement(email);
        const items = Array.from(container.querySelectorAll('.email-item'));

        // 找到插入位置（按日期降序）
        let insertIndex = -1;
        for (let i = 0; i < items.length; i++) {
            const itemUid = items[i].dataset.uid;
            const itemEmail = this.emailHeaderList.get(itemUid);
            if (itemEmail && itemEmail.date < email.date) {
                insertIndex = i;
                break;
            }
        }

        if (insertIndex === -1) {
            const loadingStatus = container.querySelector('.loading-status');
            if (loadingStatus) {
                container.insertBefore(newElement, loadingStatus);
            } else {
                container.appendChild(newElement);
            }
        } else {
            container.insertBefore(newElement, items[insertIndex]);
        }
    }

    appendEmailItems(emails) {
        const emailListContainer = this.querySelector('#email-list');
        if (!emailListContainer) return;

        const loadingStatus = emailListContainer.querySelector('.loading-status');
        if (loadingStatus) {
            loadingStatus.remove();
        }

        const fragment = document.createDocumentFragment();
        for (const email of emails) {
            if (this.shouldShowEmail(email)) {
                const element = this.createEmailItemElement(email);
                fragment.appendChild(element);
            }
        }

        emailListContainer.appendChild(fragment);
        this.updateLoadingStatusUI();
    }

    reloadEmailList(emailList = this.emailHeaderList, forceFullReload = false) {
        const emailListContainer = this.querySelector('#email-list');
        if (!emailListContainer) return;

        if (forceFullReload) {
            emailListContainer.innerHTML = '';
        }

        // 过滤出应该显示的邮件
        const emailsToShow = Array.from(emailList.values()).filter((email) => this.shouldShowEmail(email));

        if (emailsToShow.length === 0) {
            if (forceFullReload || emailListContainer.children.length === 0) {
                emailListContainer.innerHTML = '<div class="text-gray-500 text-center py-4">暂无符合条件的邮件</div>';
            }
            return;
        }

        // 如果强制完全重新加载，使用 DocumentFragment 批量添加
        if (forceFullReload) {
            const fragment = document.createDocumentFragment();
            for (const email of emailsToShow) {
                const element = this.createEmailItemElement(email);
                fragment.appendChild(element);
            }
            emailListContainer.appendChild(fragment);
        } else {
            // 增量更新：只更新变化的邮件项
            const existingUids = new Set(
                Array.from(emailListContainer.querySelectorAll('.email-item')).map((item) => item.dataset.uid)
            );

            // 更新已存在的邮件项
            for (const email of emailsToShow) {
                if (existingUids.has(email.uid)) {
                    this.updateEmailItem(email.uid);
                } else {
                    // 新邮件，按顺序插入
                    this.insertEmailItemInOrder(emailListContainer, email);
                }
            }

            // 移除不再应该显示的邮件项
            for (const uid of existingUids) {
                const email = emailList.get(uid);
                if (!email || !this.shouldShowEmail(email)) {
                    const item = emailListContainer.querySelector(`[data-uid="${uid}"]`);
                    if (item) {
                        item.remove();
                    }
                }
            }
        }

        // 添加加载状态 UI
        this.updateLoadingStatusUI();
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
            const escapedError = escapeHtml(this.loadingError);
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
        const email = this.emailHeaderList.get(uid);
        if (email) {
            email.unread = false;
            // 只更新单个邮件项，不重新加载整个列表
            this.updateEmailItem(uid);
        }
        if (this.selectedEmailUid === uid) {
            this.selectedEmailHeader.unread = false;
            this.updateReadUnreadButton();
        }
    }

    async markEmailAsUnread(uid) {
        console.info('mark email as unread', uid);
        await window.applicationAPI.call('markEmailAsUnread', uid);
        const email = this.emailHeaderList.get(uid);
        if (email) {
            email.unread = true;
            // 只更新单个邮件项，不重新加载整个列表
            this.updateEmailItem(uid);
        }
        if (this.selectedEmailUid === uid) {
            this.selectedEmailHeader.unread = true;
            this.updateReadUnreadButton();
        }
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
        const starOptions = {
            uid: uid,
            starred: starred
        };
        await window.applicationAPI.call('starEmail', starOptions);
        const email = this.emailHeaderList.get(uid);
        if (email) {
            email.starred = starred;
            // 只更新单个邮件项，不重新加载整个列表
            this.updateEmailItem(uid);
        }
        if (this.selectedEmailUid === uid) {
            this.selectedEmailHeader.starred = starred;
        }
    }

    async searchEmails(query) {
        // 重置搜索状态
        this.currentOffset = 0;
        this.hasMoreEmails = true;
        this.loadingError = null;

        const searchQuery = { ...query, limit: this.emailPerPage, offset: 0 };
        this.currentSearchQuery = searchQuery;
        await this.loadFilteredEmails(searchQuery, true);
    }

    /**
     * 立即同步邮件
     */
    async syncEmails() {
        // ElasticToolbarWidget 会给 ID 添加 uid 后缀，使用前缀匹配查找
        const syncButton = this.querySelector('[id^="mailbox-sync-email-button"]');
        const icon = syncButton?.querySelector('i');

        // 添加旋转动画
        if (syncButton && icon) {
            icon.classList.add('fa-spin');
            syncButton.disabled = true;
        }

        try {
            await window.applicationAPI.call('syncEmails');
            await this.loadEmailList();
        } catch (error) {
            console.error('同步邮件失败:', error);
        } finally {
            if (syncButton && icon) {
                icon.classList.remove('fa-spin');
                syncButton.disabled = false;
            }
        }
    }

    async sendEmail(sendEmailSchema) {
        // 显示小提示（右上角下方，不阻塞操作）
        const toast = document.createElement('div');
        toast.id = 'email-sending-toast';
        toast.innerHTML = `
            <div style="position: fixed; top: 80px; right: 20px; z-index: 9999;
                        background: white; padding: 12px 20px; border-radius: 8px;
                        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                        display: flex; align-items: center; gap: 10px;
                        border-left: 4px solid #3b82f6;">
                <i class="fas fa-spinner fa-spin" style="color: #3b82f6;"></i>
                <span style="color: #374151; font-size: 14px;">正在发送邮件...</span>
            </div>
        `;
        document.body.appendChild(toast);

        try {
            await window.applicationAPI.call('sendEmail', sendEmailSchema);
        } finally {
            // 移除提示
            const toastEl = document.getElementById('email-sending-toast');
            if (toastEl) toastEl.remove();
        }
    }

    renderCurrentEmailHeader() {
        if (!this.selectedEmailHeader) return '';

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
                ${
                    type === 'from'
                        ? `
                <button class="ml-1 text-gray-400 hover:text-gray-600">
                    <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" /></svg>
                </button>
                `
                        : ''
                }
            </div>
            `;
        };

        // 检查是否需要显示展开/收起按钮，计算收件人和抄送人的数量
        const needsExpandButton = () => {
            const totalAddresses =
                (this.selectedEmailHeader.to?.length || 0) + (this.selectedEmailHeader.cc?.length || 0);
            return totalAddresses > 3;
        };

        let addresses = '';

        // 渲染发件人，右侧添加展开/收起按钮
        if (this.selectedEmailHeader.from && this.selectedEmailHeader.from.length > 0) {
            const senderHtml = this.selectedEmailHeader.from.map((addr) => renderEmailAddress(addr, 'from')).join('');

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

        // 检查总地址数（收件人+抄送）
        const toCount = this.selectedEmailHeader.to?.length || 0;
        const ccCount = this.selectedEmailHeader.cc?.length || 0;
        const totalAddresses = toCount + ccCount;

        // 当总地址数 <= 3 时，显示所有收件人、抄送，无需展开
        const shouldShowAll = totalAddresses <= 3 || this.isHeadersExpanded;

        // 渲染收件人
        if (toCount > 0) {
            let toHtml = '';

            if (shouldShowAll) {
                // 展开状态，显示所有收件人
                toHtml = this.selectedEmailHeader.to.map((addr) => renderEmailAddress(addr, 'to')).join('');
            } else {
                // 未展开状态，计算显示的收件人数
                const maxTotalVisible = 3;
                const toVisibleCount = Math.min(toCount, maxTotalVisible);
                const displayTos = this.selectedEmailHeader.to.slice(0, toVisibleCount);
                toHtml = displayTos.map((addr) => renderEmailAddress(addr, 'to')).join('');
            }

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

        // 渲染抄送
        if (ccCount > 0) {
            let ccHtml = '';

            if (shouldShowAll) {
                // 展开状态，显示所有抄送人
                ccHtml = this.selectedEmailHeader.cc.map((addr) => renderEmailAddress(addr, 'cc')).join('');
            } else {
                // 未展开状态，显示部分抄送人
                const maxTotalVisible = 3;
                const toVisibleCount = Math.min(toCount, maxTotalVisible);
                const ccVisibleCount = Math.max(0, maxTotalVisible - toVisibleCount);

                if (ccVisibleCount > 0) {
                    const displayCcs = this.selectedEmailHeader.cc.slice(0, ccVisibleCount);
                    ccHtml = displayCcs.map((addr) => renderEmailAddress(addr, 'cc')).join('');
                }
            }

            if (ccHtml) {
                addresses += ` <!-- 抄送行 -->
                <div class="group flex items-start px-1 py-1 hover:bg-gray-50 transition-colors">
                    <label class="w-12 text-xs text-gray-400 font-medium pt-0.5">抄送</label>
                    <div class="flex-1 flex flex-wrap gap-2">
                        ${ccHtml}
                    </div>
                </div>
                `;
            }
        }

        // 渲染密送，总地址数 <= 3 或展开时显示
        if (this.selectedEmailHeader.bcc && this.selectedEmailHeader.bcc.length > 0 && shouldShowAll) {
            const bccHtml = this.selectedEmailHeader.bcc.map((addr) => renderEmailAddress(addr, 'bcc')).join('');
            addresses += ` <!-- 密送行 -->
                <div class="group flex items-start px-1 py-1 hover:bg-gray-50 transition-colors">
                <label class="w-12 text-xs text-gray-400 font-medium pt-0.5">密送</label>
                <div class="flex-1 flex flex-wrap gap-2">
                    ${bccHtml}
                </div>
            </div>
            `;
        }

        let attachments = '';
        if (this.selectedEmailContent && this.selectedEmailContent.attachments) {
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
                    <i class="fa fa-file-alt text-gray-400 text-sm mr-2"></i>
                    <div class="flex flex-col min-w-0 flex-1 overflow-hidden">
                        <span class="text-[13px] font-medium text-gray-900 truncate tracking-tight font-sans">
                            ${attachment.filename}
                        </span>
                    </div>
                </div>
                `;
            }
        }

        if (attachments) {
            attachments = `
            <div class="group flex items-center px-1 py-1 hover:bg-gray-50 transition-colors">
                <label class="w-12 text-xs text-gray-400 font-medium">附件</label>
                <div class="flex-1 flex flex-wrap gap-2 items-center">
                    ${attachments}
                </div>
            </div>
            `;
        }

        const fullHeader = `
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
        `;

        return fullHeader;
    }

    /**
     *
     * @param {MailOperations} operation
     * @param {EmailHeader | undefined} mailHeader
     * @param {EmailContent | undefined} mailContent
     * @param {string | undefined} replyContent
     */
    async createNewEmail(operation, mailHeader, mailContent, replyContent) {
        // 这里可以直接 new 一个邮件编辑控件并赋值给 #email-content
        const emailContent = this.querySelector('#email-content');
        const editor = new MailEditorWidget();
        // 与阅读界面一致：flex flex-col 让工具栏固定顶部、内容区单独滚动；min-h-0 使内部 overflow 生效；不加 overflow-y-auto 避免整块（含工具栏）一起滚动
        editor.classList.add('flex-1', 'flex', 'flex-col', 'min-h-0', 'bg-white', 'w-full');
        editor.id = 'editor';
        emailContent.innerHTML = '';
        emailContent.appendChild(editor);
        editor.addEventListener('cancel', () => {
            this.reloadCurrentEmailContent();
        });
        editor.addEventListener('send', async () => {
            const mailSchema = await editor.getMailContent();
            // 先关闭编辑器
            this.reloadCurrentEmailContent();
            // 再发送邮件（带加载提示）
            await this.sendEmail(mailSchema);
        });

        editor.addEventListener('saveDraft', async () => {
            const mailSchema = await editor.getMailContent();
            await this.saveDraft(mailSchema);
        });
        editor.setMailContent(operation, mailHeader, mailContent, replyContent, this.currentAccount);
    }

    async saveDraft(draftSchema) {
        try {
            const uid = await window.applicationAPI.call('saveDraft', draftSchema);
            Swal.fire({
                title: '保存成功',
                text: '草稿已保存',
                icon: 'success',
                timer: 1500,
                showConfirmButton: false
            });
            // 如果当前在草稿箱，刷新列表
            if (this.currentFilter === 'draft') {
                await this.handleFilter('draft');
            }
            return uid;
        } catch (error) {
            console.error('保存草稿失败:', error);
            Swal.fire({
                title: '保存失败',
                text: error.message || '保存草稿时发生错误',
                icon: 'error'
            });
        }
    }

    async handleFilter(filter) {
        console.info('handle filter', filter);
        this.currentFilter = filter; // 保存当前过滤器状态

        // 根据筛选器从数据库加载邮件
        const query = this.buildFilterQuery();
        if (query === null) {
            // 如果是"全部"，重新加载所有邮件
            this.currentSearchQuery = null;
            this.currentOffset = 0;
            this.hasMoreEmails = true;
            const emails = await this.getEmailHeaderList(this.currentOffset, this.emailPerPage);
            this.emailHeaderList.clear();
            for (const email of emails) {
                this.emailHeaderList.set(email.uid, email);
            }
            this.currentOffset += emails.length;
            if (emails.length < this.emailPerPage) {
                this.hasMoreEmails = false;
            }
            this.reloadEmailList(this.emailHeaderList, true);
        } else {
            // 其他筛选条件，从数据库搜索
            await this.loadFilteredEmails(query, true);
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

        // 如果是草稿或已发送，从本地数据库加载
        if (this.selectedEmailHeader.type === 'draft' || this.selectedEmailHeader.type === 'sent') {
            this.selectedEmailContent = await this.getEmailContent(this.selectedEmailUid);
        } else {
            // 收件箱邮件，可能需要从服务器下载
            if (redownload) {
                this.selectedEmailContent = await this.reDownloadEmailContent(this.selectedEmailUid);
            } else {
                this.selectedEmailContent = await this.getEmailContent(this.selectedEmailUid);
            }
        }

        if (!this.selectedEmailContent) {
            return;
        }

        // 根据邮件类型显示不同的操作按钮
        let topButtons = [];

        if (this.selectedEmailHeader.type === 'draft') {
            // 草稿：编辑、删除
            topButtons = [
                {
                    id: 'mailbox-edit-draft-button',
                    icon: 'fa-edit',
                    label: '编辑',
                    action: () => this.editDraft(this.selectedEmailUid)
                },
                {
                    id: 'mailbox-delete-draft-button',
                    icon: 'fa-trash-alt',
                    label: '删除',
                    action: () => this.handleDeleteDraft(this.selectedEmailUid)
                }
            ];
        } else if (this.selectedEmailHeader.type === 'sent') {
            // 已发送：转发、删除
            topButtons = [
                {
                    id: 'mailbox-forward-button',
                    icon: 'fa-share',
                    label: '转发',
                    action: () =>
                        this.createNewEmail(MailOperations.FORWARD, this.selectedEmailHeader, this.selectedEmailContent)
                },
                {
                    id: 'mailbox-trash-button',
                    icon: 'fa-trash-alt',
                    label: '删除',
                    action: () => this.handleDelete(this.selectedEmailUid)
                },
                {
                    id: 'mailbox-star-button',
                    icon: 'fa-star',
                    label: '收藏',
                    action: () => this.starEmail(this.selectedEmailUid, !this.selectedEmailHeader.starred)
                }
            ];
        } else {
            // 收件箱：回复、转发、删除等
            const readUnreadButton = this.selectedEmailHeader.unread
                ? {
                      id: 'mailbox-mark-read-button',
                      icon: 'fa-envelope-open',
                      label: '标为已读',
                      action: () => this.markEmailAsRead(this.selectedEmailUid)
                  }
                : {
                      id: 'mailbox-mark-unread-button',
                      icon: 'fa-envelope',
                      label: '标为未读',
                      action: () => this.markEmailAsUnread(this.selectedEmailUid)
                  };

            topButtons = [
                {
                    id: 'mailbox-reply-button',
                    icon: 'fa-reply',
                    label: '回复',
                    action: () =>
                        this.createNewEmail(MailOperations.REPLY, this.selectedEmailHeader, this.selectedEmailContent)
                },
                {
                    id: 'mailbox-reply-all-button',
                    icon: 'fa-reply-all',
                    label: '回复全部',
                    action: () =>
                        this.createNewEmail(
                            MailOperations.REPLYALL,
                            this.selectedEmailHeader,
                            this.selectedEmailContent
                        )
                },
                {
                    id: 'mailbox-forward-button',
                    icon: 'fa-share',
                    label: '转发',
                    action: () =>
                        this.createNewEmail(MailOperations.FORWARD, this.selectedEmailHeader, this.selectedEmailContent)
                },
                {
                    id: 'mailbox-reload-button',
                    icon: 'fa-redo-alt',
                    label: '重新下载',
                    action: () => this.openEmailByUid(this.selectedEmailUid, true)
                },
                {
                    id: 'mailbox-trash-button',
                    icon: 'fa-trash-alt',
                    label: '删除',
                    action: () => this.handleDelete(this.selectedEmailUid)
                },
                {
                    id: 'mailbox-star-button',
                    icon: 'fa-star',
                    label: '收藏',
                    action: () => this.starEmail(this.selectedEmailUid, !this.selectedEmailHeader.starred)
                },
                readUnreadButton
            ];
        }

        const toolbar = new ElasticToolbarWidget(topButtons);
        toolbar.classList.add('pl-3', 'pr-16', 'align-left', 'mailbox-header');

        this.querySelector('#email-content').innerHTML = '';
        this.querySelector('#email-content').appendChild(toolbar);

        /* 不要直接操作innerHTML，因为可能会导致样式错乱 */
        this.querySelector('#email-content').insertAdjacentHTML(
            'beforeend',
            `
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
        );

        document.querySelector('#email-body-content').attachShadow({ mode: 'open' });
        if (this.selectedEmailContent.htmlContent) {
            document.querySelector('#email-body-content').shadowRoot.innerHTML = this.selectedEmailContent.htmlContent;
        } else if (this.selectedEmailContent.textContent) {
            let textContent = this.selectedEmailContent.textContent;
            textContent = textContent.replace(/\n/g, '<br>');
            document.querySelector('#email-body-content').shadowRoot.innerHTML = textContent;
        } else {
            document.querySelector('#email-body-content').shadowRoot.innerHTML = '';
        }

        document.querySelectorAll('.mailbox-open-attachment-item').forEach((item) => {
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

    async editDraft(uid) {
        const email = this.emailHeaderList.get(uid);
        const content = await this.getEmailContent(uid);
        if (!email || !content) {
            Swal.fire({
                title: '错误',
                text: '无法加载草稿内容',
                icon: 'error'
            });
            return;
        }

        // 打开编辑器，传入草稿的 uid
        const emailContent = this.querySelector('#email-content');
        const editor = new MailEditorWidget();
        editor.classList.add('flex-1', 'overflow-y-auto', 'bg-white');
        editor.id = 'editor';
        editor.draftUid = uid; // 保存草稿 uid
        emailContent.innerHTML = '';
        emailContent.appendChild(editor);

        editor.addEventListener('cancel', () => {
            this.reloadCurrentEmailContent();
        });

        editor.addEventListener('send', async () => {
            const mailSchema = await editor.getMailContent();
            mailSchema.draftUid = uid;
            // 先关闭编辑器
            this.reloadCurrentEmailContent();
            // 再发送邮件（带加载提示）
            await this.sendEmail(mailSchema);
            this.deleteEmail(uid);
        });

        editor.addEventListener('saveDraft', async () => {
            const mailSchema = await editor.getMailContent();
            mailSchema.uid = uid; // 更新现有草稿
            await this.saveDraft(mailSchema);
        });

        // 设置编辑器内容
        await editor.setMailContent(MailOperations.SEND, email, content);
    }

    async handleDeleteDraft(uid) {
        const result = await Swal.fire({
            title: '确定要删除这个草稿吗？',
            text: '此操作无法撤销',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            cancelButtonColor: '#3085d6',
            confirmButtonText: '确定',
            cancelButtonText: '取消',
            didOpen: (popup) => {
                popup.style.fontSize = '0.8rem';
            }
        });

        if (result.isConfirmed) {
            try {
                await window.applicationAPI.call('deleteDraft', uid);
                this.emailHeaderList.delete(uid);

                // 移除邮件项的 DOM
                const emailListContainer = this.querySelector('#email-list');
                if (emailListContainer) {
                    const item = emailListContainer.querySelector(`[data-uid="${uid}"]`);
                    if (item) {
                        item.remove();
                    }
                }

                // 清空右侧内容区
                this.selectedEmailUid = null;
                this.selectedEmailHeader = null;
                this.selectedEmailContent = null;
                this.querySelector('#email-content').innerHTML = '';

                Swal.fire({
                    title: '删除成功',
                    text: '草稿已删除',
                    icon: 'success',
                    timer: 1500,
                    showConfirmButton: false
                });
            } catch (error) {
                console.error('删除草稿失败:', error);
                Swal.fire({
                    title: '删除失败',
                    text: error.message,
                    icon: 'error'
                });
            }
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
        this.reloadEmailList(this.emailHeaderList, false);
    }

    async handleDelete(uid, redownload = false) {
        // 1. 弹出询问框（UI 逻辑）
        const result = await Swal.fire({
            title: '确定要删除这封邮件吗？',
            text: '此操作无法撤销',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            cancelButtonColor: '#3085d6',
            confirmButtonText: '确定',
            cancelButtonText: '取消',
            didOpen: (popup) => {
                popup.style.fontSize = '0.8rem'; // 设置为原大小的 80%
            }
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

        // 移除邮件项的 DOM，不重新渲染整个列表
        const emailListContainer = this.querySelector('#email-list');
        if (emailListContainer) {
            const item = emailListContainer.querySelector(`[data-uid="${uid}"]`);
            if (item) {
                item.remove();
            }
        }

        this.selectedEmailUid = nextuid;
        await this.reloadCurrentEmailContent(redownload);
    }

    render() {
        const accountName = this.currentAccount ? this.currentAccount.name || this.currentAccount.email : '未配置账号';

        // 生成账号列表项 HTML，包含空值保护
        const accountListHtml = (this.accounts || [])
            .map(
                (acc) => `
            <div class="account-selector-item px-3 py-2 hover:bg-gray-100 cursor-pointer text-sm flex items-center gap-2 ${acc.email === this.currentAccount?.email ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700'}"
                 data-email="${acc.email}">
                 <div class="w-2 h-2 rounded-full ${acc.email === this.currentAccount?.email ? 'bg-indigo-600' : 'bg-transparent'}"></div>
                 <div class="flex flex-col overflow-hidden">
                    <span class="font-medium truncate">${acc.name || acc.email}</span>
                    <span class="text-xs text-gray-400 truncate">${acc.email}</span>
                 </div>
            </div>
        `
            )
            .join('');

        this.innerHTML = `
        <splitter-widget class="w-full h-full flex">
            <aside slot="left" class="w-full bg-white flex flex-col flex-shrink-0" style="height: 100%; min-height: 0; overflow: hidden;">

                <div class="px-3 space-y-3">
                    <div class="flex items-center justify-between">
                        <div class="relative z-20 pt-3">
                            <button id="account-selector-btn" class="flex items-center gap-2 px-2 py-1 -ml-2 rounded-lg hover:bg-gray-100 transition-colors group">
                                <h1 class="text-xl font-bold tracking-tight text-gray-900 group-hover:text-indigo-600 transition-colors truncate max-w-[180px]">
                                    ${accountName}
                                </h1>
                                <i class="fa-solid fa-chevron-down text-gray-400 text-xs group-hover:text-indigo-500 transition-colors"></i>
                            </button>

                            <div id="account-selector-menu" class="hidden absolute left-0 top-full mt-1 w-64 bg-white rounded-xl shadow-lg border border-gray-100 py-1 overflow-hidden origin-top-left transition-all duration-200">
                                <div class="px-3 py-2 text-xs font-medium text-gray-400 border-b border-gray-50">切换账号</div>
                                ${accountListHtml || '<div class="p-3 text-xs text-gray-400">暂无可用账号</div>'}
                                <div class="border-t border-gray-100">
                                    <div id="add-new-mailbox-btn" class="px-3 py-2.5 hover:bg-indigo-50 cursor-pointer text-sm flex items-center gap-2 text-indigo-600 transition-colors">
                                        <i class="fa-solid fa-plus text-xs"></i>
                                        <span class="font-medium">配置新邮箱</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div id="mailbox-header-toolbar" class="flex items-center gap-2">
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
            <main id='email-content' slot="right" class="flex-1 bg-white flex flex-col overflow-auto"></main>
        </splitter-widget>
        `;

        this._createHeaderToolbar();
        this.setupTabListeners();
        this.setupSearchListeners();
    }

    _createHeaderToolbar() {
        const toolbar = new ElasticToolbarWidget([
            {
                id: 'mailbox-sync-email-button',
                icon: 'fa-sync-alt',
                label: '同步',
                action: () => this.syncEmails()
            },
            {
                id: 'mailbox-new-email-button',
                icon: 'fa-plus',
                label: '写邮件',
                action: () => this.createNewEmail(MailOperations.SEND)
            }
        ]);

        toolbar.classList.add('mailbox-header');
        const container = this.querySelector('#mailbox-header-toolbar');
        if (container) {
            container.appendChild(toolbar);
        }
    }

    // 辅助方法：设置账号切换器的事件监听
    setupAccountSelectorListeners() {
        const btn = this.querySelector('#account-selector-btn');
        const menu = this.querySelector('#account-selector-menu');
        if (!btn || !menu) return;

        // 切换菜单显示
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.classList.toggle('hidden');
        });

        // 点击外部关闭菜单
        document.addEventListener('click', (e) => {
            if (!menu.classList.contains('hidden') && !btn.contains(e.target) && !menu.contains(e.target)) {
                menu.classList.add('hidden');
            }
        });

        // 账号点击事件
        const items = menu.querySelectorAll('.account-selector-item');
        items.forEach((item) => {
            item.addEventListener('click', (e) => {
                const email = item.dataset.email;
                if (email) {
                    this.switchAccount(email);
                    menu.classList.add('hidden');
                }
            });
        });

        // 配置新邮箱按钮
        this._bindAddNewMailboxBtn(menu);
    }

    async _onAddNewMailboxClick() {
        const menu = this.querySelector('#account-selector-menu');
        if (menu) menu.classList.add('hidden');
        try {
            const taskId = await window.taskManagerAPI.createTask();
            await window.taskManagerAPI.submitMessage(taskId, {
                message: '请帮我配置一个新的邮箱账号',
                attachedFilePaths: []
            });
            const root = window.parent || window;
            if (root.globalControlAPI?.openTask) {
                root.globalControlAPI.openTask(taskId);
            }
        } catch (err) {
            console.error('创建配置邮箱任务失败', err);
        }
    }

    _bindAddNewMailboxBtn(container) {
        const btn = container?.querySelector('#add-new-mailbox-btn');
        if (btn) {
            btn.addEventListener('click', () => this._onAddNewMailboxClick());
        }
    }

    // 辅助方法：更新账号切换器 UI（选中状态和标题）
    // 辅助方法：更新账号切换器 UI（重新渲染列表并绑定事件）
    updateAccountSelectorUI() {
        // 1. 更新顶部按钮的标题
        const titleEl = this.querySelector('#account-selector-btn h1');
        if (titleEl) {
            titleEl.textContent = this.currentAccount
                ? this.currentAccount.name || this.currentAccount.email
                : '未配置账号';
        }

        // 2. 重新生成账号列表的 HTML
        const menu = this.querySelector('#account-selector-menu');
        if (!menu) return;

        const accountListHtml = (this.accounts || [])
            .map(
                (acc) => `
            <div class="account-selector-item px-3 py-2 hover:bg-gray-100 cursor-pointer text-sm flex items-center gap-2 ${acc.email === this.currentAccount?.email ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700'}"
                 data-email="${acc.email}">
                 <div class="w-2 h-2 rounded-full ${acc.email === this.currentAccount?.email ? 'bg-indigo-600' : 'bg-transparent'}"></div>
                 <div class="flex flex-col overflow-hidden">
                    <span class="font-medium truncate">${acc.name || acc.email}</span>
                    <span class="text-xs text-gray-400 truncate">${acc.email}</span>
                 </div>
            </div>
        `
            )
            .join('');

        // 3. 将新生成的 HTML 注入到菜单中
        // 保留顶部的 "切换账号" 标题栏，只替换列表部分
        menu.innerHTML = `
            <div class="px-3 py-2 text-xs font-medium text-gray-400 border-b border-gray-50">切换账号</div>
            ${accountListHtml || '<div class="p-3 text-xs text-gray-400">暂无可用账号</div>'}
            <div class="border-t border-gray-100">
                <div id="add-new-mailbox-btn" class="px-3 py-2.5 hover:bg-indigo-50 cursor-pointer text-sm flex items-center gap-2 text-indigo-600 transition-colors">
                    <i class="fa-solid fa-plus text-xs"></i>
                    <span class="font-medium">配置新邮箱</span>
                </div>
            </div>
        `;

        // 4. 【关键】因为 DOM 被重写了，必须重新绑定点击事件
        const items = menu.querySelectorAll('.account-selector-item');
        items.forEach((item) => {
            item.addEventListener('click', (e) => {
                const email = item.dataset.email;
                if (email) {
                    this.switchAccount(email);
                    menu.classList.add('hidden');
                }
            });
        });

        // 5. 绑定"配置新邮箱"按钮
        this._bindAddNewMailboxBtn(menu);
    }

    // 辅助方法：设置标签页事件
    setupTabListeners() {
        const tabsContainer = document.getElementById('mailbox-tabs');
        if (!tabsContainer) return;

        const tabButtons = tabsContainer.querySelectorAll('button');
        tabsContainer.addEventListener('click', function (e) {
            if (e.target.tagName === 'BUTTON') {
                // 重置所有按钮样式
                tabButtons.forEach((btn) => {
                    btn.className =
                        'whitespace-nowrap px-3 py-1.5 bg-gray-100 text-gray-600 hover:bg-gray-200 rounded-lg font-medium';
                });
                // 设置当前按钮为激活状态
                e.target.className = 'whitespace-nowrap px-3 py-1.5 bg-gray-900 text-white rounded-lg active';
            }
        });

        // 绑定具体功能
        document.getElementById('mailbox-all-email-button')?.addEventListener('click', () => this.handleFilter('all'));
        document
            .getElementById('mailbox-unread-email-button')
            ?.addEventListener('click', () => this.handleFilter('unread'));
        document
            .getElementById('mailbox-star-email-button')
            ?.addEventListener('click', () => this.handleFilter('starred'));
        document
            .getElementById('mailbox-draft-email-button')
            ?.addEventListener('click', () => this.handleFilter('draft'));
        document
            .getElementById('mailbox-sent-email-button')
            ?.addEventListener('click', () => this.handleFilter('sent'));
    }

    // 辅助方法：设置搜索事件
    setupSearchListeners() {
        const searchInput = document.getElementById('mailbox-search-input');
        if (!searchInput) return;

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
            if (e.key === 'Enter' && !e.isComposing) {
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
            { key: 'date', regex: /date:([^\s]+)/i }
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
                const [startDate, endDate] = query.date.split('~').map((d) => d.trim());
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
        /** @type {string | null} */
        this.currentOperation = null;
    }

    async getEditor() {
        return await this.editorReady;
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
        return tags.map((tag) => (typeof tag === 'string' ? tag : tag.value));
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

        const attachmentsHTML = this.attachments
            .map((attachment, index) => {
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
            })
            .join('');

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
        container.querySelectorAll('.remove-attachment').forEach((btn) => {
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
        this.addEventListener('focusin', () => {
            try {
                const Alpine = window.Alpine;
                if (Alpine && Alpine.$data) {
                    Alpine.$data(document.body).showFloatingChatPanel = false;
                }
            } catch (_) {
                /* ignore */
            }
        });
    }

    async cancel() {
        console.info('cancel');

        // 弹出确认对话框，询问是否保存草稿
        const result = await Swal.fire({
            title: '是否保存草稿？',
            text: '您可以选择保存草稿或直接退出',
            icon: 'question',
            showCancelButton: true,
            showDenyButton: true,
            confirmButtonColor: '#3085d6',
            denyButtonColor: '#6c757d',
            cancelButtonColor: '#d33',
            confirmButtonText: '保存草稿',
            denyButtonText: '不保存',
            cancelButtonText: '继续编辑',
            didOpen: (popup) => {
                popup.style.fontSize = '0.9rem';
            }
        });

        if (result.isConfirmed) {
            // 用户选择保存草稿
            await this.saveDraft();
            this.dispatchEvent(new CustomEvent('cancel'), { bubbles: true });
        } else if (result.isDenied) {
            // 用户选择不保存，直接退出
            this.dispatchEvent(new CustomEvent('cancel'), { bubbles: true });
        }
        // 如果用户点击"继续编辑"或关闭对话框，则什么都不做
    }

    send() {
        this.dispatchEvent(new CustomEvent('send', { bubbles: true }));
    }

    composeContent(selectedEmailHeader, originEmailContent, replyContent) {
        const sender =
            selectedEmailHeader.from && selectedEmailHeader.from[0]
                ? selectedEmailHeader.from[0].address
                : '未知发件人';
        const sendTime = new Date(selectedEmailHeader.date).toLocaleString();
        const receivers = selectedEmailHeader.to ? selectedEmailHeader.to.map((t) => t.address).join(', ') : '';
        const ccReceivers =
            selectedEmailHeader.cc && selectedEmailHeader.cc.length > 0
                ? selectedEmailHeader.cc.map((c) => c.address).join(', ')
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

                ${
                    ccReceivers
                        ? `
                <div style="margin-bottom: 6px;">
                    <span style="color: #6b7280; font-weight: bold; display: inline-block; width: 70px;">抄送:</span>
                    <span style="color: #374151;">${ccReceivers}</span>
                </div>
                `
                        : ''
                }

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
        const sendEmailSchema = {
            to: to,
            cc: ccList,
            bcc: bccList,
            subject: subject,
            html: content,
            attachments: attachments
        };
        return sendEmailSchema;
    }

    async setMailContent(operation, mailHeader, mailContent, replyContent, currentAccount) {
        if (!mailHeader && !mailContent) {
            return;
        }
        const editor = await this.editorReady;
        this.currentOperation = operation;
        if (operation == MailOperations.POLISH) {
            editor.setContent(mailContent);
            return;
        }
        if (operation == MailOperations.REPLY) {
            document.getElementById('to').value = mailHeader.from[0].address;
            document.getElementById('subject').value = '答复:' + mailHeader.subject;
        } else if (operation == MailOperations.REPLYALL) {
            const filteredTo = mailHeader.to.filter((to) => to.address != currentAccount?.email);
            document.getElementById('to').value = mailHeader.from[0].address;
            document.getElementById('to').value += ',' + filteredTo.map((to) => to.address).join(',');
            document.getElementById('subject').value = '答复全部:' + mailHeader.subject;
            if (mailHeader.cc && mailHeader.cc.length > 0) {
                document.getElementById('cc').value = mailHeader.cc.map((cc) => cc.address).join(',');
            }
            if (mailHeader.bcc && mailHeader.bcc.length > 0) {
                document.getElementById('bcc').value = mailHeader.bcc.map((bcc) => bcc.address).join(',');
            }
        } else if (operation == MailOperations.FORWARD) {
            document.getElementById('subject').value = '转发:' + mailHeader.subject;
        } else if (operation == MailOperations.SEND) {
            document.getElementById('subject').value = mailHeader.subject;
            document.getElementById('to').value = mailHeader.to.map((to) => to.address).join(',');
            document.getElementById('cc').value = mailHeader.cc.map((cc) => cc.address).join(',');
            document.getElementById('bcc').value = mailHeader.bcc.map((bcc) => bcc.address).join(',');
        }

        const originContent = mailContent.htmlContent
            ? mailContent.htmlContent
            : mailContent.textContent.replace(/\n/g, '<br>');
        if (operation == MailOperations.SEND) {
            editor.setContent(originContent);
        } else {
            const combileContent = this.composeContent(mailHeader, originContent, replyContent);
            editor.setContent(combileContent);
        }
    }

    async magicWrite() {
        const isReplyMode = [MailOperations.REPLY, MailOperations.REPLYALL, MailOperations.FORWARD].includes(
            this.currentOperation
        );

        if (isReplyMode) {
            window.aiBarAPI.submitRequestInNewTask('帮我回复一下当前打开的这封邮件');
            return;
        }

        const to = this.getTagValue('to');
        const subject = document.getElementById('subject').value.trim();
        const editor = await this.editorReady;
        const bodyContent = editor.getContent({ format: 'text' }).trim();

        if (!to || to.length === 0 || !subject) {
            Swal.fire({
                title: '信息不完整',
                text: '请先填写收件人和主题，再使用帮我写功能',
                icon: 'warning',
                timer: 2000,
                showConfirmButton: false
            });
            return;
        }

        const toAddresses = to.map((t) => (typeof t === 'string' ? t : t.value)).join(', ');
        window.aiBarAPI.submitRequestInNewTask(
            `请帮我写以下邮件。\n\n收件人: ${toAddresses}\n主题: ${subject}\n正文:\n${bodyContent}`
        );
    }

    render() {
        const buttons = [
            {
                id: 'send-email-cancel-button',
                icon: 'fa-circle-arrow-left',
                label: '取消',
                action: () => this.cancel()
            },
            {
                id: 'send-email-save-draft-button',
                icon: 'fa-save',
                label: '保存草稿',
                action: () => this.saveDraft()
            },
            {
                id: 'send-email-send-button',
                icon: 'fa-paper-plane',
                label: '发送',
                action: () => this.send()
            },
            {
                id: 'send-email-magic-write-button',
                icon: 'fa-wand-sparkles',
                label: '帮我写',
                labelStayVisible: true,
                action: () => this.magicWrite()
            }
        ];
        const headerToolbar = new ElasticToolbarWidget(buttons);
        headerToolbar.classList.add('pl-3', 'pr-16', 'align-left', 'mailbox-header');

        this.innerHTML = '';
        this.appendChild(headerToolbar);

        this.insertAdjacentHTML(
            'beforeend',
            `
        <!-- 邮件编辑区（布局与阅读界面一致：工具栏固定顶部，此处 flex-1 min-h-0 使内容区单独滚动） -->
        <div class="flex-1 min-h-0 overflow-y-auto p-4 bg-white flex flex-col">
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
        `
        );

        // 初始化 Tagify
        const commonConfig = {
            pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
            delimiters: ',|;| ',
            keepInvalidTags: false,
            dropdown: { enabled: 0 },
            trim: true
        };

        const inputTo = document.getElementById('to');
        if (inputTo) {
            this.tagifyInstances.to = new Tagify(inputTo, commonConfig);
        }

        ['cc', 'bcc'].forEach((type) => {
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
            language: 'zh_CN', // 设置中文语言

            // 【关键配置】TinyMCE 7.x 需要的配置
            skin: false, // 不动态加载皮肤（已在顶部 import）
            content_css: false, // 不动态加载内容样式（已在顶部 import）
            license_key: 'gpl', // 声明为 GPL 开源使用（避免弹窗）
            highlight_on_focus: false,

            plugins: [
                'advlist',
                'autolink',
                'lists',
                'link',
                'image',
                'charmap',
                'preview',
                'anchor',
                'searchreplace',
                'visualblocks',
                'code',
                'fullscreen',
                'insertdatetime',
                'media',
                'table',
                'wordcount'
            ],
            toolbar:
                'addAttachment | fontfamily fontsize | bold italic underline strikethrough | forecolor backcolor | bullist numlist | alignleft aligncenter alignright alignjustify | removeformat lineheight hr blockquote code',
            toolbar_mode: 'sliding',
            line_height_formats: '1 1.2 1.4 1.5 2 3',
            font_family_formats:
                '微软雅黑=Microsoft YaHei,Helvetica Neue,PingFang SC,sans-serif;苹果苹方=PingFang SC,Microsoft YaHei,sans-serif;宋体=simsun,serif;Arial=arial,helvetica,sans-serif;',
            font_size_formats: '12px 14px 16px 18px 24px 36px 48px',
            setup: (editor) => {
                editor.ui.registry.addIcon(
                    'paperclip',
                    '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5a2.5 2.5 0 0 0 5 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z" fill="currentColor"/></svg>'
                );
                const self = this;
                editor.ui.registry.addButton('addAttachment', {
                    icon: 'paperclip',
                    tooltip: '添加附件',
                    onAction: async () => {
                        try {
                            const paths = await window.fsAPI.selectFile();
                            if (paths && paths.length > 0) {
                                paths.forEach((fullPath) => {
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
                // 分割线自动补全：输入 --- 后按回车，转换为 <hr>
                editor.on('keydown', (e) => {
                    if (e.key === 'Enter') {
                        self._handleHorizontalRuleShortcut(editor, e);
                    }
                });
            },

            // 回调
            init_instance_callback: (editor) => {
                console.log('编辑器加载完成！');
                editor.on('focus', () => {
                    try {
                        const Alpine = window.Alpine;
                        if (Alpine && Alpine.$data) {
                            Alpine.$data(document.body).showFloatingChatPanel = false;
                        }
                    } catch (_) {
                        /* ignore */
                    }
                });
                this.resolveEditor(editor);
            }
        });
        window.toggleRow = function (type) {
            const row = document.getElementById('row-' + type);
            const btn = document.getElementById('btn-' + type);

            if (row) row.classList.remove('hidden');
            if (btn) btn.style.display = 'none';
        };
        window.closeRow = function (type) {
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

        console.log('Tagify (To, Cc, Bcc) 初始化完成！');
    }

    saveDraft() {
        this.dispatchEvent(new CustomEvent('saveDraft', { bubbles: true }));
    }

    // ─── 分割线自动补全 ───

    _handleHorizontalRuleShortcut(editor, e) {
        const node = editor.selection.getNode();
        if (!node || node.nodeName === 'HR') return;

        const text = node.textContent || '';
        const trimmedText = text.trim();

        // 支持 --- 和 *** 两种常见分割线语法
        if (trimmedText === '---' || trimmedText === '***') {
            // 阻止默认回车行为
            e.preventDefault();

            // 清空当前节点内容并插入分割线
            editor.undoManager.transact(() => {
                node.textContent = '';
                // 在当前节点后插入分割线
                const hr = editor.dom.create('hr');
                editor.dom.insertAfter(hr, node);
                // 在分割线后插入空段落，并将光标移动到那里
                const p = editor.dom.create('p');
                p.innerHTML = '<br data-mce-bogus="1">';
                editor.dom.insertAfter(p, hr);
                editor.selection.setCursorLocation(p, 0);
            });
        }
    }
}

customElements.define('mailbox-entry-widget', MailBoxEntryWidget);
customElements.define('mail-editor-widget', MailEditorWidget);

console.info('mailbox/renderer/entry.js loaded');
