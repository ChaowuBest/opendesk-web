/**
 * 测试权限引擎的基本功能
 *
 * 测试内容：
 * 1. CasbinPermissionEnforcer 基本创建和初始化
 * 2. 工作空间内读写 → allow
 * 3. 工作空间外读写 → ask
 * 4. 动态添加规则
 * 5. HarnessContext 创建和默认规则
 * 6. PermissionRequest 类型检查
 *
 * 运行方式: npx tsx src/tests/permission-test.ts
 */

import path from 'path';
import { CasbinPermissionEnforcer, createDefaultPermissionRules } from '../main/aikernel/security/enforcer';
import { HarnessContext } from '../main/aikernel/security/harness';
import type { PermissionRequest, PermissionRule } from '../main/aikernel/security/permission';

/** 使用当前平台的真实路径作为测试工作空间 */
const TEST_WORKSPACE = path.resolve(process.cwd(), 'test-workspace-for-permission');
const TEST_WORKSPACE_NORM = TEST_WORKSPACE.replace(/\\/g, '/');

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
            rules.every((r) => r.effect === 'allow'),
            'default rules are all allow (ask is implicit fallback)'
        );

        const enforcer = await CasbinPermissionEnforcer.create(rules);
        assert(enforcer !== null, 'enforcer created successfully');
    }

    // Test 2: Workspace file access → allow
    console.log('\nTest 2: Workspace file access → allow');
    {
        const rules = createDefaultPermissionRules(TEST_WORKSPACE);
        const enforcer = await CasbinPermissionEnforcer.create(rules);

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
    }

    // Test 3: Outside workspace file access → ask
    console.log('\nTest 3: Outside workspace file access → ask');
    {
        const rules = createDefaultPermissionRules(TEST_WORKSPACE);
        const enforcer = await CasbinPermissionEnforcer.create(rules);

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
        const enforcer = await CasbinPermissionEnforcer.create(rules);

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
        const enforcer = await CasbinPermissionEnforcer.create(rules);

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
        const enforcer = await CasbinPermissionEnforcer.create(rules);

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
        const enforcer = await CasbinPermissionEnforcer.create([
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
        const enforcer = await CasbinPermissionEnforcer.create(rules);

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
        const enforcer = await CasbinPermissionEnforcer.create(rules);

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

    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests();
