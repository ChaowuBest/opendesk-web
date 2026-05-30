import { type Component, Input, TUI, Key, matchesKey, visibleWidth, isKeyRelease } from '@mariozechner/pi-tui';
import chalk from 'chalk';

export interface TextFieldDef {
    type: 'text';
    key: string;
    label: string;
    value: string;
    visible?: boolean;
}

export interface BooleanFieldDef {
    type: 'boolean';
    key: string;
    label: string;
    value: boolean;
    visible?: boolean;
}

export interface SelectFieldDef {
    type: 'select';
    key: string;
    label: string;
    value: string;
    options: string[];
    /** 可选的显示标签映射，key 为 option value，value 为显示文本 */
    optionLabels?: Record<string, string>;
    visible?: boolean;
}

export type FieldDef = TextFieldDef | BooleanFieldDef | SelectFieldDef;

export interface ActionDef {
    key: string;
    label: string;
    style?: 'primary' | 'danger' | 'default';
}

type FormItem =
    | { type: 'text'; key: string; label: string; input: Input; visible?: boolean }
    | { type: 'boolean'; key: string; label: string; value: boolean; visible?: boolean }
    | {
          type: 'select';
          key: string;
          label: string;
          value: string;
          options: string[];
          optionLabels?: Record<string, string>;
          visible?: boolean;
      }
    | { type: 'action'; key: string; label: string; style: string; visible?: boolean };

/**
 * 可复用的配置表单组件。
 * - 支持文本输入、布尔开关、选项切换、操作按钮
 * - 上下键在字段间导航，当前文本字段接收键盘输入
 * - 通过 TUI InputListener 拦截导航键，其余按键透传给 pi-tui Input
 */
export class ConfigForm implements Component {
    private tui: TUI;
    private title: string;
    private items: FormItem[] = [];
    private activeIndex = 0;
    private removeInputListener?: () => void;
    private onAction: (actionKey: string, values: Record<string, any>) => void;
    private onCancel: () => void;
    private onFieldChange?: (values: Record<string, any>) => void;

    constructor(
        tui: TUI,
        title: string,
        fields: FieldDef[],
        actions: ActionDef[],
        onAction: (actionKey: string, values: Record<string, any>) => void,
        onCancel: () => void,
        onFieldChange?: (values: Record<string, any>) => void
    ) {
        this.tui = tui;
        this.title = title;
        this.onAction = onAction;
        this.onCancel = onCancel;
        this.onFieldChange = onFieldChange;

        for (const field of fields) {
            if (field.type === 'text') {
                const input = new Input();
                input.setValue(field.value);
                input.onSubmit = () => this.moveToNext();
                this.items.push({ type: 'text', key: field.key, label: field.label, input, visible: field.visible });
            } else if (field.type === 'boolean') {
                this.items.push({
                    type: 'boolean',
                    key: field.key,
                    label: field.label,
                    value: field.value,
                    visible: field.visible
                });
            } else if (field.type === 'select') {
                this.items.push({
                    type: 'select',
                    key: field.key,
                    label: field.label,
                    value: field.value,
                    options: [...field.options],
                    optionLabels: field.optionLabels,
                    visible: field.visible
                });
            }
        }

        for (const action of actions) {
            this.items.push({
                type: 'action',
                key: action.key,
                label: action.label,
                style: action.style ?? 'default'
            });
        }
    }

    activate() {
        this.removeInputListener = this.tui.addInputListener((data: string) => {
            return this.handleKeyInput(data);
        });
        this.updateFocus();
    }

    deactivate() {
        this.removeInputListener?.();
        this.removeInputListener = undefined;
        this.tui.setFocus(null);
    }

    private handleKeyInput(data: string): { consume?: boolean; data?: string } | undefined {
        // 忽略 key release，否则在 Kitty 键盘协议下按一次方向键会触发「按下+松开」两次，导致移动两行
        if (isKeyRelease(data)) {
            return { consume: true };
        }
        if (matchesKey(data, Key.up) || matchesKey(data, Key.shift('tab'))) {
            this.moveToPrev();
            return { consume: true };
        }
        if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
            this.moveToNext();
            return { consume: true };
        }
        if (matchesKey(data, Key.escape)) {
            this.onCancel();
            return { consume: true };
        }

        const item = this.items[this.activeIndex];

        if (item.type === 'text') {
            return undefined;
        }

