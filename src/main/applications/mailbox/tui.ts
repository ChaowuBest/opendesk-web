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
import { UserMessage, ChatContext, AssistantMessage, AssistantResponse, SystemMessage, ToolCall } from "../../aikernel/messages.js";
import { BaseTool, BaseToolset } from "../../aikernel/tool.js";
import { ToolCallView, ToolCallMessagePartView } from "../../tui/components/taskview.js";
import { logger } from "../../utils/logger.js";
import chalk from "chalk";
import { z } from "zod";
import { jsonrepair } from "jsonrepair";


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

type MailViewState = 'loading' | 'list' | 'detail' | 'compose' | 'assistant' | 'assistant-result' | 'search' | 'search-list';
type FilterType = 'all' | 'unread' | 'starred' | 'draft' | 'sent';
type ComposeType = 'reply' | 'replyall' | 'new' | 'forward';

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

// ━━━ 邮件助手工具（供模型调用） ━━━

const GetEmailListArgsSchema = z.object({
    offset: z.number().optional().describe('从第几条开始，默认 0'),
    limit: z.number().optional().describe('最多返回条数，默认 20'),
});
const getEmailListTool = new BaseTool(
    'getEmailList',
    '获取当前邮箱的邮件列表。返回每封邮件的 uid、主题、发件人、日期、是否未读等，用于列举或查找邮件。',
    GetEmailListArgsSchema,
);
getEmailListTool.setExecutor(async (args) => {
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 20;
    const data = await callMailWorker('getEmailHeaderList', offset, limit);
    const emails: EmailHeader[] = Array.isArray(data) ? data : [];
    if (emails.length === 0) {
        return JSON.stringify({ total: 0, emails: [], message: '暂无邮件' });
    }
    const items = emails.map((e: EmailHeader) => ({
        uid: e.uid,
        subject: e.subject || '(无主题)',
        from: formatSender(e.from),
        date: new Date(e.date).toISOString(),
        unread: e.unread,
        starred: e.starred,
        type: e.type,
    }));
    return JSON.stringify({ total: items.length, emails: items });
});

const GetEmailContentArgsSchema = z.object({
    uid: z.string().describe('邮件唯一标识 uid，从 getEmailList 或 searchEmails 结果中获取'),
});
const getEmailContentTool = new BaseTool(
    'getEmailContent',
    '获取指定 uid 的邮件完整内容（主题、发件人、收件人、日期、正文纯文本）。用于查看邮件详情或做摘要。',
    GetEmailContentArgsSchema,
);
getEmailContentTool.setExecutor(async (args) => {
    const content = await callMailWorker('getEmailContent', args.uid);
    if (!content) {
        return JSON.stringify({ error: '未找到该邮件' });
    }
    const text = (content.textContent && content.textContent.trim()) || stripHtml(content.htmlContent || '');
    return JSON.stringify({
        uid: args.uid,
        textContent: text.slice(0, 5000),
        fullLength: text.length,
    });
});

const SearchEmailsArgsSchema = z.object({
    subject: z.string().optional().describe('按主题关键词搜索（模糊匹配）'),
    general: z.string().optional().describe('在主题、发件人、正文中搜索的关键词'),
    limit: z.number().optional().describe('最多返回条数，默认 50'),
    offset: z.number().optional().describe('跳过前 N 条'),
});
const searchEmailsTool = new BaseTool(
    'searchEmails',
    '按条件搜索邮件。可按主题(subject)、或通用关键词(general)在主题/发件人/正文中搜索。返回与 getEmailList 相同结构的列表。',
    SearchEmailsArgsSchema,
);
searchEmailsTool.setExecutor(async (args) => {
    const query: any = { limit: args.limit ?? 50, offset: args.offset ?? 0 };
    if (args.subject) query.subject = args.subject;
    if (args.general) query.general = args.general;
    const data = await callMailWorker('searchEmails', query);
    const emails: EmailHeader[] = Array.isArray(data) ? data : [];
    const items = emails.map((e: EmailHeader) => ({
        uid: e.uid,
        subject: e.subject || '(无主题)',
        from: formatSender(e.from),
        date: new Date(e.date).toISOString(),
        unread: e.unread,
        starred: e.starred,
        type: e.type,
    }));
    return JSON.stringify({ total: items.length, emails: items });
});

