/**
 * interpreters 目录权限单元测试。
 *
 * OpenDesk 自带运行时的 interpreters 目录（pip-global、npm-global、uv、cmd-pkgs）
 * 由应用自身管理，包安装器会持续写入。Standard / Solo 模式都应直接放行其中的
 * 读写操作，避免沙箱内安装包时反复触发授权弹窗。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { GlobPermissionEnforcer, createDefaultPermissionRules } from '../../../main/aikernel/security/enforcer';
import { createSoloModePermissionRules } from '../../../main/aikernel/agents/main/modes/solo';
import { createInterpretersPermissionRules } from '../../../main/utils/permissionRules';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting';
import {
    hostPatternToVirtual,
    permissionRulesForSandbox,
    policyText
} from '../../../main/applications/terminal/sandboxes/dynabox';
import type { PermissionRule } from '../../../main/aikernel/security/permission';

describe('interpreters 目录权限', () => {
    const testRoot = path.join(process.cwd(), '.tmp-interpreters-test');
    let tempDir: string;
    let interpretersDir: string;

    beforeEach(() => {
        // 固定在仓库测试目录下而不是 os.tmpdir()：standard 模式始终放行临时目录，
        // 放在临时目录里会让用例失去区分度（未实现时也会因临时目录规则而通过）。
        fs.mkdirSync(testRoot, { recursive: true });
        tempDir = fs.mkdtempSync(path.join(testRoot, 'run-'));
        setCustomOpendeskDirectory(tempDir);
        interpretersDir = path.join(tempDir, 'interpreters');
    });

    afterEach(() => {
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    afterAll(() => {
        fs.rmSync(testRoot, { recursive: true, force: true });
    });

    const workspaceDir = () => path.join(tempDir, 'workspace');
    const toPosix = (p: string) => p.replace(/\\/g, '/');

    test('createInterpretersPermissionRules 覆盖 interpreters 根目录与子树的读写', () => {
        const pattern = `${toPosix(interpretersDir)}{,/**}`;
        expect(createInterpretersPermissionRules()).toEqual([
            { resourceType: 'file', action: 'read', pathPattern: pattern, effect: 'allow' },
            { resourceType: 'file', action: 'write', pathPattern: pattern, effect: 'allow' }
        ]);
    });

    test('Standard 模式写入 pip-global 放行，不再触发 ask', async () => {
        const enforcer = await GlobPermissionEnforcer.create(createDefaultPermissionRules(workspaceDir()));
        const pipGlobal = `${toPosix(interpretersDir)}/pip-global/site-packages/demo/__init__.py`;

        await expect(
            enforcer.check({ resourceType: 'file', action: 'write', resourcePath: pipGlobal })
        ).resolves.toMatchObject({ effect: 'allow' });
        await expect(
            enforcer.check({ resourceType: 'file', action: 'read', resourcePath: pipGlobal })
        ).resolves.toMatchObject({ effect: 'allow' });
    });

    test('Standard 模式写入 npm-global / uv / cmd-pkgs 同样放行', async () => {
        const enforcer = await GlobPermissionEnforcer.create(createDefaultPermissionRules(workspaceDir()));
        for (const sub of ['npm-global/node_modules/left-pad', 'uv/cache/wheel', 'cmd-pkgs/tool.py']) {
            await expect(
                enforcer.check({
                    resourceType: 'file',
                    action: 'write',
                    resourcePath: `${toPosix(interpretersDir)}/${sub}`
                })
            ).resolves.toMatchObject({ effect: 'allow' });
        }
    });

    test('Solo 模式写入 interpreters 放行', async () => {
        const enforcer = await GlobPermissionEnforcer.create(createSoloModePermissionRules());
        await expect(
            enforcer.check({
                resourceType: 'file',
                action: 'write',
                resourcePath: `${toPosix(interpretersDir)}/pip-global/Scripts/pip.exe`
            })
        ).resolves.toMatchObject({ effect: 'allow' });
    });

    test('Standard 模式 interpreters 之外的目录写入仍需确认', async () => {
        const enforcer = await GlobPermissionEnforcer.create(createDefaultPermissionRules(workspaceDir()));
        await expect(
            enforcer.check({ resourceType: 'file', action: 'write', resourcePath: '/opt/outside-pkgs/a.py' })
        ).resolves.toMatchObject({ effect: 'ask' });
    });

    test('Standard 模式 interpreters 规则导出到原生沙箱策略且先于写问询兜底', () => {
        const dirNorm = toPosix(interpretersDir);
        const rules: PermissionRule[] = createDefaultPermissionRules(workspaceDir());

        // 原生沙箱只暴露盘符路径；非 Windows 的 interpreters 路径不会导出（保持只读兜底）
        if (!/^[A-Za-z]:/.test(dirNorm)) {
            expect(dirNorm.startsWith('/')).toBe(true);
            return;
        }

        const virtual = hostPatternToVirtual(`${dirNorm}/**`);
        expect(virtual).toBe(`/${dirNorm[0].toUpperCase()}${dirNorm.slice(2)}/**`);

        const lines = permissionRulesForSandbox(rules);
        const writeAllow = lines.find(
            (line) => line.includes(`path = "${virtual}"`) && line.includes('access = "write"')
        );
        expect(writeAllow).toBeDefined();
        expect(writeAllow).toContain('perm = "allow"');

        const text = policyText('http://127.0.0.1:1/decide', 'token', rules);
        const allowIndex = text.indexOf(`path = "${virtual}"`);
        const fallbackAskIndex = text.indexOf('path = "/**"\naccess = "write"\nperm = "ask"');
        expect(allowIndex).toBeGreaterThanOrEqual(0);
        expect(allowIndex).toBeLessThan(fallbackAskIndex);
    });

    test('盘符 interpreters 路径（含 {,/**} 展开与虚拟转换）的合成规则导出', () => {
        const lines = permissionRulesForSandbox([
            {
                resourceType: 'file',
                action: 'write',
                pathPattern: 'C:/Users/u/AppData/Roaming/opendesk/interpreters{,/**}',
                effect: 'allow'
            }
        ]);
        expect(lines).toEqual([
            '[[rules]]\npath = "/C/Users/u/AppData/Roaming/opendesk/interpreters"\naccess = "write"\nperm = "allow"',
            '[[rules]]\npath = "/C/Users/u/AppData/Roaming/opendesk/interpreters/**"\naccess = "write"\nperm = "allow"'
        ]);
    });

    test('interpreters 规则不外溢到 opendesk 数据目录的兄弟目录', async () => {
        const enforcer = await GlobPermissionEnforcer.create(createDefaultPermissionRules(workspaceDir()));
        await expect(
            enforcer.check({
                resourceType: 'file',
                action: 'write',
                resourcePath: toPosix(path.join(path.dirname(interpretersDir), 'logs', 'sandbox.log'))
            })
        ).resolves.toMatchObject({ effect: 'ask' });
    });
});
