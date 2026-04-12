/**
 * 测试权限引擎的基本功能
 *
 * 测试内容：
 * 1. GlobPermissionEnforcer 基本创建和初始化
 * 2. 工作空间内读写（含 dotfiles）→ allow
 * 3. 工作空间外读写 → ask
 * 4. 动态添加/移除规则
 * 5. HarnessContext 创建和默认规则
 * 6. deny > ask(保护) > allow > ask(隐式) 优先级
 * 7. 敏感路径保护规则（.ssh、.gnupg、.env 等）
 * 8. ResourcePath 统一抽象与前缀计算
 * 9. AllowEverythingEnforcer 关键路径保护
 * 10. Windows nocase 匹配
 * 11. 目录级授权后子路径 allow（重复弹窗 bug 修复验证）
 *
 * 运行方式: npx tsx src/tests/permission-test.ts
 */

import os from 'os';
import path from 'path';
import {
    GlobPermissionEnforcer,
    AllowEverythingEnforcer,
    createDefaultPermissionRules
} from '../main/aikernel/security/enforcer';
import { HarnessContext } from '../main/aikernel/security/harness';
import type { PermissionRequest, PermissionRule } from '../main/aikernel/security/permission';
import {
    FileResourcePath,
    NetworkResourcePath,
    SkillResourcePath,
    createResourcePath
} from '../main/aikernel/security/permission';
import {
    createSensitivePathRules,
    createCriticalPathRules,
    SENSITIVE_PATH_PATTERNS
} from '../main/utils/permissionRules';

/** 使用当前平台的真实路径作为测试工作空间 */
const TEST_WORKSPACE = path.resolve(process.cwd(), 'test-workspace-for-permission');
const TEST_WORKSPACE_NORM = TEST_WORKSPACE.replace(/\\/g, '/');
const HOME_NORM = os.homedir().replace(/\\/g, '/');

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
    if (condition) {
        console.log(`  ✅ ${msg}`);
        passed++;
    } else {
        console.log(`  ❌ ${msg}`);
        failed++;
    }
}

