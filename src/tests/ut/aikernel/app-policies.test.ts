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

/**
 * App 专属策略（security/policies）回归：
 * - 各 app 策略的运行时读放行清单跨平台模板正确展开；
 * - 凭据文件 ask 保护（绝不 read allow）；
 * - 聚合入口完整注入 createDefaultPermissionRules（standard 模式）；
 * - 注入后的规则经沙箱导出（permissionRulesForSandbox/Linux）生成原生策略文本。
 */

import { describe, expect, test } from '@jest/globals';
import os from 'os';
import { createAppPolicyRules } from '../../../main/aikernel/security/policies/index.js';
import { createGitPolicyRules } from '../../../main/aikernel/security/policies/git.js';
import { createPythonPolicyRules } from '../../../main/aikernel/security/policies/python.js';
import { createNodePolicyRules } from '../../../main/aikernel/security/policies/node.js';
import { createNvmPolicyRules } from '../../../main/aikernel/security/policies/nvm.js';
import { createUvPolicyRules } from '../../../main/aikernel/security/policies/uv.js';
import { createSshPolicyRules } from '../../../main/aikernel/security/policies/ssh.js';
import { createCargoPolicyRules } from '../../../main/aikernel/security/policies/cargo.js';
import { createGoPolicyRules } from '../../../main/aikernel/security/policies/go.js';
import { createJvmPolicyRules } from '../../../main/aikernel/security/policies/jvm.js';
import { createDockerPolicyRules } from '../../../main/aikernel/security/policies/docker.js';
import { createDotnetPolicyRules } from '../../../main/aikernel/security/policies/dotnet.js';
import { createTransferPolicyRules } from '../../../main/aikernel/security/policies/transfer.js';
import { createEditorPolicyRules } from '../../../main/aikernel/security/policies/editor.js';
import { createRubyPolicyRules } from '../../../main/aikernel/security/policies/ruby.js';
import { createAgentsPolicyRules } from '../../../main/aikernel/security/policies/agents.js';
import { createDefaultPermissionRules, GlobPermissionEnforcer } from '../../../main/aikernel/security/enforcer.js';
import {
    policyText,
    policyTextLinux,
    hostPatternToVirtual
} from '../../../main/applications/terminal/sandboxes/dynabox-policy.js';
import type { PermissionRule } from '../../../main/aikernel/security/permission.js';

const HOME_WIN = 'C:/Users/tester';
const HOME_UNIX = '/home/tester';

describe('git app 策略', () => {
    test('凭据文件 read ask 保护（.git-credentials/.netrc，绝不 allow）', () => {
        const rules = createGitPolicyRules();
        for (const cred of ['.git-credentials', '.netrc']) {
            const rule = rules.find((r) => r.pathPattern.endsWith(cred));
            expect(rule).toBeDefined();
            expect(rule!.effect).toBe('ask');
            expect(rule!.action).toBe('read');
        }
        // 无凭据 allow
        expect(rules.some((r) => r.pathPattern.endsWith('.git-credentials') && r.effect === 'allow')).toBe(false);
    });

    test('运行时读放行（跨平台 {home} 模板展开，支持 homeDir 注入）', () => {
        const unix = createGitPolicyRules(HOME_UNIX)
            .filter((r) => r.effect === 'allow')
            .map((r) => r.pathPattern);
        expect(unix).toContain(`${HOME_UNIX}/.gitconfig`);
        expect(unix).toContain(`${HOME_UNIX}/.config/git/config`);
        expect(unix).toContain(`${HOME_UNIX}/.config/git/ignore`);
        // XDG 全局 attributes：git attributes 查找链的一环，路径常不存在
        //（回归：standard 沙箱 git status 对不存在的 ~/.config/git/attributes
        // 逐次弹读 ask——策略层放行后，由引擎 allow 先于隐式 ask 命中）
        expect(unix).toContain(`${HOME_UNIX}/.config/git/attributes`);
        // 系统级配置（Linux/macOS；Windows 的 Git 安装目录由 Program Files 读放行覆盖）
        expect(unix).toContain('/etc/gitconfig');
        // 默认（无注入）用 os.homedir()
        const osHome = createGitPolicyRules()
            .filter((r) => r.effect === 'allow')
            .map((r) => r.pathPattern);
        expect(osHome.every((p) => !p.includes('{home}'))).toBe(true);
    });
});

