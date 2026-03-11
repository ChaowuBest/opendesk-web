import { type Component, type OverlayHandle, Box, Text, matchesKey, Key } from "@mariozechner/pi-tui";
import { defaultSelectListTheme } from "../theme";
import type { OpenDeskTUI } from "../entry";
import chalk from "chalk";
import { visibleWidth } from "@mariozechner/pi-tui";
import { InfoOverlay } from "./notice";
import { SelectTable, type SelectRow } from "./selecttable";

// ─── Notification Types & Store ──────────────────────────────

export type NotificationType = 'info' | 'warning' | 'error';
export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface NotificationItem {
    id: string;
    type: NotificationType;
    priority: NotificationPriority;
    source: string;
    title: string;
    message: string;
    timestamp: number;
    read: boolean;
    /** 分组键，同 group 的通知会被折叠 */
    group?: string;
}

type NotificationListener = (item: NotificationItem) => void;

/**
 * 全局通知存储中心（单例）
 * - 存储所有通知历史
 * - 提供未读计数、标记已读等能力
 * - 支持 onChange 变更监听（用于刷新 StatusBar 等外部组件）
 */
export class NotificationStore {
    private static instance: NotificationStore | null = null;

    private items: NotificationItem[] = [];
    private maxItems: number;
    private listeners: NotificationListener[] = [];
    /** 数据变更回调（增删改都会触发），用于刷新 StatusBar 等外部组件 */
    private changeListeners: (() => void)[] = [];

    static getInstance(): NotificationStore {
        if (!NotificationStore.instance) {
            NotificationStore.instance = new NotificationStore();
        }
        return NotificationStore.instance;
    }

    private constructor() {
        this.maxItems = 200;
    }

    /**
     * 添加一条通知
     */
    push(type: NotificationType, source: string, title: string, message: string, options?: {
        priority?: NotificationPriority;
        group?: string;
    }): NotificationItem {
        const item: NotificationItem = {
            id: crypto.randomUUID(),
            type,
            priority: options?.priority ?? 'normal',
            source,
            title,
            message,
            timestamp: Date.now(),
            read: false,
            group: options?.group,
        };

        this.items.push(item);
        this.evict();

        // 通知监听者（toast 弹窗）
        for (const listener of this.listeners) {
            listener(item);
        }

        this.notifyChange();
        return item;
    }

    /**
     * 注册新通知到达的监听器
     */
    onNotification(listener: NotificationListener): () => void {
        this.listeners.push(listener);
        return () => {
            this.listeners = this.listeners.filter(l => l !== listener);
        };
    }

    /**
     * 注册数据变更监听器（增删改都会触发），返回取消注册函数
     */
    onChange(listener: () => void): () => void {
        this.changeListeners.push(listener);
        return () => {
            this.changeListeners = this.changeListeners.filter(l => l !== listener);
        };
    }

    private notifyChange(): void {
        for (const listener of this.changeListeners) {
            try { listener(); } catch { /* ignore */ }
        }
    }

    /**
     * 获取所有通知（最新在前）
     */
    getAll(): NotificationItem[] {
        return [...this.items].reverse();
    }

    /**
     * 未读通知数
     */
    getUnreadCount(): number {
        return this.items.filter(i => !i.read).length;
    }

    /**
     * 按优先级获取未读数
     */
    getUnreadCountByPriority(): Record<NotificationPriority, number> {
        const counts: Record<NotificationPriority, number> = { low: 0, normal: 0, high: 0, urgent: 0 };
        for (const item of this.items) {
            if (!item.read) {
                counts[item.priority]++;
            }
        }
        return counts;
    }

    /**
     * 标记单条为已读
     */
    markRead(id: string): void {
        const item = this.items.find(i => i.id === id);
        if (item) {
            item.read = true;
            this.notifyChange();
        }
    }

    /**
     * 标记全部已读
     */
    markAllRead(): void {
        for (const item of this.items) {
            item.read = true;
        }
        this.notifyChange();
    }

    /**
     * 删除单条通知
     */
    remove(id: string): void {
        this.items = this.items.filter(i => i.id !== id);
        this.notifyChange();
    }

    /**
     * 清空所有通知
     */
    clear(): void {
        this.items = [];
        this.notifyChange();
    }

