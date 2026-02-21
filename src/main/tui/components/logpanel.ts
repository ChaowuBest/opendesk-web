
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

import type { Component, TUI } from '@mariozechner/pi-tui';
import { Card } from './card';
import chalk from 'chalk';
import { getLines, subscribe } from '../../utils/cliLogStore.js';

export type LogPanelMode = 'off' | 'last' | 'all';

type LogPanelChangeCallback = (mode: LogPanelMode) => void;

/**
 * 日志面板组件，显示从 cliLogStore 订阅的日志，支持三种显示模式：
 *  - off: 不显示
 *  - last: 显示最后10条，有圆角边框
 *  - all: 显示全部，全屏日志
 */
export class LogPanel implements Component {
    private _mode: LogPanelMode = 'off';
    private _lines: string[] = [];
    private _tui?: TUI;
    private _unsubscribe?: () => void;
    private _onModeChange?: LogPanelChangeCallback;
    private invalidated = true;
    private lastWidth?: number;
    private cachedOutput?: string[];

    constructor(tui?: TUI) {
        this._tui = tui;
        this._lines = getLines();
        this._unsubscribe = subscribe(() => {
            this._lines = getLines();
            this.invalidated = true;
            this._tui?.requestRender();
        });
    }

    /**
     * 设置 TUI 引用，用于请求渲染
     */
    setTUI(tui: TUI) {
        this._tui = tui;
    }

    /**
     * 设置模式变更回调，当日志面板模式变更时通知
     */
    onModeChange(callback: LogPanelChangeCallback) {
        this._onModeChange = callback;
    }

    /**
     * 获取当前模式
     */
    get mode(): LogPanelMode {
        return this._mode;
    }

    /**
     * 设置显示模式
     */
    setMode(mode: LogPanelMode) {
        const oldMode = this._mode;
        this._mode = mode;
        if (oldMode !== mode && this._onModeChange) {
            this._onModeChange(mode);
        }
        this.invalidated = true;
        this._tui?.requestRender();
    }

    invalidate() {
        this.invalidated = true;
    }

    /**
     * 清理资源
     */
    destroy() {
        if (this._unsubscribe) {
            this._unsubscribe();
            this._unsubscribe = undefined;
        }
    }

    render(width: number): string[] {
        if (!this.invalidated && this.lastWidth === width && this.cachedOutput) {
            return this.cachedOutput;
        }
        this.lastWidth = width;

        if (this._mode === 'off') {
            this.cachedOutput = [];
            this.invalidated = false;
            return this.cachedOutput;
        }

        // 准备要显示的日志行
        let displayLines: string[];
        let title: string;

        if (this._mode === 'last') {
            displayLines = this._lines.slice(-10);
            title = '📋 日志 (最后 10 条)';
        } else {
            displayLines = this._lines;
            title = '📋 日志';
        }

        // 使用 Card 组件渲染
        const card = new Card({
            title,
            body: displayLines,
            maxLines: this._mode === 'all' ? undefined : 12,
            truncateStrategy: 'tail'
        });

        this.cachedOutput = card.render(width);
        this.invalidated = false;
        return this.cachedOutput;
    }
}