        if (item.type === 'boolean') {
            if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
                item.value = !item.value;
                this.onFieldChange?.(this.getValues());
                this.tui.requestRender();
                return { consume: true };
            }
        }

        if (item.type === 'select') {
            if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || matchesKey(data, Key.right)) {
                if (item.options.length > 0) {
                    const idx = item.options.indexOf(item.value);
                    item.value = item.options[(idx + 1) % item.options.length];
                    this.onFieldChange?.(this.getValues());
                    this.tui.requestRender();
                }
                return { consume: true };
            }
            if (matchesKey(data, Key.left)) {
                if (item.options.length > 0) {
                    const idx = item.options.indexOf(item.value);
                    item.value = item.options[(idx - 1 + item.options.length) % item.options.length];
                    this.onFieldChange?.(this.getValues());
                    this.tui.requestRender();
                }
                return { consume: true };
            }
        }

        if (item.type === 'action') {
            if (matchesKey(data, Key.enter)) {
                this.onAction(item.key, this.getValues());
                return { consume: true };
            }
        }

        return { consume: true };
    }

    private moveToNext() {
        let nextIndex = this.activeIndex + 1;
        while (nextIndex < this.items.length && this.items[nextIndex].visible === false) {
            nextIndex++;
        }
        if (nextIndex < this.items.length) {
            this.activeIndex = nextIndex;
            this.updateFocus();
        }
    }

    private moveToPrev() {
        let prevIndex = this.activeIndex - 1;
        while (prevIndex >= 0 && this.items[prevIndex].visible === false) {
            prevIndex--;
        }
        if (prevIndex >= 0) {
            this.activeIndex = prevIndex;
            this.updateFocus();
        }
    }

    private updateFocus() {
        const item = this.items[this.activeIndex];
        if (item.type === 'text') {
            this.tui.setFocus(item.input);
        } else {
            this.tui.setFocus(null);
        }
        this.tui.requestRender();
    }

    getValues(): Record<string, any> {
        const result: Record<string, any> = {};
        for (const item of this.items) {
            if (item.type === 'text') {
                result[item.key] = item.input.getValue();
            } else if (item.type === 'boolean') {
                result[item.key] = item.value;
            } else if (item.type === 'select') {
                result[item.key] = item.value;
            }
        }
        return result;
    }

    /** 设置单个字段的可见性 */
    setItemVisible(key: string, visible: boolean) {
        const item = this.items.find((i) => i.key === key);
        if (item) item.visible = visible;
    }

    /** 批量设置字段可见性 */
    setItemsVisible(keys: string[], visible: boolean) {
        for (const key of keys) {
            this.setItemVisible(key, visible);
        }
    }

    invalidate() {}

    render(width: number): string[] {
        const lines: string[] = [];
        const dividerWidth = Math.min(width - 2, 50);

        lines.push(chalk.bold(`⚙️  ${this.title}`));
        lines.push(chalk.dim('─'.repeat(dividerWidth)));
        lines.push('');

        for (let i = 0; i < this.items.length; i++) {
            const item = this.items[i];
            if (item.visible === false) continue;
            const active = i === this.activeIndex;

            if (item.type === 'text') {
                this.renderTextField(lines, item, active, width);
            } else if (item.type === 'boolean') {
                this.renderBooleanField(lines, item, active);
            } else if (item.type === 'select') {
                this.renderSelectField(lines, item, active);
            } else if (item.type === 'action') {
                if (i > 0 && this.items[i - 1].type !== 'action') {
                    lines.push('');
                }
                this.renderAction(lines, item, active);
            }
        }

        lines.push('');
        lines.push(chalk.dim('  ↑↓ 切换字段  Enter 确认  Esc 返回'));

        return lines;
    }

    private renderTextField(lines: string[], item: FormItem & { type: 'text' }, active: boolean, width: number) {
        const labelColor = active ? chalk.cyan : chalk.dim;
        lines.push(labelColor(`  ${item.label}:`));

        if (active) {
            const inputLines = item.input.render(width - 2);
            for (const line of inputLines) {
                lines.push('  ' + line);
            }
        } else {
            const displayValue = item.input.getValue();
            if (displayValue) {
                lines.push('    ' + chalk.dim(truncateValue(displayValue, width - 6)));
            } else {
                lines.push('    ' + chalk.dim.italic('(空)'));
            }
        }
        lines.push('');
    }

    private renderBooleanField(lines: string[], item: FormItem & { type: 'boolean' }, active: boolean) {
        const indicator = active ? chalk.cyan('❯ ') : '  ';
        const label = active ? chalk.cyan(item.label) : chalk.dim(item.label);
        const value = item.value ? chalk.green('是') : chalk.red('否');
        lines.push(`${indicator}${label}: ${value}`);
    }

    private renderSelectField(lines: string[], item: FormItem & { type: 'select' }, active: boolean) {
        const indicator = active ? chalk.cyan('❯ ') : '  ';
        const label = active ? chalk.cyan(item.label) : chalk.dim(item.label);
        const displayValue = item.optionLabels?.[item.value] ?? (item.value || '(未选择)');
        const value = active ? chalk.cyan.bold(displayValue) : chalk.dim(displayValue);
        lines.push(`${indicator}${label}: ${value}`);
        if (active) {
            lines.push(chalk.dim('    ←→ / Enter 切换'));
        }
    }

    private renderAction(lines: string[], item: FormItem & { type: 'action' }, active: boolean) {
        const indicator = active ? chalk.cyan('❯ ') : '  ';
        let label: string;
        if (item.style === 'primary') {
            label = active ? chalk.green.bold(item.label) : chalk.green(item.label);
        } else if (item.style === 'danger') {
            label = active ? chalk.red.bold(item.label) : chalk.red.dim(item.label);
        } else {
            label = active ? chalk.bold(item.label) : chalk.dim(item.label);
        }
        lines.push(`${indicator}${label}`);
    }
}

function truncateValue(value: string, maxWidth: number): string {
    if (visibleWidth(value) <= maxWidth) return value;
    let result = '';
    for (const ch of value) {
        if (visibleWidth(result + ch + '…') > maxWidth) {
            return result + '…';
        }
        result += ch;
    }
    return result;
}