const mailAssistantToolset = new BaseToolset('mailbox');
mailAssistantToolset.addTools(getEmailListTool, getEmailContentTool, searchEmailsTool);

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

    // 分页加载相关
    private currentOffset = 0;
    private pageSize = 100;
    private initialPageSize = 50;
    private hasMoreEmails = true;
    private isLoadingMore = false;

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
    /** 回复时的原始邮件引用文本（不放入编辑器，单独渲染在编辑器下方） */
    private composeQuotedText?: string;
    /** 回复时引用区域的滚动偏移 */
    private composeQuoteScrollOffset = 0;

    // 助手模式
    private assistantPromptInput?: Input;
    private assistantResult = '';
    private assistantBusy = false;
    private assistantResultScrollOffset = 0;
    private assistantResultTotalLines = 0;
    private assistantResultVisibleLines = 0;
    private assistantToolCalls: any[] = [];
    private chatContext?: ChatContext;
    private conversationHistory: string = '';

    // 搜索模式
    private isInSearchMode = false;
    private searchQuery = '';
    private searchResults: EmailHeader[] = [];
    private originalEmails: EmailHeader[] = [];
    private searchInput?: Input;

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
            // 当焦点在 Editor 上，Enter 换行（默认 Enter 是 submit，需要转换为 \n 让 Editor 插入新行）
            if (matchesKey(data, Key.enter)) {
                const fields = this.getComposeFocusFields();
                if (fields[this.composeFocusIdx] === this.composeEditor && this.composeEditor) {
                    this.composeEditor.handleInput('\n');
                    this.openDeskTUI.tui.requestRender();
                    return { consume: true };
                }
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
            // w 转发
            if (data === 'w' || data === 'W') {
                this.startCompose('forward');
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
                this.buildEmailList(this.isInSearchMode);
                return { consume: true };
            }
            return { consume: true }; // 详情视图消费所有按键，避免穿透
        }

        if (this.state === 'list' || this.state === 'search-list') {
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
            if (data === 'p' || data === 'P') {
                this.enterAssistantMode();
                return { consume: true };
            }
            if (data === 'l' || data === 'L') {
                this.enterSearchMode();
                return { consume: true };
            }
            if (this.state === 'search-list' && matchesKey(data, Key.escape)) {
                this.exitSearchMode();
                return { consume: true };
            }
        }

        if (this.state === 'search') {
            if (matchesKey(data, Key.escape)) {
                this.exitSearchMode();
                return { consume: true };
            }
            if (matchesKey(data, Key.enter)) {
                const query = this.searchInput?.getValue()?.trim() || '';
                if (query) {
                    this.searchQuery = query;
                    this.executeSearch();
                }
                return { consume: true };
            }
            return undefined;
        }

        if (this.state === 'assistant') {
            // 滚动控制
            if (data === 'j' || data === 'J' || matchesKey(data, Key.down)) {
                this.scrollAssistantResult(1);
                return { consume: true };
            }
            if (data === 'k' || data === 'K' || matchesKey(data, Key.up)) {
                this.scrollAssistantResult(-1);
                return { consume: true };
            }
            if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) {
                this.scrollAssistantResult(Math.max(1, this.assistantResultVisibleLines - 2));
                return { consume: true };
            }
            if (matchesKey(data, Key.pageUp) || data === 'b' || data === 'B') {
                this.scrollAssistantResult(-(Math.max(1, this.assistantResultVisibleLines - 2)));
                return { consume: true };
            }
            if (matchesKey(data, Key.home) || data === 'g') {
                this.assistantResultScrollOffset = 0;
                this.openDeskTUI.tui.requestRender();
                return { consume: true };
            }
            if (matchesKey(data, Key.end) || data === 'G') {
                const bodyArea = Math.max(1, this.assistantResultVisibleLines - 1);
                this.assistantResultScrollOffset = Math.max(0, this.assistantResultTotalLines - bodyArea);
                this.openDeskTUI.tui.requestRender();
                return { consume: true };
            }
            
            if (matchesKey(data, Key.escape)) {
                this.exitAssistantMode();
                return { consume: true };
            }
            if (matchesKey(data, Key.enter)) {
                const query = this.assistantPromptInput?.getValue()?.trim() || '';
                if (query) {
                    this.runAssistant(query);
                }
                return { consume: true };
            }
            return undefined;
        }

        if (this.state === 'assistant-result') {
            // 滚动控制
            if (data === 'j' || data === 'J' || matchesKey(data, Key.down)) {
                this.scrollAssistantResult(1);
                return { consume: true };
            }
            if (data === 'k' || data === 'K' || matchesKey(data, Key.up)) {
                this.scrollAssistantResult(-1);
                return { consume: true };
            }
            if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.space)) {
                this.scrollAssistantResult(Math.max(1, this.assistantResultVisibleLines - 2));
                return { consume: true };
            }
            if (matchesKey(data, Key.pageUp) || data === 'b' || data === 'B') {
                this.scrollAssistantResult(-(Math.max(1, this.assistantResultVisibleLines - 2)));
                return { consume: true };
            }
            if (matchesKey(data, Key.home) || data === 'g') {
                this.assistantResultScrollOffset = 0;
                this.openDeskTUI.tui.requestRender();
                return { consume: true };
            }
            if (matchesKey(data, Key.end) || data === 'G') {
                const bodyArea = Math.max(1, this.assistantResultVisibleLines - 1);
                this.assistantResultScrollOffset = Math.max(0, this.assistantResultTotalLines - bodyArea);
                this.openDeskTUI.tui.requestRender();
                return { consume: true };
            }
            // 只使用 ESC 键退出
            if (matchesKey(data, Key.escape)) {
                this.assistantResult = '';
                this.assistantResultScrollOffset = 0;
                this.chatContext = undefined; // 清理对话上下文
                if (this.isInSearchMode) {
                    this.state = 'search-list';
                    this.openDeskTUI.tui.setFocus(this.emailList!);
                } else {
                    this.buildEmailList();
                }
                return { consume: true };
            }
            // 其他键不退出，保持在结果页面
            return { consume: true };
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
        this.composeQuotedText = undefined;
        this.composeQuoteScrollOffset = 0;
        this.errorText = undefined;
        if (this.selectedEmail) {
            this.buildDetailView();
        } else {
            // 如果来自搜索模式，返回搜索结果列表
            if (this.isInSearchMode) {
                this.state = 'search-list';
                this.buildEmailList(true);
            } else {
                this.buildEmailList(false);
            }
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
        this.currentOffset = 0;
        this.hasMoreEmails = true;
        this.openDeskTUI.tui.requestRender();

        try {
            let data: any;
            if (this.currentFilter === 'all') {
                data = await callMailWorker('getEmailHeaderList', 0, this.initialPageSize);
            } else {
                const query = this.buildFilterQuery();
                query.limit = this.initialPageSize;
                query.offset = 0;
                data = await callMailWorker('searchEmails', query);
            }
            const emails: EmailHeader[] = Array.isArray(data) ? data : [];
            emails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
            this.emails = emails;
            this.currentOffset = this.initialPageSize;
            this.hasMoreEmails = emails.length >= this.initialPageSize;
            this.buildEmailList();
        } catch (err: any) {
            logger.error(`加载邮件失败: ${err}`);
            this.errorText = `加载失败: ${err?.message || '未知错误'}`;
            this.emails = [];
            this.buildEmailList();
        }
    }

    private async loadMoreEmails() {
        if (!this.hasMoreEmails || this.isLoadingMore) return;

        this.isLoadingMore = true;
        this.openDeskTUI.tui.requestRender();

        try {
            let data: any;
            if (this.currentFilter === 'all') {
                data = await callMailWorker('getEmailHeaderList', this.currentOffset, this.pageSize);
            } else {
                const query = this.buildFilterQuery();
                query.limit = this.pageSize;
                query.offset = this.currentOffset;
                data = await callMailWorker('searchEmails', query);
            }
            const newEmails: EmailHeader[] = Array.isArray(data) ? data : [];
            
            if (newEmails.length > 0) {
                this.emails.push(...newEmails);
                this.emails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
                this.currentOffset += newEmails.length;
                this.hasMoreEmails = newEmails.length >= this.pageSize;
                
                // 保存当前选中索引
                const currentIndex = (this.emailList as any)?.selectedIndex || 0;
                this.buildEmailList();
                
                // 恢复选中索引
                if (this.emailList && currentIndex >= 0) {
                    (this.emailList as any).selectedIndex = Math.min(currentIndex, this.emails.length - 1);
                }
            } else {
                this.hasMoreEmails = false;
            }
        } catch (err: any) {
            logger.error(`加载更多邮件失败: ${err}`);
        } finally {
            this.isLoadingMore = false;
            this.openDeskTUI.tui.requestRender();
        }
    }

    private buildFilterQuery(): any {
        switch (this.currentFilter) {
            case 'unread': return { unread: true, limit: this.initialPageSize, offset: 0 };
            case 'starred': return { starred: true, limit: this.initialPageSize, offset: 0 };
            case 'draft': return { type: 'draft', limit: this.initialPageSize, offset: 0 };
            case 'sent': return { type: 'sent', limit: this.initialPageSize, offset: 0 };
            default: return { limit: this.initialPageSize, offset: 0 };
        }
    }

    private parseSearchQuery(queryString: string): any {
        const query: any = { limit: 100, offset: 0 };
        const terms = queryString.split(/\s+/).filter(t => t.length > 0);

        for (const term of terms) {
            const match = term.match(/^(from|to|subject|body|date):(.+)$/i);
            if (match) {
                const [, field, value] = match;
                const normalizedField = field.toLowerCase();
                if (normalizedField === 'from') {
                    query.from = value;
                } else if (normalizedField === 'to') {
                    query.to = value;
                } else if (normalizedField === 'subject') {
                    query.subject = value;
                } else if (normalizedField === 'body') {
                    query.body = value;
                } else if (normalizedField === 'date') {
                    // 处理日期，支持单个日期或日期范围
                    if (value.includes('~')) {
                        const [startDate, endDate] = value.split('~').map(d => d.trim());
                        query.startDate = startDate;
                        query.endDate = endDate || startDate;
                    } else {
                        query.startDate = value;
                        query.endDate = value;
                    }
                }
            } else {
                // 无前缀的关键词，默认在主题和发件人中搜索
                if (!query.general) {
                    query.general = term;
                } else {
                    query.general += ' ' + term;
                }
            }
        }

        return query;
    }

    private async executeSearch() {
        this.state = 'loading';
        this.loadingText = '正在搜索邮件...';
        this.errorText = undefined;
        this.openDeskTUI.tui.requestRender();

        try {
            const searchQuery = this.parseSearchQuery(this.searchQuery);
            const data = await callMailWorker('searchEmails', searchQuery);
            const emails: EmailHeader[] = Array.isArray(data) ? data : [];
            emails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

            // 保存原始邮件列表以便退出搜索时恢复
            this.originalEmails = this.emails;
            this.searchResults = emails;
            this.emails = emails;

            this.buildEmailList(true);
        } catch (err: any) {
            logger.error(`搜索邮件失败：${err}`);
            this.errorText = `搜索失败：${err?.message || '未知错误'}`;
            this.emails = this.originalEmails.length > 0 ? this.originalEmails : [];
            // 返回初始列表时清除错误信息
            this.errorText = undefined;
            this.buildEmailList(false);
        }
    }

    private enterSearchMode() {
        this.isInSearchMode = true;
        this.searchQuery = '';
        this.searchInput = new Input();
        this.searchInput.setValue('');
        this.state = 'search';
        // 保存原始邮件列表用于退出搜索时恢复
        this.originalEmails = [...this.emails];
        this.openDeskTUI.tui.setFocus(this.searchInput);
        this.openDeskTUI.tui.requestRender();
    }

    private exitSearchMode() {
        this.isInSearchMode = false;
        this.searchQuery = '';
        this.searchInput = undefined;
        this.searchResults = [];

        // 恢复原始邮件列表
        if (this.originalEmails.length > 0) {
            this.emails = this.originalEmails;
            this.originalEmails = [];
        }

        this.state = 'list';
        this.buildEmailList(false);
        this.openDeskTUI.tui.setFocus(this.emailList!);
        this.openDeskTUI.tui.requestRender();
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
     *   [loading more]          0 | 1
     *   空行                    1
     *   ListFooter              1
     *   Box bottom padding      1
     *   ─────────────────────────
     *   固定合计(无error)       10
     */
    private buildEmailList(isSearchMode = false) {
        this.state = isSearchMode ? 'search-list' : 'list';

        const rows = this.openDeskTUI.tui.terminal.rows;
        const fixedLines = 10 + (this.errorText ? 1 : 0) + (this.isLoadingMore ? 1 : 0);
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
            if (isSearchMode) {
                this.exitSearchMode();
            } else {
                this.close();
            }
        };

        // 列表选择变化时强制全量重绘，避免差异更新导致表头/标签行重复堆叠
        this.emailList.onSelectionChange = () => {
            this.openDeskTUI.tui.requestRender(true);
            
            // 检测是否滚动到底部，触发加载更多
            if (this.hasMoreEmails && !this.isLoadingMore && this.emails.length > 0) {
                const selectedIndex = (this.emailList as any)?.selectedIndex || 0;
                const totalItems = this.emails.length;
                // 当滚动到倒数第3项时开始加载更多
                if (totalItems > 0 && selectedIndex >= totalItems - 3) {
                    this.loadMoreEmails().catch(err => {
                        logger.error(`自动加载更多邮件失败: ${err}`);
                    });
                }
            }
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
            // 如果来自搜索模式，返回搜索结果列表
            if (this.isInSearchMode) {
                this.state = 'search-list';
                this.buildEmailList(true);
            } else {
                // 返回初始列表时清除错误信息
                this.errorText = undefined;
                this.buildEmailList(false);
            }
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
        // 记录是否来自搜索模式，以便 ESC 返回搜索结果列表
        this.isInSearchMode = this.searchResults.length > 0;

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
                this.buildEmailList(this.isInSearchMode);
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

    private scrollAssistantResult(delta: number) {
        // bodyArea = visibleLines - 1（ScrollableEmailBody 留了 1 行给滚动指示器）
        const bodyArea = Math.max(1, this.assistantResultVisibleLines - 1);
        const maxOffset = Math.max(0, this.assistantResultTotalLines - bodyArea);
        this.assistantResultScrollOffset = Math.max(0, Math.min(this.assistantResultScrollOffset + delta, maxOffset));
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

    // ──────────────────── 助手模式 ────────────────────

    private enterAssistantMode() {
        this.assistantPromptInput = new Input();
        this.assistantPromptInput.setValue('');
        this.assistantResult = '';
        this.assistantBusy = false;
        this.assistantToolCalls = [];
        this.conversationHistory = ''; // 重置对话历史
        
        // 初始化或重置对话上下文
        this.chatContext = new ChatContext();
        this.chatContext.system_prompt = new SystemMessage(
            '你是邮件助手。用户会在 TUI 邮件界面中描述需求，例如：查找最近关于某主题的邮件、对某封邮件做摘要、列出最近 N 封邮件等。\n' +
            '你可以调用工具：\n' +
            '- mailbox-getEmailList: 获取邮件列表（offset, limit）\n' +
            '- mailbox-getEmailContent: 根据 uid 获取邮件正文\n' +
            '- mailbox-searchEmails: 按 subject 或 general 关键词搜索邮件\n' +
            '根据用户意图先调用相应工具获取数据，再给出简洁清晰的中文回答。若用户要求摘要，先 getEmailList 或 searchEmails 定位邮件，再用 getEmailContent 取正文后总结。'
        );
        this.chatContext.attachToolsets(mailAssistantToolset);
        
        this.state = 'assistant';
        this.openDeskTUI.tui.setFocus(this.assistantPromptInput);
        this.openDeskTUI.tui.requestRender();
    }

    private exitAssistantMode() {
        this.assistantPromptInput = undefined;
        this.assistantResult = '';
        this.assistantBusy = false;
        this.assistantToolCalls = [];
        this.chatContext = undefined; // 清理对话上下文
        this.conversationHistory = ''; // 清理对话历史
        this.state = 'list';
        this.openDeskTUI.tui.setFocus(this.emailList!);
        this.openDeskTUI.tui.requestRender();
    }

    private async runAssistant(userInput: string) {
        this.assistantBusy = true;
        this.assistantResult = '';
        this.assistantToolCalls = [];
        this.openDeskTUI.tui.setFocus(null);
        
        // 更新对话历史，添加用户输入
        this.conversationHistory += `我: ${userInput}\n\n`;
        this.openDeskTUI.tui.requestRender();

        try {
            // 使用持久的对话上下文
            if (!this.chatContext) {
                this.chatContext = new ChatContext();
                this.chatContext.system_prompt = new SystemMessage(
                    '你是邮件助手。用户会在 TUI 邮件界面中描述需求，例如：查找最近关于某主题的邮件、对某封邮件做摘要、列出最近 N 封邮件等。\n' +
                    '你可以调用工具：\n' +
                    '- mailbox-getEmailList: 获取邮件列表（offset, limit）\n' +
                    '- mailbox-getEmailContent: 根据 uid 获取邮件正文\n' +
                    '- mailbox-searchEmails: 按 subject 或 general 关键词搜索邮件\n' +
                    '根据用户意图先调用相应工具获取数据，再给出简洁清晰的中文回答。若用户要求摘要，先 getEmailList 或 searchEmails 定位邮件，再用 getEmailContent 取正文后总结。'
                );
                this.chatContext.attachToolsets(mailAssistantToolset);
            }
            
            // 添加用户消息到对话上下文
            this.chatContext.appendMessage(new UserMessage(userInput));
            const ctx = this.chatContext;

            // 用于累积所有回复内容
            let accumulatedText = '';

            // 循环处理，直到没有工具调用为止
            for (;;) {
                // 创建助手消息用于累积响应
                const assistantMessage = new AssistantMessage();

                // 使用流式完成
                let hasToolCalls = false;
                let currentText = '';
                let toolCalls = [];
                
                for await (const chunkResponse of LLM.streamComplete(ctx)) {
                    // 合并 chunk 到 assistant message
                    assistantMessage.mergeChunk(chunkResponse.content);
                    
                    // 提取文本内容和工具调用
                    currentText = '';
                    toolCalls = [];
                    
                    for (const part of assistantMessage.content) {
                        if (part.type === 'text') {
                            currentText = part.text;
                        } else if (part.type === 'tool_call') {
                            toolCalls = part.toolcalls;
                            hasToolCalls = true;
                        }
                    }
                    
                    // 更新 UI，保持之前的内容
                    this.assistantResult = (accumulatedText + currentText).trim() || '（生成中……）';
                    this.assistantToolCalls = toolCalls;
                    // 保持在 assistant 状态
                    this.state = 'assistant';
                    // 自动滚动到底部
                    this.assistantResultScrollOffset = Number.MAX_SAFE_INTEGER;
                    this.openDeskTUI.tui.requestRender();
                }

                // 将当前消息的文本内容添加到累积内容中
                accumulatedText += currentText + '\n';

                // 将助手消息添加到对话上下文
                ctx.appendMessage(assistantMessage);

                // 如果没有工具调用，结束循环
                if (!hasToolCalls) {
                    break;
                }

                // 处理工具调用
                if (toolCalls.length > 0) {
                    for (const tc of toolCalls) {
                        const tool = ctx.getTool(tc.tool_name);
                        if (!tool) {
                            tc.status = 'error';
                            tc.result = `未知工具: ${tc.tool_name}`;
                            continue;
                        }
                        tc.setTool(tool);
                        let args: any;
                        try {
                            args = tc.args_string ? JSON.parse(jsonrepair(tc.args_string)) : {};
                        } catch (e) {
                            tc.status = 'error';
                            tc.result = (e as Error).message;
                            continue;
                        }
                        tc.status = 'running';
                        
                        // 更新 UI 显示工具调用状态，保持累积的内容并添加生成中提示
                        this.assistantResult = (accumulatedText + '\n（生成中……）').trim() || '（生成中……）';
                        this.assistantToolCalls = toolCalls;
                        // 保持在 assistant 状态，不切换到 assistant-result
                        this.state = 'assistant';
                        this.openDeskTUI.tui.requestRender();
                        
                        try {
                            const result = await tool.execute(args);
                            tc.status = result.status;
                            tc.result = result.result;
                        } catch (e) {
                            tc.status = 'error';
                            tc.result = (e as Error).message;
                        }
                        
                        // 工具调用完成后更新 UI，保持累积的内容并继续显示生成中提示
                        // 因为接下来要等待大模型的回复
                        this.assistantResult = (accumulatedText + '\n（生成中……）').trim() || '（生成中……）';
                        this.assistantToolCalls = toolCalls;
                        // 保持在 assistant 状态，不切换到 assistant-result
                        this.state = 'assistant';
                        this.openDeskTUI.tui.requestRender();
                    }
                }
            }

            // 最终结果使用累积的内容
            const assistantReply = accumulatedText.trim() || '（无回复内容）';
            this.assistantResult = assistantReply;
            
            // 更新对话历史，添加助手回复
            this.conversationHistory += `助手: ${assistantReply}\n\n`;
            
            this.state = 'assistant'; // 保持在助手模式，允许用户继续输入
            this.assistantResultScrollOffset = Number.MAX_SAFE_INTEGER; // 自动滚动到底部
            const lines = this.conversationHistory.split('\n');
            this.assistantResultTotalLines = lines.length;
            this.assistantResultVisibleLines = Math.max(3, this.openDeskTUI.tui.terminal.rows - 10);
            
            // 重新聚焦到输入框
            if (this.assistantPromptInput) {
                this.assistantPromptInput.setValue(''); // 清空输入框
                this.openDeskTUI.tui.setFocus(this.assistantPromptInput);
            }
        } catch (err: any) {
            logger.error(`邮件助手失败: ${err}`);
            const errorMessage = `助手出错: ${err?.message || '未知错误'}`;
            this.assistantResult = errorMessage;
            
            // 更新对话历史，添加错误信息
            this.conversationHistory += `助手: ${errorMessage}\n\n`;
            
            this.state = 'assistant'; // 保持在助手模式，允许用户继续输入
            
            // 重新聚焦到输入框
            if (this.assistantPromptInput) {
                this.assistantPromptInput.setValue(''); // 清空输入框
                this.openDeskTUI.tui.setFocus(this.assistantPromptInput);
            }
        } finally {
            this.assistantBusy = false;
            this.openDeskTUI.tui.requestRender();
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
        } else if (type === 'forward' && this.selectedEmail) {
            // 新增：转发逻辑
            this.composeToInput.setValue('');
            this.composeSubjectInput.setValue('转发: ' + (this.selectedEmail.subject || ''));
        }else {
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

        // 回复/回复全部时，构建原始邮件引用（不放入编辑器，单独渲染在编辑器下方）
        if ((type === 'reply' || type === 'replyall'|| type === 'forward') && this.selectedEmail && this.selectedEmailContent) {
            this.composeQuotedText = this.buildQuotedText(this.selectedEmail, this.selectedEmailContent);
            this.composeQuoteScrollOffset = 0;
        } else {
            this.composeQuotedText = undefined;
            this.composeQuoteScrollOffset = 0;
        }

        this.state = 'compose';

        // 新邮件焦点从收件人开始；回复焦点直接到编辑器
        if (type === 'new' ) {
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
        const replyBody = this.composeEditor.getText().trim();
        if (!to) {
            this.errorText = '请填写收件人地址';
            this.openDeskTUI.tui.requestRender();
            return;
        }

        this.composeSending = true;
        this.openDeskTUI.tui.requestRender();

        try {
            // 拼接完整纯文本：回复正文 + 引用
            let fullText = replyBody;
            if (this.composeQuotedText) {
                fullText = replyBody + '\n\n' + this.composeQuotedText;
            }

            // 生成 HTML：回复/回复全部时附带原始邮件引用
            let html = '';
            if ((this.composeType === 'reply' || this.composeType === 'replyall' || this.composeType === 'forward')
                && this.selectedEmail && this.selectedEmailContent) {
                html = this.buildReplyHtml(replyBody, this.selectedEmail, this.selectedEmailContent);
            } else {
                // 新邮件：纯文本转简单 HTML
                html = replyBody.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
            }

            await callMailWorker('sendEmail', {
                to,
                cc,
                bcc: '',
                subject,
                text: fullText,
                html,
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

    /**
     * 构建回复邮件时的原始邮件引用文本（纯文本格式）。
     * 参考 Electron 前端的 composeContent 方法，在 CLI 下以文本方式呈现。
     */
    private buildQuotedText(email: EmailHeader, content: EmailContent): string {
        const sender = formatAddresses(email.from);
        const sendTime = new Date(email.date).toLocaleString();
        const receivers = formatAddresses(email.to);
        const cc = email.cc && email.cc.length > 0 ? formatAddresses(email.cc) : '';
        const subject = email.subject || '(无主题)';

        let originalBody = '';
        if (content.textContent) {
            originalBody = content.textContent;
        } else if (content.htmlContent) {
            originalBody = stripHtml(content.htmlContent);
        }

        // 每行加 > 前缀
        const quotedBody = originalBody
            .split('\n')
            .map(line => `> ${line}`)
            .join('\n');

        const lines = [
            '---------- 原始邮件 ----------',
            `发件人: ${sender}`,
            `发送时间: ${sendTime}`,
            `收件人: ${receivers}`,
        ];
        if (cc) {
            lines.push(`抄送: ${cc}`);
        }
        lines.push(`主题: ${subject}`);
        lines.push('');
        lines.push(quotedBody);

        return lines.join('\n');
    }

    /**
     * 构建回复邮件的 HTML 内容（用户正文 + 原始邮件引用）。
     * 参考 Electron 前端 MailEditorWidget.composeContent 的样式。
     */
    /**
     * 构建回复邮件的 HTML 内容（用户正文 + 原始邮件引用）。
     * replyBody 仅为用户输入的回复正文（不含引用）。
     */
    private buildReplyHtml(replyBody: string, email: EmailHeader, content: EmailContent): string {
        const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const userHtml = escHtml(replyBody).replace(/\n/g, '<br>');

        const sender = formatAddresses(email.from);
        const sendTime = new Date(email.date).toLocaleString();
        const receivers = formatAddresses(email.to);
        const cc = email.cc && email.cc.length > 0 ? formatAddresses(email.cc) : '';
        const subject = email.subject || '(无主题)';

        const originContent = content.htmlContent
            ? content.htmlContent
            : escHtml(content.textContent || '').replace(/\n/g, '<br>');

        return `<div>${userHtml}</div>
<br><br>
<hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 20px 0;">
<div style="background-color: #f3f4f6; padding: 16px; border-radius: 8px; font-size: 13px; color: #374151; margin-bottom: 20px;">
  <div style="font-weight: bold; font-size: 14px; margin-bottom: 12px; color: #111827; border-bottom: 1px solid #e5e7eb; padding-bottom: 8px;">
    ----- 原始邮件 -----
  </div>
  <div style="margin-bottom: 6px;"><span style="color: #6b7280; font-weight: bold;">发件人:</span> ${escHtml(sender)}</div>
  <div style="margin-bottom: 6px;"><span style="color: #6b7280; font-weight: bold;">发送时间:</span> ${escHtml(sendTime)}</div>
  <div style="margin-bottom: 6px;"><span style="color: #6b7280; font-weight: bold;">收件人:</span> ${escHtml(receivers)}</div>
  ${cc ? `<div style="margin-bottom: 6px;"><span style="color: #6b7280; font-weight: bold;">抄送:</span> ${escHtml(cc)}</div>` : ''}
  <div><span style="color: #6b7280; font-weight: bold;">主题:</span> ${escHtml(subject)}</div>
</div>
<div style="font-size: 14px; line-height: 1.6;">${originContent}</div>`;
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
                // 只替换编辑器中的回复正文，引用内容在编辑器外部，不受影响
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
                if (this.isLoadingMore) {
                    this.box.addChild(new Text(MC.neon('  ⟳ 正在加载更多邮件...')));        // 1
                }
                this.box.addChild(new Text(''));                                             // 1
                this.box.addChild(new ListFooter(this.accounts.length > 1, this.emails.length, this.hasMoreEmails));  // 1
                break;
            }

            case 'search-list': {
                this.box.addChild(new MailHeaderBar(this.currentAccount, this.isSyncing));  // 3
                this.box.addChild(new Text(''));                                             // 1
                this.box.addChild(new SearchResultsBar(this.searchQuery));                  // 1
                this.box.addChild(new SeparatorLine());                                     // 1
                if (this.errorText) {
                    this.box.addChild(new Text(MC.red(`  ⚠ ${this.errorText}`)));           // 1
                }
                if (this.emailList) {
                    this.box.addChild(this.emailList);                                      // flex
                }
                this.box.addChild(new Text(''));                                             // 1
                this.box.addChild(new SearchFooter());                                      // 1
                break;
            }

            case 'search': {
                this.box.addChild(new MailHeaderBar(this.currentAccount, this.isSyncing));  // 3
                this.box.addChild(new Text(''));                                             // 1
                this.box.addChild(new Text(MC.dim('  输入搜索关键词，支持语法：from: 发件人 | to: 收件人 | subject: 主题 | body: 正文 | date: 日期'))); // 1
                this.box.addChild(new Text(''));                                             // 1
                if (this.searchInput) {
                    this.box.addChild(new SearchInputWrapper(this.searchInput));            // 1
                }
                this.box.addChild(new SeparatorLine());                                     // 1
                // 显示邮件列表（与 list 视图一致）
                if (this.emailList) {
                    this.box.addChild(this.emailList);                                      // flex
                }
                this.box.addChild(new Text(''));                                             // 1
                this.box.addChild(new SearchModeFooter());                                  // 1
                break;
            }

            case 'assistant': {
                this.box.addChild(new MailHeaderBar(this.currentAccount, this.isSyncing));
                this.box.addChild(new Text(''));
                this.box.addChild(new Text(MC.dim('  描述你的需求，例如：查找最近关于「周报」的邮件；对第3封邮件做摘要。')));
                this.box.addChild(new Text(''));
                
                // 计算可用空间
                const headerLines = 5; // 标题和提示占 5 行
                const footerLines = 3; // 底部提示和输入框占 3 行
                let conversationLines = Math.max(3, availableForContent - headerLines - footerLines);
                
                // 构建完整的对话历史，包括正在生成的内容
                let displayHistory = this.conversationHistory;
                
                // 如果正在生成内容，将其添加到对话历史中
                if (this.assistantBusy && this.assistantResult) {
                    displayHistory += `助手: ${this.assistantResult}\n\n`;
                }
                
                // 显示对话历史（如果有）
                if (displayHistory) {
                    const bodyView = new ScrollableEmailBody(
                        { textContent: displayHistory, htmlContent: '', attachments: [] },
                        conversationLines,
                        this.assistantResultScrollOffset
                    );
                    this.box.addChild(bodyView);
                    this.assistantResultTotalLines = bodyView.getTotalLines();
                } else {
                    this.box.addChild(new VerticalFiller(MC.dim('  对话历史将显示在这里'), conversationLines));
                }
                
                // 显示工具调用（如果有）
                if (this.assistantToolCalls.length > 0) {
                    this.box.addChild(new Text(''));
                    const toolCallView = new ToolCallMessagePartView();
                    toolCallView.setToolcalls(this.assistantToolCalls);
                    this.box.addChild(toolCallView);
                }
                
                this.box.addChild(new Text(''));
                
                // 显示输入框
                if (this.assistantBusy) {
                    this.box.addChild(new Text(MC.neon('  ⟳ 正在处理…')));
                } else if (this.assistantPromptInput) {
                    this.box.addChild(this.assistantPromptInput);
                }
                
                this.box.addChild(new Text(''));
                this.box.addChild(new AssistantFooter());
                break;
            }

            case 'assistant-result': {
                this.box.addChild(new MailHeaderBar(this.currentAccount, this.isSyncing));
                this.box.addChild(new Text(''));
                this.box.addChild(new Text(MC.neonBold('  邮件助手 回复')));
                this.box.addChild(new SeparatorLine('─'));
                
                const bodyLines = Math.max(3, availableForContent - 8);
                
                // 显示工具调用（如果有）
                if (this.assistantToolCalls.length > 0) {
                    const toolCallView = new ToolCallMessagePartView();
                    toolCallView.setToolcalls(this.assistantToolCalls);
                    this.box.addChild(toolCallView);
                    this.box.addChild(new Text(''));
                }
                
                const bodyView = new ScrollableEmailBody(
                    { textContent: this.assistantResult, htmlContent: '', attachments: [] },
                    bodyLines,
                    this.assistantResultScrollOffset
                );
                this.box.addChild(bodyView);
                
                // 更新总行数供滚动逻辑使用
                this.assistantResultTotalLines = bodyView.getTotalLines();
                this.assistantResultVisibleLines = bodyLines;
                
                this.box.addChild(new Text(''));
                this.box.addChild(new AssistantResultFooter(
                    this.assistantResultScrollOffset,
                    this.assistantResultTotalLines,
                    this.assistantResultVisibleLines
                ));
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
                //   Editor/SpinnerView      ← 弹性区域（回复时分给编辑器和引用）
                //   QuotedTextView (回复时) ← 引用区域
                //   SeparatorLine(━)        1
                //   ComposeFooterBar        1
                //   Box bottom padding      1
                const fields = this.getComposeFocusFields();
                const fieldLineCount = this.composeCcInput ? 3 : 2;
                const hasError = this.errorText ? 1 : 0;
                const hasQuote = this.composeQuotedText ? 1 : 0; // 引用分隔线
                const composeFixed = 3 + fieldLineCount + 1 + hasError + hasQuote + 1 + 1;
                const flexLines = Math.max(3, availableForContent - composeFixed);

                // 有引用时：编辑器占 40%，引用占 60%（最少各 3 行）
                let editorLines: number;
                let quoteLines: number;
                if (this.composeQuotedText) {
                    editorLines = Math.max(3, Math.floor(flexLines * 0.4));
                    quoteLines = Math.max(3, flexLines - editorLines);
                } else {
                    editorLines = flexLines;
                    quoteLines = 0;
                }

                const typeLabel = this.composeType === 'new' ? '写信'
                    : this.composeType === 'replyall' ? '回复全部'
                    : this.composeType === 'forward' ? '转发邮件'
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

                // 回复时在编辑器下方显示原始邮件引用
                if (this.composeQuotedText && quoteLines > 0) {
                    this.box.addChild(new SeparatorLine('┄'));
                    this.box.addChild(new QuotedTextView(this.composeQuotedText, quoteLines, this.composeQuoteScrollOffset));
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
    constructor(
        private multiAccount: boolean,
        private emailCount: number,
        private hasMore: boolean
    ) { }
    invalidate() { }
    render(width: number): string[] {
        const hints = [
            MC.neon('↑↓') + MC.dim(' 选择'),
            MC.neon('Enter') + MC.dim(' 查看'),
            MC.neon('c') + MC.dim(' 写信'),
            MC.neon('1-5') + MC.dim(' 筛选'),
            MC.neon('s') + MC.dim(' 同步'),
            MC.neon('p') + MC.dim(' 助手'),
            MC.neon('l') + MC.dim(' 搜索'),
        ];
        if (this.multiAccount) {
            hints.push(MC.neon('a') + MC.dim(' 切换账号'));
        }
        hints.push(MC.neon('ESC') + MC.dim(' 关闭'));
        
        // 显示邮件数量和加载状态
        const countInfo = this.hasMore 
            ? MC.dim(` | 已加载 ${this.emailCount} 封`)
            : MC.dim(` | 共 ${this.emailCount} 封`);
        
        const hintsText = '  ' + hints.join('   ');
        const hintsVis = visibleWidth(hintsText);
        const countVis = visibleWidth(countInfo);
        
        if (hintsVis + countVis > width) {
            return [truncateToWidth(hintsText, width, '…')];
        }
        
        return [truncateToWidth(hintsText + countInfo, width, '…')];
    }
}

class AssistantFooter implements Component {
    invalidate() { }
    render(width: number): string[] {
        const hints = [
            MC.neon('Enter') + MC.dim(' 发送'),
            MC.neon('ESC') + MC.dim(' 返回'),
        ];
        return [truncateToWidth('  ' + hints.join('   '), width, '…')];
    }
}

class SearchResultsBar implements Component {
    constructor(private query: string) { }
    invalidate() { }
    render(width: number): string[] {
        const label = MC.neonBold(' 🔍 搜索结果');
        const queryText = MC.bright(`"${this.query}"`);
        const leftPart = `  ${label}: ${queryText}`;
        const leftVis = visibleWidth(leftPart);
        const gap = Math.max(1, width - leftVis - 10);
        return [truncateToWidth(leftPart + ' '.repeat(gap), width, '…')];
    }
}

class SearchFooter implements Component {
    invalidate() { }
    render(width: number): string[] {
        const hints = [
            MC.neon('↑↓') + MC.dim(' 选择'),
            MC.neon('Enter') + MC.dim(' 查看'),
            MC.neon('ESC') + MC.dim(' 退出搜索'),
        ];
        return [truncateToWidth('  ' + hints.join('   '), width, '…')];
    }
}

class SearchModeFooter implements Component {
    invalidate() { }
    render(width: number): string[] {
        const hints = [
            MC.neon('Enter') + MC.dim(' 搜索'),
            MC.neon('ESC') + MC.dim(' 取消'),
        ];
        return [truncateToWidth('  ' + hints.join('   '), width, '…')];
    }
}

class SearchInputWrapper implements Component {
    constructor(private input: Input) { }
    invalidate() { this.input.invalidate(); }
    render(width: number): string[] {
        const prefix = MC.dim('  搜索: ');
        const prefixVis = visibleWidth(prefix);
        const inputW = Math.max(10, width - prefixVis - 2);
        const inputOut = this.input.render(inputW);
        const line = prefix + (inputOut[0] || '');
        return [truncateToWidth(line, width, '…')];
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

/** 回复时在编辑器下方显示的原始邮件引用区域 */
class QuotedTextView implements Component {
    private allLines: string[] = [];

    constructor(
        private quotedText: string,
        private maxLines: number,
        private scrollOffset: number,
    ) {
        this.allLines = quotedText.split('\n');
    }

    invalidate() { }

    getTotalLines(): number {
        return this.allLines.length;
    }

    render(width: number): string[] {
        const result: string[] = [];
        const total = this.allLines.length;
        const cap = Math.max(1, this.maxLines);

        if (total <= cap) {
            for (const rawLine of this.allLines) {
                const line = sanitizeLine(rawLine);
                if (line.startsWith('>')) {
                    result.push(MC.ghost(truncateToWidth('  ' + line, width - 2, '…')));
                } else {
                    result.push(MC.dim(truncateToWidth('  ' + line, width - 2, '…')));
                }
            }
            while (result.length < cap) result.push('');
            return result;
        }

        const bodyArea = cap - 1; // 1 行给滚动指示器
        const offset = Math.max(0, Math.min(this.scrollOffset, total - bodyArea));
        const display = this.allLines.slice(offset, offset + bodyArea);

        for (const rawLine of display) {
            const line = sanitizeLine(rawLine);
            if (line.startsWith('>')) {
                result.push(MC.ghost(truncateToWidth('  ' + line, width - 2, '…')));
            } else {
                result.push(MC.dim(truncateToWidth('  ' + line, width - 2, '…')));
            }
        }
        while (result.length < bodyArea) result.push('');

        const progress = total > bodyArea
            ? Math.round((offset / (total - bodyArea)) * 100)
            : 100;
        const indicator = MC.ghost(`  ── 原始邮件 ${progress}%  (${offset + 1}-${Math.min(offset + bodyArea, total)}/${total}行) ──`);
        result.push(truncateToWidth(indicator, width, '…'));

        return result;
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
                let styledLine = line;
                if (line.startsWith('我:')) {
                    styledLine = MC.neon(line);
                }
                result.push(truncateToWidth('  ' + styledLine, width - 2, '…'));
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
                let styledLine = line;
                if (line.startsWith('我:')) {
                    styledLine = MC.neon(line);
                }
                result.push(truncateToWidth('  ' + styledLine, width - 2, '…'));
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

/** 助手结果底部操作提示栏 */
class AssistantResultFooter implements Component {
    constructor(
        private scrollOffset: number,
        private totalLines: number,
        private visibleLines: number,
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
        hints.push(MC.neon('ESC/任意键') + MC.dim(' 返回'));

        return [truncateToWidth('  ' + hints.join('   '), width, '…')];
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
        hints.push(MC.neon('w') + MC.dim(' 转发'));
        if (this.email) {
            hints.push(MC.neon('f') + MC.dim(this.email.starred ? ' 取消收藏' : ' 收藏'));
        }
        hints.push(MC.neon('d') + MC.dim(' 删除'));
        hints.push(MC.neon('q/ESC') + MC.dim(' 返回'));

        return [truncateToWidth('  ' + hints.join('   '), width, '…')];
    }
}
