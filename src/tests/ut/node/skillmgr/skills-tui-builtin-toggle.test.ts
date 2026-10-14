/**
 * 回归：TUI 技能中心内置技能页 Space 启停后选中行保持。
 *
 * 修复前：toggleBuiltinSkillStatus -> showViewBuiltin 整表重建，光标跳回首行
 * （soul/manage-souls），用户下一次 Space 会误切首个技能。
 * 修复后：重载时传入被切换行的索引，选中行保持不变。
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

describe('skills tui builtin toggle keeps selection', () => {
    let stub: StubTui;
    let overlay: any;

    before(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-tui-toggle-'));
        setPlatform(new CliPlatform());
        setCustomOpendeskDirectory(tmpDir);
        GlobalState.initialize();
        initializeRegistry();

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
        // show() 异步调度 showMain；以「主菜单列表已创建」为就绪信号，规避与后续视图切换的竞态
        await waitFor(() => (overlay as any).list !== undefined);
        await (overlay as any).showViewBuiltin();
        await waitFor(
            () => (overlay as any).state === 'view-builtin' && ((overlay as any).list as any)?.innerRows?.length > 0
        );
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('space toggles the highlighted row and keeps selection after reload', async () => {
        const rows: any[] = (overlay as any).list.innerRows;
        const targetValue = 'channelmgr/manage-channels';
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

        // 关键断言 1：重载后选中行保持在被切换的行，而不是跳回首行
        assert.equal((overlay as any).getSelectedListValue(), targetValue);

        // 关键断言 2：只有目标行的状态被写入，首个技能（soul/manage-souls）未被触碰
        const statuses = getAllStatuses();
        assert.equal(typeof statuses[targetValue], 'boolean', 'target row status should be recorded');
        assert.ok(!('soul/manage-souls' in statuses), 'first row must not be toggled');

        // 用户紧接着再按一次空格：应切回同一行（状态翻转回 true），而不是切到首行
        const listBefore2 = (overlay as any).list;
        stub.dispatch(' ');
        await waitFor(
            () =>
                (overlay as any).list !== listBefore2 &&
                ((overlay as any).list as any)?.innerRows?.length > 0 &&
                getAllStatuses()[targetValue] === true
        );
        assert.equal((overlay as any).getSelectedListValue(), targetValue);
        assert.ok(!('soul/manage-souls' in getAllStatuses()), 'first row must stay untouched after second space');
    });

    it('cleans up input listeners on view transitions', () => {
        assert.equal(stub.listenerCount(), 1);
    });
});
