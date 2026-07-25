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

import {
    type Component,
    type OverlayHandle,
    SelectList,
    Box,
    Text,
    Editor,
    Input,
    Key,
    matchesKey,
    isKeyRelease,
    visibleWidth,
    truncateToWidth
} from '@earendil-works/pi-tui';
import { defaultSelectListTheme, defaultEditorTheme } from '../../tui/theme';
import type { OpenDeskTUI } from '../../tui/entry';
import { LLM } from '../../aikernel/llm.js';
import {
    UserMessage,
    ChatContext,
    AssistantMessage,
    AssistantResponse,
    SystemMessage,
    ToolCall
} from '../../aikernel/messages.js';
import { BaseToolset } from '../../aikernel/tool.js';
import { ToolCallView, ToolCallMessagePartView } from '../../tui/components/taskview.js';
import { getAdaptiveGreen } from '../../tui/theme.js';
import { logger } from '../../utils/logger.js';
import chalk from 'chalk';
import { jsonrepair } from 'jsonrepair';
import fs from 'fs';
import path from 'path';
import {
    callMailWorker,
    formatSender,
    formatAddresses,
    stripHtml,
    buildQuotedText,
    buildReplyHtml,
    GetEmailListTool,
    GetEmailContentTool,
    SearchEmailsTool,
    SendEmailTool,
    ReplyEmailTool,
    MarkEmailReadTool,
    StarEmailTool,
    DeleteEmailTool,
    GetCalendarItemsTool,
    AddCalendarItemTool,
    DeleteCalendarItemTool,
    GetCurrentTimeTool
} from './tools';

// SelectList.selectedIndex 在类型声明中是 private，但运行时可访问且无公开 getter
function getListIndex(list: SelectList): number {
    return ((list as unknown as Record<string, unknown>)['selectedIndex'] as number) ?? 0;
}

// ━━━ 邮箱配色 ━━━
const MC = {
    accent: chalk.hex('#4A90D9'),
    accentBold: chalk.hex('#4A90D9').bold,
    neon: chalk.hex('#00E5FF'),
    neonBold: chalk.hex('#00E5FF').bold,
    get green() {
        return chalk.hex(getAdaptiveGreen());
    },
    amber: chalk.hex('#FFAB00'),
    red: chalk.hex('#FF1744'),
    ghost: chalk.hex('#4a4a4a'),
    dim: chalk.hex('#666666'),
    text: chalk.hex('#c0c0c0'),
    bright: chalk.hex('#e0e0e0').bold,
    unread: chalk.hex('#00E5FF').bold
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

type MailViewState =
    | 'loading'
    | 'list'
    | 'detail'
    | 'compose'
    | 'assistant'
    | 'assistant-result'
    | 'search'
    | 'search-list';
type FilterType = 'all' | 'unread' | 'starred' | 'draft' | 'sent';
type ComposeType = 'reply' | 'replyall' | 'new' | 'forward';

interface AssistantPendingDraft {
    mode: 'new' | 'reply' | 'replyall';
    sendArgs: {
        to: string | string[];
        cc?: string | string[];
        bcc?: string | string[];
        subject: string;
        text: string;
        html: string;
        attachments: Array<{ filename: string; path: string }>;
    };
    summary: {
        to: string;
        cc?: string;
        subject: string;
        preview: string;
        attachments: string[];
    };
}

let assistantDraftHandler: ((draft: AssistantPendingDraft) => string) | undefined;
let assistantDraftSender: (() => Promise<string>) | undefined;

function formatRecipientsInput(value?: string | string[]): string {
    if (!value) return '';
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
}

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
    { key: '5', value: 'sent', label: '已发送' }
];

// ━━━ 邮件助手工具（直接复用 tools.ts 的工具类） ━━━

const getEmailListTool = new GetEmailListTool();
const getEmailContentTool = new GetEmailContentTool();
const searchEmailsTool = new SearchEmailsTool();
const sendEmailTool = new SendEmailTool();
const replyEmailTool = new ReplyEmailTool();
const markEmailReadTool = new MarkEmailReadTool();
const starEmailTool = new StarEmailTool();
const deleteEmailTool = new DeleteEmailTool();

const mailAssistantToolset = new BaseToolset('mailbox');
mailAssistantToolset.addTools(
    getEmailListTool,
    getEmailContentTool,
    searchEmailsTool,
    sendEmailTool,
    replyEmailTool,
    markEmailReadTool,
    starEmailTool,
    deleteEmailTool
);

// ━━━ 跨应用联动工具：日历（复用 tools.ts 的工具类，挂载 TUI 渲染回调） ━━━

const getCalendarItemsTool = new GetCalendarItemsTool();
getCalendarItemsTool.renderToolCallCli = function (toolcall: ToolCall, width: number): string[] | undefined {
    const args = toolcall.args_object as any;
    const lines: string[] = [];
    if (args?.dateString) lines.push(MC.dim('日期: ') + MC.accent(String(args.dateString)));
    if (toolcall.status === 'running') lines.push(MC.dim('  ⏳ 正在获取日程…'));
    else if (toolcall.status === 'success' && toolcall.result) {
        try {
            const r = JSON.parse(toolcall.result);
            lines.push(MC.dim(`  共 ${r.total} 项日程`));
        } catch {
            lines.push(MC.dim('  ✓ 已获取日程'));
        }
    } else if (toolcall.status === 'error') lines.push(MC.red(String(toolcall.result || '获取失败')));
    return lines.length > 0 ? lines : undefined;
};

const addCalendarItemTool = new AddCalendarItemTool();
addCalendarItemTool.renderToolCallCli = function (toolcall: ToolCall, width: number): string[] | undefined {
    const args = toolcall.args_object as any;
    const lines: string[] = [];
    if (args?.subject) lines.push(MC.dim('标题: ') + MC.bright(String(args.subject)));
    if (args?.dateString) lines.push(MC.dim('日期: ') + MC.accent(String(args.dateString)));
    if (args?.isAllDay) lines.push(MC.dim('时间: ') + MC.amber('全天'));
    else if (args?.startTime && args?.endTime)
        lines.push(MC.dim('时间: ') + MC.accent(`${args.startTime} — ${args.endTime}`));
    if (args?.location) lines.push(MC.dim('地点: ') + MC.accent(String(args.location)));
    if (toolcall.status === 'running') lines.push(MC.dim('  ⏳ 添加中…'));
    else if (toolcall.status === 'success') {
        try {
            const r = JSON.parse(toolcall.result!);
            if (r.skipped) lines.push(MC.amber('  ⚠ 已存在相同日程，跳过添加'));
            else lines.push(MC.green('  ✓ 日程已添加'));
        } catch {
            lines.push(MC.green('  ✓ 已添加'));
        }
    } else if (toolcall.status === 'error') lines.push(MC.red(String(toolcall.result || '添加失败')));
    return lines.length > 0 ? lines : undefined;
};

const deleteCalendarItemTool = new DeleteCalendarItemTool();
deleteCalendarItemTool.renderToolCallCli = function (toolcall: ToolCall, width: number): string[] | undefined {
    const args = toolcall.args_object as any;
    const lines: string[] = [];
    if (args?.uid) lines.push(MC.dim('ID: ') + MC.accent(String(args.uid).slice(0, width - 12)));
    if (toolcall.status === 'running') lines.push(MC.dim('  ⏳ 删除中…'));
    else if (toolcall.status === 'success') lines.push(MC.green('  ✓ 日程已删除'));
    else if (toolcall.status === 'error') lines.push(MC.red(String(toolcall.result || '删除失败')));
    return lines.length > 0 ? lines : undefined;
};

const getCurrentTimeTool = new GetCurrentTimeTool();

const crossAppToolset = new BaseToolset('cross-app');
crossAppToolset.addTools(getCalendarItemsTool, addCalendarItemTool, deleteCalendarItemTool, getCurrentTimeTool);