    /**
     * 淘汰策略：超出上限时优先删除最旧的已读通知，再删未读
     */
    private evict(): void {
        if (this.items.length <= this.maxItems) return;

        // 先删已读
        const readItems = this.items.filter(i => i.read);
        const unreadItems = this.items.filter(i => !i.read);

        if (unreadItems.length >= this.maxItems) {
            // 未读都满了，只保留最新的 maxItems 条
            this.items = unreadItems.slice(-this.maxItems);
        } else {
            // 保留所有未读 + 最新的已读
            const readToKeep = this.maxItems - unreadItems.length;
            this.items = [...readItems.slice(-readToKeep), ...unreadItems];
            // 按时间排序
            this.items.sort((a, b) => a.timestamp - b.timestamp);
        }
    }
}

// ─── Toast Overlay (非阻塞左上角弹窗) ──────────────────────

const ICON_MAP: Record<NotificationType, string> = {
    info: '✅',
    warning: '⚠️',
    error: '❌',
};

const COLOR_MAP: Record<NotificationType, (text: string) => string> = {
    info: (t: string) => chalk.green(t),
    warning: (t: string) => chalk.yellow(t),
    error: (t: string) => chalk.red(t),
};

const PRIORITY_BADGE: Record<NotificationPriority, string> = {
    low: '',
    normal: '',
    high: chalk.bgYellow.black(' ! '),
    urgent: chalk.bgRed.white(' ‼ '),
};

/**
 * 单条 Toast 的完整渲染组件（带边框，左上角弹窗）
 */
class ToastComponent implements Component {
    private item: NotificationItem;

    constructor(item: NotificationItem) {
        this.item = item;
    }

    invalidate(): void { /* noop */ }

    render(width: number): string[] {
        const { type, source, title, message, priority } = this.item;
        const icon = ICON_MAP[type];
        const colorFn = COLOR_MAP[type];
        const badge = PRIORITY_BADGE[priority];

        const borderColor = type === 'error' ? '#f38ba8' : type === 'warning' ? '#f9e2af' : '#a6e3a1';
        const bgFn = (text: string) => chalk.bgHex('#1e1e2e').hex('#cdd6f4')(text);
        const borderFn = chalk.hex(borderColor);

        const innerWidth = Math.max(1, width - 2);
        const lines: string[] = [];

        // 顶部边框
        lines.push(bgFn(borderFn('┌' + '─'.repeat(innerWidth) + '┐')));

        // 标题行
        const titleContent = `${icon} ${chalk.bold(title)}${badge ? ' ' + badge : ''}`;
        const sourceTag = chalk.dim(`@${source}`);
        const titleText = `${titleContent} ${sourceTag}`;
        const titleVis = visibleWidth(titleText);
        const titlePad = Math.max(0, innerWidth - titleVis - 1);
        lines.push(bgFn(borderFn('│') + ' ' + titleText + ' '.repeat(titlePad) + borderFn('│')));

        // 消息行（最多 2 行）
        if (message) {
            const msgLines = wrapText(message, innerWidth - 2);
            for (const ml of msgLines.slice(0, 2)) {
                const mlVis = visibleWidth(ml);
                const mlPad = Math.max(0, innerWidth - mlVis - 2);
                lines.push(bgFn(borderFn('│') + ' ' + colorFn(ml) + ' '.repeat(mlPad) + ' ' + borderFn('│')));
            }
            if (msgLines.length > 2) {
                const dots = chalk.dim('...');
                const dotsVis = visibleWidth(dots);
                const dotsPad = Math.max(0, innerWidth - dotsVis - 2);
                lines.push(bgFn(borderFn('│') + ' ' + dots + ' '.repeat(dotsPad) + ' ' + borderFn('│')));
            }
        }

        // 时间戳行
        const timeStr = chalk.dim(formatTime(this.item.timestamp));
        const timeVis = visibleWidth(timeStr);
        const timePad = Math.max(0, innerWidth - timeVis - 2);
        lines.push(bgFn(borderFn('│') + ' ' + timeStr + ' '.repeat(timePad) + ' ' + borderFn('│')));

        // 底部边框
        lines.push(bgFn(borderFn('└' + '─'.repeat(innerWidth) + '┘')));

        return lines;
    }
}

