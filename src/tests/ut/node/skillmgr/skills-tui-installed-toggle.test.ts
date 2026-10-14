/**
 * 回归：TUI 技能中心已安装技能页 Space 启停。
 *
 * 场景 1（普通终端）：Space 触发启停并保持选中行。
 * 场景 2（Kitty 键盘协议终端）：协议 flags=7 开启事件类型上报，一次按键产生
 * press + release 两条输入；pi-tui 只对 focused 组件过滤 release，对
 * inputListeners 不过滤。listener 若不自行忽略 release，一次 Space 会触发
 * 两次 toggle（启用→禁用→启用），净效果为零，表现为"Space 无法开关技能"。
 * 与 mailbox/tui.ts、entry.ts 全局快捷键的 isKeyRelease 过滤是同一问题。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { setPlatform } = await import('../../../../platforms/base.js');
const { CliPlatform } = await import('../../../../platforms/cli.js');
const { setCustomOpendeskDirectory } = await import('../../../../main/utils/setting.js');
const { GlobalState } = await import('../../../../main/aikernel/states/global.js');
const { initializeRegistry } = await import('../../../../main/applications/registry.js');
const { SkillsOverlay } = await import('../../../../main/applications/skillmgr/skills-tui.js');
const { getAllStatuses } = await import('../../../../main/applications/skillmgr/status.js');

let tmpDir: string;

interface StubTui {
    tui: any;
    dispatch: (data: string) => void;
    listenerCount: () => number;
}

/** 桩 TUI：复刻 pi-tui 分发顺序——先跑 inputListeners（可 consume），未消费则交给 focused 组件 */
function makeStubTui(): StubTui {
    const listeners: Array<(data: string) => any> = [];
    let focused: any = null;
    const tui = {
        addInputListener: (l: any) => {
            listeners.push(l);
            return () => {
                const i = listeners.indexOf(l);
                if (i >= 0) listeners.splice(i, 1);
            };
        },
        setFocus: (c: any) => {
            focused = c;
        },
        requestRender: () => {},
        terminal: { columns: 100 }
    };
    return {
        tui,
        dispatch: (data: string) => {
            for (const l of [...listeners]) {
                const r = l(data);
                if (r?.consume) return;
            }
            focused?.handleInput?.(data);
        },
        listenerCount: () => listeners.length
    };
}

async function waitFor(check: () => boolean, timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
        await new Promise((r) => setTimeout(r, 25));
    }
}

function writeSkill(resourcesDir: string, id: string, description: string): void {
    const dir = path.join(resourcesDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n\nBody of ${id}.\n`
    );
}

describe('skills tui installed toggle', () => {
    let stub: StubTui;
    let overlay: any;

    before(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-tui-installed-'));
        setPlatform(new CliPlatform());
        setCustomOpendeskDirectory(tmpDir);
        GlobalState.initialize();
        initializeRegistry();

        const resourcesDir = path.join(tmpDir, 'apps', 'skills', 'resources');
        writeSkill(resourcesDir, 'alpha-skill', 'first installed skill');
        writeSkill(resourcesDir, 'beta-skill', 'second installed skill');

        stub = makeStubTui();
        const stubOpenDeskTUI: any = {
            tui: stub.tui,
            inputArea: { showPromptWidget: () => {} },
            closeInputPrompt: () => false,
            focusAfterInputPromptClose: () => {},
            deferInputPromptIfBlockedByMode: () => false,
            hasOpenOverlay: false
        };
        overlay = new SkillsOverlay(stubOpenDeskTUI);
        overlay.show();
        await waitFor(() => (overlay as any).list !== undefined);
        await (overlay as any).showViewInstalled();
        await waitFor(
            () => (overlay as any).state === 'view-installed' && ((overlay as any).list as any)?.innerRows?.length > 0
        );
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('space toggles the highlighted installed skill and keeps selection', async () => {
        const rows: any[] = (overlay as any).list.innerRows;
        const targetValue = 'alpha-skill';
        const targetIndex = rows.findIndex((r) => r.value === targetValue);
        assert.ok(targetIndex > 0, 'target row should exist beyond the first row');

        // 光标移到目标行，按 Space 切换
        for (let i = 0; i < targetIndex; i++) stub.dispatch('\x1b[B');
        assert.equal((overlay as any).getSelectedListValue(), targetValue);

        const listBefore = (overlay as any).list;
        stub.dispatch(' ');

        // 等待切换 + 重载完成（新表实例）
        await waitFor(
            () => (overlay as any).list !== listBefore && ((overlay as any).list as any)?.innerRows?.length > 0
        );

        // 关键断言 1：状态被写入（默认启用 → 禁用），且光标保持在被切换的行
        assert.equal(getAllStatuses()[targetValue], false, 'target skill should be toggled to disabled');
        assert.equal((overlay as any).getSelectedListValue(), targetValue);

        // 关键断言 2：再按一次 Space 切回启用，目标行不变
        const listBefore2 = (overlay as any).list;
        stub.dispatch(' ');
        await waitFor(() => (overlay as any).list !== listBefore2 && getAllStatuses()[targetValue] === true);
        assert.equal((overlay as any).getSelectedListValue(), targetValue);
    });

    it('kitty protocol press+release pair toggles exactly once', async () => {
        const rows: any[] = (overlay as any).list.innerRows;
        const targetValue = 'alpha-skill';
        assert.ok(
            rows.some((r) => r.value === targetValue),
            'target row should exist'
        );

        // 光标起始位置取决于前一用例的遗留状态（SelectList 末行向下会回绕），向下导航直到命中目标行
        for (let i = 0; i < rows.length && (overlay as any).getSelectedListValue() !== targetValue; i++) {
            stub.dispatch('\x1b[B');
        }
        assert.equal((overlay as any).getSelectedListValue(), targetValue);

        // 一次物理按键 = press + release 两条事件（Kitty 协议 flags=7 含事件类型上报）
        const press = '\x1b[32;1:1u';
        const release = '\x1b[32;1:3u';
        const listBefore = (overlay as any).list;
        stub.dispatch(press);
        stub.dispatch(release);

        // 修复前：release 也会命中 matchesKey(space) 再次 toggle，状态回到 true，此处超时
        await waitFor(() => (overlay as any).list !== listBefore && getAllStatuses()[targetValue] === false);
        assert.equal((overlay as any).getSelectedListValue(), targetValue);
        assert.equal(getAllStatuses()[targetValue], false, 'release must not toggle the skill back');
    });

    it('cleans up input listeners on view transitions', () => {
        assert.equal(stub.listenerCount(), 1);
    });
});