async function runTests() {
    console.log('\n=== Permission Engine Tests ===\n');

    // =====================================================
    // 基础功能测试
    // =====================================================

    // Test 1: Create enforcer with default rules
    console.log('Test 1: Create enforcer with default rules');
    {
        const rules = createDefaultPermissionRules(TEST_WORKSPACE);
        assert(rules.length > 0, 'default rules created');
        assert(
            rules.some((r) => r.effect === 'allow'),
            'has allow rules'
        );
        assert(
            rules.every((r) => r.effect === 'allow' || r.effect === 'ask'),
            'default rules are allow or ask (sensitive path protection)'
        );

        const enforcer = await GlobPermissionEnforcer.create(rules);
        assert(enforcer !== null, 'enforcer created successfully');
    }

    // Test 2: Workspace file access → allow (including dotfiles)
    console.log('\nTest 2: Workspace file access → allow (including dotfiles)');
    {
        const rules = createDefaultPermissionRules(TEST_WORKSPACE);
        const enforcer = await GlobPermissionEnforcer.create(rules);

        const readReq: PermissionRequest = {
            resourceType: 'file',
            action: 'read',
            resourcePath: `${TEST_WORKSPACE_NORM}/src/index.ts`
        };
        const result = await enforcer.check(readReq);
        assert(result.effect === 'allow', `workspace file read is allow (got ${result.effect})`);

        const writeReq: PermissionRequest = {
            resourceType: 'file',
            action: 'write',
            resourcePath: `${TEST_WORKSPACE_NORM}/src/index.ts`
        };
        const writeResult = await enforcer.check(writeReq);
        assert(writeResult.effect === 'allow', `workspace file write is allow (got ${writeResult.effect})`);

        // dotfiles 应该也能匹配
        const gitignoreReq: PermissionRequest = {
            resourceType: 'file',
            action: 'read',
            resourcePath: `${TEST_WORKSPACE_NORM}/.gitignore`
        };
        const gitignoreResult = await enforcer.check(gitignoreReq);
        assert(gitignoreResult.effect === 'allow', `.gitignore read is allow (got ${gitignoreResult.effect})`);

        const eslintReq: PermissionRequest = {
            resourceType: 'file',
            action: 'read',
            resourcePath: `${TEST_WORKSPACE_NORM}/.eslintrc.json`
        };
        const eslintResult = await enforcer.check(eslintReq);
        assert(eslintResult.effect === 'allow', `.eslintrc.json read is allow (got ${eslintResult.effect})`);

        const gitConfigReq: PermissionRequest = {
            resourceType: 'file',
            action: 'read',
            resourcePath: `${TEST_WORKSPACE_NORM}/.git/config`
        };
        const gitConfigResult = await enforcer.check(gitConfigReq);
        assert(gitConfigResult.effect === 'allow', `.git/config read is allow (got ${gitConfigResult.effect})`);
    }

    // Test 3: Outside workspace file access → ask
    console.log('\nTest 3: Outside workspace file access → ask');
    {
        const rules = createDefaultPermissionRules(TEST_WORKSPACE);
        const enforcer = await GlobPermissionEnforcer.create(rules);

        const outsidePath = process.platform === 'win32' ? 'D:/other/secret.txt' : '/etc/passwd';
        const readReq: PermissionRequest = {
            resourceType: 'file',
            action: 'read',
            resourcePath: outsidePath
        };
        const result = await enforcer.check(readReq);
        assert(result.effect === 'ask', `outside workspace file read is ask (got ${result.effect})`);
    }

    // Test 4: Dynamic rule addition
    console.log('\nTest 4: Dynamic rule addition');
    {
        const rules = createDefaultPermissionRules(TEST_WORKSPACE);
        const enforcer = await GlobPermissionEnforcer.create(rules);

        const extraPath = process.platform === 'win32' ? 'C:/temp/test.txt' : '/tmp/test.txt';
        const extraPattern = process.platform === 'win32' ? 'C:/temp/**' : '/tmp/**';

        const tmpReq: PermissionRequest = {
            resourceType: 'file',
            action: 'read',
            resourcePath: extraPath
        };
        const beforeResult = await enforcer.check(tmpReq);
        assert(beforeResult.effect === 'ask', `before: extra path read is ask (got ${beforeResult.effect})`);

        await enforcer.addRule({
            resourceType: 'file',
            action: 'read',
            pathPattern: extraPattern,
            effect: 'allow'
        });

        const afterResult = await enforcer.check(tmpReq);
        assert(afterResult.effect === 'allow', `after: extra path read is allow (got ${afterResult.effect})`);
    }

    // Test 5: checkAll - batch check
    console.log('\nTest 5: checkAll - batch check');
    {
        const rules = createDefaultPermissionRules(TEST_WORKSPACE);
        const enforcer = await GlobPermissionEnforcer.create(rules);

        const allAllow = await enforcer.checkAll([
            { resourceType: 'file', action: 'read', resourcePath: `${TEST_WORKSPACE_NORM}/a.ts` },
            { resourceType: 'file', action: 'write', resourcePath: `${TEST_WORKSPACE_NORM}/b.ts` }
        ]);
        assert(allAllow === null, 'all workspace files → checkAll returns null (all allowed)');

        const outsidePath = process.platform === 'win32' ? 'D:/other/secret.txt' : '/etc/secret.txt';
        const mixed = await enforcer.checkAll([
            { resourceType: 'file', action: 'read', resourcePath: `${TEST_WORKSPACE_NORM}/a.ts` },
            { resourceType: 'file', action: 'write', resourcePath: outsidePath }
        ]);
        assert(mixed !== null, 'mixed access → checkAll returns non-null');
        assert(mixed!.effect === 'ask', `mixed access non-allow effect is ask (got ${mixed!.effect})`);
    }

    // Test 6: HarnessContext.createWithDefaults
    console.log('\nTest 6: HarnessContext.createWithDefaults');
    {
        const ctx = await HarnessContext.createWithDefaults(TEST_WORKSPACE);
        assert(ctx.permission !== null, 'permission enforcer is initialized');
        assert(ctx.workspace === TEST_WORKSPACE, 'workspace is set');
        assert(Object.keys(ctx.environ).length === 0, 'environ starts empty');
    }

    // Test 7: HarnessContext.createEmpty
    console.log('\nTest 7: HarnessContext.createEmpty');
    {
        const ctx = HarnessContext.createEmpty();
        assert(ctx.permission === null, 'empty context has null permission');
        assert(ctx.permissionPrompt === null, 'empty context has null prompt');
        assert(Object.keys(ctx.environ).length === 0, 'environ starts empty');
    }

    // Test 8: Network access → ask
    console.log('\nTest 8: Network access → ask by default');
    {
        const rules = createDefaultPermissionRules(TEST_WORKSPACE);
        const enforcer = await GlobPermissionEnforcer.create(rules);

        const netReq: PermissionRequest = {
            resourceType: 'network',
            action: 'access',
            resourcePath: 'https://api.example.com'
        };
        const result = await enforcer.check(netReq);
        assert(result.effect === 'ask', `network access is ask by default (got ${result.effect})`);
    }

    // Test 9: Deny rule takes priority
    console.log('\nTest 9: Deny rule takes priority over allow');
    {
        const enforcer = await GlobPermissionEnforcer.create([
            { resourceType: 'file', action: 'write', pathPattern: `${TEST_WORKSPACE_NORM}/**`, effect: 'allow' },
            { resourceType: 'file', action: 'write', pathPattern: `${TEST_WORKSPACE_NORM}/.env`, effect: 'deny' }
        ]);

        const normalWrite: PermissionRequest = {
            resourceType: 'file',
            action: 'write',
            resourcePath: `${TEST_WORKSPACE_NORM}/src/index.ts`
        };
        const normalResult = await enforcer.check(normalWrite);
        assert(normalResult.effect === 'allow', `normal file write is allow (got ${normalResult.effect})`);

        const envWrite: PermissionRequest = {
            resourceType: 'file',
            action: 'write',
            resourcePath: `${TEST_WORKSPACE_NORM}/.env`
        };
        const envResult = await enforcer.check(envWrite);
        assert(envResult.effect === 'deny', `deny rule blocks .env write (got ${envResult.effect})`);
    }

    // Test 10: checkAllDetailed - returns all non-allow results
    console.log('\nTest 10: checkAllDetailed - returns all non-allow results');
    {
        const rules = createDefaultPermissionRules(TEST_WORKSPACE);
        const enforcer = await GlobPermissionEnforcer.create(rules);

        const outsidePath1 = process.platform === 'win32' ? 'D:/other/a.txt' : '/etc/a.txt';
        const outsidePath2 = process.platform === 'win32' ? 'D:/other/b.txt' : '/etc/b.txt';

        const allDetailed = await enforcer.checkAllDetailed([
            { resourceType: 'file', action: 'read', resourcePath: `${TEST_WORKSPACE_NORM}/a.ts` },
            { resourceType: 'file', action: 'write', resourcePath: outsidePath1 },
            { resourceType: 'file', action: 'write', resourcePath: outsidePath2 }
        ]);
        assert(allDetailed.length === 2, `checkAllDetailed returns 2 ask results (got ${allDetailed.length})`);
        assert(
            allDetailed.every((r) => r.effect === 'ask'),
            'all non-allow results are ask'
        );
        assert(allDetailed[0].request.resourcePath === outsidePath1, `first ask is ${outsidePath1}`);
        assert(allDetailed[1].request.resourcePath === outsidePath2, `second ask is ${outsidePath2}`);

        const allAllowed = await enforcer.checkAllDetailed([
            { resourceType: 'file', action: 'read', resourcePath: `${TEST_WORKSPACE_NORM}/a.ts` },
            { resourceType: 'file', action: 'write', resourcePath: `${TEST_WORKSPACE_NORM}/b.ts` }
        ]);
        assert(allAllowed.length === 0, 'checkAllDetailed returns empty when all allowed');
    }

    // Test 11: Skill read → allow, skill write → ask
    console.log('\nTest 11: Skill permissions - read allow, write ask');
    {
        const rules = createDefaultPermissionRules(TEST_WORKSPACE);
        const enforcer = await GlobPermissionEnforcer.create(rules);

        const skillRead: PermissionRequest = {
            resourceType: 'skill',
            action: 'read',
            resourcePath: 'myapp/my-skill'
        };
        const readResult = await enforcer.check(skillRead);
        assert(readResult.effect === 'allow', `skill read is allow (got ${readResult.effect})`);

        const skillWrite: PermissionRequest = {
            resourceType: 'skill',
            action: 'write',
            resourcePath: 'myapp/my-skill'
        };
        const writeResult = await enforcer.check(skillWrite);
        assert(writeResult.effect === 'ask', `skill write is ask (got ${writeResult.effect})`);

        const skillExec: PermissionRequest = {
            resourceType: 'skill',
            action: 'execute',
            resourcePath: 'myapp/my-skill/some-tool'
        };
        const execResult = await enforcer.check(skillExec);
        assert(execResult.effect === 'ask', `skill execute is ask (got ${execResult.effect})`);
    }

    // =====================================================
    // 敏感路径保护规则测试
    // =====================================================

    // Test 12: 工作空间为 $HOME 时，.ssh 路径被保护规则拦截为 ask
    console.log('\nTest 12: Workspace=$HOME, .ssh access → ask (protected)');
    {
        const homeWorkspace = os.homedir();
        const rules = createDefaultPermissionRules(homeWorkspace);
        const enforcer = await GlobPermissionEnforcer.create(rules);

        const sshRead: PermissionRequest = {
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/.ssh/id_rsa`
        };
        const sshResult = await enforcer.check(sshRead);
        assert(sshResult.effect === 'ask', `$HOME workspace: .ssh/id_rsa read is ask (got ${sshResult.effect})`);

        const sshWrite: PermissionRequest = {
            resourceType: 'file',
            action: 'write',
            resourcePath: `${HOME_NORM}/.ssh/config`
        };
        const sshWriteResult = await enforcer.check(sshWrite);
        assert(
            sshWriteResult.effect === 'ask',
            `$HOME workspace: .ssh/config write is ask (got ${sshWriteResult.effect})`
        );
    }

    // Test 13: 工作空间为 $HOME 时，普通文件仍然 allow（包括普通 dotfiles）
    console.log('\nTest 13: Workspace=$HOME, normal files (incl. dotfiles) → allow');
    {
        const homeWorkspace = os.homedir();
        const rules = createDefaultPermissionRules(homeWorkspace);
        const enforcer = await GlobPermissionEnforcer.create(rules);

        const normalRead: PermissionRequest = {
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/projects/myapp/src/index.ts`
        };
        const normalResult = await enforcer.check(normalRead);
        assert(normalResult.effect === 'allow', `normal file read is allow (got ${normalResult.effect})`);

        const gitignoreReq: PermissionRequest = {
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/projects/myapp/.gitignore`
        };
        const gitignoreResult = await enforcer.check(gitignoreReq);
        assert(gitignoreResult.effect === 'allow', `.gitignore read is allow (got ${gitignoreResult.effect})`);

        const eslintReq: PermissionRequest = {
            resourceType: 'file',
            action: 'write',
            resourcePath: `${HOME_NORM}/projects/myapp/.eslintrc.json`
        };
        const eslintResult = await enforcer.check(eslintReq);
        assert(eslintResult.effect === 'allow', `.eslintrc.json write is allow (got ${eslintResult.effect})`);
    }

    // Test 14: 多个敏感路径保护同时生效
    console.log('\nTest 14: Workspace=$HOME, multiple sensitive paths → ask');
    {
        const homeWorkspace = os.homedir();
        const rules = createDefaultPermissionRules(homeWorkspace);
        const enforcer = await GlobPermissionEnforcer.create(rules);

        const gnupgResult = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/.gnupg/secring.gpg`
        });
        assert(gnupgResult.effect === 'ask', `.gnupg is protected (got ${gnupgResult.effect})`);

        const awsResult = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/.aws/credentials`
        });
        assert(awsResult.effect === 'ask', `.aws is protected (got ${awsResult.effect})`);

        const dockerResult = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/.docker/config.json`
        });
        assert(dockerResult.effect === 'ask', `.docker is protected (got ${dockerResult.effect})`);

        const kubeResult = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/.kube/config`
        });
        assert(kubeResult.effect === 'ask', `.kube is protected (got ${kubeResult.effect})`);

        const npmrcResult = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/.npmrc`
        });
        assert(npmrcResult.effect === 'ask', `.npmrc is protected (got ${npmrcResult.effect})`);

        const gitCredResult = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/.git-credentials`
        });
        assert(gitCredResult.effect === 'ask', `.git-credentials is protected (got ${gitCredResult.effect})`);
    }

    // Test 15: deny > ask 保护 > allow 优先级链
    console.log('\nTest 15: Deny > ask protection > allow priority chain');
    {
        const enforcer = await GlobPermissionEnforcer.create([
            { resourceType: 'file', action: 'write', pathPattern: `${HOME_NORM}/**`, effect: 'allow' },
            { resourceType: 'file', action: 'write', pathPattern: `${HOME_NORM}/.ssh/**`, effect: 'ask' },
            { resourceType: 'file', action: 'write', pathPattern: `${HOME_NORM}/.ssh/authorized_keys`, effect: 'deny' }
        ]);

        const normalResult = await enforcer.check({
            resourceType: 'file',
            action: 'write',
            resourcePath: `${HOME_NORM}/projects/a.ts`
        });
        assert(normalResult.effect === 'allow', `normal path: allow (got ${normalResult.effect})`);

        const askResult = await enforcer.check({
            resourceType: 'file',
            action: 'write',
            resourcePath: `${HOME_NORM}/.ssh/config`
        });
        assert(askResult.effect === 'ask', `.ssh/config: ask overrides allow (got ${askResult.effect})`);

        const denyResult = await enforcer.check({
            resourceType: 'file',
            action: 'write',
            resourcePath: `${HOME_NORM}/.ssh/authorized_keys`
        });
        assert(denyResult.effect === 'deny', `.ssh/authorized_keys: deny overrides ask (got ${denyResult.effect})`);
    }

    // Test 16: createSensitivePathRules 生成正确规则
    console.log('\nTest 16: createSensitivePathRules generates rules');
    {
        const rules = createSensitivePathRules(os.homedir());
        assert(rules.length > 0, `sensitive path rules generated: ${rules.length} rules`);
        assert(
            rules.every((r) => r.effect === 'ask'),
            'all sensitive path rules are ask'
        );
        assert(
            rules.some((r) => r.pathPattern.includes('.ssh')),
            'has .ssh protection rule'
        );
        assert(
            rules.some((r) => r.pathPattern.includes('.gnupg')),
            'has .gnupg protection rule'
        );
        assert(
            rules.some((r) => r.pathPattern.includes('.aws')),
            'has .aws protection rule'
        );
    }

    // Test 17: 动态添加 ask 保护规则
    console.log('\nTest 17: Dynamic ask rule addition');
    {
        const enforcer = await GlobPermissionEnforcer.create([
            { resourceType: 'file', action: 'read', pathPattern: `${HOME_NORM}/secrets/**`, effect: 'allow' }
        ]);

        const customPath = `${HOME_NORM}/secrets/api-keys.json`;
        const beforeResult = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: customPath
        });
        assert(beforeResult.effect === 'allow', `before: custom path read is allow (got ${beforeResult.effect})`);

        await enforcer.addRule({
            resourceType: 'file',
            action: 'read',
            pathPattern: `${HOME_NORM}/secrets/**`,
            effect: 'ask'
        });

        const afterResult = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: customPath
        });
        assert(afterResult.effect === 'ask', `after: custom path read is ask (got ${afterResult.effect})`);
    }

    // Test 18: 动态移除 ask 保护规则
    console.log('\nTest 18: Dynamic ask rule removal');
    {
        const enforcer = await GlobPermissionEnforcer.create([
            { resourceType: 'file', action: 'read', pathPattern: `${HOME_NORM}/secrets/**`, effect: 'allow' },
            { resourceType: 'file', action: 'read', pathPattern: `${HOME_NORM}/secrets/**`, effect: 'ask' }
        ]);

        const req: PermissionRequest = {
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/secrets/key.pem`
        };
        const beforeResult = await enforcer.check(req);
        assert(beforeResult.effect === 'ask', `before removal: protected path is ask (got ${beforeResult.effect})`);

        await enforcer.removeRule({
            resourceType: 'file',
            action: 'read',
            pathPattern: `${HOME_NORM}/secrets/**`,
            effect: 'ask'
        });

        const afterResult = await enforcer.check(req);
        assert(afterResult.effect === 'allow', `after removal: path reverts to allow (got ${afterResult.effect})`);
    }

    // Test 19: .env 文件在任何工作空间内都受保护
    console.log('\nTest 19: .env files protected in any workspace');
    {
        const rules = createDefaultPermissionRules(TEST_WORKSPACE);
        const enforcer = await GlobPermissionEnforcer.create(rules);

        const envRead: PermissionRequest = {
            resourceType: 'file',
            action: 'read',
            resourcePath: `${TEST_WORKSPACE_NORM}/.env`
        };
        const result = await enforcer.check(envRead);
        assert(result.effect === 'ask', `.env read in workspace triggers ask (got ${result.effect})`);

        const envProd: PermissionRequest = {
            resourceType: 'file',
            action: 'write',
            resourcePath: `${TEST_WORKSPACE_NORM}/backend/.env.production`
        };
        const prodResult = await enforcer.check(envProd);
        assert(prodResult.effect === 'ask', `.env.production write triggers ask (got ${prodResult.effect})`);
    }

    // Test 20: createDefaultPermissionRules 包含敏感路径保护
    console.log('\nTest 20: Default rules include sensitive path protection');
    {
        const homeWorkspace = os.homedir();
        const rules = createDefaultPermissionRules(homeWorkspace);
        const askRules = rules.filter((r) => r.effect === 'ask');
        assert(askRules.length > 0, `default rules contain ask rules: ${askRules.length} ask rules`);
        assert(
            askRules.some((r) => r.pathPattern.includes('.ssh')),
            'default rules include .ssh protection'
        );
    }

    // Test 21: checkAllDetailed 正确报告保护路径
    console.log('\nTest 21: checkAllDetailed reports protected paths');
    {
        const enforcer = await GlobPermissionEnforcer.create([
            { resourceType: 'file', action: 'read', pathPattern: `${HOME_NORM}/**`, effect: 'allow' },
            { resourceType: 'file', action: 'read', pathPattern: `${HOME_NORM}/.ssh/**`, effect: 'ask' }
        ]);

        const results = await enforcer.checkAllDetailed([
            { resourceType: 'file', action: 'read', resourcePath: `${HOME_NORM}/projects/a.ts` },
            { resourceType: 'file', action: 'read', resourcePath: `${HOME_NORM}/.ssh/id_rsa` },
            { resourceType: 'file', action: 'read', resourcePath: `${HOME_NORM}/.ssh/config` }
        ]);
        assert(results.length === 2, `2 protected paths reported (got ${results.length})`);
        assert(
            results.every((r) => r.effect === 'ask'),
            'all protected paths are ask'
        );
    }

    // Test 22: 保护规则对不同操作独立生效
    console.log('\nTest 22: Protection rules work per action');
    {
        const enforcer = await GlobPermissionEnforcer.create([
            { resourceType: 'file', action: 'read', pathPattern: `${HOME_NORM}/**`, effect: 'allow' },
            { resourceType: 'file', action: 'write', pathPattern: `${HOME_NORM}/**`, effect: 'allow' },
            { resourceType: 'file', action: 'read', pathPattern: `${HOME_NORM}/.ssh/**`, effect: 'ask' }
        ]);

        const readResult = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/.ssh/id_rsa`
        });
        assert(readResult.effect === 'ask', `.ssh read is ask (protected) (got ${readResult.effect})`);

        const writeResult = await enforcer.check({
            resourceType: 'file',
            action: 'write',
            resourcePath: `${HOME_NORM}/.ssh/id_rsa`
        });
        assert(
            writeResult.effect === 'allow',
            `.ssh write is allow (no write protection rule) (got ${writeResult.effect})`
        );
    }

    // Test 23: 工作空间为子目录时，~/.ssh 不在工作空间内 → 隐式 ask
    console.log('\nTest 23: Workspace=subdir, ~/.ssh outside workspace → implicit ask');
    {
        const rules = createDefaultPermissionRules(TEST_WORKSPACE);
        const enforcer = await GlobPermissionEnforcer.create(rules);

        const sshRead: PermissionRequest = {
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/.ssh/id_rsa`
        };
        const result = await enforcer.check(sshRead);
        assert(result.effect === 'ask', `.ssh outside workspace is ask (got ${result.effect})`);
    }

    // Test 24: 工作空间为 $HOME 时，未列入保护的 dotfile 目录正常 allow
    console.log('\nTest 24: Workspace=$HOME, unprotected dot-directories → allow');
    {
        const homeWorkspace = os.homedir();
        const rules = createDefaultPermissionRules(homeWorkspace);
        const enforcer = await GlobPermissionEnforcer.create(rules);

        const vscodeReq: PermissionRequest = {
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/.vscode/settings.json`
        };
        const vscodeResult = await enforcer.check(vscodeReq);
        assert(vscodeResult.effect === 'allow', `.vscode/settings.json is allow (got ${vscodeResult.effect})`);

        const configReq: PermissionRequest = {
            resourceType: 'file',
            action: 'write',
            resourcePath: `${HOME_NORM}/.config/some-app/config.toml`
        };
        const configResult = await enforcer.check(configReq);
        assert(configResult.effect === 'allow', `.config/some-app write is allow (got ${configResult.effect})`);
    }

    // Test 25: SENSITIVE_PATH_PATTERNS 常量可供外部扩展使用
    console.log('\nTest 25: SENSITIVE_PATH_PATTERNS is well-formed');
    {
        assert(SENSITIVE_PATH_PATTERNS.length > 0, `patterns defined: ${SENSITIVE_PATH_PATTERNS.length}`);
        assert(
            SENSITIVE_PATH_PATTERNS.every((p) => p.pattern.length > 0 && p.description.length > 0),
            'all patterns have pattern and description'
        );
        const homePatterns = SENSITIVE_PATH_PATTERNS.filter((p) => p.pattern.includes('{home}'));
        assert(homePatterns.length > 0, `has home-based patterns: ${homePatterns.length}`);
        const globalPatterns = SENSITIVE_PATH_PATTERNS.filter((p) => p.pattern.startsWith('**/'));
        assert(globalPatterns.length > 0, `has global patterns: ${globalPatterns.length}`);
    }

    // =====================================================
    // ResourcePath 统一抽象测试
    // =====================================================

    // Test 26: FileResourcePath.getPrefixes 基本功能
    console.log('\nTest 26: FileResourcePath.getPrefixes for exact file path');
    {
        const rp = new FileResourcePath('C:/Projects/OpenDesk/src/a.txt');
        const prefixes = rp.getPrefixes();
        assert(prefixes.length >= 3, `at least 3 prefix levels (got ${prefixes.length})`);
        assert(prefixes[0].pattern === 'C:/Projects/OpenDesk/src/a.txt', `first is exact path`);
        assert(prefixes[1].pattern === 'C:/Projects/OpenDesk/src/**', `second is parent dir glob`);
        assert(prefixes[2].pattern === 'C:/Projects/OpenDesk/**', `third is grandparent dir glob`);
    }

    // Test 27: FileResourcePath.getPrefixes for glob path (e.g. from globFiles)
    console.log('\nTest 27: FileResourcePath.getPrefixes for glob path');
    {
        const rp = new FileResourcePath('D:/Users/liyif/Projects/skills/hmsign/**');
        const prefixes = rp.getPrefixes();
        assert(prefixes.length >= 2, `at least 2 prefix levels for glob path (got ${prefixes.length})`);
        // glob 路径不应该有"精确路径"级别，应直接从目录开始
        assert(
            prefixes[0].pattern === 'D:/Users/liyif/Projects/skills/hmsign/**',
            `first is the concrete dir glob (got ${prefixes[0].pattern})`
        );
        assert(
            prefixes[1].pattern === 'D:/Users/liyif/Projects/skills/**',
            `second is parent (got ${prefixes[1].pattern})`
        );
    }

    // Test 28: NetworkResourcePath.getPrefixes
    console.log('\nTest 28: NetworkResourcePath.getPrefixes');
    {
        const rp = new NetworkResourcePath('https://api.example.com/v1/users');
        const prefixes = rp.getPrefixes();
        assert(prefixes.length >= 3, `at least 3 prefix levels (got ${prefixes.length})`);
        assert(prefixes[0].pattern === 'https://api.example.com/v1/users', `first is exact URL`);
        assert(prefixes[1].pattern === 'https://api.example.com/v1/**', `second is /v1/**`);
        assert(prefixes[2].pattern === 'https://api.example.com/**', `third is origin/**`);
    }

    // Test 29: SkillResourcePath.getPrefixes
    console.log('\nTest 29: SkillResourcePath.getPrefixes');
    {
        const rp = new SkillResourcePath('myapp/my-skill');
        const prefixes = rp.getPrefixes();
        assert(prefixes.length === 2, `2 prefix levels (got ${prefixes.length})`);
        assert(prefixes[0].pattern === 'myapp/my-skill', `first is exact skill`);
        assert(prefixes[1].pattern === 'myapp/**', `second is bundle glob`);
    }

    // Test 30: createResourcePath factory
    console.log('\nTest 30: createResourcePath factory');
    {
        const file = createResourcePath('file', '/home/user/a.txt');
        assert(file instanceof FileResourcePath, `file type creates FileResourcePath`);

        const net = createResourcePath('network', 'https://api.example.com');
        assert(net instanceof NetworkResourcePath, `network type creates NetworkResourcePath`);

        const skill = createResourcePath('skill', 'bundle/skill');
        assert(skill instanceof SkillResourcePath, `skill type creates SkillResourcePath`);
    }

    // =====================================================
    // AllowEverythingEnforcer 关键路径保护测试
    // =====================================================

    // Test 31: AllowEverythingEnforcer 正常文件 → allow
    console.log('\nTest 31: AllowEverythingEnforcer allows normal files');
    {
        const criticalRules = createCriticalPathRules();
        const enforcer = new AllowEverythingEnforcer(criticalRules);

        const result = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/projects/myapp/src/index.ts`
        });
        assert(result.effect === 'allow', `normal file in allow-everything is allow (got ${result.effect})`);
    }

    // Test 32: AllowEverythingEnforcer 关键路径 → ask
    console.log('\nTest 32: AllowEverythingEnforcer protects critical paths');
    {
        const criticalRules = createCriticalPathRules();
        const enforcer = new AllowEverythingEnforcer(criticalRules);

        const sshResult = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/.ssh/id_rsa`
        });
        assert(sshResult.effect === 'ask', `.ssh still needs ask in allow-everything (got ${sshResult.effect})`);

        const awsResult = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/.aws/credentials`
        });
        assert(awsResult.effect === 'ask', `.aws still needs ask in allow-everything (got ${awsResult.effect})`);
    }

    // Test 33: AllowEverythingEnforcer 网络访问 → allow
    console.log('\nTest 33: AllowEverythingEnforcer allows network');
    {
        const enforcer = new AllowEverythingEnforcer([]);

        const result = await enforcer.check({
            resourceType: 'network',
            action: 'access',
            resourcePath: 'https://api.example.com'
        });
        assert(result.effect === 'allow', `network in allow-everything is allow (got ${result.effect})`);
    }

    // =====================================================
    // 目录级授权后子路径匹配测试（修复重复弹窗 bug）
    // =====================================================

    // Test 34: 动态添加目录级 allow 后，子文件应匹配
    console.log('\nTest 34: Directory-level allow rule covers child files');
    {
        const enforcer = await GlobPermissionEnforcer.create([]);

        // 模拟 globFiles 的 resourcePath 被用户授权后写入 allow 规则
        const dirPattern = `${HOME_NORM}/Projects/skills/hmsign/**`;
        await enforcer.addRule({
            resourceType: 'file',
            action: 'read',
            pathPattern: dirPattern,
            effect: 'allow'
        });

        // 后续 readFiles 访问该目录下的文件应直接 allow
        const fileResult = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/Projects/skills/hmsign/SKILL.md`
        });
        assert(
            fileResult.effect === 'allow',
            `child file SKILL.md is allow after dir-level rule (got ${fileResult.effect})`
        );

        // 子目录中的文件也应匹配
        const subDirResult = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/Projects/skills/hmsign/scripts/run.sh`
        });
        assert(
            subDirResult.effect === 'allow',
            `nested file is allow after dir-level rule (got ${subDirResult.effect})`
        );

        // 其他目录应不受影响
        const otherResult = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/Projects/skills/other/SKILL.md`
        });
        assert(otherResult.effect === 'ask', `file in other dir is still ask (got ${otherResult.effect})`);
    }

    // Test 35: prefix 级别授权后的覆盖测试
    console.log('\nTest 35: Prefix-level authorization covers all sub-paths');
    {
        const enforcer = await GlobPermissionEnforcer.create([]);

        // 模拟用户选择了父目录级别的授权
        const parentPattern = `${HOME_NORM}/Projects/skills/**`;
        await enforcer.addRule({
            resourceType: 'file',
            action: 'read',
            pathPattern: parentPattern,
            effect: 'allow'
        });

        // 所有子路径都应被覆盖
        const a = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/Projects/skills/hmsign/SKILL.md`
        });
        assert(a.effect === 'allow', `hmsign/SKILL.md covered (got ${a.effect})`);

        const b = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/Projects/skills/another-skill/README.md`
        });
        assert(b.effect === 'allow', `another-skill/README.md covered (got ${b.effect})`);
    }

    // Test 36: HarnessContext.createAllowEverything 保护关键路径
    console.log('\nTest 36: HarnessContext.createAllowEverything protects critical paths');
    {
        const ctx = HarnessContext.createAllowEverything(os.homedir());
        assert(ctx.permission !== null, 'permission enforcer is initialized');

        const sshResult = await ctx.permission!.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/.ssh/id_rsa`
        });
        assert(sshResult.effect === 'ask', `.ssh protected in allow-everything mode (got ${sshResult.effect})`);

        const normalResult = await ctx.permission!.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: `${HOME_NORM}/projects/myapp/src/index.ts`
        });
        assert(
            normalResult.effect === 'allow',
            `normal file allowed in allow-everything mode (got ${normalResult.effect})`
        );
    }

    // Test 37: 目录路径（以 / 结尾）在 enforcer 中正确匹配 workspace/** 规则
    console.log('\nTest 37: Directory path (trailing slash) matches workspace/** rules');
    {
        const ws = 'D:/Projects/OpenDesk';
        const rules = createDefaultPermissionRules(ws);
        const enforcer = await GlobPermissionEnforcer.create(rules);

        // globFiles/grepFiles 现在申请的是目录路径（以 / 结尾）
        const dirResult = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: ws + '/src/'
        });
        assert(dirResult.effect === 'allow', `workspace subdir with trailing slash is allow (got ${dirResult.effect})`);

        const dirResult2 = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: ws + '/'
        });
        assert(
            dirResult2.effect === 'allow',
            `workspace root dir with trailing slash is allow (got ${dirResult2.effect})`
        );

        const outsideDir = await enforcer.check({
            resourceType: 'file',
            action: 'read',
            resourcePath: 'C:/Windows/System32/'
        });
        assert(outsideDir.effect === 'ask', `outside workspace dir is ask (got ${outsideDir.effect})`);
    }

    // Test 38: FileResourcePath.getPrefixes 对目录路径（以 / 结尾）的处理
    console.log('\nTest 38: FileResourcePath.getPrefixes for directory path (trailing slash)');
    {
        const rp = new FileResourcePath('D:/Projects/OpenDesk/src/');
        const prefixes = rp.getPrefixes();
        assert(prefixes.length >= 3, `at least 3 prefix levels for dir path (got ${prefixes.length})`);
        // 第一项应该是 dir/** 而非精确路径
        assert(
            prefixes[0].pattern === 'D:/Projects/OpenDesk/src/**',
            `first prefix pattern is dir/** (got ${prefixes[0].pattern})`
        );
        assert(
            prefixes[0].label === 'D:/Projects/OpenDesk/src/',
            `first prefix label ends with / (got ${prefixes[0].label})`
        );
        // 第二项是父目录
        assert(
            prefixes[1].pattern === 'D:/Projects/OpenDesk/**',
            `second prefix pattern is parent/** (got ${prefixes[1].pattern})`
        );
    }

    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests();
