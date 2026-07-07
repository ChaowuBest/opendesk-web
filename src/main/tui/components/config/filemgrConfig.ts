import { type Component, SelectList, type TUI, Input, Key, matchesKey } from '../../pi-tui.js';
import { defaultSelectListTheme } from '../../theme.js';
import { Setting } from '../../../utils/setting.js';
import chalk from 'chalk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { t } from '../../../../locale/index.js';

type PageState = 'list' | 'add';

/**
 * FileMgr 文件扫描配置页面。
 * - list 状态：展示当前 entries（只显示 root），可选中删除，或选"添加新目录"
 * - add 状态：输入 root 路径，Enter 确认，Esc 取消
 * CLI 只管 root 增/删；include/exclude 由 FSEntrySchema 的 Zod 默认值自动填充。
 */
export class FileMgrConfigPage implements Component {
    private tui: TUI;
    private onBack: () => void;
    private state: PageState = 'list';

    private list?: SelectList;
    private addInput?: Input;
    private removeInputListener?: () => void;
    private errorMessage?: string;

    constructor(tui: TUI, onBack: () => void) {
        this.tui = tui;
        this.onBack = onBack;
        this.showList();
    }

    private getCurrentRoots(): string[] {
        const setting = Setting.getInstance();
        const config = setting.getApplicationConfig('filemgr') as any;
        return (config?.entries ?? []).map((e: any) => e.root);
    }

    private showList() {
        this.state = 'list';
        this.addInput = undefined;
        this.errorMessage = undefined;
        this.removeInputListener?.();
        this.removeInputListener = undefined;

        const roots = this.getCurrentRoots();
        const items = [
            ...roots.map((root, i) => ({
                value: `delete:${i}`,
                label: `  ${chalk.white(root)}  ${chalk.dim.red(t('config.filemgr.delete'))}`
            })),
            { value: 'add', label: chalk.green('  ' + t('config.filemgr.add')) }
        ];

        this.list = new SelectList(items, items.length, defaultSelectListTheme);
        this.tui.setFocus(this.list);

        this.list.onSelect = (item: { value: string }) => {
            if (item.value === 'add') {
                this.showAdd();
            } else if (item.value.startsWith('delete:')) {
                const idx = parseInt(item.value.split(':')[1], 10);
                this.deleteEntry(idx);
            }
        };
        this.list.onCancel = () => this.onBack();

        this.tui.requestRender();
    }

    private showAdd() {
        this.state = 'add';
        this.list = undefined;
        this.errorMessage = undefined;

        this.addInput = new Input();
        // 预填默认值：用户直接 Enter 即可接受 ~/
        this.addInput.setValue(os.homedir());
        this.tui.setFocus(this.addInput);

        this.addInput.onSubmit = () => {
            const inputPath = this.addInput!.getValue().trim();
            this.tryAddEntry(inputPath);
        };

        this.removeInputListener = this.tui.addInputListener((data: string) => {
            if (matchesKey(data, Key.escape)) {
                this.removeInputListener?.();
                this.removeInputListener = undefined;
                this.showList();
                return { consume: true };
            }
            return undefined;
        });

        this.tui.requestRender();
    }

    private tryAddEntry(rawInput: string) {
        // 空字符串回退默认目录（home），与预填值保持一致
        const input = rawInput || os.homedir();

        // 展开 ~ 并解析为绝对路径
        const expanded = input.startsWith('~') ? os.homedir() + input.slice(1) : input;
        const root = path.resolve(expanded);

        let isDir = false;
        try {
            isDir = fs.statSync(root).isDirectory();
        } catch {
            this.errorMessage = t('config.filemgr.error.not.exist') + ' ' + root;
            this.tui.requestRender();
            return;
        }

        if (!isDir) {
            this.errorMessage = t('config.filemgr.error.not.directory') + ' ' + root;
            this.tui.requestRender();
            return;
        }

        const existing = this.getCurrentRoots();
        if (existing.includes(root)) {
            this.errorMessage = t('config.filemgr.error.already.exists');
            this.tui.requestRender();
            return;
        }

        this.saveEntry('add', root);
        this.removeInputListener?.();
        this.removeInputListener = undefined;
        this.showList();
    }

    private deleteEntry(index: number) {
        this.saveEntry('delete', undefined, index);
        this.showList();
    }

    /**
     * 读取当前 setting data，修改 filemgr.entries 后写回。
     * setting.setData() 会触发 applicationConfigChanged -> worker._restartScanners()。
     */
    private saveEntry(action: 'add' | 'delete', root?: string, deleteIndex?: number) {
        const setting = Setting.getInstance();
        const data = setting.getData() as any;
        const currentEntries = [...(data.applications?.filemgr?.entries ?? [])];

        if (action === 'add' && root) {
            // 只写 root，FSEntrySchema Zod parse 会填充 include/exclude 默认值
            currentEntries.push({ root });
        } else if (action === 'delete' && deleteIndex !== undefined) {
            currentEntries.splice(deleteIndex, 1);
        }

        const newData = {
            ...data,
            applications: {
                ...data.applications,
                filemgr: {
                    ...(data.applications?.filemgr ?? {}),
                    enabled: true,
                    entries: currentEntries
                }
            }
        };

        setting.setData(newData);
    }

    invalidate() {}

    render(width: number): string[] {
        const lines: string[] = [];
        lines.push(chalk.bold('  ' + t('config.filemgr.title')));
        lines.push(chalk.dim('─'.repeat(Math.min(width - 2, 50))));
        lines.push('');

        if (this.state === 'list') {
            const roots = this.getCurrentRoots();
            if (roots.length === 0) {
                lines.push(chalk.dim('  ' + t('config.filemgr.empty')));
                lines.push('');
            }
            if (this.list) lines.push(...this.list.render(width));
            lines.push('');
            lines.push(chalk.dim('  ' + t('config.main.hint')));
        } else if (this.state === 'add') {
            lines.push(chalk.cyan('  ' + t('config.filemgr.input.prompt')));
            lines.push('');
            if (this.addInput) {
                for (const line of this.addInput.render(width - 4)) {
                    lines.push('  ' + line);
                }
            }
            if (this.errorMessage) {
                lines.push('');
                lines.push(chalk.red(`  x ${this.errorMessage}`));
            }
            lines.push('');
            lines.push(
                chalk.dim(
                    '  Enter ' +
                        t('config.common.save').replace('🆗 ', '') +
                        '  Esc ' +
                        t('config.common.cancel').replace('↩  ', '')
                )
            );
        }

        return lines;
    }
}
