import test from 'node:test';
import assert from 'node:assert/strict';
import { TUI, type Terminal } from '@earendil-works/pi-tui';
import { AgentInputArea, getCachedUserInvocableSkills } from '../../../../main/tui/components/input.js';
import { SlashCommandRegistry } from '../../../../main/tui/commands/base.js';
import { SkillRegistry, Skill } from '../../../../main/aikernel/skill.js';
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setupSkill() {
    const reg = SkillRegistry.getInstance();
    reg.registerSkillProvider('__test_e2e', {
        getSkills: async () => [
            new Skill(
                { name: 'manage-mailbox', description: '管理邮箱', 'user-invocable': true },
                'test body',
                undefined
            )
        ]
    });
}

/** 等待 skill 缓存刷新完成（注册的测试技能可见） */
async function waitForSkillCache() {
    for (let i = 0; i < 50; i++) {
        if (getCachedUserInvocableSkills().some((s) => s.name === 'manage-mailbox')) return;
        await sleep(20);
    }
    assert.fail('skill 缓存应包含 manage-mailbox');
}

/**
 * 在打开的补全菜单中把选择项移动到第一个 manage-mailbox 项，
 * 然后依次断言：Enter 选中不提交 → 菜单不重开 → 再 Enter 提交。
 */
async function selectManageMailboxAndPressEnterTwice(inputArea: AgentInputArea, submit: string[]) {
    const input = inputArea.input as any;
    await sleep(250);
    assert.equal(input.autocompleteState, 'regular', '补全菜单应已打开');

    // 把选择项移到 manage-mailbox（首个匹配项）
    const list = input.autocompleteList;
    let selected = list.getSelectedItem()?.value as string;
    let guard = 0;
    while (selected !== 'manage-mailbox' && guard++ < 20) {
        input.handleInput('\x1b[B'); // down
        await sleep(20);
        selected = list.getSelectedItem()?.value as string;
    }
    assert.equal(selected, 'manage-mailbox', '应能通过方向键选中 manage-mailbox');

    // 第 1 次 Enter：选择技能，不应提交
    input.handleInput('\r');
    await sleep(250);
    assert.deepEqual(submit, [], '选中技能后的第一次 Enter 不应提交');
    assert.equal(input.autocompleteState, null, '补全后菜单不应重开（避免吞掉后续 Enter）');

    // 第 2 次 Enter：应正常提交
    input.handleInput('\r');
    await sleep(250);
    assert.equal(submit.length, 1, '第二次 Enter 应提交消息');
}

test('行首 / 选技能后：再回车可正常提交', async () => {
    setRuntimeLocale('zh-CN');
    await setupSkill();
    const registry = new SlashCommandRegistry();
    const inputArea = createInputArea();
    inputArea.setCommandRegistry(registry);
    const submit: string[] = [];
    inputArea.onSubmit((text: string) => submit.push(text));
    inputArea.setStatus('idle');

    await waitForSkillCache();
    inputArea.input.handleInput('/');
    await selectManageMailboxAndPressEnterTwice(inputArea, submit);
    assert.equal(submit[0], '/manage-mailbox', '行首提交的文本应为 /manage-mailbox');
    setRuntimeLocale(null);
});

test('行内文字 + / 选技能后：再回车同样可正常提交', async () => {
    setRuntimeLocale('zh-CN');
    await setupSkill();
    const registry = new SlashCommandRegistry();
    const inputArea = createInputArea();
    inputArea.setCommandRegistry(registry);
    const submit: string[] = [];
    inputArea.onSubmit((text: string) => submit.push(text));
    inputArea.setStatus('idle');

    await waitForSkillCache();
    for (const c of '介绍该技能 /') {
        inputArea.input.handleInput(c);
    }
    await selectManageMailboxAndPressEnterTwice(inputArea, submit);
    assert.equal(submit[0], '介绍该技能 /manage-mailbox', '行内提交的文本应为 介绍该技能 /manage-mailbox');
    setRuntimeLocale(null);
});