describe('python app 策略', () => {
    test('用户站点包与 pip 缓存读放行；~/.pypirc ask 保护', () => {
        const rules = createPythonPolicyRules();
        const allows = rules.filter((r) => r.effect === 'allow').map((r) => r.pathPattern);
        expect(allows.some((p) => p.includes('/.local/lib/python'))).toBe(true);
        expect(allows.some((p) => p.includes('/AppData/Roaming/Python'))).toBe(true);
        expect(allows.some((p) => p.includes('/.cache/opendesk-sandbox/pip'))).toBe(true);
        expect(allows.some((p) => p.includes('/.cache/opendesk-sandbox/pycache'))).toBe(true);
        expect(allows.some((p) => p.includes('/.cache/pip'))).toBe(true);
        expect(allows.some((p) => p.includes('Library/Caches/pip'))).toBe(true);
        const pypirc = rules.find((r) => r.pathPattern.endsWith('.pypirc'));
        expect(pypirc?.effect).toBe('ask');
    });
});

describe('node app 策略', () => {
    test('npm 缓存/全局前缀读放行；~/.npmrc 读写始终 ask，绝不 allow', () => {
        const rules = createNodePolicyRules(HOME_UNIX);
        const allows = rules.filter((r) => r.effect === 'allow').map((r) => r.pathPattern);
        expect(allows).toContain(`${HOME_UNIX}/.npm/**`);
        expect(allows).toContain(`${HOME_UNIX}/.node_modules/**`);
        expect(allows).toContain(`${HOME_UNIX}/AppData/Local/npm-cache/**`);
        expect(allows).toContain(`${HOME_UNIX}/.harmonybrew/**`);
        expect(rules.find((r) => r.pathPattern.endsWith('.npmrc') && r.action === 'read')?.effect).toBe('ask');
        expect(rules.find((r) => r.pathPattern.endsWith('.npmrc') && r.action === 'write')?.effect).toBe('ask');
        expect(rules.some((r) => r.pathPattern.endsWith('.npmrc') && r.effect === 'allow')).toBe(false);
    });
    test('npm 调试日志目录写放行（每次 npm/npx 执行都写 _logs/*.log，回归：standard 沙箱逐次写 ask）', () => {
        // 实测：沙箱内 npx jest 一次即对 ~/.npm/_logs/<时间戳>-debug-0.log 触发写 ask
        //（cache_ttl=0 不缓存，每次 npm 执行必弹）。日志为框架诊断产物，放行写。
        const rules = createNodePolicyRules(HOME_UNIX);
        const writes = rules.filter((r) => r.action === 'write' && r.effect === 'allow').map((r) => r.pathPattern);
        expect(writes).toContain(`${HOME_UNIX}/.npm/_logs/**`);
        expect(writes).toContain(`${HOME_UNIX}/AppData/Local/npm-cache/_logs/**`);
    });
});

describe('nvm app 策略', () => {
    test('工具链整体读放行（版本树/nvm.sh/缓存），仅 read 无凭据规则', () => {
        const rules = createNvmPolicyRules(HOME_UNIX);
        const allows = rules.filter((r) => r.effect === 'allow').map((r) => r.pathPattern);
        // 版本树整树：bin（PATH 上）与 lib/node_modules（bin 的兄弟目录，npm 自读）
        expect(allows).toContain(`${HOME_UNIX}/.nvm/**`);
        // 只有 read，无 write（防工具链持久化），无凭据类 ask 条目
        expect(rules.every((r) => r.action === 'read')).toBe(true);
        expect(createAppPolicyRules()).toEqual(expect.arrayContaining(createNvmPolicyRules()));
    });
});

describe('uv app 策略', () => {
    test('缓存与工具区读放行（XDG/Library/AppData 三形态）', () => {
        const allows = createUvPolicyRules(HOME_UNIX).map((r) => r.pathPattern);
        expect(allows).toContain(`${HOME_UNIX}/.cache/uv/**`);
        expect(allows).toContain(`${HOME_UNIX}/Library/Caches/uv/**`);
        expect(allows).toContain(`${HOME_UNIX}/.local/share/uv/**`);
        expect(allows).toContain(`${HOME_UNIX}/.local/bin/**`);
    });
});