/**
 * Toast 容器：管理左上角的 toast 弹窗队列
 * 支持自动消失、堆叠显示、优先级排序
 */
export class ToastManager {
    private openDeskTUI: OpenDeskTUI;
    private activeToasts: {
        item: NotificationItem;
        handle: OverlayHandle;
        timer: ReturnType<typeof setTimeout>;
    }[] = [];
    private maxVisible = 3;
    private unsubscribe?: () => void;

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;
    }

    /**
     * 开始监听通知并弹出 toast
     */
    start(): void {
        const store = NotificationStore.getInstance();
        this.unsubscribe = store.onNotification((item) => {
            this.showToast(item);
        });
    }

    /**
     * 停止监听并清除所有 toast
     */
    stop(): void {
        this.unsubscribe?.();
        this.dismissAll();
    }

    /**
     * 立即清除所有当前显示的 toast（不停止监听）
     * 用于打开通知中心时移除残留的 toast 弹窗
     */
    dismissAll(): void {
        for (const toast of this.activeToasts) {
            clearTimeout(toast.timer);
            toast.handle.hide();
        }
        this.activeToasts = [];
        this.openDeskTUI.tui.requestRender();
    }

    private showToast(item: NotificationItem): void {
        // 如果已达到最大显示数，移除最旧的
        while (this.activeToasts.length >= this.maxVisible) {
            const oldest = this.activeToasts.shift();
            if (oldest) {
                clearTimeout(oldest.timer);
                oldest.handle.hide();
            }
        }

        const component = new ToastComponent(item);
        const termWidth = this.openDeskTUI.tui.terminal.columns;
        const toastWidth = Math.min(50, termWidth - 4);

        const offsetY = this.activeToasts.length * 6

        // showOverlay 会自动将焦点转移到 overlay 组件，需要先保存当前焦点
        const previousFocus = this.openDeskTUI.tui['focusedComponent'] as Component | null;

        const handle = this.openDeskTUI.tui.showOverlay(component, {
            width: toastWidth,
            maxHeight: 8,
            anchor: 'top-left',
            offsetX: 0,
            offsetY: offsetY,
        });

        // Toast 是纯展示型组件，不应抢占焦点，立即恢复之前的焦点
        if (previousFocus) {
            this.openDeskTUI.tui.setFocus(previousFocus);
        }

        // 自动消失时间根据优先级调整
        const durations: Record<NotificationPriority, number> = {
            low: 2000,
            normal: 3000,
            high: 5000,
            urgent: 8000,
        };

        const timer = setTimeout(() => {
            this.removeToast(item.id);
        }, durations[item.priority]);

        this.activeToasts.push({ item, handle, timer });
        this.openDeskTUI.tui.requestRender();
    }

    private removeToast(id: string): void {
        const index = this.activeToasts.findIndex(t => t.item.id === id);
        if (index !== -1) {
            const toast = this.activeToasts[index];
            clearTimeout(toast.timer);
            toast.handle.hide();
            this.activeToasts.splice(index, 1);
            this.openDeskTUI.tui.requestRender();
        }
    }
}

// ─── Notification Center Overlay (通知中心) ─────────────────

class Splitter implements Component {
    invalidate(): void { /* noop */ }
    render(width: number): string[] {
        return [chalk.hex('#b6b6b6')('━'.repeat(width))];
    }
}

/**
 * 通知中心 Overlay：显示所有历史通知
 * 支持筛选（全部/未读/已读）、标记已读、清空、免打扰切换
 *
 * 自身实现 handleInput 来拦截自定义按键（a/d/c/f/n），
 * 其余按键（上下）转发给内部 SelectTable。
 * Enter 和 Esc 由 overlay 自身处理（不转发给 SelectTable）。
 */
