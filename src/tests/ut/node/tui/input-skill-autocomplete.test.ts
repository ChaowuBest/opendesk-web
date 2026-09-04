import test from 'node:test';
import assert from 'node:assert/strict';
import { TUI, type Terminal } from '@earendil-works/pi-tui';
import {
    AgentInputArea,
    consumePendingSkillCompletion,
    _setPendingSkillCompletionForTest
} from '../../../../main/tui/components/input.js';
import { setRuntimeLocale } from '../../../../locale/index.js';

class TestTerminal implements Terminal {
    columns = 120;
    rows = 30;
    kittyProtocolActive = false;
    start(_onInput: (data: string) => void, _onResize: () => void): void {}
    stop(): void {}
    async drainInput(): Promise<void> {}
    write(_data: string): void {}
    moveBy(_lines: number): void {}
    hideCursor(): void {}
    showCursor(): void {}
    clearLine(): void {}
    clearFromCursor(): void {}
    clearScreen(): void {}
    setTitle(_title: string): void {}
}

function createInputArea() {
    const tui = new TUI(new TestTerminal());
    return new AgentInputArea({
        tui,
        workspace: process.cwd(),
        isInputBlocked: () => false,
        isModelNotConfiguredMode: () => false,
        isActiveGoalRunningForInput: () => false,
        isGoalClearStoppingForInput: () => false
    } as any);
}

test('模拟 pi-tui submitValue 完整时序：Enter 选技能 → onChange("") → onSubmit，不直接开聊', async () => {
    setRuntimeLocale('zh-CN');
    const inputArea = createInputArea();
    const submit: Array<string> = [];
    let onChangeLast: string | null = null;
    inputArea.onSubmit((text: string) => submit.push(text));
    inputArea.setStatus('idle');

    // 模拟行首 / 的 Enter：applyCompletion 置位标记
    _setPendingSkillCompletionForTest(true);
    // submitValue 先清空编辑器（onChange("")），再提交（onSubmit）
    inputArea.input.onChange?.('');
    onChangeLast = (inputArea.input as any).lastChange ?? null;
    inputArea.input.onSubmit?.('/appmgr-appguide ');

    await Promise.resolve();

    assert.equal(submit.length, 0, '刚选技能时 Enter 不应提交，即使 submitValue 已触发 onChange("")');
    assert.equal(inputArea.input.getText(), '/appmgr-appguide ', '文本应恢复保留在输入框');
    assert.equal(consumePendingSkillCompletion(), false, '标记应被消费');
    void onChangeLast; // onChange("") 不应清除标记（由空串分支保留）
    setRuntimeLocale(null);
});

test('选中技能后恢复记录的补全文本（含尾随空格与光标位置），而非被 trim 的提交值', async () => {
    setRuntimeLocale('zh-CN');
    const inputArea = createInputArea();
    const submit: Array<string> = [];
    inputArea.onSubmit((text: string) => submit.push(text));
    inputArea.setStatus('idle');

    // 模拟 applyCompletion 置位标记并记录补全后的完整文本（含尾随空格）
    _setPendingSkillCompletionForTest(true, '介绍该技能 /appmgr-appguide ', 17);
    // submitValue 先清空编辑器（onChange("")），再提交 trim 后的文本（尾随空格被去掉）
    inputArea.input.onChange?.('');
    inputArea.input.onSubmit?.('介绍该技能 /appmgr-appguide');

    await Promise.resolve();

    assert.equal(submit.length, 0, '刚选技能时 Enter 不应提交');
    assert.equal(inputArea.input.getText(), '介绍该技能 /appmgr-appguide ', '应恢复包含尾随空格的确切补全文本');
    assert.equal(inputArea.input.getCursor().col, 17, '光标应恢复到补全位置');
    assert.equal(consumePendingSkillCompletion(), false, '标记应被消费');
    setRuntimeLocale(null);
});

test('用户真实继续输入非空文本后清除标记，Enter 正常提交', async () => {
    setRuntimeLocale('zh-CN');
    const inputArea = createInputArea();
    const submit: Array<string> = [];
    inputArea.onSubmit((text: string) => submit.push(text));
    inputArea.setStatus('idle');

    // 先选技能（置位）
    _setPendingSkillCompletionForTest(true);
    // 用户在输入框继续打字（非空 onChange）→ 清除标记
    inputArea.input.onChange?.('/appmgr-appguide 介绍一下');
    // 随后 Enter 提交
    inputArea.input.onSubmit?.('/appmgr-appguide 介绍一下');

    await Promise.resolve();

    assert.deepEqual(submit, ['/appmgr-appguide 介绍一下'], '用户已追加参数后应正常提交');
    setRuntimeLocale(null);
});

test('无补全标记时按 Enter 正常提交', async () => {
    setRuntimeLocale('zh-CN');
    const inputArea = createInputArea();
    const submit: Array<string> = [];
    inputArea.onSubmit((text: string) => submit.push(text));
    inputArea.setStatus('idle');

    inputArea.input.onSubmit?.('介绍一下 opendesk');
    await Promise.resolve();

    assert.deepEqual(submit, ['介绍一下 opendesk']);
    setRuntimeLocale(null);
});

test('consumePendingSkillCompletion 默认返回 false', () => {
    assert.equal(consumePendingSkillCompletion(), false);
});