const MAIL_ASSISTANT_SYSTEM_PROMPT =
    '你是邮件助手。用户会用自然语言描述需求，你需要理解用户意图并调用合适的工具来完成任务。\n\n' +
    '## 可用工具\n\n' +
    '### mailbox-getEmailList\n' +
    '**用途**：获取当前邮箱的邮件列表，返回每封邮件的基本信息。\n' +
    '**参数**：\n' +
    '- **offset**（可选）：从第几条开始，默认 0\n' +
    '- **limit**（可选）：最多返回条数，默认 20\n' +
    '**使用场景**：当需要查看邮箱中的邮件列表，或获取邮件的基本信息时使用。\n\n' +
    '### mailbox-getEmailContent\n' +
    '**用途**：根据邮件 uid 获取邮件的完整正文内容。\n' +
    '**参数**：\n' +
    '- **uid**（必需）：邮件唯一标识 uid，从 getEmailList 或 searchEmails 结果中获取\n' +
    '**使用场景**：当需要查看邮件的详细内容，或对邮件内容进行分析、摘要时使用。\n\n' +
    '### mailbox-searchEmails\n' +
    '**用途**：按条件搜索邮件，支持多条件组合。\n' +
    '**参数**：\n' +
    '- **subject**（可选）：按主题关键词搜索（模糊匹配）\n' +
    '- **from**（可选）：按发件人搜索（姓名或邮箱地址，模糊匹配）\n' +
    '- **to**（可选）：按收件人搜索（姓名或邮箱地址，模糊匹配）\n' +
    '- **body**（可选）：按正文内容搜索（模糊匹配）\n' +
    '- **general**（可选）：通用关键词，在主题/发件人/正文中统一搜索（与 subject/from/body 互斥）\n' +
    '- **dateFrom**（可选）：搜索起始日期（含），格式 YYYY-MM-DD，例如 "2026-01-01"\n' +
    '- **dateTo**（可选）：搜索结束日期（含），格式 YYYY-MM-DD，例如 "2026-03-05"\n' +
    '- **unread**（可选）：筛选已读/未读状态：true=仅未读，false=仅已读，不传=不限\n' +
    '- **starred**（可选）：筛选收藏状态：true=仅收藏，false=仅非收藏，不传=不限\n' +
    '- **attachmentName**（可选）：按附件文件名搜索（模糊匹配），例如 "报告.pdf"\n' +
    '- **limit**（可选）：最多返回条数，默认 50\n' +
    '- **offset**（可选）：跳过前 N 条\n' +
    '**使用场景**：当需要根据特定条件查找邮件时使用，如按发件人、主题、日期等筛选。\n\n' +
    '### mailbox-sendEmail\n' +
    '**用途**：发送新邮件（调用后会立即发送）。\n' +
    '**参数**：\n' +
    '- **to**（必需）：收件人列表，每个收件人包含 name（可选）和 address（必需）\n' +
    '- **cc**（可选）：抄送列表，格式同 to\n' +
    '- **bcc**（可选）：密送列表，格式同 to\n' +
    '- **subject**（必需）：邮件主题\n' +
    '- **content**（必需）：邮件内容\n' +
    '- **attachments**（可选）：附件文件路径列表，每个元素是本地文件的绝对路径，例如 ["/home/user/report.pdf"]\n' +
    '**使用场景**：\n' +
    '- 当用户已明确给出收件人、主题、正文时，可直接调用发送。\n' +
    '- 若缺少必要信息，先补齐信息再发送。\n' +
    '- 若正文由你生成/改写，先展示完整正文并确认，确认后再发送。\n\n' +
    '### mailbox-replyEmail\n' +
    '**用途**：回复邮件（调用后会立即发送）。\n' +
    '**参数**：\n' +
    '- **uid**（必需）：要回复的邮件唯一标识 uid\n' +
    '- **content**（必需）：回复内容\n' +
    '- **replyAll**（可选）：是否回复所有人，默认 false\n' +
    '**使用场景**：\n' +
    '- 当回复对象与正文明确时可直接发送。\n' +
    '- 若正文需你生成/改写，先展示完整正文并确认，确认后再发送。\n\n' +
    '### mailbox-markEmailReadStatus\n' +
    '**用途**：标记邮件已读/未读状态。\n' +
    '**参数**：\n' +
    '- **uid**（必需）：邮件唯一标识 uid，从 getEmailList 或 searchEmails 结果中获取\n' +
    '- **read**（必需）：是否标记为已读：true=标记为已读，false=标记为未读\n' +
    '**使用场景**：当需要改变邮件的已读/未读状态时使用。\n\n' +
    '### mailbox-starEmail\n' +
    '**用途**：收藏/取消收藏邮件。\n' +
    '**参数**：\n' +
    '- **uid**（必需）：邮件唯一标识 uid，从 getEmailList 或 searchEmails 结果中获取\n' +
    '- **starred**（必需）：是否收藏：true=收藏，false=取消收藏\n' +
    '**使用场景**：当需要将重要邮件标记为收藏，或取消收藏时使用。\n\n' +
    '### mailbox-deleteEmail\n' +
    '**用途**：删除邮件。\n' +
    '**参数**：\n' +
    '- **uid**（必需）：邮件唯一标识 uid，从 getEmailList 或 searchEmails 结果中获取\n' +
    '**使用场景**：当需要删除不需要的邮件时使用。\n\n' +
    '## 使用指南与示例\n\n' +
    '### 场景示例\n' +
    '- **查找特定邮件**：\n' +
    '  - 用户说"查找上周关于周报的邮件"→ 调用 searchEmails，使用 subject: "周报" + dateFrom/dateTo 设置上周日期范围\n' +
    '  - 用户说"张三发给我的邮件"→ 调用 searchEmails，使用 from: "张三"\n' +
    '  - 用户说"找一下附件名包含报告的邮件"→ 调用 searchEmails，使用 attachmentName: "报告"\n' +
    '  - 用户说"最近的未读邮件"→ 调用 searchEmails，使用 unread: true\n' +
    '  - 用户说"我收藏过的邮件"→ 调用 searchEmails，使用 starred: true\n' +
    '- **查看邮件内容**：\n' +
    '  - 用户说"查看最新的邮件内容"→ 先调用 getEmailList 获取邮件列表，再调用 getEmailContent 获取最新邮件的内容\n' +
    '  - 用户说"查看张三发来的邮件内容"→ 先调用 searchEmails 找到张三的邮件，再调用 getEmailContent 获取内容\n' +
    '- **邮件操作**：\n' +
    '  - 用户说"给张三发送邮件，主题是会议通知，内容是明天下午3点开会"→ 信息齐全，直接调用 sendEmail\n' +
    '  - 用户说"给张三发邮件，附件是 /home/user/report.pdf"（但未给主题或正文）→ 先补齐缺失信息，再调用 sendEmail\n' +
    '  - 用户说"回复刚才的邮件，你帮我组织一下措辞再发"→ 先生成完整回复正文并展示给用户确认；用户明确确认后再调用 replyEmail\n' +
    '  - 用户说"把这段回复润色后发出去"→ 先给出润色后的完整正文并确认；确认后调用 replyEmail\n' +
    '  - 用户说"标记这封邮件为已读"→ 调用 markEmailReadStatus，设置 read: true\n' +
    '  - 用户说"收藏这封重要邮件"→ 调用 starEmail，设置 starred: true\n' +
    '  - 用户说"删除这封垃圾邮件"→ 调用 deleteEmail\n' +
    '- **邮件摘要**：\n' +
    '  - 用户说"总结一下最近的项目邮件"→ 先调用 searchEmails 找到相关邮件，再调用 getEmailContent 获取内容，最后进行总结\n\n' +
    '### 调用流程指导\n' +
    '1. **理解用户意图**：分析用户需求，确定需要执行的操作类型\n' +
    '2. **选择合适工具**：根据操作类型选择对应的工具\n' +
    '3. **准备工具参数**：根据用户提供的信息，准备工具所需的参数\n' +
    '4. **调用工具**：执行工具调用，获取结果\n' +
    '5. **处理结果**：根据工具返回的结果，给用户提供清晰的回答\n\n' +
    '请根据用户意图先调用相应工具获取数据，再给出简洁清晰的中文回答。\n' +
    `今天的日期是 ${new Date().toISOString().split('T')[0]}，请据此推断用户提到的相对时间（如"上周"、"最近三天"等）。

    '## 跨应用联动工具\n' +
    '- cross-app-getCurrentTime: 获取当前日期时间（在需要"今天"、"明天"等相对日期时先调用）\n' +
    '- cross-app-getCalendarItems: 查询指定日期的日程列表\n' +
    '- cross-app-addCalendarItem: 根据邮件中的会议/活动信息创建日程\n' +
    '- cross-app-deleteCalendarItem: 删除指定日程（需提供 uid，可通过 getCalendarItems 获取）\n' +
    '## 使用策略\n' +
    '1. 邮件操作：根据用户意图先调用相应工具获取数据，再给出简洁清晰的中文回答。\n' +
    '2. 发送/回复策略：信息齐全（收件人、主题、正文明确且无歧义）可直接调用 sendEmail/replyEmail；信息不全先补齐。若正文由你生成或改写，必须先向用户展示完整正文并等待明确确认，再调用发送工具。\n' +
    '3. 邮件转日程：当用户要求将邮件中的会议/活动添加到日历时，先用 getEmailContent 获取邮件内容，提取日期、时间、地点等信息，然后调用 addCalendarItem 创建日程。工具内置了去重检查，如果返回 skipped=true 表示已存在相同日程，请告知用户无需重复添加。\n' +
    '4. 日程查询：用户想查看某天安排时，先调用 getCurrentTime 获取当前日期，再调用 getCalendarItems。\n' +
    '5. 删除操作：删除日程前，先调用 getCalendarItems 获取日程的 uid，再执行删除。\n' +
    '6. 综合分析：用户可能要求"查看今天的邮件和日程"，此时需同时调用邮件和日历工具。\n' +
    '7. 去重原则：添加日程时，工具会自动检查是否已存在相同或相似的日程（按主题和时间匹配）。若已存在则跳过添加并返回已有项信息，请据此给出友好提示。\n' +
    '8. 回答始终使用简洁清晰的中文。';
    `;

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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MailOverlay — 全屏邮箱 TUI 界面
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const mailSelectListTheme = {
    ...defaultSelectListTheme,
    selectedPrefix: (text: string) => chalk.bgHex('#1a2735').hex('#4A90D9')(text),
    selectedText: (text: string) => chalk.bgHex('#1a2735').bold(text)
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
    private successText?: string;
    private isSyncing = false;

    private emailList?: SelectList;
    /** 列表可见行数，用于左右键翻页 */
    private emailListVisibleCount = 10;
    private detailList?: SelectList;
    private handle?: OverlayHandle;
    private inputListenerRemove?: () => void;

    // 分页加载相关
    private currentOffset = 0;
    private pageSize = 50;
    private initialPageSize = 50;
    private hasMoreEmails = true;
    private isLoadingMore = false;

    // 详情视图滚动状态
    private detailScrollOffset = 0;
    private detailBodyTotalLines = 0;
    private detailBodyVisibleLines = 0;

    // 窗口自适应
    private lastTermRows = 0;
    private lastTermCols = 0;

    // compose 相关
    private composeType?: ComposeType;
    private composeToInput?: Input;
    private composeCcInput?: Input;
    private composeSubjectInput?: Input;
    private composeAttachmentInput?: Input;
    private composeAttachments: Array<{ filename: string; path: string }> = [];
    private composeAttachmentSelectedIdx = -1;
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
    /** 正在编辑的草稿的 uid */
    private draftUid?: string;

    // 助手模式
    private assistantPromptInput?: Input;
    private assistantResult = '';
    private assistantBusy = false;
    private assistantResultScrollOffset = 0;
    private assistantResultTotalLines = 0;
    private assistantResultVisibleLines = 0;
    private assistantToolCalls: any[] = [];
    private assistantPendingDraft?: AssistantPendingDraft;
    private assistantUserRepliedAfterDraft = false;
    private chatContext?: ChatContext;
    private conversationHistory: string = '';
    /** 标记助手是否从详情页唤起（ESC 时返回详情而非列表） */
    private assistantFromDetail = false;

    // 搜索模式
    private isInSearchMode = false;
    private searchQuery = '';
    private searchResults: EmailHeader[] = [];
    private originalEmails: EmailHeader[] = [];
    private searchInput?: Input;

    // 附件面板相关（内嵌在详情视图中）
    private showAttachmentPanel = false;
    private attachmentList?: SelectList;
    private attachmentItems: Array<{ filename: string; path: string }> = [];
    private attachmentSelectedIdx = 0;
    private attachmentSaveInput?: Input;
    private attachmentSaveIdx = -1;
    private attachmentSaving = false;

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
            width: '100%',
            maxHeight: '100%',
            anchor: 'center'
        });
        this.openDeskTUI.hasOpenOverlay = true;
        assistantDraftHandler = this.setAssistantDraft.bind(this);
        assistantDraftSender = this.confirmAssistantDraft.bind(this);

        this.inputListenerRemove = this.openDeskTUI.tui.addInputListener((data: string) => {
            return this.handleInput(data);
        });

        try {
            await callMailWorker('notifyMailboxOpened');
        } catch {
            /* ignore */
        }

        await this.loadAccounts();
        await this.loadEmails();
    }

    private close() {
        this.stopAiSpinner();
        this.inputListenerRemove?.();
        this.handle?.hide();
        this.openDeskTUI.hasOpenOverlay = false;
        this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
        assistantDraftHandler = undefined;
        assistantDraftSender = undefined;
        this.assistantPendingDraft = undefined;
        this.assistantUserRepliedAfterDraft = false;

        callMailWorker('notifyMailboxClosed').catch(() => {});
    }

    private focusOverlayTarget(target: Component | null) {
        if (this.handle?.isFocused()) {
            this.handle.unfocus({ target });
        } else {
            this.openDeskTUI.tui.setFocus(target);
        }
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
            if (matchesKey(data, Key.ctrl('d'))) {
                this.saveDraft();
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
            const fields = this.getComposeFocusFields();
            // 附件输入框上的特殊按键处理
            if (this.composeAttachmentInput) {
                const isAttachmentFocused = fields[this.composeFocusIdx] === this.composeAttachmentInput;

                // Enter：添加附件而非跳转
                if (matchesKey(data, Key.enter) && isAttachmentFocused) {
                    this.addAttachmentFromInput();
                    return { consume: true };
                }

                // 焦点在附件输入框时，上下键选择附件
                if (isAttachmentFocused && this.composeAttachments.length > 0) {
                    if (matchesKey(data, Key.up)) {
                        if (this.composeAttachmentSelectedIdx <= 0) {
                            this.composeAttachmentSelectedIdx = this.composeAttachments.length - 1;
                        } else {
                            this.composeAttachmentSelectedIdx--;
                        }
                        this.openDeskTUI.tui.requestRender();
                        return { consume: true };
                    }
                    if (matchesKey(data, Key.down)) {
                        if (this.composeAttachmentSelectedIdx >= this.composeAttachments.length - 1) {
                            this.composeAttachmentSelectedIdx = 0;
                        } else {
                            this.composeAttachmentSelectedIdx++;
                        }
                        this.openDeskTUI.tui.requestRender();
                        return { consume: true };
                    }
                }

                // Ctrl+X 删除选中的附件（或最后一个）
                if (matchesKey(data, Key.ctrl('x')) && this.composeAttachments.length > 0) {
                    const idx =
                        this.composeAttachmentSelectedIdx >= 0 &&
                        this.composeAttachmentSelectedIdx < this.composeAttachments.length
                            ? this.composeAttachmentSelectedIdx
                            : this.composeAttachments.length - 1;
                    this.composeAttachments.splice(idx, 1);
                    if (this.composeAttachments.length === 0) {
                        this.composeAttachmentSelectedIdx = -1;
                    } else {
                        this.composeAttachmentSelectedIdx = Math.min(idx, this.composeAttachments.length - 1);
                    }
                    this.openDeskTUI.tui.requestRender();
                    return { consume: true };
                }
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
            // 忽略 key release，否则在 Kitty 键盘协议下按一次会触发「按下+松开」两次，导致左右键滚两行、上下键滚两页
            if (isKeyRelease(data)) {
                return { consume: true };
            }

            // ── 附件面板内嵌在详情中 ──
            if (this.showAttachmentPanel) {
                // 正在输入另存为路径
                if (this.attachmentSaveInput) {
                    if (matchesKey(data, Key.escape)) {
                        this.attachmentSaveInput = undefined;
                        this.attachmentSaveIdx = -1;
                        this.focusOverlayTarget(this.attachmentList ?? null);
                        this.openDeskTUI.tui.requestRender();
                        return { consume: true };
                    }
                    if (matchesKey(data, Key.enter)) {
                        this.saveAttachmentAs();
                        return { consume: true };
                    }
                    return undefined; // 让 Input 组件处理其他输入
                }
                // s 另存为
                if (data === 's' || data === 'S') {
                    this.startSaveAttachmentAs();
                    return { consume: true };
                }
                // ESC / q 关闭附件面板，回到正文
                if (matchesKey(data, Key.escape) || data === 'q') {
                    this.closeAttachmentPanel();
                    return { consume: true };
                }
                return undefined; // 让 SelectList 处理导航和 Enter
            }

            if (matchesKey(data, Key.down)) {
                this.scrollDetailBody(1);
                return { consume: true };
            }
            if (matchesKey(data, Key.up)) {
                this.scrollDetailBody(-1);
                return { consume: true };
            }
            if (matchesKey(data, Key.pageDown)) {
                this.scrollDetailBody(Math.max(1, this.detailBodyVisibleLines - 2));
                return { consume: true };
            }
            if (matchesKey(data, Key.pageUp)) {
                this.scrollDetailBody(-Math.max(1, this.detailBodyVisibleLines - 2));
                return { consume: true };
            }
            if (matchesKey(data, Key.home)) {
                this.detailScrollOffset = 0;
                this.openDeskTUI.tui.requestRender();
                return { consume: true };
            }
            if (matchesKey(data, Key.end)) {
                const bodyArea = Math.max(1, this.detailBodyVisibleLines - 1);
                this.detailScrollOffset = Math.max(0, this.detailBodyTotalLines - bodyArea);
                this.openDeskTUI.tui.requestRender();
                return { consume: true };
            }
            // ← 向左：向上翻一页（正文当前可见行数）；→ 向右：向下翻一页
            const detailPageLines = Math.max(1, this.detailBodyVisibleLines - 2);
            if (matchesKey(data, Key.left)) {
                this.scrollDetailBody(-detailPageLines);
                return { consume: true };
            }
            if (matchesKey(data, Key.right)) {
                this.scrollDetailBody(detailPageLines);
                return { consume: true };
            }

            // 草稿邮件操作
            if (this.selectedEmail && this.selectedEmail.type === 'draft') {
                // e 编辑
                if (data === 'e' || data === 'E') {
                    this.editDraft();
                    return { consume: true };
                }
                // d 删除
                if (data === 'd') {
                    this.handleDetailAction('deleteDraft');
                    return { consume: true };
                }
            } else {
                // 普通邮件操作
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
            }
            // p 唤起助手（带邮件上下文）
            if (data === 'p' || data === 'P') {
                this.enterAssistantModeFromDetail();
                return { consume: true };
            }
            // o 切换附件面板（打开/关闭）
            if (data === 'o' || data === 'O') {
                if (this.showAttachmentPanel) {
                    this.closeAttachmentPanel();
                } else {
                    this.openAttachmentPanel();
                }
                return { consume: true };
            }
            // ESC / q 返回列表
            if (matchesKey(data, Key.escape) || data === 'q') {
                this.showAttachmentPanel = false;
                this.attachmentList = undefined;
                this.attachmentItems = [];
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
            if (this.emailList && this.emails.length > 0 && !isKeyRelease(data)) {
                const currentIndex = getListIndex(this.emailList);
                const pageSize = Math.max(1, this.emailListVisibleCount);

                // ↑ 键：第一封时不动（阻止 SelectList 默认的循环跳到末尾）
                if (matchesKey(data, Key.up) && currentIndex === 0) {
                    return { consume: true };
                }

                // ← 键：向上翻一页
                if (matchesKey(data, Key.left)) {
                    const next = Math.max(0, currentIndex - pageSize);
                    this.emailList.setSelectedIndex(next);
                    this.openDeskTUI.tui.requestRender(true);
                    return { consume: true };
                }

                // → 键：向下翻一页，到底部时触发加载更多
                if (matchesKey(data, Key.right)) {
                    const next = Math.min(this.emails.length - 1, currentIndex + pageSize);
                    this.emailList.setSelectedIndex(next);
                    this.openDeskTUI.tui.requestRender(true);
                    // 翻页到接近底部时加载更多
                    if (this.hasMoreEmails && !this.isLoadingMore && next >= this.emails.length - 3) {
                        this.loadMoreEmails().catch((err) => {
                            logger.error(`翻页加载更多邮件失败: ${err}`);
                        });
                    }
                    return { consume: true };
                }
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
            if (matchesKey(data, Key.down)) {
                this.scrollAssistantResult(1);
                return { consume: true };
            }
            if (matchesKey(data, Key.up)) {
                this.scrollAssistantResult(-1);
                return { consume: true };
            }
            if (matchesKey(data, Key.pageDown)) {
                this.scrollAssistantResult(Math.max(1, this.assistantResultVisibleLines - 2));
                return { consume: true };
            }
            if (matchesKey(data, Key.pageUp)) {
                this.scrollAssistantResult(-Math.max(1, this.assistantResultVisibleLines - 2));
                return { consume: true };
            }
            if (matchesKey(data, Key.home)) {
                this.assistantResultScrollOffset = 0;
                this.openDeskTUI.tui.requestRender();
                return { consume: true };
            }
            if (matchesKey(data, Key.end)) {
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
            if (matchesKey(data, Key.down)) {
                this.scrollAssistantResult(1);
                return { consume: true };
            }
            if (matchesKey(data, Key.up)) {
                this.scrollAssistantResult(-1);
                return { consume: true };
            }
            if (matchesKey(data, Key.pageDown)) {
                this.scrollAssistantResult(Math.max(1, this.assistantResultVisibleLines - 2));
                return { consume: true };
            }
            if (matchesKey(data, Key.pageUp)) {
                this.scrollAssistantResult(-Math.max(1, this.assistantResultVisibleLines - 2));
                return { consume: true };
            }
            if (matchesKey(data, Key.home)) {
                this.assistantResultScrollOffset = 0;
                this.openDeskTUI.tui.requestRender();
                return { consume: true };
            }
            if (matchesKey(data, Key.end)) {
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
                if (this.assistantFromDetail && this.selectedEmail) {
                    this.assistantFromDetail = false;
                    this.buildDetailView();
                } else if (this.isInSearchMode) {
                    this.assistantFromDetail = false;
                    this.state = 'search-list';
                    this.focusOverlayTarget(this.emailList!);
                } else {
                    this.assistantFromDetail = false;
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
        if (this.composeAttachmentInput) fields.push(this.composeAttachmentInput);
        if (this.composeEditor) fields.push(this.composeEditor);
        return fields;
    }

    private cycleComposeFocus(dir: 1 | -1) {
        const fields = this.getComposeFocusFields();
        if (fields.length === 0) return;
        this.composeFocusIdx = (this.composeFocusIdx + dir + fields.length) % fields.length;
        this.focusOverlayTarget(fields[this.composeFocusIdx]);
        this.openDeskTUI.tui.requestRender();
    }

    private setComposeFocusToEditor() {
        const fields = this.getComposeFocusFields();
        const editorIdx = fields.indexOf(this.composeEditor!);
        if (editorIdx >= 0) {
            this.composeFocusIdx = editorIdx;
            this.focusOverlayTarget(this.composeEditor!);
        }
    }

    private addAttachmentFromInput() {
        if (!this.composeAttachmentInput) return;
        const raw = this.composeAttachmentInput.getValue().trim();
        if (!raw) return;

        // 去掉用户可能粘贴的引号
        const filePath = raw.replace(/^["']|["']$/g, '');

        try {
            const resolved = path.resolve(filePath);
            if (!fs.existsSync(resolved)) {
                this.errorText = `文件不存在: ${filePath}`;
                this.openDeskTUI.tui.requestRender();
                setTimeout(() => {
                    if (this.errorText === `文件不存在: ${filePath}`) {
                        this.errorText = undefined;
                        this.openDeskTUI.tui.requestRender();
                    }
                }, 3000);
                return;
            }
            const stat = fs.statSync(resolved);
            if (!stat.isFile()) {
                this.errorText = `不是一个文件: ${filePath}`;
                this.openDeskTUI.tui.requestRender();
                setTimeout(() => {
                    if (this.errorText === `不是一个文件: ${filePath}`) {
                        this.errorText = undefined;
                        this.openDeskTUI.tui.requestRender();
                    }
                }, 3000);
                return;
            }

            // 检查是否已添加过
            if (this.composeAttachments.some((a) => a.path === resolved)) {
                this.errorText = `附件已添加: ${path.basename(resolved)}`;
                this.openDeskTUI.tui.requestRender();
                setTimeout(() => {
                    if (this.errorText === `附件已添加: ${path.basename(resolved)}`) {
                        this.errorText = undefined;
                        this.openDeskTUI.tui.requestRender();
                    }
                }, 3000);
                return;
            }

            this.composeAttachments.push({
                filename: path.basename(resolved),
                path: resolved
            });
            this.composeAttachmentSelectedIdx = this.composeAttachments.length - 1;
            this.errorText = undefined;
            this.successText = '附件添加成功';
            this.composeAttachmentInput.setValue('');
            // 3 秒后自动清除成功提示
            setTimeout(() => {
                if (this.successText === '附件添加成功') {
                    this.successText = undefined;
                    this.openDeskTUI.tui.requestRender();
                }
            }, 3000);
        } catch (err: any) {
            this.errorText = `添加附件失败：${err?.message || '未知错误'}`;
            this.openDeskTUI.tui.requestRender();
            // 3 秒后自动清除错误提示
            setTimeout(() => {
                if (this.errorText === `添加附件失败：${err?.message || '未知错误'}`) {
                    this.errorText = undefined;
                    this.openDeskTUI.tui.requestRender();
                }
            }, 3000);
        }
        this.openDeskTUI.tui.requestRender();
    }

    private async exitCompose() {
        this.stopAiSpinner();
        this.composeEditor = undefined;
        this.composeToInput = undefined;
        this.composeCcInput = undefined;
        this.composeSubjectInput = undefined;
        this.composeAttachmentInput = undefined;
        this.composeAttachments = [];
        this.composeAttachmentSelectedIdx = -1;
        this.composeQuotedText = undefined;
        this.composeQuoteScrollOffset = 0;
        const wasEditingDraft = this.draftUid !== undefined;
        this.draftUid = undefined; // 重置草稿 uid
        this.errorText = undefined;
        this.successText = undefined;
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
        // 如果是编辑草稿后退出，且当前在草稿箱视图，更新列表
        if (wasEditingDraft && this.currentFilter === 'draft') {
            await this.loadEmails();
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

                const currentIndex = this.emailList ? getListIndex(this.emailList) : 0;
                this.buildEmailList();

                if (this.emailList && currentIndex >= 0) {
                    this.emailList.setSelectedIndex(Math.min(currentIndex, this.emails.length - 1));
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
            case 'unread':
                return { unread: true, limit: this.initialPageSize, offset: 0 };
            case 'starred':
                return { starred: true, limit: this.initialPageSize, offset: 0 };
            case 'draft':
                return { type: 'draft', limit: this.initialPageSize, offset: 0 };
            case 'sent':
                return { type: 'sent', limit: this.initialPageSize, offset: 0 };
            default:
                return { limit: this.initialPageSize, offset: 0 };
        }
    }

    private parseSearchQuery(queryString: string): any {
        const query: any = { limit: 100, offset: 0 };
        const terms = queryString.split(/\s+/).filter((t) => t.length > 0);

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
                        const [startDate, endDate] = value.split('~').map((d) => d.trim());
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
        this.focusOverlayTarget(this.searchInput);
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
        this.focusOverlayTarget(this.emailList!);
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
        this.emailListVisibleCount = visibleCount;
        const contentWidth = this.openDeskTUI.tui.terminal.columns - 6;

        const items = this.emails.map((email) => ({
            value: email.uid,
            label: this.formatEmailItem(email, contentWidth)
        }));

        if (items.length === 0) {
            items.push({ value: '__empty__', label: MC.dim('  ∅ 暂无邮件') });
        }

        this.emailList = new SelectList(items, visibleCount, mailSelectListTheme);
        this.focusOverlayTarget(this.emailList);

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
                const selectedIndex = getListIndex(this.emailList!);
                const totalItems = this.emails.length;
                // 当滚动到倒数第3项时开始加载更多
                if (totalItems > 0 && selectedIndex >= totalItems - 3) {
                    this.loadMoreEmails().catch((err) => {
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
        const sender =
            email.type === 'sent' || email.type === 'draft' ? formatAddresses(email.to) : formatSender(email.from);

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
            const email = this.emails.find((e) => e.uid === uid);
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
        this.focusOverlayTarget(null);

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
                await callMailWorker('starEmail', {
                    uid: this.selectedEmail.uid,
                    starred: newStarred
                });
                this.selectedEmail.starred = newStarred;
                this.buildDetailView();
                break;
            }
            case 'delete':
                await callMailWorker('deleteEmail', this.selectedEmail.uid);
                this.emails = this.emails.filter((e) => e.uid !== this.selectedEmail!.uid);
                this.selectedEmail = undefined;
                this.selectedEmailContent = undefined;
                this.buildEmailList(this.isInSearchMode);
                break;
            case 'deleteDraft':
                await callMailWorker('deleteDraft', this.selectedEmail.uid);
                this.emails = this.emails.filter((e) => e.uid !== this.selectedEmail!.uid);
                this.selectedEmail = undefined;
                this.selectedEmailContent = undefined;
                this.buildEmailList(this.isInSearchMode);
                break;
        }
    }

    // ──────────────────── 附件面板 ────────────────────

    private openAttachmentPanel() {
        const attachments = this.selectedEmailContent?.attachments;
        if (!attachments || attachments.length === 0) {
            // 没有附件，不做任何事
            return;
        }

        this.attachmentItems = attachments;
        this.attachmentSelectedIdx = 0;
        this.attachmentSaveInput = undefined;
        this.attachmentSaveIdx = -1;
        this.attachmentSaving = false;

        const items = this.attachmentItems.map((att, idx) => {
            const ext = path.extname(att.filename).toLowerCase();
            const icon = this.getFileIcon(ext);
            const sizeInfo = this.getFileSizeInfo(att.path);
            return { value: String(idx), label: `${icon} ${att.filename}${sizeInfo}` };
        });

        this.attachmentList = new SelectList(items, Math.min(items.length, 15), mailSelectListTheme);
        this.showAttachmentPanel = true;

        this.attachmentList.onSelect = (item: any) => {
            this.attachmentSelectedIdx = parseInt(item.value, 10);
            this.startSaveAttachmentAs();
        };
        this.attachmentList.onSelectionChange = (item: any) => {
            this.attachmentSelectedIdx = parseInt(item.value, 10);
            this.openDeskTUI.tui.requestRender(true);
        };
        this.attachmentList.onCancel = () => {
            this.closeAttachmentPanel();
        };

        this.focusOverlayTarget(this.attachmentList);
        this.openDeskTUI.tui.requestRender();
    }

    private closeAttachmentPanel() {
        this.showAttachmentPanel = false;
        this.attachmentList = undefined;
        this.attachmentItems = [];
        this.attachmentSaveInput = undefined;
        this.attachmentSaveIdx = -1;
        this.attachmentSaving = false;
        this.focusOverlayTarget(null);
        this.openDeskTUI.tui.requestRender();
    }

    private getFileIcon(ext: string): string {
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico'];
        const docExts = ['.doc', '.docx', '.pdf', '.txt', '.rtf', '.odt'];
        const sheetExts = ['.xls', '.xlsx', '.csv', '.ods'];
        const slideExts = ['.ppt', '.pptx', '.odp'];
        const archiveExts = ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2'];
        const codeExts = ['.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.html', '.css', '.json', '.xml'];
        const audioExts = ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma'];
        const videoExts = ['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv'];

        if (imageExts.includes(ext)) return '🖼';
        if (docExts.includes(ext)) return '📄';
        if (sheetExts.includes(ext)) return '📊';
        if (slideExts.includes(ext)) return '📽';
        if (archiveExts.includes(ext)) return '📦';
        if (codeExts.includes(ext)) return '📝';
        if (audioExts.includes(ext)) return '🎵';
        if (videoExts.includes(ext)) return '🎬';
        if (ext === '.eml') return '✉';
        return '📎';
    }

    private getFileSizeInfo(filePath: string): string {
        try {
            if (!filePath || !fs.existsSync(filePath)) return '';
            const stats = fs.statSync(filePath);
            const bytes = stats.size;
            if (bytes < 1024) return MC.dim(` (${bytes} B)`);
            if (bytes < 1024 * 1024) return MC.dim(` (${(bytes / 1024).toFixed(1)} KB)`);
            return MC.dim(` (${(bytes / (1024 * 1024)).toFixed(1)} MB)`);
        } catch {
            return '';
        }
    }

    private startSaveAttachmentAs() {
        const att = this.attachmentItems[this.attachmentSelectedIdx];
        if (!att || !att.path) return;

        this.attachmentSaveIdx = this.attachmentSelectedIdx;

        // 默认保存路径：优先桌面，桌面不存在则用户主目录/Downloads，都不存在则用户主目录
        const homeDir = process.env.USERPROFILE || process.env.HOME || '.';
        const candidates = [path.join(homeDir, 'Desktop'), path.join(homeDir, 'Downloads'), homeDir];
        const saveDir =
            candidates.find((d) => {
                try {
                    return fs.existsSync(d) && fs.statSync(d).isDirectory();
                } catch {
                    return false;
                }
            }) || homeDir;
        const defaultPath = path.join(saveDir, att.filename);

        this.attachmentSaveInput = new Input();
        this.attachmentSaveInput.setValue(defaultPath);
        this.focusOverlayTarget(this.attachmentSaveInput);
        this.openDeskTUI.tui.requestRender();
    }

    /**
     * 规范化用户输入的保存路径，兼容 Windows / macOS / Linux / HarmonyOS：
     *  - Windows: "D:test.pdf" → "D:\test.pdf"，"D:" → "D:\"
     *  - 波浪线: "~/Downloads/a.pdf" → "/home/user/Downloads/a.pdf"
     *  - 如果用户只输入目录（以 / 或 \ 结尾），自动追加原文件名
     *  - 最终通过 path.resolve 转为绝对路径
     */
    private normalizeSavePath(rawPath: string, defaultFilename: string): string {
        let p = rawPath.trim();
        if (!p) return '';

        // 展开 ~ 为用户主目录
        if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
            const home = process.env.HOME || process.env.USERPROFILE || '';
            p = path.join(home, p.slice(1));
        }

        // Windows: "D:filename" → "D:\filename"（盘符后无分隔符的情况）
        // 匹配 "X:非斜杠字符" 的模式（X 是字母）
        if (/^[a-zA-Z]:[^/\\]/.test(p)) {
            p = p[0] + ':\\' + p.slice(2);
        }
        // Windows: 单独 "D:" → "D:\"
        if (/^[a-zA-Z]:$/.test(p)) {
            p = p + '\\';
        }

        // 如果路径以分隔符结尾，说明用户输入的是目录，追加原文件名
        if (p.endsWith(path.sep) || p.endsWith('/') || p.endsWith('\\')) {
            p = path.join(p, defaultFilename);
        }

        // 如果路径没有扩展名且不像文件名，可能用户输入的是目录
        // 例如 "D:\Downloads" 且该路径是已存在的目录
        try {
            if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
                p = path.join(p, defaultFilename);
            }
        } catch {
            /* ignore */
        }

        // 解析为绝对路径
        return path.resolve(p);
    }

    private saveAttachmentAs() {
        if (this.attachmentSaveIdx < 0 || !this.attachmentSaveInput) return;
        const att = this.attachmentItems[this.attachmentSaveIdx];
        if (!att || !att.path) return;

        const rawInput = this.attachmentSaveInput.getValue().trim();
        if (!rawInput) {
            this.errorText = '保存路径不能为空';
            this.openDeskTUI.tui.requestRender();
            setTimeout(() => {
                this.errorText = undefined;
                this.openDeskTUI.tui.requestRender();
            }, 3000);
            return;
        }

        const destPath = this.normalizeSavePath(rawInput, att.filename);

        if (!fs.existsSync(att.path)) {
            this.errorText = `源文件不存在: ${att.filename}`;
            this.openDeskTUI.tui.requestRender();
            setTimeout(() => {
                this.errorText = undefined;
                this.openDeskTUI.tui.requestRender();
            }, 3000);
            return;
        }

        try {
            this.attachmentSaving = true;
            this.openDeskTUI.tui.requestRender();

            // 确保目标目录存在
            const destDir = path.dirname(destPath);
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }

            fs.copyFileSync(att.path, destPath);

            this.attachmentSaving = false;
            this.attachmentSaveInput = undefined;
            this.attachmentSaveIdx = -1;
            this.errorText = undefined;

            // 显示成功提示
            this.errorText = `✅ 已保存到: ${destPath}`;
            this.focusOverlayTarget(this.attachmentList ?? null);
            this.openDeskTUI.tui.requestRender();
            setTimeout(() => {
                this.errorText = undefined;
                this.openDeskTUI.tui.requestRender();
            }, 3000);
        } catch (err: any) {
            this.attachmentSaving = false;
            this.errorText = `保存失败: ${err?.message || '未知错误'}`;
            this.openDeskTUI.tui.requestRender();
            setTimeout(() => {
                this.errorText = undefined;
                this.openDeskTUI.tui.requestRender();
            }, 3000);
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
        this.assistantFromDetail = false;

        // 初始化或重置对话上下文
        this.chatContext = new ChatContext();
        this.chatContext.system_prompt = new SystemMessage(MAIL_ASSISTANT_SYSTEM_PROMPT);
        this.chatContext.attachToolsets(mailAssistantToolset, crossAppToolset);

        this.state = 'assistant';
        this.focusOverlayTarget(this.assistantPromptInput);
        this.openDeskTUI.tui.requestRender();
    }

    /**
     * 从邮件详情页唤起助手模式。
     * 将当前邮件的主题、发件人、日期和正文摘要作为上下文预置到对话中，
     * 并显示引导提示，让用户自由输入需求。
     */
    private enterAssistantModeFromDetail() {
        if (!this.selectedEmail) return;

        const email = this.selectedEmail;
        const subject = email.subject || '(无主题)';
        const from = formatSender(email.from);
        const date = formatDate(email.date);

        // 获取邮件正文摘要（取前 500 字）
        let bodySnippet = '';
        if (this.selectedEmailContent) {
            const text =
                this.selectedEmailContent.textContent?.trim() || stripHtml(this.selectedEmailContent.htmlContent || '');
            bodySnippet = text.slice(0, 500);
        }

        // 构建邮件上下文摘要
        const emailContext =
            `📧 当前邮件\n` +
            `  主题: ${subject}\n` +
            `  发件人: ${from}\n` +
            `  日期: ${date}\n` +
            (bodySnippet ? `  内容摘要: ${bodySnippet.slice(0, 200)}${bodySnippet.length > 200 ? '…' : ''}\n` : '') +
            `\n🤖 我是邮件助手，请问有什么可以帮你？\n` +
            `  例如：将这封邮件添加到日程 / 帮我总结这封邮件 / 查看今天的日程安排\n\n`;

        // 初始化助手模式
        this.assistantPromptInput = new Input();
        this.assistantPromptInput.setValue('');
        this.assistantResult = '';
        this.assistantBusy = false;
        this.assistantToolCalls = [];
        this.assistantFromDetail = true;
        this.conversationHistory = emailContext;

        // 初始化对话上下文，将邮件信息注入 system prompt
        this.chatContext = new ChatContext();
        const detailSystemPrompt =
            MAIL_ASSISTANT_SYSTEM_PROMPT +
            '\n\n' +
            '## 当前邮件上下文\n' +
            `用户正在查看一封邮件，信息如下：\n` +
            `- 主题: ${subject}\n` +
            `- 发件人: ${from}\n` +
            `- 日期: ${date}\n` +
            (bodySnippet ? `- 正文（前500字）:\n${bodySnippet}\n` : '') +
            '\n请根据用户的后续指令，结合这封邮件的内容来完成任务。' +
            '用户可能会要求：添加日程、总结邮件、回复建议、查看日程安排等。';
        this.chatContext.system_prompt = new SystemMessage(detailSystemPrompt);
        this.chatContext.attachToolsets(mailAssistantToolset, crossAppToolset);

        this.state = 'assistant';
        this.focusOverlayTarget(this.assistantPromptInput);
        this.openDeskTUI.tui.requestRender();
    }

    private exitAssistantMode() {
        this.assistantPromptInput = undefined;
        this.assistantResult = '';
        this.assistantBusy = false;
        this.assistantToolCalls = [];
        this.assistantPendingDraft = undefined;
        this.assistantUserRepliedAfterDraft = false;
        this.chatContext = undefined; // 清理对话上下文
        this.conversationHistory = ''; // 清理对话历史

        if (this.assistantFromDetail && this.selectedEmail) {
            // 从详情页唤起的助手，返回详情页
            this.assistantFromDetail = false;
            this.buildDetailView();
        } else {
            this.assistantFromDetail = false;
            this.state = 'list';
            this.focusOverlayTarget(this.emailList!);
        }
        this.openDeskTUI.tui.requestRender();
    }

    private async runAssistant(userInput: string) {
        this.assistantBusy = true;
        this.assistantResult = '';
        this.assistantToolCalls = [];
        this.assistantUserRepliedAfterDraft = Boolean(this.assistantPendingDraft);
        this.focusOverlayTarget(null);

        // 更新对话历史，添加用户输入
        this.conversationHistory += `我: ${userInput}\n\n`;
        this.openDeskTUI.tui.requestRender();

        try {
            // 使用持久的对话上下文
            if (!this.chatContext) {
                this.chatContext = new ChatContext();
                this.chatContext.system_prompt = new SystemMessage(MAIL_ASSISTANT_SYSTEM_PROMPT);
                this.chatContext.attachToolsets(mailAssistantToolset, crossAppToolset);
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
                let toolCalls: ToolCall[] = [];

                for await (const chunkResponse of LLM.streamComplete(ctx)) {
                    // 合并 chunk 到 assistant message
                    assistantMessage.mergeChunk(chunkResponse.content);

                    // 提取文本内容和工具调用
                    currentText = '';
                    toolCalls = [] as ToolCall[];

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
                this.focusOverlayTarget(this.assistantPromptInput);
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
                this.focusOverlayTarget(this.assistantPromptInput);
            }
        } finally {
            this.assistantBusy = false;
            this.openDeskTUI.tui.requestRender();
        }
    }

    // ──────────────────── 撰写/回复邮件 ────────────────────

    private setAssistantDraft(draft: AssistantPendingDraft): string {
        this.assistantPendingDraft = draft;
        this.assistantUserRepliedAfterDraft = false;
        return JSON.stringify({
            success: true,
            pending: true,
            message: '已生成草稿，请确认发送或提出修改。',
            summary: draft.summary,
            draft: {
                to: draft.summary.to,
                cc: draft.summary.cc || '',
                subject: draft.summary.subject,
                content: draft.sendArgs.text,
                attachments: draft.summary.attachments
            }
        });
    }

    private async confirmAssistantDraft(): Promise<string> {
        if (!this.assistantPendingDraft) {
            return JSON.stringify({
                success: false,
                error: '没有待发送的草稿，请先让助手生成邮件内容'
            });
        }
        if (!this.assistantUserRepliedAfterDraft) {
            return JSON.stringify({
                success: false,
                error: '需要用户在草稿生成后再输入一轮确认，才能发送'
            });
        }
        try {
            const result = await callMailWorker('sendEmail', this.assistantPendingDraft.sendArgs);
            this.assistantPendingDraft = undefined;
            this.assistantUserRepliedAfterDraft = false;
            return JSON.stringify({ success: true, message: '邮件已发送', data: result });
        } catch (err: any) {
            return JSON.stringify({ success: false, error: err?.message || '发送失败' });
        }
    }

    private startCompose(type: ComposeType) {
        if (type !== 'new' && !this.selectedEmail) return;

        this.composeType = type;
        this.errorText = undefined;
        this.successText = undefined;
        this.isAiGenerating = false;
        this.composeSending = false;
        this.aiSpinnerFrame = 0;

        // 创建 Input 字段
        this.composeToInput = new Input();
        this.composeSubjectInput = new Input();
        this.composeCcInput = new Input();
        this.composeAttachmentInput = new Input();
        this.composeAttachments = [];

        if (type === 'reply' && this.selectedEmail) {
            this.composeToInput.setValue(this.selectedEmail.from?.[0]?.address || '');
            this.composeSubjectInput.setValue('答复: ' + (this.selectedEmail.subject || ''));
        } else if (type === 'replyall' && this.selectedEmail) {
            const currentEmail = this.currentAccount?.email || '';
            const toAddresses = [
                this.selectedEmail.from?.[0]?.address,
                ...(this.selectedEmail.to || []).filter((a) => a.address !== currentEmail).map((a) => a.address)
            ].filter(Boolean);
            this.composeToInput.setValue(toAddresses.join(', '));
            this.composeCcInput.setValue((this.selectedEmail.cc || []).map((a) => a.address).join(', '));
            this.composeSubjectInput.setValue('答复全部: ' + (this.selectedEmail.subject || ''));
        } else if (type === 'forward' && this.selectedEmail) {
            this.composeToInput.setValue('');
            this.composeSubjectInput.setValue('转发: ' + (this.selectedEmail.subject || ''));
            // 转发时自动携带原邮件的附件
            if (this.selectedEmailContent?.attachments?.length) {
                this.composeAttachments = this.selectedEmailContent.attachments
                    .filter((a) => a.path && fs.existsSync(a.path))
                    .map((a) => ({ filename: a.filename, path: a.path }));
            }
        } else {
            // 'new' — 空白邮件
            this.composeToInput.setValue('');
            this.composeSubjectInput.setValue('');
        }

        // 创建 Editor
        this.composeEditor = new Editor(this.openDeskTUI.tui, {
            ...defaultEditorTheme,
            borderColor: () => ''
        });

        this.composeEditor.setText('');

        // 回复/回复全部时，构建原始邮件引用（不放入编辑器，单独渲染在编辑器下方）
        if (
            (type === 'reply' || type === 'replyall' || type === 'forward') &&
            this.selectedEmail &&
            this.selectedEmailContent
        ) {
            this.composeQuotedText = buildQuotedText(this.selectedEmail, this.selectedEmailContent);
            this.composeQuoteScrollOffset = 0;
        } else {
            this.composeQuotedText = undefined;
            this.composeQuoteScrollOffset = 0;
        }

        this.state = 'compose';

        // 新邮件焦点从收件人开始；回复焦点直接到编辑器
        if (type === 'new') {
            this.composeFocusIdx = 0;
            this.focusOverlayTarget(this.composeToInput);
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
            if (
                (this.composeType === 'reply' || this.composeType === 'replyall' || this.composeType === 'forward') &&
                this.selectedEmail &&
                this.selectedEmailContent
            ) {
                html = buildReplyHtml(replyBody, this.selectedEmail, this.selectedEmailContent);
            } else {
                // 新邮件：纯文本转简单 HTML
                html = replyBody
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/\n/g, '<br>');
            }

            await callMailWorker('sendEmail', {
                to,
                cc,
                bcc: '',
                subject,
                text: fullText,
                html,
                attachments: this.composeAttachments.map((a) => ({
                    filename: a.filename,
                    path: a.path
                }))
            });

            // 如果是编辑草稿后发送，删除原草稿
            if (this.draftUid) {
                await callMailWorker('deleteDraft', this.draftUid);
            }

            await this.exitCompose();
        } catch (err: any) {
            logger.error(`发送邮件失败: ${err}`);
            this.composeSending = false;
            this.errorText = `发送失败: ${err?.message || '未知错误'}`;
            this.openDeskTUI.tui.requestRender();
        }
    }

    private async saveDraft() {
        if (!this.composeEditor) return;
        const to = this.composeToInput?.getValue()?.trim() || '';
        const cc = this.composeCcInput?.getValue()?.trim() || '';
        const subject = this.composeSubjectInput?.getValue()?.trim() || '';
        const replyBody = this.composeEditor.getText().trim();

        try {
            let fullText = replyBody;
            if (this.composeQuotedText) {
                fullText = replyBody + '\n\n' + this.composeQuotedText;
            }
            // 生成 HTML：回复/回复全部时附带原始邮件引用
            let html = '';
            if (
                (this.composeType === 'reply' || this.composeType === 'replyall' || this.composeType === 'forward') &&
                this.selectedEmail &&
                this.selectedEmailContent
            ) {
                html = buildReplyHtml(replyBody, this.selectedEmail, this.selectedEmailContent);
            } else {
                // 新邮件：纯文本转简单 HTML
                html = replyBody
                    .replace(/&/g, '&amp;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;')
                    .replace(/\n/g, '<br>');
            }
            // 如果是编辑草稿，先删除原草稿
            if (this.draftUid) {
                await callMailWorker('deleteDraft', this.draftUid);
            }

            const draftUid = await callMailWorker('saveDraft', {
                to,
                cc,
                bcc: '',
                subject,
                text: fullText,
                html,
                attachments: this.composeAttachments.map((a) => ({
                    filename: a.filename,
                    path: a.path
                }))
            });

            // 存储返回的草稿 UID，以便后续编辑时能正确更新
            this.draftUid = draftUid;

            this.successText = '草稿保存成功';
            this.openDeskTUI.tui.requestRender();

            setTimeout(async () => {
                await this.exitCompose();
                // 如果当前在草稿箱视图，更新列表
                if (this.currentFilter === 'draft') {
                    await this.loadEmails();
                }
            }, 1500);
        } catch (err: any) {
            logger.error(`保存草稿失败: ${err}`);
            this.errorText = `保存失败: ${err?.message || '未知错误'}`;
            this.openDeskTUI.tui.requestRender();
        }
    }

    private async editDraft() {
        if (!this.selectedEmail || this.selectedEmail.type !== 'draft') return;

        try {
            // 获取草稿内容
            const content = await callMailWorker('getEmailContent', this.selectedEmail.uid);
            if (!content) {
                this.errorText = '加载草稿内容失败';
                this.openDeskTUI.tui.requestRender();
                return;
            }

            this.composeToInput = new Input();
            this.composeSubjectInput = new Input();
            this.composeCcInput = new Input();
            this.composeAttachmentInput = new Input();
            this.composeAttachments = (content.attachments || [])
                .map((a: any) => ({
                    filename: a.filename || path.basename(a.path || ''),
                    path: a.path || ''
                }))
                .filter((a: any) => a.path);

            this.composeToInput.setValue(this.selectedEmail.to?.map((a) => a.address).join(', ') || '');
            this.composeCcInput.setValue((this.selectedEmail.cc || []).map((a) => a.address).join(', '));
            this.composeSubjectInput.setValue(this.selectedEmail.subject || '');

            this.composeEditor = new Editor(this.openDeskTUI.tui, {
                ...defaultEditorTheme,
                borderColor: () => ''
            });

            const bodyText = content.textContent || stripHtml(content.htmlContent) || '';
            this.composeEditor.setText(bodyText);

            this.composeType = 'new';
            this.errorText = undefined;
            this.isAiGenerating = false;
            this.composeSending = false;
            this.aiSpinnerFrame = 0;
            this.composeQuotedText = undefined;
            this.draftUid = this.selectedEmail.uid;

            this.state = 'compose';
            this.setComposeFocusToEditor();
            this.openDeskTUI.tui.requestRender();
        } catch (err: any) {
            logger.error(`编辑草稿失败: ${err}`);
            this.errorText = `编辑失败: ${err?.message || '未知错误'}`;
            this.openDeskTUI.tui.requestRender();
        }
    }

    // buildQuotedText / buildReplyHtml 已提取到 tools.ts 共享模块

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
        this.focusOverlayTarget(null);
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
                    originalBody
                ].join('\n');
            } else {
                prompt = [
                    '你是一个邮件助手。请帮我撰写一封邮件。',
                    '直接给出邮件的正文内容（纯文本），不需要包含邮件头（收件人、主题等），不需要 markdown 格式。',
                    '',
                    `收件人: ${to || '(未指定)'}`,
                    `主题: ${subject || '(未指定)'}`
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
        const termRows = this.openDeskTUI.tui.terminal.rows;
        const termCols = this.openDeskTUI.tui.terminal.columns;

        // 窗口尺寸变化时异步重建列表（自适应）
        if (termRows !== this.lastTermRows || termCols !== this.lastTermCols) {
            const wasTracking = this.lastTermRows > 0;
            this.lastTermRows = termRows;
            this.lastTermCols = termCols;
            if (wasTracking && (this.state === 'list' || this.state === 'search-list')) {
                const isSearch = this.state === 'search-list';
                const prevIdx = this.emailList ? getListIndex(this.emailList) : 0;
                setTimeout(() => {
                    this.buildEmailList(isSearch);
                    if (this.emailList && prevIdx > 0) {
                        this.emailList.setSelectedIndex(prevIdx);
                    }
                }, 0);
            }
        }

        const targetHeight = termRows;
        // Box padding: top 1 + bottom 1 = 2
        const availableForContent = targetHeight - 2;

        this.box.clear();

        switch (this.state) {
            case 'loading':
                this.box.addChild(new MailHeaderBar(this.currentAccount, this.isSyncing));
                this.box.addChild(new VerticalFiller(this.loadingText, availableForContent - 3));
                break;

            case 'list': {
                const listFixedLines = 8 + (this.errorText ? 1 : 0) + (this.isLoadingMore ? 1 : 0);
                const listFlexLines = Math.max(1, availableForContent - listFixedLines);
                const emailCount = this.emailList ? this.emails.length || 1 : 0;
                const listPadLines = Math.max(0, listFlexLines - emailCount);

                this.box.addChild(new MailHeaderBar(this.currentAccount, this.isSyncing)); // 3
                this.box.addChild(new Text('')); // 1
                this.box.addChild(new FilterTabsBar(this.currentFilter)); // 1
                this.box.addChild(new SeparatorLine()); // 1
                if (this.errorText) {
                    this.box.addChild(new Text(MC.red(`  ⚠ ${this.errorText}`))); // 1
                }
                if (this.emailList) {
                    this.box.addChild(this.emailList); // flex
                }
                if (listPadLines > 0) {
                    this.box.addChild(new EmptyFiller(listPadLines));
                }
                if (this.isLoadingMore) {
                    this.box.addChild(new Text(MC.neon('  ⟳ 正在加载更多邮件...'))); // 1
                }
                this.box.addChild(new Text('')); // 1
                const listSelectedIdx = this.emailList ? getListIndex(this.emailList) : 0;
                this.box.addChild(
                    new ListFooter(
                        this.accounts.length > 1,
                        this.emails.length,
                        this.hasMoreEmails,
                        listSelectedIdx,
                        this.emails.length
                    )
                ); // 1
                break;
            }

            case 'search-list': {
                const searchFixedLines = 8 + (this.errorText ? 1 : 0);
                const searchFlexLines = Math.max(1, availableForContent - searchFixedLines);
                const searchEmailCount = this.emailList ? this.emails.length || 1 : 0;
                const searchPadLines = Math.max(0, searchFlexLines - searchEmailCount);

                this.box.addChild(new MailHeaderBar(this.currentAccount, this.isSyncing)); // 3
                this.box.addChild(new Text('')); // 1
                this.box.addChild(new SearchResultsBar(this.searchQuery)); // 1
                this.box.addChild(new SeparatorLine()); // 1
                if (this.errorText) {
                    this.box.addChild(new Text(MC.red(`  ⚠ ${this.errorText}`))); // 1
                }
                if (this.emailList) {
                    this.box.addChild(this.emailList); // flex
                }
                if (searchPadLines > 0) {
                    this.box.addChild(new EmptyFiller(searchPadLines));
                }
                this.box.addChild(new Text('')); // 1
                this.box.addChild(new SearchFooter()); // 1
                break;
            }

            case 'search': {
                const smFixedLines = 10;
                const smFlexLines = Math.max(1, availableForContent - smFixedLines);
                const smEmailCount = this.emailList ? this.emails.length || 1 : 0;
                const smPadLines = Math.max(0, smFlexLines - smEmailCount);

                this.box.addChild(new MailHeaderBar(this.currentAccount, this.isSyncing)); // 3
                this.box.addChild(new Text('')); // 1
                this.box.addChild(
                    new Text(
                        MC.dim(
                            '  输入搜索关键词，支持语法：from: 发件人 | to: 收件人 | subject: 主题 | body: 正文 | date: 日期'
                        )
                    )
                ); // 1
                this.box.addChild(new Text('')); // 1
                if (this.searchInput) {
                    this.box.addChild(new SearchInputWrapper(this.searchInput)); // 1
                }
                this.box.addChild(new SeparatorLine()); // 1
                if (this.emailList) {
                    this.box.addChild(this.emailList); // flex
                }
                if (smPadLines > 0) {
                    this.box.addChild(new EmptyFiller(smPadLines));
                }
                this.box.addChild(new Text('')); // 1
                this.box.addChild(new SearchModeFooter()); // 1
                break;
            }

            case 'assistant': {
                this.box.addChild(new MailHeaderBar(this.currentAccount, this.isSyncing));
                this.box.addChild(new Text(''));
                this.box.addChild(
                    new Text(MC.dim('  描述你的需求，例如：查找最近关于「周报」的邮件；对第3封邮件做摘要。'))
                );
                this.box.addChild(new Text(''));

                // 计算可用空间
                const headerLines = 5; // 标题和提示占 5 行
                const footerLines = 3; // 底部提示和输入框占 3 行
                const conversationLines = Math.max(3, availableForContent - headerLines - footerLines);

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
                this.box.addChild(
                    new AssistantResultFooter(
                        this.assistantResultScrollOffset,
                        this.assistantResultTotalLines,
                        this.assistantResultVisibleLines
                    )
                );
                break;
            }

            case 'detail': {
                const metaH = this.computeMetadataLineCount();
                const hasAtt = (this.selectedEmailContent?.attachments?.length ?? 0) > 0;

                if (this.showAttachmentPanel) {
                    // ── 附件面板内嵌模式 ──
                    // 正文高度与正常详情一致，附件列表占用底部 footer 区域
                    const saveH = this.attachmentSaveInput ? 1 : 0;
                    const errH = this.errorText ? 1 : 0;
                    const attFixedH = 1 + saveH + errH + 1 + 1; // sep + 附件标题 + [另存为] + [错误] + sep + footer
                    const fixedDetailLines = 3 + 1 + metaH + 1 + 1 + attFixedH;
                    const flexArea = Math.max(4, availableForContent - fixedDetailLines);
                    const attListH = Math.min(this.attachmentItems.length, Math.max(2, Math.floor(flexArea * 0.3)));
                    const bodyLines = Math.max(2, flexArea - attListH);

                    this.box.addChild(new DetailHeaderBar());
                    this.box.addChild(new Text(''));
                    if (this.selectedEmail && this.selectedEmailContent) {
                        this.box.addChild(new EmailMetadata(this.selectedEmail, this.selectedEmailContent));
                        this.box.addChild(new SeparatorLine('─'));

                        const bodyView = new ScrollableEmailBody(
                            this.selectedEmailContent,
                            bodyLines,
                            this.detailScrollOffset
                        );
                        this.box.addChild(bodyView);
                        this.detailBodyTotalLines = bodyView.getTotalLines();
                        this.detailBodyVisibleLines = bodyLines;
                    }
                    this.box.addChild(new SeparatorLine());
                    this.box.addChild(new AttachmentInlineHeader(this.attachmentItems.length));
                    if (this.attachmentList) {
                        this.box.addChild(this.attachmentList);
                    }
                    if (this.attachmentSaveInput) {
                        this.box.addChild(new SaveAsField(this.attachmentSaveInput, this.attachmentSaving));
                    }
                    if (this.errorText) {
                        const isSuccess = this.errorText.startsWith('✅');
                        this.box.addChild(
                            new Text(isSuccess ? MC.green(`  ${this.errorText}`) : MC.red(`  ⚠ ${this.errorText}`))
                        );
                    }
                    this.box.addChild(new SeparatorLine());
                    this.box.addChild(new AttachmentFooterBar(!!this.attachmentSaveInput));
                } else {
                    // ── 正常详情模式 ──
                    const fixedDetailLines = 3 + 1 + metaH + 1 + 1 + 1 + 1;
                    const bodyLines = Math.max(3, availableForContent - fixedDetailLines);

                    this.box.addChild(new DetailHeaderBar());
                    this.box.addChild(new Text(''));
                    if (this.selectedEmail && this.selectedEmailContent) {
                        this.box.addChild(new EmailMetadata(this.selectedEmail, this.selectedEmailContent));
                        this.box.addChild(new Text(''));
                        this.box.addChild(new SeparatorLine('─'));

                        const bodyView = new ScrollableEmailBody(
                            this.selectedEmailContent,
                            bodyLines,
                            this.detailScrollOffset
                        );
                        this.box.addChild(bodyView);
                        this.detailBodyTotalLines = bodyView.getTotalLines();
                        this.detailBodyVisibleLines = bodyLines;
                    }
                    this.box.addChild(new SeparatorLine());
                    this.box.addChild(
                        new DetailFooter(
                            this.detailScrollOffset,
                            this.detailBodyTotalLines,
                            this.detailBodyVisibleLines,
                            this.selectedEmail,
                            hasAtt
                        )
                    );
                }
                break;
            }

            case 'compose': {
                const fields = this.getComposeFocusFields();
                const fieldLineCount = 3 + 1; // 收件人 + 抄送 + 主题 + 附件
                const attachmentListLines = this.composeAttachments.length;
                // 错误提示作为附件输入框的一部分显示，不单独占用空间
                const hasQuote = this.composeQuotedText ? 1 : 0;
                const composeFixed = 3 + fieldLineCount + attachmentListLines + 1 + 1 + 1;
                const flexLines = Math.max(3, availableForContent - composeFixed);

                let editorLines: number;
                let quoteLines: number;
                if (this.composeQuotedText) {
                    editorLines = Math.max(3, Math.floor(flexLines * 0.4));
                    quoteLines = Math.max(3, flexLines - editorLines);
                } else {
                    editorLines = flexLines;
                    quoteLines = 0;
                }

                const typeLabel =
                    this.composeType === 'new'
                        ? '写信'
                        : this.composeType === 'replyall'
                          ? '回复全部'
                          : this.composeType === 'forward'
                            ? '转发邮件'
                            : '回复邮件';
                this.box.addChild(new ComposeHeaderBar(typeLabel, this.composeSending, this.isAiGenerating));
                if (this.composeToInput) {
                    this.box.addChild(
                        new ComposeField(
                            '收件人',
                            this.composeToInput,
                            fields[this.composeFocusIdx] === this.composeToInput
                        )
                    );
                }
                if (this.composeCcInput) {
                    this.box.addChild(
                        new ComposeField(
                            '抄  送',
                            this.composeCcInput,
                            fields[this.composeFocusIdx] === this.composeCcInput
                        )
                    );
                }
                if (this.composeSubjectInput) {
                    this.box.addChild(
                        new ComposeField(
                            '主  题',
                            this.composeSubjectInput,
                            fields[this.composeFocusIdx] === this.composeSubjectInput
                        )
                    );
                }
                if (this.composeAttachmentInput) {
                    const attachmentFocused = fields[this.composeFocusIdx] === this.composeAttachmentInput;
                    // 错误提示和成功提示直接显示在附件输入框下方
                    this.box.addChild(
                        new ComposeField(
                            '附  件',
                            this.composeAttachmentInput,
                            attachmentFocused,
                            '输入文件完整路径后按 Enter 添加',
                            this.errorText,
                            this.successText
                        )
                    );
                    if (this.composeAttachments.length > 0) {
                        this.box.addChild(
                            new ComposeAttachmentList(
                                this.composeAttachments,
                                this.composeAttachmentSelectedIdx,
                                attachmentFocused
                            )
                        );
                    }
                }
                this.box.addChild(new SeparatorLine('─'));
                if (this.isAiGenerating) {
                    this.box.addChild(new SpinnerView('AI 正在帮你撰写...', this.aiSpinnerFrame, editorLines));
                } else if (this.composeEditor) {
                    this.box.addChild(new EditorWrapper(this.composeEditor, editorLines));
                }

                if (this.composeQuotedText && quoteLines > 0) {
                    this.box.addChild(new SeparatorLine('┄'));
                    this.box.addChild(
                        new QuotedTextView(this.composeQuotedText, quoteLines, this.composeQuoteScrollOffset)
                    );
                }

                this.box.addChild(new SeparatorLine());
                this.box.addChild(new ComposeFooterBar(this.composeAttachments.length));
                break;
            }
        }

        // 安全截断：清洗控制字符（TAB→空格）后再截断，防止 visibleWidth 与实际渲染宽度不一致
        return this.box.render(width).map((l) => truncateToWidth(sanitizeLine(l), width, '', true));
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 子组件 —— 纯渲染
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class MailHeaderBar implements Component {
    constructor(
        private account: any,
        private syncing: boolean
    ) {}
    invalidate() {}
    render(width: number): string[] {
        const bar = MC.ghost('━'.repeat(width));

        const logo = MC.neonBold('◈');
        const title = MC.neonBold(' OPENDESK MAIL');
        const syncTag = this.syncing ? MC.neon(' ⟳ 同步中') : '';

        const accountName = this.account ? MC.dim(this.account.name || this.account.email) : MC.dim('未配置账号');

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
    invalidate() {}
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
    constructor(private current: FilterType) {}
    invalidate() {}
    render(width: number): string[] {
        const tabs = FILTERS.map((f) => {
            if (f.value === this.current) {
                return MC.neonBold(`[${f.key}:${f.label}]`);
            }
            return MC.ghost(`[${f.key}:${f.label}]`);
        });
        return [truncateToWidth('  ' + tabs.join('  '), width, '…')];
    }
}

class SeparatorLine implements Component {
    constructor(private char: string = '━') {}
    invalidate() {}
    render(width: number): string[] {
        return [MC.ghost(this.char.repeat(width))];
    }
}

/** 空行填充，用于列表项不足时填满剩余空间 */
class EmptyFiller implements Component {
    constructor(private lines: number) {}
    invalidate() {}
    render(_width: number): string[] {
        return Array(this.lines).fill('');
    }
}

/** 加载状态占位：垂直居中显示加载文字，精确填满指定行数 */
class VerticalFiller implements Component {
    constructor(
        private text: string,
        private totalLines: number
    ) {}
    invalidate() {}
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
        private hasMore: boolean,
        private selectedIndex: number,
        private totalCount: number
    ) {}
    invalidate() {}
    render(width: number): string[] {
        // 左侧：位置指示 + 操作提示
        const position =
            this.totalCount > 0 ? MC.neonBold(` ${this.selectedIndex + 1}/${this.totalCount} `) : MC.dim(' 0/0 ');

        const hints = [
            MC.neon('↑↓') + MC.dim(' 选择'),
            MC.neon('←→') + MC.dim(' 翻页'),
            MC.neon('Enter') + MC.dim(' 查看'),
            MC.neon('c') + MC.dim(' 写信'),
            MC.neon('1-5') + MC.dim(' 筛选'),
            MC.neon('s') + MC.dim(' 同步'),
            MC.neon('p') + MC.dim(' 助手'),
            MC.neon('l') + MC.dim(' 搜索')
        ];
        if (this.multiAccount) {
            hints.push(MC.neon('a') + MC.dim(' 切换账号'));
        }
        hints.push(MC.neon('ESC') + MC.dim(' 关闭'));

        const leftText = position + ' ' + hints.join('   ');

        // 右侧：已加载数量
        const rightText = MC.dim(`已加载 ${this.emailCount} 封 `);

        const leftVis = visibleWidth(leftText);
        const rightVis = visibleWidth(rightText);
        const gap = width - leftVis - rightVis;

        if (gap < 1) {
            return [truncateToWidth(leftText, width, '…')];
        }

        return [leftText + ' '.repeat(gap) + rightText];
    }
}

class AssistantFooter implements Component {
    invalidate() {}
    render(width: number): string[] {
        const hints = [MC.neon('Enter') + MC.dim(' 发送'), MC.neon('ESC') + MC.dim(' 返回')];
        return [truncateToWidth('  ' + hints.join('   '), width, '…')];
    }
}

class SearchResultsBar implements Component {
    constructor(private query: string) {}
    invalidate() {}
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
    invalidate() {}
    render(width: number): string[] {
        const hints = [
            MC.neon('↑↓') + MC.dim(' 选择'),
            MC.neon('Enter') + MC.dim(' 查看'),
            MC.neon('ESC') + MC.dim(' 退出搜索')
        ];
        return [truncateToWidth('  ' + hints.join('   '), width, '…')];
    }
}

class SearchModeFooter implements Component {
    invalidate() {}
    render(width: number): string[] {
        const hints = [MC.neon('Enter') + MC.dim(' 搜索'), MC.neon('ESC') + MC.dim(' 取消')];
        return [truncateToWidth('  ' + hints.join('   '), width, '…')];
    }
}

class SearchInputWrapper implements Component {
    constructor(private input: Input) {}
    invalidate() {
        this.input.invalidate();
    }
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
    constructor(
        private email: EmailHeader,
        private content: EmailContent
    ) {}
    invalidate() {}
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
            const names = this.content.attachments.map((a) => a.filename).join(', ');
            lines.push(metaLine('附  件', MC.amber(names)));
        }

        return lines;
    }
}

// ━━━ 撰写子组件 ━━━

class ComposeHeaderBar implements Component {
    constructor(
        private label: string,
        private sending: boolean,
        private aiGen: boolean
    ) {}
    invalidate() {}
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

/** 撰写字段：标签 + Input 内联渲染，支持错误提示和成功提示 */
class ComposeField implements Component {
    constructor(
        private label: string,
        private input: Input,
        private active: boolean,
        private placeholder?: string,
        private errorText?: string,
        private successText?: string
    ) {}
    invalidate() {
        this.input.invalidate();
    }
    render(width: number): string[] {
        const lines: string[] = [];
        const prefix = `  ${MC.dim(this.label + '  ')}`;
        const prefixVis = visibleWidth(prefix);
        const inputW = Math.max(10, width - prefixVis);

        if (this.active) {
            const inputOut = this.input.render(inputW);
            const line = prefix + (inputOut[0] || '');
            lines.push(truncateToWidth(line, width, '…'));
        } else {
            const value = this.input.getValue();
            if (!value && this.placeholder) {
                lines.push(truncateToWidth(prefix + MC.ghost(this.placeholder), width, '…'));
            } else {
                lines.push(truncateToWidth(prefix + MC.text(value), width, '…'));
            }
        }

        // 如果有错误提示，在输入框下方显示
        if (this.errorText) {
            lines.push(MC.red(`  ⚠ ${this.errorText}`));
        }

        // 如果有成功提示，在输入框下方显示
        if (this.successText) {
            lines.push(MC.neon(`  ✓ ${this.successText}`));
        }

        return lines;
    }
}

const SPINNER_CHARS = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

/** AI 生成中的 Spinner 占位视图 */
class SpinnerView implements Component {
    constructor(
        private text: string,
        private frame: number,
        private maxLines: number
    ) {}
    invalidate() {}
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

/** 已添加的附件列表，支持高亮选中项 */
class ComposeAttachmentList implements Component {
    constructor(
        private attachments: Array<{ filename: string; path: string }>,
        private selectedIdx: number,
        private isFocused: boolean
    ) {}
    invalidate() {}
    render(width: number): string[] {
        const lines: string[] = [];
        for (let i = 0; i < this.attachments.length; i++) {
            const a = this.attachments[i];
            const isSelected = this.isFocused && i === this.selectedIdx;
            const prefix = isSelected ? MC.neon('→ ') : '  ';
            const icon = '📎 ';
            const name = isSelected ? MC.neonBold(a.filename) : MC.dim(a.filename);
            const line = `  　　　${prefix}${icon}${name}`;
            lines.push(truncateToWidth(line, width, '…'));
        }
        return lines;
    }
}

class ComposeFooterBar implements Component {
    constructor(private attachmentCount: number = 0) {}
    invalidate() {}
    render(width: number): string[] {
        const hints = [
            MC.neon('Tab') + MC.dim(' 切换字段'),
            MC.neon('Ctrl+S') + MC.dim(' 发送'),
            MC.neon('Ctrl+D') + MC.dim(' 保存草稿'),
            MC.neon('Ctrl+W') + MC.dim(' 帮我写')
        ];
        if (this.attachmentCount > 0) {
            hints.push(MC.neon('↑↓') + MC.dim(' 选附件') + '  ' + MC.neon('Ctrl+X') + MC.dim(' 删除'));
        }
        hints.push(MC.neon('ESC') + MC.dim(' 取消'));
        return [truncateToWidth('  ' + hints.join('   '), width, '…')];
    }
}

/** 回复时在编辑器下方显示的原始邮件引用区域 */
class QuotedTextView implements Component {
    private allLines: string[] = [];

    constructor(
        private quotedText: string,
        private maxLines: number,
        private scrollOffset: number
    ) {
        this.allLines = quotedText.split('\n');
    }

    invalidate() {}

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

        const progress = total > bodyArea ? Math.round((offset / (total - bodyArea)) * 100) : 100;
        const indicator = MC.ghost(
            `  ── 原始邮件 ${progress}%  (${offset + 1}-${Math.min(offset + bodyArea, total)}/${total}行) ──`
        );
        result.push(truncateToWidth(indicator, width, '…'));

        return result;
    }
}

/** 包装 Editor 组件，精确输出 maxLines 行 */
class EditorWrapper implements Component {
    constructor(
        private editor: Editor,
        private maxLines: number
    ) {}
    invalidate() {
        this.editor.invalidate();
    }
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
 * 支持 ↑↓/j/k 逐行滚动、←/→/PgUp/PgDn/Space/b 翻页、g/G 首尾跳转。
 */
class ScrollableEmailBody implements Component {
    private allLines: string[] = [];

    constructor(
        private content: EmailContent,
        private visibleLines: number,
        private scrollOffset: number
    ) {
        this.allLines = this.prepareLines();
    }

    invalidate() {}

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
        const progress = total > bodyArea ? Math.round((offset / (total - bodyArea)) * 100) : 100;
        const scrollBar = this.renderScrollBar(width - 6, bodyArea, total, offset);
        const indicator = MC.dim(
            `  ${scrollBar}  ${progress}%  (${offset + 1}-${Math.min(offset + bodyArea, total)}/${total}行)`
        );
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
        private visibleLines: number
    ) {}
    invalidate() {}
    render(width: number): string[] {
        const hints: string[] = [];

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
        private hasAttachments = false
    ) {}
    invalidate() {}
    render(width: number): string[] {
        const hints: string[] = [];

        // 滚动提示（仅在有溢出时显示）
        if (this.totalLines > this.visibleLines) {
            hints.push(MC.neon('↑↓') + MC.dim(' 滚动'));
            hints.push(MC.neon('←→') + MC.dim(' 翻页'));
        }

        // 操作提示
        if (this.email && this.email.type === 'draft') {
            // 草稿邮件：编辑、删除
            hints.push(MC.neon('e') + MC.dim(' 编辑'));
        } else {
            // 普通邮件：回复、转发、收藏、删除
            hints.push(MC.neon('r') + MC.dim(' 回复'));
            hints.push(MC.neon('R') + MC.dim(' 全部回复'));
            hints.push(MC.neon('w') + MC.dim(' 转发'));
            if (this.hasAttachments) {
                hints.push(MC.neon('o') + MC.dim(' 附件'));
            }
            if (this.email) {
                hints.push(MC.neon('f') + MC.dim(this.email.starred ? ' 取消收藏' : ' 收藏'));
            }
        }
        hints.push(MC.neon('p') + MC.dim(' 助手'));
        hints.push(MC.neon('d') + MC.dim(' 删除'));
        hints.push(MC.neon('q/ESC') + MC.dim(' 返回'));

        return [truncateToWidth('  ' + hints.join('   '), width, '…')];
    }
}

/** 内嵌附件标题行（单行，紧凑） */
class AttachmentInlineHeader implements Component {
    constructor(private count: number) {}
    invalidate() {}
    render(width: number): string[] {
        const icon = MC.neonBold('📎');
        const title = MC.neonBold(` 附件 (${this.count})`);
        return [truncateToWidth(`  ${icon}${title}`, width, '…')];
    }
}

/** 附件面板底部操作提示 */
class AttachmentFooterBar implements Component {
    constructor(private isSaving: boolean) {}
    invalidate() {}
    render(width: number): string[] {
        const hints: string[] = [];
        if (this.isSaving) {
            hints.push(MC.neon('Enter') + MC.dim(' 确认保存'));
            hints.push(MC.neon('ESC') + MC.dim(' 取消'));
        } else {
            hints.push(MC.neon('s') + MC.dim(' 另存为'));
            hints.push(MC.neon('↑↓') + MC.dim(' 选择'));
            hints.push(MC.neon('q/ESC') + MC.dim(' 返回'));
        }
        return [truncateToWidth('  ' + hints.join('   '), width, '…')];
    }
}

/** 另存为路径输入字段 */
class SaveAsField implements Component {
    constructor(
        private input: Input,
        private saving: boolean
    ) {}
    invalidate() {
        this.input.invalidate();
    }
    render(width: number): string[] {
        const label = this.saving ? MC.amber('  保存中... ') : MC.neon('  另存为: ');
        const labelVis = visibleWidth(label);
        const inputW = Math.max(10, width - labelVis - 2);
        const inputLines = this.input.render(inputW);
        return [label + (inputLines[0] || '')];
    }
}