export class NotificationCenterOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private table: SelectTable;
    private header: Text;
    private footer: Text;
    private box: Box;
    private filter: 'all' | 'unread' | 'read' = 'all';
    private overlayHandle?: OverlayHandle;
    /** 列表可见行数，在 show() 时根据终端高度计算 */
    private listMaxVisible = 15;

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;

        const rows = this.buildTableRows();
        this.table = new SelectTable(rows, this.listMaxVisible, defaultSelectListTheme);
        this.table.setColumnStrechFactors([0, 0, 1, 0]);
        this.table.setAlignments(['left', 'left', 'left', 'right']);

        this.header = new Text(this.buildHeaderText());
        this.footer = new Text(chalk.dim('  Enter 查看 │ a 全部已读 │ d 删除 │ c 清空 │ f 切换筛选 │ Esc 关闭'));

        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#1e1e2e').hex('#cdd6f4')(text));
        this.rebuildBox();
    }

    private buildHeaderText(): string {
        const store = NotificationStore.getInstance();
        const unreadCount = store.getUnreadCount();
        const total = store.getAll().length;
        const FILTER_LABELS: Record<typeof this.filter, string> = {
            all: '全部',
            unread: '未读',
            read: '已读',
        };
        const filterLabel = chalk.dim(` [${FILTER_LABELS[this.filter]}]`);
        return chalk.bold(`🔔 通知中心`) + chalk.dim(` (${unreadCount}/${total})`) + filterLabel;
    }

    private rebuildBox(): void {
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#1e1e2e').hex('#cdd6f4')(text));
        this.box.addChild(this.header);
        this.box.addChild(new Splitter());
        this.box.addChild(new Text(''));
        this.box.addChild(this.table);
        this.box.addChild(new Text(''));
        this.box.addChild(this.footer);
    }

    private buildTableRows(): SelectRow[] {
        const store = NotificationStore.getInstance();
        let notifications = store.getAll();

        // 按筛选条件过滤
        if (this.filter === 'unread') {
            notifications = notifications.filter(n => !n.read);
        } else if (this.filter === 'read') {
            notifications = notifications.filter(n => n.read);
        }

        if (notifications.length === 0) {
            const hint = this.filter === 'unread' ? '暂无未读通知'
                       : this.filter === 'read' ? '暂无已读通知'
                       : '暂无通知';
            return [{ value: '__empty__', labels: ['', '', chalk.dim(hint), ''] }];
        }

        return notifications.map(item => {
            const icon = ICON_MAP[item.type];
            const readMark = item.read ? '○' : '●';
            const priorityMark = item.priority === 'urgent' ? ' ‼' : item.priority === 'high' ? ' !' : '';
            const titleCol = `${item.title}${priorityMark}`;
            const desc = `@${item.source}  ${item.message.slice(0, 60)}${item.message.length > 60 ? '...' : ''}`;
            return {
                value: item.id,
                labels: [`${readMark} ${icon}`, titleCol, desc, formatRelativeTime(item.timestamp)],
            };
        });
    }

    private refreshList(): void {
        const rows = this.buildTableRows();
        this.header.setText(this.buildHeaderText());
        this.table = new SelectTable(rows, this.listMaxVisible, defaultSelectListTheme);
        this.table.setColumnStrechFactors([0, 0, 1, 0]);
        this.table.setAlignments(['left', 'left', 'left', 'right']);
        this.rebuildBox();
        this.openDeskTUI.tui.requestRender();
    }

    private close(): void {
        if (this.overlayHandle) {
            this.overlayHandle.hide();
        }
        this.openDeskTUI.hasOpenOverlay = false;
        this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
    }

    /**
     * 自身拦截 Esc / Enter / 自定义按键，其余转发给 SelectTable（上下翻页）
     */
    handleInput(keyData: string): void {
        const store = NotificationStore.getInstance();

        // Esc → 关闭
        if (matchesKey(keyData, Key.escape)) {
            this.close();
            return;
        }

        // Enter → 查看详情并标记已读
        if (matchesKey(keyData, Key.enter)) {
            const selected = this.table.innerList.getSelectedItem();
            if (selected && selected.value !== '__empty__') {
                const notification = store.getAll().find(n => n.id === selected.value);
                if (notification) {
                    store.markRead(notification.id);
                    this.refreshList();
                    // 弹出详情，关闭后焦点回到通知中心
                    const info = new InfoOverlay(this.openDeskTUI, {
                        title: `${ICON_MAP[notification.type]} ${notification.title}`,
                        message: [
                            notification.message,
                            '',
                            `来源: ${notification.source}`,
                            `优先级: ${notification.priority}`,
                            `时间: ${new Date(notification.timestamp).toLocaleString()}`,
                            notification.group ? `分组: ${notification.group}` : '',
                        ].filter(Boolean).join('\n'),
                        closeLabel: "确定"
                    });
                    info.show(() => {
                        // InfoOverlay 关闭后，将焦点还给通知中心
                        this.openDeskTUI.hasOpenOverlay = true;
                        this.openDeskTUI.tui.setFocus(this);
                    });
                }
            }
            return;
        }

        // ── 自定义快捷键 ──
        if (keyData === 'a') {
            // 全部标记已读
            store.markAllRead();
            this.refreshList();
            return;
        }
        if (keyData === 'd') {
            // 删除选中通知
            const selected = this.table.innerList.getSelectedItem();
            if (selected && selected.value !== '__empty__') {
                store.remove(selected.value);
                this.refreshList();
            }
            return;
        }
        if (keyData === 'c') {
            // 清空所有通知
            store.clear();
            this.refreshList();
            return;
        }
        if (keyData === 'f') {
            // 循环切换筛选：全部 → 未读 → 已读 → 全部
            const cycle: Record<typeof this.filter, typeof this.filter> = {
                all: 'unread',
                unread: 'read',
                read: 'all',
            };
            this.filter = cycle[this.filter];
            this.refreshList();
            return;
        }

        // 其余按键（上下翻页等）转发给 SelectTable
        this.table.handleInput(keyData);
    }

    invalidate(): void {
        this.box.invalidate();
    }

    render(width: number): string[] {
        return this.box.render(width);
    }

    show(): void {
        const termWidth = this.openDeskTUI.tui.terminal.columns;
        const termHeight = this.openDeskTUI.tui.terminal.rows;
        const overlayWidth = Math.min(80, termWidth - 4);
        const overlayMaxHeight = Math.max(12, termHeight - 4);

        // 根据终端高度计算列表可见行数（减去 header/footer/padding 约 8 行）
        this.listMaxVisible = Math.max(3, overlayMaxHeight - 8);
        this.refreshList(); // 用新的 maxVisible 重建列表

        this.overlayHandle = this.openDeskTUI.tui.showOverlay(this, {
            width: overlayWidth,
            maxHeight: overlayMaxHeight,
            anchor: 'center',
        });

        this.openDeskTUI.hasOpenOverlay = true;
        // 焦点设到自身，这样 handleInput 才能拦截自定义按键
        this.openDeskTUI.tui.setFocus(this);
    }
}