describe('办公/开发场景新 app 策略（ssh/cargo/go/jvm/docker/dotnet/transfer/editor）', () => {
    test('ssh：config/known_hosts 放行；私钥目录整体仍由敏感清单 ask（不在 allow）', () => {
        const allows = createSshPolicyRules(HOME_UNIX).map((r) => r.pathPattern);
        expect(allows).toContain(`${HOME_UNIX}/.ssh/config`);
        expect(allows).toContain(`${HOME_UNIX}/.ssh/known_hosts`);
        expect(allows.some((p) => p.endsWith('/.ssh/**'))).toBe(false);
    });

    test('cargo：registry/工具链放行；credentials.toml ask', () => {
        const rules = createCargoPolicyRules(HOME_UNIX);
        const allows = rules.filter((r) => r.effect === 'allow').map((r) => r.pathPattern);
        expect(allows).toContain(`${HOME_UNIX}/.cargo/registry/**`);
        expect(allows).toContain(`${HOME_UNIX}/.rustup/**`);
        const cred = rules.find((r) => r.pathPattern.endsWith('credentials.toml'));
        expect(cred?.effect).toBe('ask');
    });

    test('go：GOPATH 与构建缓存放行，无凭据规则', () => {
        const rules = createGoPolicyRules(HOME_UNIX);
        expect(rules.every((r) => r.effect === 'allow')).toBe(true);
        expect(rules.map((r) => r.pathPattern)).toContain(`${HOME_UNIX}/go/**`);
    });

    test('jvm：repository/caches 放行；settings-security.xml ask', () => {
        const rules = createJvmPolicyRules(HOME_UNIX);
        const allows = rules.filter((r) => r.effect === 'allow').map((r) => r.pathPattern);
        expect(allows).toContain(`${HOME_UNIX}/.m2/repository/**`);
        expect(allows).toContain(`${HOME_UNIX}/.gradle/caches/**`);
        const sec = rules.find((r) => r.pathPattern.endsWith('settings-security.xml'));
        expect(sec?.effect).toBe('ask');
    });

    test('docker：config.json/contexts 放行；key.pem 不在 allow（兜底 ask）', () => {
        const allows = createDockerPolicyRules(HOME_UNIX).map((r) => r.pathPattern);
        expect(allows).toContain(`${HOME_UNIX}/.docker/config.json`);
        expect(allows.some((p) => p.endsWith('key.pem'))).toBe(false);
    });

    test('dotnet：nuget packages/NuGet.Config 放行；usersecrets ask', () => {
        const rules = createDotnetPolicyRules(HOME_UNIX);
        const allows = rules.filter((r) => r.effect === 'allow').map((r) => r.pathPattern);
        expect(allows).toContain(`${HOME_UNIX}/.nuget/packages/**`);
        const secrets = rules.filter((r) => r.effect === 'ask');
        expect(secrets.length).toBe(2);
        expect(
            secrets.every((r) => r.pathPattern.includes('UserSecrets') || r.pathPattern.includes('usersecrets'))
        ).toBe(true);
    });

    test('transfer：curl/wget rc 放行；.netrc 不在 allow（凭据，已有 ask 覆盖）', () => {
        const allows = createTransferPolicyRules(HOME_UNIX).map((r) => r.pathPattern);
        expect(allows).toContain(`${HOME_UNIX}/.curlrc`);
        expect(allows).toContain(`${HOME_UNIX}/.wgetrc`);
        expect(allows.some((p) => p.endsWith('.netrc'))).toBe(false);
    });

    test('editor：VS Code 扩展与 User 配置放行', () => {
        const allows = createEditorPolicyRules(HOME_UNIX).map((r) => r.pathPattern);
        expect(allows).toContain(`${HOME_UNIX}/.vscode/extensions/**`);
        expect(allows).toContain(`${HOME_UNIX}/AppData/Roaming/Code/User/**`);
    });

    test('ruby：Windows 盘根安装树与用户 gem 放行；gem push credentials ask', () => {
        const rules = createRubyPolicyRules(HOME_UNIX);
        const allows = rules.filter((r) => r.effect === 'allow').map((r) => r.pathPattern);
        expect(allows).toContain('/Ruby*/**');
        expect(allows).toContain(`${HOME_UNIX}/.local/share/gem/**`);
        expect(allows).toContain(`${HOME_UNIX}/.rbenv/**`);
        const cred = rules.find((r) => r.pathPattern.endsWith('.gem/credentials'));
        expect(cred?.effect).toBe('ask');
    });

    test('agents：codex/claude 用户目录读写放行（会话临时区痛点）', () => {
        const rules = createAgentsPolicyRules(HOME_UNIX);
        const readAllows = rules.filter((r) => r.effect === 'allow' && r.action === 'read').map((r) => r.pathPattern);
        const writeAllows = rules.filter((r) => r.effect === 'allow' && r.action === 'write').map((r) => r.pathPattern);
        expect(readAllows).toContain(`${HOME_UNIX}/.codex/**`);
        expect(readAllows).toContain(`${HOME_UNIX}/.claude/**`);
        expect(writeAllows).toContain(`${HOME_UNIX}/.codex/**`);
    });

    test('全量聚合：所有工厂产物都进入 createAppPolicyRules', () => {
        const all = createAppPolicyRules();
        expect(all.length).toBeGreaterThanOrEqual(30);
        // 凭据类不允许出现 allow
        const credFragments = [
            'credentials.toml',
            'settings-security.xml',
            'usersecrets',
            'UserSecrets',
            '.pypirc',
            '.npmrc'
        ];
        for (const frag of credFragments) {
            expect(all.some((r) => r.pathPattern.includes(frag) && r.effect === 'allow')).toBe(false);
        }
    });
});

