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

import { type Component, SelectList, Box, Text, Editor, Input, Key, matchesKey, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import { defaultSelectListTheme, defaultEditorTheme } from "../../tui/theme";
import type { OpenDeskTUI } from "../../tui/entry";
import { ApplicationRegistry } from "../../applications/registry";
import { LLM } from "../../aikernel/llm.js";
import { UserMessage } from "../../aikernel/messages.js";
import { logger } from "../../utils/logger.js";
import chalk from "chalk";


// ━━━ 邮箱配色 ━━━
const MC = {
    accent: chalk.hex('#4A90D9'),
    accentBold: chalk.hex('#4A90D9').bold,
    neon: chalk.hex('#00E5FF'),
    neonBold: chalk.hex('#00E5FF').bold,
    green: chalk.hex('#39FF14'),
    amber: chalk.hex('#FFAB00'),
    red: chalk.hex('#FF1744'),
    ghost: chalk.hex('#4a4a4a'),
    dim: chalk.hex('#666666'),
    text: chalk.hex('#c0c0c0'),
    bright: chalk.hex('#e0e0e0').bold,
    unread: chalk.hex('#00E5FF').bold,
};

// ━━━ 类型定义 ━━━

interface EmailHeader {
    uid: string;
    subject: string;
    from: Array<{ name: string; address: string }>;
    to: Array<{ name: string; address: string }>;
    cc?: Array<{ name: string; address: string }>;
    bcc?: Array<{ name: string; address: string }>;
    date: string | Date;
    unread: boolean;
    starred: boolean;
    deleted: boolean;
    type: string;
}

interface EmailContent {
    htmlContent: string;
    textContent: string;
    attachments: Array<{ filename: string; path: string }>;
}

type MailViewState = 'loading' | 'list' | 'detail' | 'compose';
type FilterType = 'all' | 'unread' | 'starred' | 'draft' | 'sent';
type ComposeType = 'reply' | 'replyall' | 'new';

interface FilterDef {
    key: string;
    value: FilterType;
    label: string;
}

const FILTERS: FilterDef[] = [
    { key: '1', value: 'all', label: '全部' },
    { key: '2', value: 'unread', label: '未读' },
    { key: '3', value: 'starred', label: '收藏' },
    { key: '4', value: 'draft', label: '草稿' },
    { key: '5', value: 'sent', label: '已发送' },
];

// ━━━ Worker 通信助手 ━━━

async function callMailWorker(method: string, ...args: any[]): Promise<any> {
    const result = await ApplicationRegistry.callWorker('mailbox', method, ...args);
    if (result?.status === 'error') {
        throw new Error(result.message || `mailbox.${method} failed`);
    }
    return result?.data;
}

// ━━━ 工具函数 ━━━

/**
 * 清洗终端不安全的控制字符（与 Card 组件一致）。
 * \t → 3 空格（匹配 pi-tui visibleWidth 行为）
 * \r 及其余 C0 控制字符（保留 \x1b 以兼容 ANSI 色码）→ 移除
 * 保留 \x07 (BEL)，以免破坏 pi-tui 的 CURSOR_MARKER (\x1b_pi:c\x07)，否则会露出 "pi:c" 且光标无法定位
 */
function sanitizeLine(line: string): string {
    // eslint-disable-next-line no-control-regex
    return line.replace(/[\x00-\x06\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\r]/g, '').replace(/\t/g, '   ');
}

function stripHtml(html: string): string {
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<\/tr>/gi, '\n')
        .replace(/<\/h[1-6]>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function formatDate(dateStr: string | Date): string {
    const date = new Date(dateStr);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) {
        return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    return (
        date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) +
        ' ' +
        date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    );
}

function formatSender(from: Array<{ name: string; address: string }> | undefined): string {
    if (!from || from.length === 0) return '未知';
    const sender = from[0];
    return sender.name || sender.address || '未知';
}

function formatAddresses(addrs: Array<{ name: string; address: string }> | undefined): string {
    if (!addrs || addrs.length === 0) return '未知';
    return addrs.map(a => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MailOverlay — 全屏邮箱 TUI 界面
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const mailSelectListTheme = {
    ...defaultSelectListTheme,
    selectedPrefix: (text: string) => chalk.bgHex('#1a2735').hex('#4A90D9')(text),
    selectedText: (text: string) => chalk.bgHex('#1a2735').bold(text),
};

export class MailOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private box: Box;

    private state: MailViewState = 'loading';
    private emails: EmailHeader[] = [];
    private selectedEmail?: EmailHeader;
    private selectedEmailContent?: EmailContent;
    private currentFilter: FilterType = 'all';
    private accounts: any[] = [];
    private currentAccount?: any;
    private loadingText = '正在加载邮件...';
    private errorText?: string;
    private isSyncing = false;

    private emailList?: SelectList;
    private detailList?: SelectList;
    private handle?: any;
    private inputListenerRemove?: () => void;

    // 详情视图滚动状态
    private detailScrollOffset = 0;
    private detailBodyTotalLines = 0;
    private detailBodyVisibleLines = 0;

    // compose 相关
    private composeType?: ComposeType;
    private composeToInput?: Input;
    private composeCcInput?: Input;
    private composeSubjectInput?: Input;
    private composeEditor?: Editor;
    private composeFocusIdx = 0;
    private isAiGenerating = false;
    private composeSending = false;
    private aiSpinnerTimer?: ReturnType<typeof setInterval>;
    private aiSpinnerFrame = 0;

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#0a0e14').hex('#c0c0c0')(text));
    }

    invalidate(): void {
        this.box.invalidate();
    }

    // ──────────────────── 生命周期 ────────────────────

    async show() {
        this.handle = this.openDeskTUI.tui.showOverlay(this, {
            width: "100%",
            maxHeight: "100%",
            anchor: "center",
        });
        this.openDeskTUI.hasOpenOverlay = true;

        this.inputListenerRemove = this.openDeskTUI.tui.addInputListener((data: string) => {
            return this.handleInput(data);
        });

        try { await callMailWorker('notifyMailboxOpened'); } catch { /* ignore */ }

        await this.loadAccounts();
        await this.loadEmails();
    }

    private close() {
        this.stopAiSpinner();
        this.inputListenerRemove?.();
        this.handle?.hide();
        this.openDeskTUI.hasOpenOverlay = false;
        this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);

        callMailWorker('notifyMailboxClosed').catch(() => { });
    }

    // ──────────────────── 输入处理 ────────────────────

    handleInput(data: string): { consume: boolean } | undefined {
        if (this.state === 'compose') {
            // AI 生成期间锁定所有键盘输入
            if (this.isAiGenerating) {
                return { consume: true };
            }
            if (matchesKey(data, Key.ctrl('s'))) {
                this.sendComposedEmail();
                return { consume: true };
            }
            if (matchesKey(data, Key.ctrl('w'))) {
                this.aiGenerateReply();
                return { consume: true };
            }
            if (matchesKey(data, Key.escape)) {
                this.exitCompose();
                return { consume: true };
            }
            if (matchesKey(data, Key.tab)) {
                this.cycleComposeFocus(1);
                return { consume: true };
            }
            if (matchesKey(data, Key.shift('tab'))) {
                this.cycleComposeFocus(-1);
                return { consume: true };
            }
            // 当焦点在 Input 字段上，Enter 跳到下一个字段
            if (matchesKey(data, Key.enter) && this.composeFocusIdx < this.getComposeFocusFields().length - 1) {
                this.cycleComposeFocus(1);
                return { consume: true };
            }
            return undefined;
        }

        if (this.state === 'detail') {
            // j / ↓ 向下滚动邮件正文
            if (data === 'j' || data === 'J' || matchesKey(data, Key.down)) {
                this.scrollDetailBody(1);
                return { consume: true };
            }
            // k / ↑ 向上滚动邮件正文
            if (data === 'k' || data === 'K' || matchesKey(data, Key.up)) {
                this.scrollDetailBody(-1);
                return { consume: true };
            }
            // PageDown / 空格 翻页
            if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) {
                this.scrollDetailBody(Math.max(1, this.detailBodyVisibleLines - 2));
                return { consume: true };
            }
            // PageUp / b 翻页
            if (matchesKey(data, Key.pageUp) || data === 'b' || data === 'B') {
                this.scrollDetailBody(-(Math.max(1, this.detailBodyVisibleLines - 2)));
                return { consume: true };
            }
            // Home / g 跳到顶部
            if (matchesKey(data, Key.home) || data === 'g') {
                this.detailScrollOffset = 0;
                this.openDeskTUI.tui.requestRender();
                return { consume: true };
            }
            // End / G 跳到底部
            if (matchesKey(data, Key.end) || data === 'G') {
                const bodyArea = Math.max(1, this.detailBodyVisibleLines - 1);
                this.detailScrollOffset = Math.max(0, this.detailBodyTotalLines - bodyArea);
                this.openDeskTUI.tui.requestRender();
                return { consume: true };
            }
            // r 回复
            if (data === 'r') {
                this.startCompose('reply');
                return { consume: true };
            }
            // R 回复全部
            if (data === 'R') {
                this.startCompose('replyall');
                return { consume: true };
            }
            // d 删除
            if (data === 'd') {
                this.handleDetailAction('delete');
                return { consume: true };
            }
            // f 收藏切换
            if (data === 'f' || data === 'F') {
                this.handleDetailAction('star');
                return { consume: true };
            }
            // ESC / q 返回列表
            if (matchesKey(data, Key.escape) || data === 'q') {
                this.selectedEmail = undefined;
                this.selectedEmailContent = undefined;
                this.buildEmailList();
                return { consume: true };
            }
            return { consume: true }; // 详情视图消费所有按键，避免穿透
        }

        if (this.state === 'list') {
            for (const f of FILTERS) {
                if (data === f.key) {
                    this.switchFilter(f.value);
                    return { consume: true };
                }
            }
            if (data === 'c' || data === 'C') {
                this.startCompose('new');
                return { consume: true };
            }
            if (data === 's' || data === 'S') {
                this.syncEmails();
                return { consume: true };
            }
            if (data === 'a' || data === 'A') {
                this.cycleAccount();
                return { consume: true };
            }
        }
        return undefined;
    }

    private getComposeFocusFields(): Array<Input | Editor> {
        const fields: Array<Input | Editor> = [];
        if (this.composeToInput) fields.push(this.composeToInput);
        if (this.composeCcInput) fields.push(this.composeCcInput);
        if (this.composeSubjectInput) fields.push(this.composeSubjectInput);
        if (this.composeEditor) fields.push(this.composeEditor);
        return fields;
    }

    private cycleComposeFocus(dir: 1 | -1) {
        const fields = this.getComposeFocusFields();
        if (fields.length === 0) return;
        this.composeFocusIdx = (this.composeFocusIdx + dir + fields.length) % fields.length;
        this.openDeskTUI.tui.setFocus(fields[this.composeFocusIdx]);
        this.openDeskTUI.tui.requestRender();
    }

    private setComposeFocusToEditor() {
        const fields = this.getComposeFocusFields();
        const editorIdx = fields.indexOf(this.composeEditor!);
        if (editorIdx >= 0) {
            this.composeFocusIdx = editorIdx;
            this.openDeskTUI.tui.setFocus(this.composeEditor!);
        }
    }

    private exitCompose() {
        this.stopAiSpinner();
        this.composeEditor = undefined;
        this.composeToInput = undefined;
        this.composeCcInput = undefined;
        this.composeSubjectInput = undefined;
        this.errorText = undefined;
        if (this.selectedEmail) {
            this.buildDetailView();
        } else {
            this.buildEmailList();
        }
    }

    // ──────────────────── 数据加载 ────────────────────

    private async loadAccounts() {
        try {
            const data = await callMailWorker('getAccountList');
            this.accounts = Array.isArray(data) ? data : [];
            this.currentAccount = this.accounts.find((a: any) => a.active) || this.accounts[0];
        } catch (err) {
            logger.error(`加载邮箱账号失败: ${err}`);
            this.accounts = [];
        }
    }

    private async loadEmails() {
        this.state = 'loading';
        this.loadingText = '正在加载邮件...';
        this.errorText = undefined;
        this.openDeskTUI.tui.requestRender();

        try {
            let data: any;
            if (this.currentFilter === 'all') {
                data = await callMailWorker('getEmailHeaderList', 0, 100);
            } else {
                data = await callMailWorker('searchEmails', this.buildFilterQuery());
            }
            const emails: EmailHeader[] = Array.isArray(data) ? data : [];
            emails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
            this.emails = emails;
            this.buildEmailList();
        } catch (err: any) {
            logger.error(`加载邮件失败: ${err}`);
            this.errorText = `加载失败: ${err?.message || '未知错误'}`;
            this.emails = [];
            this.buildEmailList();
        }
    }

    private buildFilterQuery(): any {
        switch (this.currentFilter) {
            case 'unread': return { unread: true, limit: 100, offset: 0 };
            case 'starred': return { starred: true, limit: 100, offset: 0 };
            case 'draft': return { type: 'draft', limit: 100, offset: 0 };
            case 'sent': return { type: 'sent', limit: 100, offset: 0 };
            default: return null;
        }
    }

    // ──────────────────── 列表视图 ────────────────────

    /**
     * 列表视图布局（行高精确到行，确保填满屏幕）：
     *   Box top padding        1
     *   MailHeaderBar           3  (bar + title + bar)
     *   空行                    1
     *   FilterTabsBar           1
     *   SeparatorLine           1
     *   [error]                 0 | 1
     *   SelectList              ← 弹性区域
     *   空行                    1
     *   ListFooter              1
     *   Box bottom padding      1
     *   ─────────────────────────
     *   固定合计(无error)       10
     */
    private buildEmailList() {
        this.state = 'list';

        const rows = this.openDeskTUI.tui.terminal.rows;
        const fixedLines = 10 + (this.errorText ? 1 : 0);
        const visibleCount = Math.max(1, rows - fixedLines);
        const contentWidth = this.openDeskTUI.tui.terminal.columns - 6;

        const items = this.emails.map((email) => ({
            value: email.uid,
            label: this.formatEmailItem(email, contentWidth),
        }));

        if (items.length === 0) {
            items.push({ value: '__empty__', label: MC.dim('  ∅ 暂无邮件') });
        }

        this.emailList = new SelectList(items, visibleCount, mailSelectListTheme);
        this.openDeskTUI.tui.setFocus(this.emailList);

        this.emailList.onSelect = async (item: any) => {
            if (item.value === '__empty__') return;
            await this.openEmail(item.value);
        };

        this.emailList.onCancel = () => {
            this.close();
        };

        // 列表选择变化时强制全量重绘，避免差异更新导致表头/标签行重复堆叠
        this.emailList.onSelectionChange = () => {
            this.openDeskTUI.tui.requestRender(true);
        };

        this.openDeskTUI.tui.requestRender();
    }

    private formatEmailItem(email: EmailHeader, maxWidth: number): string {
        const unreadIcon = email.unread ? MC.unread('●') : MC.ghost('○');
        const starIcon = email.starred ? MC.amber('★') : ' ';

        let typeIcon = '';
        if (email.type === 'draft') typeIcon = MC.amber('✎ ');
        else if (email.type === 'sent') typeIcon = MC.accent('➤ ');

        const dateStr = MC.dim(formatDate(email.date).padEnd(12));
        const sender = (email.type === 'sent' || email.type === 'draft')
            ? formatAddresses(email.to)
            : formatSender(email.from);

        const fixedPart = `${unreadIcon} ${typeIcon}${dateStr}`;
        const fixedVis = visibleWidth(fixedPart);
        const starVis = visibleWidth(starIcon);

        const remaining = Math.max(20, maxWidth - fixedVis - starVis - 4);
        const senderMaxW = Math.min(20, Math.floor(remaining * 0.35));
        const subjectMaxW = remaining - senderMaxW - 2;

        const truncSender = truncateToWidth(sender, senderMaxW, '…');
        const truncSubject = truncateToWidth(email.subject || '(无主题)', subjectMaxW, '…');

        const styledSender = MC.text(truncSender);
        const styledSubject = email.unread ? MC.bright(truncSubject) : MC.dim(truncSubject);

        const senderPadded = styledSender + ' '.repeat(Math.max(0, senderMaxW - visibleWidth(truncSender)));

        const assembled = `${fixedPart}  ${senderPadded}  ${styledSubject}  ${starIcon}`;
        return truncateToWidth(assembled, maxWidth, '…');
    }

    // ──────────────────── 详情视图 ────────────────────

    private async openEmail(uid: string) {
        this.state = 'loading';
        this.loadingText = '正在加载邮件内容...';
        this.openDeskTUI.tui.requestRender();

        try {
            const email = this.emails.find(e => e.uid === uid);
            if (!email) return;

            this.selectedEmail = email;
            this.selectedEmailContent = await callMailWorker('getEmailContent', uid);

            if (email.unread) {
                await callMailWorker('markEmailAsRead', uid);
                email.unread = false;
            }

            this.buildDetailView();
        } catch (err: any) {
            logger.error(`加载邮件内容失败: ${err}`);
            this.errorText = `加载邮件失败: ${err?.message || '未知错误'}`;
            this.buildEmailList();
        }
    }

    /**
     * 详情视图布局：
     *   Box top padding         1
     *   DetailHeaderBar          3
     *   空行                     1
     *   EmailMetadata            metaH (动态计算)
     *   空行                     1
     *   SeparatorLine(─)         1
     *   ScrollableEmailBody      ← 弹性区域（含滚动条指示）
     *   SeparatorLine(━)         1
     *   DetailFooter             1
     *   Box bottom padding       1
     *   ──────────────────────────
     *   固定合计(不含 meta/body): 10
     */
    private buildDetailView() {
        this.state = 'detail';
        this.detailScrollOffset = 0;

        // 不再使用 SelectList，键盘快捷键直接处理操作
        this.detailList = undefined;
        // 取消焦点（所有按键由 handleInput 拦截）
        this.openDeskTUI.tui.setFocus(null);

        this.openDeskTUI.tui.requestRender();
    }

    private computeMetadataLineCount(): number {
        if (!this.selectedEmail) return 0;
        let count = 4; // subject + blank + from + to
        if (this.selectedEmail.cc && this.selectedEmail.cc.length > 0) count++;
        if (this.selectedEmail.bcc && this.selectedEmail.bcc.length > 0) count++;
        count++; // date
        if (this.selectedEmailContent?.attachments && this.selectedEmailContent.attachments.length > 0) count++;
        return count;
    }

    private async handleDetailAction(action: string) {
        if (!this.selectedEmail) return;

        switch (action) {
            case 'back':
                this.buildEmailList();
                break;
            case 'reply':
                this.startCompose('reply');
                break;
            case 'replyall':
                this.startCompose('replyall');
                break;
            case 'mark-read':
                await callMailWorker('markEmailAsRead', this.selectedEmail.uid);
                this.selectedEmail.unread = false;
                this.buildDetailView();
                break;
            case 'mark-unread':
                await callMailWorker('markEmailAsUnread', this.selectedEmail.uid);
                this.selectedEmail.unread = true;
                this.buildDetailView();
                break;
            case 'star': {
                const newStarred = !this.selectedEmail.starred;
                await callMailWorker('starEmail', { uid: this.selectedEmail.uid, starred: newStarred });
                this.selectedEmail.starred = newStarred;
                this.buildDetailView();
                break;
            }
            case 'delete':
                await callMailWorker('deleteEmail', this.selectedEmail.uid);
                this.emails = this.emails.filter(e => e.uid !== this.selectedEmail!.uid);
                this.selectedEmail = undefined;
                this.selectedEmailContent = undefined;
                this.buildEmailList();
                break;
        }
    }

    // ──────────────────── 滚动 ────────────────────

    private scrollDetailBody(delta: number) {
        // bodyArea = visibleLines - 1（ScrollableEmailBody 留了 1 行给滚动指示器）
        const bodyArea = Math.max(1, this.detailBodyVisibleLines - 1);
        const maxOffset = Math.max(0, this.detailBodyTotalLines - bodyArea);
        this.detailScrollOffset = Math.max(0, Math.min(this.detailScrollOffset + delta, maxOffset));
        this.openDeskTUI.tui.requestRender();
    }

    // ──────────────────── 操作方法 ────────────────────

    private async switchFilter(filter: FilterType) {
        if (this.currentFilter === filter) return;
        this.currentFilter = filter;
        await this.loadEmails();
    }

    private async syncEmails() {
        if (this.isSyncing) return;
        this.isSyncing = true;
        this.openDeskTUI.tui.requestRender();

        try {
            await callMailWorker('syncEmails');
            await this.loadEmails();
        } catch (err: any) {
            logger.error(`同步邮件失败: ${err}`);
        } finally {
            this.isSyncing = false;
            this.openDeskTUI.tui.requestRender();
        }
    }

    private async cycleAccount() {
        if (this.accounts.length <= 1) return;

        const currentIdx = this.accounts.findIndex((a: any) => a.email === this.currentAccount?.email);
        const nextIdx = (currentIdx + 1) % this.accounts.length;
        const nextAccount = this.accounts[nextIdx];

        try {
            await callMailWorker('switchAccount', nextAccount.email);
            this.currentAccount = nextAccount;
            await this.loadEmails();
        } catch (err: any) {
            logger.error(`切换账号失败: ${err}`);
        }
    }

    // ──────────────────── 撰写/回复邮件 ────────────────────

    private startCompose(type: ComposeType) {
        if (type !== 'new' && !this.selectedEmail) return;

        this.composeType = type;
        this.errorText = undefined;
        this.isAiGenerating = false;
        this.composeSending = false;
        this.aiSpinnerFrame = 0;

        // 创建 Input 字段
        this.composeToInput = new Input();
        this.composeSubjectInput = new Input();
        this.composeCcInput = undefined;

        if (type === 'reply' && this.selectedEmail) {
            this.composeToInput.setValue(this.selectedEmail.from?.[0]?.address || '');
            this.composeSubjectInput.setValue('答复: ' + (this.selectedEmail.subject || ''));
        } else if (type === 'replyall' && this.selectedEmail) {
            const currentEmail = this.currentAccount?.email || '';
            const toAddresses = [
                this.selectedEmail.from?.[0]?.address,
                ...(this.selectedEmail.to || []).filter(a => a.address !== currentEmail).map(a => a.address),
            ].filter(Boolean);
            this.composeToInput.setValue(toAddresses.join(', '));
            this.composeCcInput = new Input();
            this.composeCcInput.setValue((this.selectedEmail.cc || []).map(a => a.address).join(', '));
            this.composeSubjectInput.setValue('答复全部: ' + (this.selectedEmail.subject || ''));
        } else {
            // 'new' — 空白邮件
            this.composeToInput.setValue('');
            this.composeSubjectInput.setValue('');
        }

        // 创建 Editor
        this.composeEditor = new Editor(this.openDeskTUI.tui, {
            ...defaultEditorTheme,
            borderColor: () => '',
        });
        this.composeEditor.setText('');

        this.state = 'compose';

        // 新邮件焦点从收件人开始；回复焦点直接到编辑器
        if (type === 'new') {
            this.composeFocusIdx = 0;
            this.openDeskTUI.tui.setFocus(this.composeToInput);
        } else {
            this.setComposeFocusToEditor();
        }
        this.openDeskTUI.tui.requestRender();
    }

    private async sendComposedEmail() {
        if (this.composeSending || !this.composeEditor) return;
        const to = this.composeToInput?.getValue()?.trim() || '';
        const cc = this.composeCcInput?.getValue()?.trim() || '';
        const subject = this.composeSubjectInput?.getValue()?.trim() || '';
        const body = this.composeEditor.getText().trim();
        if (!to) {
            this.errorText = '请填写收件人地址';
            this.openDeskTUI.tui.requestRender();
            return;
        }

        this.composeSending = true;
        this.openDeskTUI.tui.requestRender();

        try {
            await callMailWorker('sendEmail', {
                to,
                cc,
                bcc: '',
                subject,
                text: body,
                html: '',
                attachments: [],
            });

            this.exitCompose();
        } catch (err: any) {
            logger.error(`发送邮件失败: ${err}`);
            this.composeSending = false;
            this.errorText = `发送失败: ${err?.message || '未知错误'}`;
            this.openDeskTUI.tui.requestRender();
        }
    }

    private startAiSpinner() {
        this.aiSpinnerFrame = 0;
        this.aiSpinnerTimer = setInterval(() => {
            this.aiSpinnerFrame++;
            this.openDeskTUI.tui.requestRender();
        }, 120);
    }

    private stopAiSpinner() {
        if (this.aiSpinnerTimer) {
            clearInterval(this.aiSpinnerTimer);
            this.aiSpinnerTimer = undefined;
        }
    }

    private async aiGenerateReply() {
        if (this.isAiGenerating || !this.composeEditor) return;

        this.isAiGenerating = true;
        this.openDeskTUI.tui.setFocus(null);
        this.startAiSpinner();
        this.openDeskTUI.tui.requestRender();

        try {
            const subject = this.composeSubjectInput?.getValue() || '';
            const to = this.composeToInput?.getValue() || '';

            let originalBody = '';
            if (this.selectedEmailContent) {
                if (this.selectedEmailContent.textContent) {
                    originalBody = this.selectedEmailContent.textContent;
                } else if (this.selectedEmailContent.htmlContent) {
                    originalBody = stripHtml(this.selectedEmailContent.htmlContent);
                }
            }
            const maxBodyLen = 2000;
            if (originalBody.length > maxBodyLen) {
                originalBody = originalBody.slice(0, maxBodyLen) + '\n...(内容已截断)';
            }

            let prompt: string;
            if (this.selectedEmail && this.composeType !== 'new') {
                prompt = [
                    '你是一个邮件助手。请帮我撰写一封回复邮件。',
                    '直接给出回复的正文内容（纯文本），不需要包含邮件头（收件人、主题等），不需要 markdown 格式。',
                    '',
                    '原始邮件信息：',
                    `发件人: ${formatAddresses(this.selectedEmail.from)}`,
                    `主题: ${this.selectedEmail.subject || '(无主题)'}`,
                    `日期: ${new Date(this.selectedEmail.date).toLocaleString()}`,
                    '',
                    '原始邮件内容：',
                    originalBody,
                ].join('\n');
            } else {
                prompt = [
                    '你是一个邮件助手。请帮我撰写一封邮件。',
                    '直接给出邮件的正文内容（纯文本），不需要包含邮件头（收件人、主题等），不需要 markdown 格式。',
                    '',
                    `收件人: ${to || '(未指定)'}`,
                    `主题: ${subject || '(未指定)'}`,
                ].join('\n');
            }

            const reply = await LLM.ask(new UserMessage(prompt));
            if (this.composeEditor && this.state === 'compose') {
                this.composeEditor.setText(reply.trim());
            }
        } catch (err: any) {
            logger.error(`AI 生成回复失败: ${err}`);
            this.errorText = `AI 生成失败: ${err?.message || '未知错误'}`;
        } finally {
            this.isAiGenerating = false;
            this.stopAiSpinner();
            if (this.state === 'compose') {
                this.setComposeFocusToEditor();
            }
            this.openDeskTUI.tui.requestRender();
        }
    }

    // ──────────────────── 渲染（精确填满屏幕） ────────────────────

    render(width: number): string[] {
        const targetHeight = this.openDeskTUI.tui.terminal.rows;
        // Box padding: top 1 + bottom 1 = 2
        const availableForContent = targetHeight - 2;

        this.box.clear();

        switch (this.state) {
            case 'loading':
                this.box.addChild(new MailHeaderBar(this.currentAccount, this.isSyncing));
                this.box.addChild(new VerticalFiller(this.loadingText, availableForContent - 3));
                break;

            case 'list': {
                this.box.addChild(new MailHeaderBar(this.currentAccount, this.isSyncing));  // 3
                this.box.addChild(new Text(''));                                             // 1
                this.box.addChild(new FilterTabsBar(this.currentFilter));                   // 1
                this.box.addChild(new SeparatorLine());                                     // 1
                if (this.errorText) {
                    this.box.addChild(new Text(MC.red(`  ⚠ ${this.errorText}`)));           // 1
                }
                if (this.emailList) {
                    this.box.addChild(this.emailList);                                      // flex
                }
                this.box.addChild(new Text(''));                                             // 1
                this.box.addChild(new ListFooter(this.accounts.length > 1));                // 1
                break;
            }

            case 'detail': {
                const metaH = this.computeMetadataLineCount();
                // fixed = header(3) + blank(1) + meta(metaH) + blank(1) + sep(1) + sep(1) + footer(1)
                const fixedDetailLines = 3 + 1 + metaH + 1 + 1 + 1 + 1;
                const bodyLines = Math.max(3, availableForContent - fixedDetailLines);

                this.box.addChild(new DetailHeaderBar());                                   // 3
                this.box.addChild(new Text(''));                                             // 1
                if (this.selectedEmail && this.selectedEmailContent) {
                    this.box.addChild(new EmailMetadata(this.selectedEmail, this.selectedEmailContent));
                    this.box.addChild(new Text(''));                                         // 1
                    this.box.addChild(new SeparatorLine('─'));                               // 1

                    const bodyView = new ScrollableEmailBody(
                        this.selectedEmailContent, bodyLines, this.detailScrollOffset
                    );
                    this.box.addChild(bodyView);

                    // 更新总行数供滚动逻辑使用
                    this.detailBodyTotalLines = bodyView.getTotalLines();
                    this.detailBodyVisibleLines = bodyLines;
                }
                this.box.addChild(new SeparatorLine());                                     // 1
                this.box.addChild(new DetailFooter(
                    this.detailScrollOffset,
                    this.detailBodyTotalLines,
                    this.detailBodyVisibleLines,
                    this.selectedEmail,
                ));                                                                          // 1
                break;
            }

            case 'compose': {
                // 撰写视图布局：
                //   Box top padding        1
                //   ComposeHeaderBar        3
                //   ComposeField (收件人)   1
                //   ComposeField (抄送)?    0|1
                //   ComposeField (主题)     1
                //   SeparatorLine(─)        1
                //   error (可选)            0|1
                //   Editor/SpinnerView      ← 弹性区域
                //   SeparatorLine(━)        1
                //   ComposeFooterBar        1
                //   Box bottom padding      1
                const fields = this.getComposeFocusFields();
                const fieldLineCount = this.composeCcInput ? 3 : 2;
                const hasError = this.errorText ? 1 : 0;
                const composeFixed = 3 + fieldLineCount + 1 + hasError + 1 + 1;
                const editorLines = Math.max(3, availableForContent - composeFixed);

                const typeLabel = this.composeType === 'new' ? '写信'
                    : this.composeType === 'replyall' ? '回复全部'
                        : '回复邮件';
                this.box.addChild(new ComposeHeaderBar(typeLabel, this.composeSending, this.isAiGenerating));
                if (this.composeToInput) {
                    this.box.addChild(new ComposeField('收件人', this.composeToInput, fields[this.composeFocusIdx] === this.composeToInput));
                }
                if (this.composeCcInput) {
                    this.box.addChild(new ComposeField('抄  送', this.composeCcInput, fields[this.composeFocusIdx] === this.composeCcInput));
                }
                if (this.composeSubjectInput) {
                    this.box.addChild(new ComposeField('主  题', this.composeSubjectInput, fields[this.composeFocusIdx] === this.composeSubjectInput));
                }
                this.box.addChild(new SeparatorLine('─'));
                if (this.errorText) {
                    this.box.addChild(new Text(MC.red(`  ⚠ ${this.errorText}`)));
                }
                if (this.isAiGenerating) {
                    this.box.addChild(new SpinnerView('AI 正在帮你撰写...', this.aiSpinnerFrame, editorLines));
                } else if (this.composeEditor) {
                    this.box.addChild(new EditorWrapper(this.composeEditor, editorLines));
                }
                this.box.addChild(new SeparatorLine());
                this.box.addChild(new ComposeFooterBar());
                break;
            }
        }

        // 安全截断：清洗控制字符（TAB→空格）后再截断，防止 visibleWidth 与实际渲染宽度不一致
        return this.box.render(width).map(l => truncateToWidth(sanitizeLine(l), width, '', true));
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 子组件 —— 纯渲染
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class MailHeaderBar implements Component {
    constructor(private account: any, private syncing: boolean) { }
    invalidate() { }
    render(width: number): string[] {
        const bar = MC.ghost('━'.repeat(width));

        const logo = MC.neonBold('◈');
        const title = MC.neonBold(' OPENDESK MAIL');
        const syncTag = this.syncing ? MC.neon(' ⟳ 同步中') : '';

        const accountName = this.account
            ? MC.dim(this.account.name || this.account.email)
            : MC.dim('未配置账号');

        const leftPart = `  ${logo}${title}${syncTag}`;
        const leftVis = visibleWidth(leftPart);
        const rightVis = visibleWidth(accountName);
        const gap = Math.max(1, width - leftVis - rightVis);

        let titleLine: string;
        if (leftVis + rightVis >= width) {
            titleLine = truncateToWidth(leftPart, width, '…');
        } else {
            titleLine = leftPart + ' '.repeat(gap) + accountName;
        }

        return [bar, truncateToWidth(titleLine, width, '…'), bar];
    }
}

class DetailHeaderBar implements Component {
    invalidate() { }
    render(width: number): string[] {
        const bar = MC.ghost('━'.repeat(width));
        const logo = MC.neonBold('◈');
        const title = MC.neonBold(' 邮件详情');
        const hint = MC.dim('ESC 返回');
        const leftPart = `  ${logo}${title}`;
        const leftVis = visibleWidth(leftPart);
        const rightVis = visibleWidth(hint);
        const gap = Math.max(1, width - leftVis - rightVis);

        let titleLine: string;
        if (leftVis + rightVis >= width) {
            titleLine = truncateToWidth(leftPart, width, '…');
        } else {
            titleLine = leftPart + ' '.repeat(gap) + hint;
        }

        return [bar, truncateToWidth(titleLine, width, '…'), bar];
    }
}

class FilterTabsBar implements Component {
    constructor(private current: FilterType) { }
    invalidate() { }
    render(width: number): string[] {
        const tabs = FILTERS.map(f => {
            if (f.value === this.current) {
                return MC.neonBold(`[${f.key}:${f.label}]`);
            }
            return MC.ghost(`[${f.key}:${f.label}]`);
        });
        return [truncateToWidth('  ' + tabs.join('  '), width, '…')];
    }
}

class SeparatorLine implements Component {
    constructor(private char: string = '━') { }
    invalidate() { }
    render(width: number): string[] {
        return [MC.ghost(this.char.repeat(width))];
    }
}

/** 加载状态占位：垂直居中显示加载文字，精确填满指定行数 */
class VerticalFiller implements Component {
    constructor(private text: string, private totalLines: number) { }
    invalidate() { }
    render(_width: number): string[] {
        const lines: string[] = [];
        const padTop = Math.max(0, Math.floor(this.totalLines / 2));
        for (let i = 0; i < padTop; i++) lines.push('');
        lines.push(MC.neon(`  ⟳ ${this.text}`));
        const remaining = this.totalLines - padTop - 1;
        for (let i = 0; i < remaining; i++) lines.push('');
        return lines;
    }
}

class ListFooter implements Component {
    constructor(private multiAccount: boolean) { }
    invalidate() { }
    render(width: number): string[] {
        const hints = [
            MC.neon('↑↓') + MC.dim(' 选择'),
            MC.neon('Enter') + MC.dim(' 查看'),
            MC.neon('c') + MC.dim(' 写信'),
            MC.neon('1-5') + MC.dim(' 筛选'),
            MC.neon('s') + MC.dim(' 同步'),
        ];
        if (this.multiAccount) {
            hints.push(MC.neon('a') + MC.dim(' 切换账号'));
        }
        hints.push(MC.neon('ESC') + MC.dim(' 关闭'));
        return [truncateToWidth('  ' + hints.join('   '), width, '…')];
    }
}

class EmailMetadata implements Component {
    constructor(private email: EmailHeader, private content: EmailContent) { }
    invalidate() { }
    render(width: number): string[] {
        const lines: string[] = [];
        const e = this.email;

        lines.push(truncateToWidth(`  ${e.subject || '(无主题)'}`, width, '…'));
        lines.push('');

        const metaLine = (label: string, value: string) => {
            const styledLabel = MC.dim(label + '  ');
            const labelVis = visibleWidth(styledLabel);
            const valueW = Math.max(10, width - labelVis - 2);
            return truncateToWidth(`  ${styledLabel}${value}`, width, '…');
        };

        lines.push(metaLine('发件人', formatAddresses(e.from)));
        lines.push(metaLine('收件人', formatAddresses(e.to)));

        if (e.cc && e.cc.length > 0) {
            lines.push(metaLine('抄  送', formatAddresses(e.cc)));
        }
        if (e.bcc && e.bcc.length > 0) {
            lines.push(metaLine('密  送', formatAddresses(e.bcc)));
        }

        lines.push(metaLine('日  期', new Date(e.date).toLocaleString()));

        if (this.content?.attachments && this.content.attachments.length > 0) {
            const names = this.content.attachments.map(a => a.filename).join(', ');
            lines.push(metaLine('附  件', MC.amber(names)));
        }

        return lines;
    }
}

// ━━━ 撰写子组件 ━━━

class ComposeHeaderBar implements Component {
    constructor(private label: string, private sending: boolean, private aiGen: boolean) { }
    invalidate() { }
    render(width: number): string[] {
        const bar = MC.ghost('━'.repeat(width));
        const logo = MC.neonBold('◈');
        const title = MC.neonBold(` ${this.label}`);
        let statusTag = '';
        if (this.sending) statusTag = MC.amber(' ⟳ 发送中...');
        else if (this.aiGen) statusTag = MC.neon(' ✨ AI 生成中...');

        const leftPart = `  ${logo}${title}${statusTag}`;
        const hint = MC.dim('ESC 取消');
        const leftVis = visibleWidth(leftPart);
        const rightVis = visibleWidth(hint);
        const gap = Math.max(1, width - leftVis - rightVis);

        let titleLine: string;
        if (leftVis + rightVis >= width) {
            titleLine = truncateToWidth(leftPart, width, '…');
        } else {
            titleLine = leftPart + ' '.repeat(gap) + hint;
        }
        return [bar, truncateToWidth(titleLine, width, '…'), bar];
    }
}

/** 撰写字段：标签 + Input 内联渲染 */
class ComposeField implements Component {
    constructor(private label: string, private input: Input, private active: boolean) { }
    invalidate() { this.input.invalidate(); }
    render(width: number): string[] {
        const prefix = `  ${MC.dim(this.label + '  ')}`;
        const prefixVis = visibleWidth(prefix);
        const inputW = Math.max(10, width - prefixVis);
        if (this.active) {
            const inputOut = this.input.render(inputW);
            const line = prefix + (inputOut[0] || '');
            return [truncateToWidth(line, width, '…')];
        }
        return [truncateToWidth(prefix + MC.text(this.input.getValue()), width, '…')];
    }
}

const SPINNER_CHARS = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

/** AI 生成中的 Spinner 占位视图 */
class SpinnerView implements Component {
    constructor(private text: string, private frame: number, private maxLines: number) { }
    invalidate() { }
    render(_width: number): string[] {
        const char = SPINNER_CHARS[this.frame % SPINNER_CHARS.length];
        const lines: string[] = [];
        const padTop = Math.max(0, Math.floor((this.maxLines - 1) / 2));
        for (let i = 0; i < padTop; i++) lines.push('');
        lines.push(MC.neon(`  ${char} ${this.text}`));
        while (lines.length < this.maxLines) lines.push('');
        return lines;
    }
}

class ComposeFooterBar implements Component {
    invalidate() { }
    render(width: number): string[] {
        const hints = [
            MC.neon('Tab') + MC.dim(' 切换字段'),
            MC.neon('Ctrl+S') + MC.dim(' 发送'),
            MC.neon('Ctrl+W') + MC.dim(' 帮我写'),
            MC.neon('ESC') + MC.dim(' 取消'),
        ];
        return [truncateToWidth('  ' + hints.join('   '), width, '…')];
    }
}

/** 包装 Editor 组件，精确输出 maxLines 行 */
class EditorWrapper implements Component {
    constructor(private editor: Editor, private maxLines: number) { }
    invalidate() { this.editor.invalidate(); }
    render(width: number): string[] {
        const editorLines = this.editor.render(width);
        const result = editorLines.slice(0, this.maxLines);
        while (result.length < this.maxLines) {
            result.push('');
        }
        return result;
    }
}

/**
 * 可滚动的邮件正文视图。
 * 将邮件文本按行拆分后，根据 scrollOffset 显示一个窗口。
 * 支持 ↑↓/j/k 逐行滚动、PgUp/PgDn/Space/b 翻页、g/G 首尾跳转。
 */
class ScrollableEmailBody implements Component {
    private allLines: string[] = [];

    constructor(
        private content: EmailContent,
        private visibleLines: number,
        private scrollOffset: number,
    ) {
        this.allLines = this.prepareLines();
    }

    invalidate() { }

    /** 预处理：将邮件内容拆成纯文本行数组 */
    private prepareLines(): string[] {
        let bodyText: string;
        if (this.content.textContent) {
            bodyText = sanitizeLine(this.content.textContent);
        } else if (this.content.htmlContent) {
            bodyText = sanitizeLine(stripHtml(this.content.htmlContent));
        } else {
            bodyText = '(邮件内容为空)';
        }
        return bodyText.split('\n');
    }

    /** 外部可获取总行数，用于更新 MailOverlay 的滚动状态 */
    getTotalLines(): number {
        return this.allLines.length;
    }

    render(width: number): string[] {
        const total = this.allLines.length;
        const cap = Math.max(1, this.visibleLines);

        // 如果内容不超过可视区域，无需滚动
        if (total <= cap) {
            const result: string[] = [];
            for (const rawLine of this.allLines) {
                const line = sanitizeLine(rawLine);
                result.push(MC.text(truncateToWidth('  ' + line, width - 2, '…')));
            }
            while (result.length < cap) {
                result.push('');
            }
            return result;
        }

        // 有滚动：留出 1 行给滚动指示器
        const bodyArea = cap - 1;
        const offset = Math.max(0, Math.min(this.scrollOffset, total - bodyArea));
        const display = this.allLines.slice(offset, offset + bodyArea);

        const result: string[] = [];
        for (const rawLine of display) {
            const line = sanitizeLine(rawLine);
            result.push(MC.text(truncateToWidth('  ' + line, width - 2, '…')));
        }

        // 补齐 bodyArea 行
        while (result.length < bodyArea) {
            result.push('');
        }

        // 滚动指示器
        const progress = total > bodyArea
            ? Math.round((offset / (total - bodyArea)) * 100)
            : 100;
        const scrollBar = this.renderScrollBar(width - 6, bodyArea, total, offset);
        const indicator = MC.dim(`  ${scrollBar}  ${progress}%  (${offset + 1}-${Math.min(offset + bodyArea, total)}/${total}行)`);
        result.push(truncateToWidth(indicator, width, '…'));

        return result;
    }

    /** 渲染一个迷你横向滚动条 */
    private renderScrollBar(barWidth: number, visible: number, total: number, offset: number): string {
        const w = Math.max(4, Math.min(barWidth, 30));
        const thumbSize = Math.max(1, Math.round((visible / total) * w));
        const maxThumbPos = w - thumbSize;
        const thumbPos = total <= visible ? 0 : Math.round((offset / (total - visible)) * maxThumbPos);

        let bar = '';
        for (let i = 0; i < w; i++) {
            if (i >= thumbPos && i < thumbPos + thumbSize) {
                bar += MC.neon('█');
            } else {
                bar += MC.ghost('░');
            }
        }
        return bar;
    }
}

/** 详情视图底部操作提示栏 */
class DetailFooter implements Component {
    constructor(
        private scrollOffset: number,
        private totalLines: number,
        private visibleLines: number,
        private email?: EmailHeader,
    ) { }
    invalidate() { }
    render(width: number): string[] {
        const hints: string[] = [];

        // 滚动提示（仅在有溢出时显示）
        if (this.totalLines > this.visibleLines) {
            hints.push(MC.neon('↑↓/jk') + MC.dim(' 滚动'));
            hints.push(MC.neon('Space/b') + MC.dim(' 翻页'));
            hints.push(MC.neon('g/G') + MC.dim(' 首/尾'));
        }

        // 操作提示
        hints.push(MC.neon('r') + MC.dim(' 回复'));
        hints.push(MC.neon('R') + MC.dim(' 全部回复'));
        if (this.email) {
            hints.push(MC.neon('f') + MC.dim(this.email.starred ? ' 取消收藏' : ' 收藏'));
        }
        hints.push(MC.neon('d') + MC.dim(' 删除'));
        hints.push(MC.neon('q/ESC') + MC.dim(' 返回'));

        return [truncateToWidth('  ' + hints.join('   '), width, '…')];
    }
}