// ─── StatusBar 通知角标 ─────────────────────────────────────

/**
 * 获取状态栏通知角标文本
 * 用于在 StatusBar 右侧显示未读通知数
 */
export function getNotificationBadge(): string {
    const store = NotificationStore.getInstance();
    const unread = store.getUnreadCount();
    if (unread === 0) return '';

    const byPriority = store.getUnreadCountByPriority();
    if (byPriority.urgent > 0) {
        return chalk.bgRed.white(` 🔔 ${unread} `);
    }
    if (byPriority.high > 0) {
        return chalk.bgYellow.black(` 🔔 ${unread} `);
    }
    return chalk.hex('#d4d4d4')(` 🔔 ${unread} `);
}

// ─── Utility functions ──────────────────────────────────────

function wrapText(text: string, maxWidth: number): string[] {
    if (maxWidth <= 0) return [text];
    const lines: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (visibleWidth(remaining) <= maxWidth) {
            lines.push(remaining);
            break;
        }
        // 简单按字符截断（考虑 CJK 宽度）
        let cutPoint = 0;
        let currentWidth = 0;
        for (let i = 0; i < remaining.length; i++) {
            const charCode = remaining.charCodeAt(i);
            const charWidth = (charCode >= 0x4e00 && charCode <= 0x9fff) ||
                              (charCode >= 0x3000 && charCode <= 0x303f) ||
                              (charCode >= 0xff00 && charCode <= 0xffef) ? 2 : 1;
            if (currentWidth + charWidth > maxWidth) break;
            currentWidth += charWidth;
            cutPoint = i + 1;
        }
        if (cutPoint === 0) cutPoint = 1;
        lines.push(remaining.slice(0, cutPoint));
        remaining = remaining.slice(cutPoint);
    }
    return lines;
}

function formatTime(timestamp: number): string {
    const d = new Date(timestamp);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function formatRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return '刚刚';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    return `${days}天前`;
}
