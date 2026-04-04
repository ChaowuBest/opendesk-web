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
    SelectList,
    Box,
    Text,
    Input,
    Key,
    matchesKey,
    truncateToWidth,
    wrapTextWithAnsi
} from '@mariozechner/pi-tui';
import chalk from 'chalk';
import { defaultSelectListTheme } from '../../tui/theme';
import { OpenDeskTUI } from '../../tui/entry';
import { SkillTestFramework, type TestSuiteResult } from './skill-test.js';
import { SkillRegistry } from './skillregistry.js';

type TestViewState = 'main' | 'select-skill' | 'running' | 'results' | 'test-detail';

export class SkillTestOverlay implements Component {
    private openDeskTUI: OpenDeskTUI;
    private box: Box;
    private header: Text;
    private list?: SelectList;
    private input?: Input;
    private state: TestViewState = 'main';
    private message: { text: string; isError: boolean } | null = null;
    private loading = false;
    private removeInputListener?: () => void;
    private messageTimeout?: NodeJS.Timeout;
    private overlayHandle?: any;
    private testableSkills: string[] = [];
    private currentResult: TestSuiteResult | null = null;
    private selectedTestIndex = 0;
    private resultScrollOffset = 0;
    private detailScrollOffset = 0;
    private detailContentLines: string[] = [];
    private resultContentLines: string[] = [];
    private testStartLineIndex = 0;

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;
        this.header = new Text(chalk.bold(' 技能测试'));
        this.box = new Box(1, 1);
        this.box.setBgFn((text: string) => chalk.bgHex('#1a1a2e').hex('#e0e0e0')(text));
        this.box.addChild(this.header);
    }

    private async loadTestableSkills() {
        try {
            this.testableSkills = SkillTestFramework.listTestableSkills();
        } catch (e) {
            this.testableSkills = [];
        }
    }

    private showMessage(text: string, isError: boolean = false) {
        if (this.messageTimeout) {
            clearTimeout(this.messageTimeout);
        }
        this.message = { text, isError };
        this.renderBox();
        this.messageTimeout = setTimeout(() => {
            this.message = null;
            this.renderBox();
        }, 3000);
    }

    private setLoading(loading: boolean) {
        this.loading = loading;
        this.renderBox();
    }

    private cleanup() {
        if (this.removeInputListener) {
            this.removeInputListener();
            this.removeInputListener = undefined;
        }
        this.loading = false;
    }

    private showMain() {
        this.cleanup();
        this.state = 'main';
        this.input = undefined;
        this.currentResult = null;
        this.header = new Text(chalk.bold(' 技能测试'));

        const items = [
            { value: 'select', label: chalk.cyan('🔍 选择技能进行测试') },
            { value: 'input', label: chalk.green('⌨️ 输入技能名称测试') },
            { value: 'all', label: chalk.yellow('📋 测试所有可测试技能') }
        ];

        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.setupListHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.list);
    }

    private showSelectSkill() {
        this.cleanup();
        this.state = 'select-skill';
        this.input = undefined;

        this.header = new Text(chalk.bold(' 选择技能'));

        if (this.testableSkills.length === 0) {
            const items = [{ value: 'back', label: chalk.gray('没有可测试的技能，按 Enter 返回') }];
            this.list = new SelectList(items, 1, defaultSelectListTheme);
        } else {
            const items = this.testableSkills.map((skillId) => {
                const skill = SkillRegistry.getSkillBody(skillId);
                const name = skill?.frontmatter?.name || skillId;
                const desc = skill?.frontmatter?.description || '';
                const truncatedDesc = truncateToWidth(desc, 30, '...', false);
                return {
                    value: skillId,
                    label: `${chalk.bold(name)} ${chalk.dim('·')} ${chalk.dim(truncatedDesc)}`
                };
            });
            this.list = new SelectList(items, Math.min(items.length, 10), defaultSelectListTheme);
        }

        this.setupListHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.list);
    }

    private showInputSkill() {
        this.cleanup();
        this.state = 'select-skill';
        this.list = undefined;

        this.header = new Text(chalk.bold(' 输入技能名称'));

        this.input = new Input();
        this.input.onSubmit = () => {
            this.runTestForSkill(this.input?.getValue().trim() || '').catch((err) => {
                console.error('Test error:', err);
            });
        };

        this.setupInputHandlers();
        this.renderBox();
        this.openDeskTUI.tui.setFocus(this.input);
    }

    private async runTestForSkill(skillId: string) {
        if (!skillId) {
            this.showMessage('请输入技能名称', true);
            return;
        }

        this.setLoading(true);
        this.state = 'running';
        this.renderBox();

        try {
            const result = await SkillTestFramework.runSkillTests(skillId);

            if (!result) {
                this.showMessage(`技能 "${skillId}" 不存在`, true);
                this.showMain();
                return;
            }

            this.currentResult = result;
            this.showResults();
        } catch (e: any) {
            this.showMessage(e?.message || '测试失败', true);
            this.showMain();
        } finally {
            this.setLoading(false);
        }
    }

    private async runAllTests() {
        if (this.testableSkills.length === 0) {
            this.showMessage('没有可测试的技能', true);
            return;
        }

        this.setLoading(true);
        this.state = 'running';
        this.renderBox();

        let totalPassed = 0;
        let totalFailed = 0;
        let totalTests = 0;

        for (const skillId of this.testableSkills) {
            try {
                const result = await SkillTestFramework.runSkillTests(skillId);
                if (result) {
                    totalPassed += result.summary.passed;
                    totalFailed += result.summary.failed + result.summary.error;
                    totalTests += result.summary.total;
                }
            } catch (e) {
                totalFailed++;
            }
        }

        this.setLoading(false);
        this.showMessage(`测试完成: ${totalPassed}/${totalTests} 通过, ${totalFailed} 失败`, totalFailed > 0);
        this.showMain();
    }

    private showResults() {
        this.cleanup();
        this.state = 'results';
        this.list = undefined;
        this.input = undefined;
        this.resultScrollOffset = 0;
        this.selectedTestIndex = 0;
        this.resultContentLines = [];
        this.testStartLineIndex = 0;

        if (!this.currentResult) {
            this.showMain();
            return;
        }

        const result = this.currentResult;
        const statusIcon =
            result.summary.failed === 0 && result.summary.error === 0 ? chalk.green('✓') : chalk.red('✗');

        this.header = new Text(chalk.bold(` 测试结果 ${statusIcon} ${result.skillName}`));

        this.buildResultContent();
        this.renderBox();

        this.removeInputListener = this.openDeskTUI.tui.addInputListener((data: string) => {
            if (matchesKey(data, Key.escape)) {
                this.currentResult = null;
                this.showMain();
                return { consume: true };
            }
            if (matchesKey(data, Key.up) || data === 'k') {
                if (this.selectedTestIndex > 0) {
                    this.selectedTestIndex--;
                    this.buildResultContent();
                    this.adjustScrollOffset();
                    this.renderBox();
                }
                return { consume: true };
            }
            if (matchesKey(data, Key.down) || data === 'j') {
                if (this.currentResult && this.selectedTestIndex < this.currentResult.tests.length - 1) {
                    this.selectedTestIndex++;
                    this.buildResultContent();
                    this.adjustScrollOffset();
                    this.renderBox();
                }
                return { consume: true };
            }
            if (matchesKey(data, Key.pageUp) || data === 'b' || data === 'B') {
                const h = this.contentHeight;
                this.resultScrollOffset = Math.max(0, this.resultScrollOffset - h);
                this.buildResultContent();
                this.adjustScrollOffset();
                this.renderBox();
                return { consume: true };
            }
            if (matchesKey(data, Key.pageDown) || data === 'f' || data === 'F') {
                const h = this.contentHeight;
                const maxOffset = Math.max(0, this.resultContentLines.length - h);
                this.resultScrollOffset = Math.min(maxOffset, this.resultScrollOffset + h);
                this.buildResultContent();
                this.adjustScrollOffset();
                this.renderBox();
                return { consume: true };
            }
            if (data === 'g') {
                this.selectedTestIndex = 0;
                this.resultScrollOffset = 0;
                this.buildResultContent();
                this.renderBox();
                return { consume: true };
            }
            if (data === 'G') {
                if (this.currentResult && this.currentResult.tests.length > 0) {
                    this.selectedTestIndex = this.currentResult.tests.length - 1;
                    this.buildResultContent();
                    const maxOffset = Math.max(0, this.resultContentLines.length - this.contentHeight);
                    this.resultScrollOffset = maxOffset;
                    this.renderBox();
                }
                return { consume: true };
            }
            if (data === 'r' || data === 'R') {
                if (this.currentResult) {
                    this.runTestForSkill(this.currentResult.skillId);
                }
                return { consume: true };
            }
            if (matchesKey(data, Key.enter)) {
                this.showTestDetail();
                return { consume: true };
            }
            return undefined;
        });
    }

    private showTestDetail() {
        if (!this.currentResult || this.currentResult.tests.length === 0) return;

        this.cleanup();
        this.state = 'test-detail';
        this.list = undefined;
        this.input = undefined;
        this.detailScrollOffset = 0;
        this.detailContentLines = [];

        const test = this.currentResult.tests[this.selectedTestIndex];
        this.header = new Text(chalk.bold(` 测试详情: ${test.name}`));

        this.buildDetailContent();
        this.renderBox();

        this.removeInputListener = this.openDeskTUI.tui.addInputListener((data: string) => {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
                this.showResults();
                return { consume: true };
            }
            if (matchesKey(data, Key.up) || data === 'k') {
                if (this.detailScrollOffset > 0) {
                    this.detailScrollOffset--;
                    this.renderBox();
                }
                return { consume: true };
            }
            if (matchesKey(data, Key.down) || data === 'j') {
                const maxOffset = Math.max(0, this.detailContentLines.length - this.contentHeight);
                if (this.detailScrollOffset < maxOffset) {
                    this.detailScrollOffset++;
                    this.renderBox();
                }
                return { consume: true };
            }
            if (matchesKey(data, Key.pageUp) || data === 'b' || data === 'B') {
                this.detailScrollOffset = Math.max(0, this.detailScrollOffset - this.contentHeight);
                this.renderBox();
                return { consume: true };
            }
            if (matchesKey(data, Key.pageDown) || data === 'f' || data === 'F') {
                const maxOffset = Math.max(0, this.detailContentLines.length - this.contentHeight);
                this.detailScrollOffset = Math.min(maxOffset, this.detailScrollOffset + this.contentHeight);
                this.renderBox();
                return { consume: true };
            }
            if (data === 'g') {
                this.detailScrollOffset = 0;
                this.renderBox();
                return { consume: true };
            }
            if (data === 'G') {
                const maxOffset = Math.max(0, this.detailContentLines.length - this.contentHeight);
                this.detailScrollOffset = maxOffset;
                this.renderBox();
                return { consume: true };
            }
            return undefined;
        });
    }

    /** 清洗进程输出用于 TUI 显示：统一换行、去除 ANSI、替换控制字符，避免乱码与 \r 导致只显示末尾 */
    private sanitizeForDisplay(raw: string): string {
        if (!raw || typeof raw !== 'string') return '';
        let s = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        s = s.replace(/\x1b\[[0-9;]*[mGKHJ]/g, '');
        s = s.replace(/\x1b\]8;;[^\x07]*\x07/g, '');
        s = s.replace(/\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
        return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ');
    }

    private buildDetailContent() {
        this.detailContentLines = [];
        if (!this.currentResult) return;

        const test = this.currentResult.tests[this.selectedTestIndex];
        const terminalWidth = this.openDeskTUI.tui.terminal.columns;
        const overlayWidth = Math.min(90, terminalWidth - 4);
        const innerWidth = Math.max(20, overlayWidth - 2);
        const contentWidth = Math.max(16, innerWidth - 4);

        this.detailContentLines.push(`${chalk.bold('名称')}: ${test.name}`);
        this.detailContentLines.push(
            `${chalk.bold('文件')}: ${truncateToWidth(test.file, innerWidth - 6, '…', false)}`
        );
        this.detailContentLines.push(`${chalk.bold('状态')}: ${this.formatStatus(test.status)}`);
        this.detailContentLines.push(`${chalk.bold('耗时')}: ${test.duration}ms`);

        if (test.message) {
            const msgLines = wrapTextWithAnsi(`${chalk.bold('消息')}: ${test.message}`, innerWidth);
            for (const ml of msgLines) {
                this.detailContentLines.push(ml);
            }
        }

        if (test.status === 'failed' || test.status === 'error') {
            this.detailContentLines.push('');
            const sep = '── 失败分析 ' + '─'.repeat(Math.max(0, innerWidth - 14));
            this.detailContentLines.push(chalk.dim(sep));

            if (test.suggestion) {
                const suggestionLines = test.suggestion.split('\n');
                for (const line of suggestionLines) {
                    const wrapped = wrapTextWithAnsi(line, innerWidth);
                    for (const w of wrapped) {
                        if (line.startsWith('原因:')) {
                            this.detailContentLines.push(chalk.yellow(w));
                        } else if (line.startsWith('建议:')) {
                            this.detailContentLines.push(chalk.green(w));
                        } else {
                            this.detailContentLines.push(chalk.dim(w));
                        }
                    }
                }
            } else {
                this.detailContentLines.push(chalk.yellow('原因: 未能自动分析'));
                this.detailContentLines.push(chalk.green('建议: 查看下方错误输出以获取更多信息'));
            }
        }

        if (test.error) {
            this.detailContentLines.push('');
            const sep = '── 错误输出 ' + '─'.repeat(Math.max(0, innerWidth - 14));
            this.detailContentLines.push(chalk.dim(sep));
            const sanitized = this.sanitizeForDisplay(test.error);
            const errorLines = sanitized.split('\n');
            for (const line of errorLines) {
                const wrapped = wrapTextWithAnsi(line, contentWidth);
                for (const w of wrapped) {
                    this.detailContentLines.push(chalk.red(`  ${w}`));
                }
            }
        }

        if (test.details) {
            this.detailContentLines.push('');
            const sep = '── 详细输出 ' + '─'.repeat(Math.max(0, innerWidth - 14));
            this.detailContentLines.push(chalk.dim(sep));
            const sanitized = this.sanitizeForDisplay(test.details);
            const detailLines = sanitized.split('\n');
            for (const line of detailLines) {
                const wrapped = wrapTextWithAnsi(line, contentWidth);
                for (const w of wrapped) {
                    this.detailContentLines.push(chalk.dim(`  ${w}`));
                }
            }
        }
    }

    private buildResultContent() {
        this.resultContentLines = [];
        this.testStartLineIndex = 0;
        if (!this.currentResult) return;

        const result = this.currentResult;
        const terminalWidth = this.openDeskTUI.tui.terminal.columns;
        const overlayWidth = Math.min(90, terminalWidth - 4);
        const innerWidth = Math.max(20, overlayWidth - 2);

        this.resultContentLines.push(chalk.cyan.bold('环境检查'));
        for (const check of result.environment.checks) {
            const icon = check.passed ? chalk.green('✓') : chalk.red('✗');
            this.resultContentLines.push(`  ${icon} ${check.name}: ${check.message}`);
        }

        this.resultContentLines.push('');
        const sep1 = '── 测试汇总 ' + '─'.repeat(Math.max(0, innerWidth - 14));
        this.resultContentLines.push(chalk.dim(sep1));

        const summary = result.summary;
        const summaryLine =
            `总计: ${summary.total}  ` +
            chalk.green(`通过: ${summary.passed}`) +
            '  ' +
            chalk.red(`失败: ${summary.failed}`) +
            '  ' +
            chalk.yellow(`跳过: ${summary.skipped}`) +
            '  ' +
            `耗时: ${(summary.duration / 1000).toFixed(2)}s`;
        this.resultContentLines.push(summaryLine);

        this.resultContentLines.push('');
        const sep2 = '── 测试用例 ' + '─'.repeat(Math.max(0, innerWidth - 14));
        this.resultContentLines.push(chalk.dim(sep2));

        this.testStartLineIndex = this.resultContentLines.length;

        for (let i = 0; i < result.tests.length; i++) {
            const test = result.tests[i];
            const isSelected = i === this.selectedTestIndex;
            const prefix = isSelected ? chalk.cyan('▶ ') : '  ';

            let icon: string;
            let color: (text: string) => string;
            switch (test.status) {
                case 'passed':
                    icon = '✓';
                    color = chalk.green;
                    break;
                case 'failed':
                    icon = '✗';
                    color = chalk.red;
                    break;
                case 'skipped':
                    icon = '○';
                    color = chalk.yellow;
                    break;
                default:
                    icon = '!';
                    color = chalk.red;
            }

            const duration = chalk.dim(`(${test.duration}ms)`);
            this.resultContentLines.push(`${prefix}${color(icon)} ${test.name} ${duration}`);
        }
    }

    private adjustScrollOffset() {
        if (!this.currentResult) return;
        const h = this.contentHeight;
        const maxOffset = Math.max(0, this.resultContentLines.length - h);
        const selectedTestLine = this.testStartLineIndex + this.selectedTestIndex;
        if (selectedTestLine < this.resultScrollOffset) {
            this.resultScrollOffset = selectedTestLine;
        } else if (selectedTestLine >= this.resultScrollOffset + h) {
            this.resultScrollOffset = Math.min(maxOffset, selectedTestLine - h + 1);
        }
        this.resultScrollOffset = Math.max(0, Math.min(maxOffset, this.resultScrollOffset));
    }

    private setupListHandlers() {
        if (!this.list) return;

        this.list.onSelect = (item: any) => {
            switch (this.state) {
                case 'main':
                    this.handleMainSelection(item.value);
                    break;
                case 'select-skill':
                    this.handleSkillSelection(item.value);
                    break;
            }
        };

        this.list.onCancel = () => {
            if (this.state === 'main') {
                this.close();
            } else {
                this.showMain();
            }
        };
    }

    private handleMainSelection(value: string) {
        switch (value) {
            case 'select':
                this.loadTestableSkills().then(() => this.showSelectSkill());
                break;
            case 'input':
                this.showInputSkill();
                break;
            case 'all':
                this.loadTestableSkills().then(() => this.runAllTests());
                break;
        }
    }

    private handleSkillSelection(value: string) {
        if (value === 'back') {
            this.showMain();
            return;
        }

        this.runTestForSkill(value);
    }

    private setupInputHandlers() {
        if (!this.input) return;

        this.removeInputListener = this.openDeskTUI.tui.addInputListener((data: string) => {
            if (matchesKey(data, Key.escape)) {
                this.showMain();
                return { consume: true };
            }
            return undefined;
        });
    }

    private close() {
        if (!this.overlayHandle) return;

        const handle = this.overlayHandle;
        this.overlayHandle = undefined;

        this.openDeskTUI.hasOpenOverlay = false;
        handle.hide();

        this.cleanup();
        if (this.messageTimeout) {
            clearTimeout(this.messageTimeout);
            this.messageTimeout = undefined;
        }
        this.message = null;
        this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
    }

    private renderBox() {
        if ((this.state === 'results' || this.state === 'test-detail') && this.currentResult) {
            this.openDeskTUI.tui.requestRender();
            return;
        }

        this.box.clear();
        this.box.addChild(this.header);

        if (this.message) {
            const msgText = this.message.isError
                ? chalk.red(`❌ ${this.message.text}`)
                : chalk.green(`✓ ${this.message.text}`);
            this.box.addChild(new Text(msgText));
        }

        if (this.loading) {
            this.box.addChild(new Text(chalk.yellow('⏳ 测试运行中...')));
        }

        if (this.list) {
            this.box.addChild(this.list);
        }

        if (this.input) {
            this.box.addChild(new Text(chalk.cyan('输入技能名称:')));
            this.box.addChild(this.input);
        }

        const helpText = this.getHelpText();
        if (helpText) {
            this.box.addChild(new Text(''));
            this.box.addChild(new Text(chalk.dim(helpText)));
        }

        this.openDeskTUI.tui.requestRender();
    }

    private renderScrollableView(width: number): string[] {
        const bgFn = (s: string) => chalk.bgHex('#1a1a2e').hex('#e0e0e0')(s);
        const px = 1;
        const py = 1;
        const innerWidth = Math.max(10, width - px * 2);
        const ch = this.contentHeight;

        const isResults = this.state === 'results';
        const allLines = isResults ? this.resultContentLines : this.detailContentLines;
        const offset = isResults ? this.resultScrollOffset : this.detailScrollOffset;

        const maxOff = Math.max(0, allLines.length - ch);
        const off = Math.max(0, Math.min(offset, maxOff));
        if (isResults) this.resultScrollOffset = off;
        else this.detailScrollOffset = off;

        const visible = allLines.slice(off, off + ch);

        const styledLine = (content: string): string => {
            const raw = ' '.repeat(px) + content;
            return bgFn(truncateToWidth(raw, width, '', true));
        };
        const emptyLine = bgFn(' '.repeat(width));

        const out: string[] = [];

        for (let i = 0; i < py; i++) out.push(emptyLine);

        if (isResults) {
            const r = this.currentResult!;
            const icon = r.summary.failed === 0 && r.summary.error === 0 ? chalk.green('✓') : chalk.red('✗');
            out.push(styledLine(chalk.bold(` 测试结果 ${icon} ${r.skillName}`)));
        } else {
            const test = this.currentResult!.tests[this.selectedTestIndex];
            out.push(styledLine(chalk.bold(` 测试详情: ${test.name}`)));
        }

        out.push(styledLine(chalk.dim('─'.repeat(innerWidth))));

        for (let i = 0; i < ch; i++) {
            out.push(styledLine(visible[i] ?? ''));
        }

        if (allLines.length > ch) {
            const pct = maxOff === 0 ? 100 : Math.round((off / maxOff) * 100);
            const barLen = Math.min(20, Math.max(8, innerWidth - 35));
            const filled = Math.max(1, Math.round((pct / 100) * barLen));
            const bar = '━'.repeat(filled) + '░'.repeat(barLen - filled);
            const end = Math.min(off + ch, allLines.length);
            out.push(styledLine(chalk.dim(`行 ${off + 1}-${end}/${allLines.length} ${bar} ${pct}%`)));
        } else {
            out.push(emptyLine);
        }

        const help = isResults
            ? '↑↓ 选择 │ PgUp/PgDn 翻页 │ g/G 顶/底 │ Enter 详情 │ R 重跑 │ Esc 返回'
            : '↑↓ 滚动 │ PgUp/PgDn 翻页 │ g/G 顶/底 │ Esc/Enter 返回';
        out.push(styledLine(chalk.dim(help)));

        for (let i = 0; i < py; i++) out.push(emptyLine);

        return out;
    }

    private formatStatus(status: string): string {
        switch (status) {
            case 'passed':
                return chalk.green('✓ 通过');
            case 'failed':
                return chalk.red('✗ 失败');
            case 'skipped':
                return chalk.yellow('○ 跳过');
            case 'error':
                return chalk.red('! 错误');
            default:
                return status;
        }
    }

    private getHelpText(): string {
        switch (this.state) {
            case 'main':
                return '↑↓ 选择  Enter 确认  Esc 退出';
            case 'select-skill':
                return '↑↓ 选择技能  Enter 测试  Esc 返回';
            default:
                return '';
        }
    }

    invalidate(): void {
        this.box.invalidate();
    }

    render(width: number): string[] {
        if ((this.state === 'results' || this.state === 'test-detail') && this.currentResult) {
            return this.renderScrollableView(width);
        }
        return this.box.render(width);
    }

    private get contentHeight(): number {
        const termHeight = this.openDeskTUI.tui.terminal.rows;
        const totalHeight = Math.max(15, termHeight - 4);
        // paddingY(1+1) + header(1) + separator(1) + scrollIndicator(1) + helpBar(1) = 6
        return Math.max(3, totalHeight - 6);
    }

    show(skillId?: string) {
        const terminalWidth = this.openDeskTUI.tui.terminal.columns;
        const overlayWidth = Math.min(90, terminalWidth - 4);

        this.overlayHandle = this.openDeskTUI.tui.showOverlay(this, {
            width: overlayWidth,
            maxHeight: '100%',
            anchor: 'center'
        });

        this.openDeskTUI.hasOpenOverlay = true;

        if (skillId) {
            this.runTestForSkill(skillId);
        } else {
            this.loadTestableSkills().then(() => {
                this.showMain();
            });
        }

        this.overlayHandle.onHide = () => {
            if (this.overlayHandle) {
                this.cleanup();
                if (this.messageTimeout) {
                    clearTimeout(this.messageTimeout);
                    this.messageTimeout = undefined;
                }
                this.message = null;
                this.openDeskTUI.hasOpenOverlay = false;
                this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
            }
        };
    }
}