describe('app 策略接入 standard 模式引擎', () => {
    test('createDefaultPermissionRules 包含 app 策略（git/python/node/uv）', () => {
        const rules = createDefaultPermissionRules('D:/work');
        const patterns = rules.map((r) => r.pathPattern);
        expect(patterns.some((p) => p.endsWith('/.gitconfig'))).toBe(true);
        expect(patterns.some((p) => p.includes('/.cache/pip/**'))).toBe(true);
        expect(patterns.some((p) => p.includes('/.npm/**'))).toBe(true);
        expect(patterns.some((p) => p.includes('/.cache/uv/**'))).toBe(true);
        expect(patterns.some((p) => p.includes('/.cargo/registry/**'))).toBe(true);
        expect(patterns.some((p) => p.includes('/.nuget/packages/**'))).toBe(true);
    });

    test('引擎实测：git 配置 read allow、凭据 read ask（deny > ask > allow 效果排序）', async () => {
        const rules: PermissionRule[] = createDefaultPermissionRules('D:/work');
        const enforcer = await GlobPermissionEnforcer.create(rules);
        // 引擎的 app 策略按 os.homedir() 展开（本机 Windows）
        const osHome = os.homedir().replace(/\\/g, '/').replace(/\/+$/, '');
        await expect(
            enforcer.check({ resourceType: 'file', action: 'read', resourcePath: `${osHome}/.gitconfig` })
        ).resolves.toMatchObject({ effect: 'allow' });
        // 凭据：app 策略 ask 与用户敏感清单 .git-credentials 叠加，效果 ask（standard 可确认）
        await expect(
            enforcer.check({ resourceType: 'file', action: 'read', resourcePath: `${osHome}/.git-credentials` })
        ).resolves.toMatchObject({ effect: 'ask' });
    });

    test('沙箱导出：standard 规则生成的 Windows/Linux 策略文本包含 git 运行时读放行', () => {
        // 注入固定 Windows 家目录：CI 等 Linux 宿主的 os.homedir() 非盘符路径，
        // hostPatternToVirtual 映射为 null 会被 Windows 导出跳过，断言将随宿主
        // 平台漂移；注入后导出链路（引擎规则 → 沙箱策略文本）在各宿主上一致。
        const rules = createDefaultPermissionRules('D:/work', HOME_WIN);
        const winText = policyText('http://ep/decide', 't', rules, HOME_WIN);
        const winVirtualHome = hostPatternToVirtual(HOME_WIN)!;
        expect(winText).toContain(`path = ${JSON.stringify(`${winVirtualHome}/.gitconfig`)}`);
        expect(winText).toContain(`path = ${JSON.stringify(`${winVirtualHome}/.config/git/ignore`)}`);
        // 凭据在沙箱层导出为 ask（引擎 ask 规则原样导出）
        expect(winText).toContain(`path = ${JSON.stringify(`${winVirtualHome}/.git-credentials`)}`);

        // Linux 版直接用 Linux 形态 app 规则验证导出链路：引擎规则在 Windows
        // 宿主生成（{home} 已展开为 C:/Users/...），Linux 导出会跳过 Windows
        // 形态路径（hostPatternToVirtualLinux 返回 null），故此处注入 Unix home
        // 展开的 git 规则模拟 Linux 宿主的引擎规则。
        const linuxRules = createGitPolicyRules(HOME_UNIX);
        const linuxText = policyTextLinux('http://ep/decide', 't', '/work', linuxRules, HOME_UNIX);
        expect(linuxText).toContain(`path = ${JSON.stringify(`${HOME_UNIX}/.gitconfig`)}`);
        expect(linuxText).toContain(`path = ${JSON.stringify(`${HOME_UNIX}/.config/git/config`)}`);
    });
});
