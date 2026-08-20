import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolCall } from '../../../main/aikernel/messages.js';
import {
    parseEvidenceToolCallArgs,
    resolveEvidenceToolInvocation,
    resolveEvidenceToolSemantics
} from '../../../main/utils/evidencecard.js';

function makeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    options: {
        id?: string;
        result?: string;
        resultObject?: object;
        argsString?: string;
        boundToolName?: string;
    } = {}
): ToolCall {
    const call = new ToolCall(0, options.id ?? 'call-test', toolName, options.argsString ?? JSON.stringify(args));
    call.args_object = args;
    call.status = 'success';
    call.result = options.result ?? 'ok';
    call.result_object = options.resultObject;
    if (options.boundToolName) {
        call.tool = { name: options.boundToolName } as ToolCall['tool'];
    }
    return call;
}

test('file tools use typed path and range arguments for target, kind, and phase', () => {
    const fullRead = resolveEvidenceToolSemantics(
        makeToolCall('filemgr-readFile', { file_path: 'C:\\Repo\\src\\..\\src\\a.ts' })
    );
    const rangedRead = resolveEvidenceToolSemantics(
        makeToolCall('filemgr-readFile', { file_path: 'C:/Repo/src/a.ts', offset: 101, limit: 80 })
    );
    const edit = resolveEvidenceToolSemantics(
        makeToolCall('filemgr-editFile', {
            filePath: 'C:/Repo/src/a.ts',
            oldString: 'const password = "not-a-secret";',
            newString: 'const value = 1;'
        })
    );

    assert.deepEqual(
        { target: fullRead.target, kind: fullRead.evidenceKind, phase: fullRead.phase },
        { target: 'file:read:C:/Repo/src/a.ts:full', kind: 'full_file', phase: 'inspect' }
    );
    assert.equal(fullRead.repeatPolicy, 'target');
    assert.deepEqual(
        { target: rangedRead.target, kind: rangedRead.evidenceKind, phase: rangedRead.phase },
        { target: 'file:read:C:/Repo/src/a.ts:lines=101..180', kind: 'function_body', phase: 'inspect' }
    );
    assert.match(edit.target, /^file:edit:C:\/Repo\/src\/a\.ts:region=[a-f0-9]{16}$/);
    assert.equal(edit.evidenceKind, 'edit_region');
    assert.equal(edit.phase, 'patch');
    assert.notEqual(edit.repeatPolicy, 'target');
    assert.doesNotMatch(edit.target, /password|not-a-secret|const value/);
});

test('only explicitly stable evidence operations opt in to target repetition', () => {
    const stableCases = [
        makeToolCall('filemgr-extractText', { filePath: '/repo/report.pdf' }),
        makeToolCall('filemgr-globFiles', { path: '/repo', pattern: '**/*.ts' }),
        makeToolCall('filemgr-grepFiles', { path: '/repo', pattern: 'EvidenceCard' }),
        makeToolCall('filemgr-semanticSearch', { path: '/repo', query: 'EvidenceCard policy' }),
        makeToolCall('terminal-executeBash', { command: 'rg EvidenceCard src' }),
        makeToolCall('terminal-executeBash', { command: 'Get-Content package.json' }),
        makeToolCall('skill-manager-LoadSkill', { bundleName: 'builtin', skillName: 'use-harmony' }),
        makeToolCall('search-webSearch', { query: 'OpenDesk EvidenceCard' }),
        makeToolCall('search-AcademicSearch', { query: 'EvidenceCard coding agents' }),
        makeToolCall('search-webFetch', { url: 'https://example.com/docs' }),
        makeToolCall('knowledgebase-operate-retrieve', {
            providerId: 'local',
            knowledgeBaseId: 'kb',
            query: 'EvidenceCard'
        }),
        makeToolCall('mcpmgr-mcpSearchTools', { query: 'filesystem read' }),
        makeToolCall('mcpmgr-mcpGetTool', { serverId: 'filesystem', toolName: 'read_file' })
    ];

    for (const call of stableCases) {
        assert.equal(resolveEvidenceToolSemantics(call).repeatPolicy, 'target', call.tool_name);
    }
});

test('stateful, mutating, verification, wrapped, and unknown tools do not opt in to target repetition', () => {
    const neverCases = [
        makeToolCall('terminal-checkShellStatus', { pid: 1234, kill: false }),
        makeToolCall('terminal-executeBash', { command: 'npm test' }),
        makeToolCall('terminal-executeBash', { command: 'hdc list targets' }),
        makeToolCall('filemgr-editFile', { filePath: '/repo/a.ts', oldString: 'a', newString: 'b' }),
        makeToolCall('browser-navigate', { url: 'https://example.com' }),
        makeToolCall('todomgr-TodoWrite', { todos: [] }),
        makeToolCall('interaction-askUser', { questions: [{ question: 'Continue?' }] }),
        makeToolCall('search-manage-listSearchTools', {}),
        makeToolCall('skill-manager-CallSkillTool', {
            bundleName: 'office',
            skillName: 'documents',
            toolName: 'readDocument',
            toolArgs: { documentId: 'doc-1' }
        }),
        makeToolCall('mcpmgr-mcpCallTool', {
            serverId: 'github',
            toolName: 'search_code',
            arguments: { query: 'EvidenceCard' }
        }),
        makeToolCall('future-tools-readSomething', { resourceId: 'resource-1' })
    ];

    for (const call of neverCases) {
        assert.notEqual(resolveEvidenceToolSemantics(call).repeatPolicy, 'target', call.tool_name);
    }
});

test('skill wrapper resolves its real tool identity and repaired nested arguments', () => {
    const call = makeToolCall(
        'skill-manager-CallSkillTool',
        {
            bundleName: 'builtin',
            skillName: 'use-harmony',
            toolName: 'clickRef',
            toolArgs: "{'ref':'e5','snapshotId':'s12','position':'center'}"
        },
        { boundToolName: 'CallSkillTool' }
    );
    const invocation = resolveEvidenceToolInvocation(call);
    const semantics = resolveEvidenceToolSemantics(call);

    assert.equal(invocation.qualifiedName, 'skill-manager-CallSkillTool');
    assert.equal(invocation.toolsetName, 'skill-manager');
    assert.equal(invocation.toolName, 'CallSkillTool');
    assert.equal(invocation.effectiveName, 'skill:builtin/use-harmony/clickRef');
    assert.deepEqual(invocation.args, { ref: 'e5', snapshotId: 's12', position: 'center' });
    assert.deepEqual(invocation.wrapper, {
        kind: 'skill',
        name: 'builtin/use-harmony',
        outerArgs: {
            bundleName: 'builtin',
            skillName: 'use-harmony',
            toolName: 'clickRef'
        }
    });
    assert.equal(semantics.target, 'ui:clickRef:s12/e5:center');
    assert.equal(semantics.evidenceKind, 'ui_action');
    assert.equal(semantics.phase, 'act');
});

test('evidence argument parsing accepts typed and repaired object arguments and ignores scalar data', () => {
    assert.deepEqual(parseEvidenceToolCallArgs(makeToolCall('test', { z: 1 })), { z: 1 });
    assert.deepEqual(parseEvidenceToolCallArgs(makeToolCall('test', {}, { argsString: '{"z":1}' })), { z: 1 });
    assert.deepEqual(parseEvidenceToolCallArgs(makeToolCall('test', {}, { argsString: "{'z':1,}" })), { z: 1 });
    assert.deepEqual(parseEvidenceToolCallArgs(makeToolCall('test', {}, { argsString: '42' })), {});
});

test('skill observation uses result snapshot identity when the arguments do not contain it', () => {
    const call = makeToolCall(
        'skill-manager-CallSkillTool',
        {
            bundleName: 'builtin',
            skillName: 'use-harmony',
            toolName: 'snapshot',
            toolArgs: { bundleName: 'com.example.app' }
        },
        { resultObject: { success: true, data: { snapshotId: 's99' } } }
    );

    const semantics = resolveEvidenceToolSemantics(call);
    assert.equal(semantics.target, 'ui:snapshot:com.example.app:snapshotId=s99');
    assert.equal(semantics.evidenceKind, 'ui_snapshot');
    assert.equal(semantics.phase, 'inspect');
});

test('structured success results with an error field keep typed semantics while failed calls become error traces', () => {
    const successfulCall = makeToolCall(
        'skill-manager-CallSkillTool',
        {
            bundleName: 'builtin',
            skillName: 'use-harmony',
            toolName: 'snapshot',
            toolArgs: { bundleName: 'com.example.app' }
        },
        { result: '{"success":true,"error":null,"snapshotId":"s1"}' }
    );
    const failedCall = makeToolCall('filemgr-readFile', { file_path: '/repo/missing.ts' }, { result: 'not found' });
    failedCall.status = 'error';

    const successful = resolveEvidenceToolSemantics(successfulCall);
    const failed = resolveEvidenceToolSemantics(failedCall);

    assert.equal(successful.evidenceKind, 'ui_snapshot');
    assert.equal(successful.phase, 'inspect');
    assert.equal(failed.evidenceKind, 'error_trace');
    assert.equal(failed.phase, 'localize');
});

test('generic Skill tools keep the bundle, skill, and inner tool in their fallback identity', () => {
    const read = resolveEvidenceToolSemantics(
        makeToolCall('skill-manager-CallSkillTool', {
            bundleName: 'office',
            skillName: 'documents',
            toolName: 'readDocument',
            toolArgs: { documentId: 'doc-1' }
        })
    );
    const write = resolveEvidenceToolSemantics(
        makeToolCall('skill-manager-CallSkillTool', {
            bundleName: 'office',
            skillName: 'documents',
            toolName: 'writeDocument',
            toolArgs: { documentId: 'doc-1' }
        })
    );

    assert.match(read.target, /^skill:office\/documents\/readDocument:args=[a-f0-9]{16}$/);
    assert.match(write.target, /^skill:office\/documents\/writeDocument:args=[a-f0-9]{16}$/);
    assert.notEqual(read.target, write.target);
    assert.equal(read.phase, 'inspect');
    assert.equal(write.phase, 'patch');
});

test('all use-harmony sample tools have distinct typed semantics', () => {
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
        ['snapshot', { bundleName: 'app' }, 'ui_snapshot', 'inspect'],
        ['screenshot', { region: { x1: 1, y1: 2, x2: 3, y2: 4 }, ocr: true }, 'ui_snapshot', 'inspect'],
        ['visualAssert', { mode: 'theme' }, 'visual_assertion', 'verify'],
        ['clickRef', { snapshotId: 's1', ref: 'e1', position: 'center' }, 'ui_action', 'act'],
        ['click', { x: 10, y: 20 }, 'ui_action', 'act'],
        ['findElement', { role: 'button', name: 'Send' }, 'ui_element', 'inspect'],
        ['getElementState', { ref: 'e1' }, 'ui_element', 'inspect'],
        ['input', { x: 10, y: 20, text: 'private input', mode: 'replace' }, 'ui_action', 'act'],
        ['hover', { x: 10, y: 20, duration: 800 }, 'ui_action', 'act'],
        ['scroll', { direction: 'up', distance: 500 }, 'ui_action', 'act'],
        ['pressKey', { key: 'Escape' }, 'ui_action', 'act']
    ];
    const targets = new Set<string>();

    for (const [toolName, toolArgs, evidenceKind, phase] of cases) {
        const semantics = resolveEvidenceToolSemantics(
            makeToolCall('skill-manager-CallSkillTool', {
                bundleName: 'builtin',
                skillName: 'use-harmony',
                toolName,
                toolArgs
            })
        );
        assert.equal(semantics.evidenceKind, evidenceKind, toolName);
        assert.equal(semantics.phase, phase, toolName);
        assert.notEqual(semantics.repeatPolicy, 'target', toolName);
        assert.doesNotMatch(semantics.target, /unknown/, toolName);
        targets.add(semantics.target);
    }

    assert.equal(targets.size, cases.length);
});

test('hyphenated toolsets are resolved by registry identity instead of splitting on hyphens', () => {
    const boundTool = { name: 'retrieve' } as ToolCall['tool'];
    const call = makeToolCall('retrieve', { providerId: 'local', knowledgeBaseId: 'kb', query: 'needle' });
    call.tool = boundTool;
    const registry = {
        getTools: () => new Map([['knowledgebase-operate-retrieve', boundTool]])
    };

    const invocation = resolveEvidenceToolInvocation(call, registry);
    assert.equal(invocation.qualifiedName, 'knowledgebase-operate-retrieve');
    assert.equal(invocation.toolsetName, 'knowledgebase-operate');
    assert.equal(invocation.toolName, 'retrieve');
});

test('MCP, device, and workflow wrappers preserve their nested resource identity', () => {
    const mcp = resolveEvidenceToolSemantics(
        makeToolCall('mcpmgr-mcpCallTool', {
            serverId: 'github',
            toolName: 'search_code',
            arguments: { query: 'EvidenceCard' }
        })
    );
    const device = resolveEvidenceToolSemantics(
        makeToolCall('device-invoke-invokeDeviceCommand', {
            nodeId: 'phone-1',
            command: 'camera.snap',
            params: { quality: 80 }
        })
    );
    const workflow = resolveEvidenceToolSemantics(
        makeToolCall('workflow-RunWorkflow', { reference: 'daily-report', input: { date: '2026-08-17' } })
    );

    assert.match(mcp.target, /^mcp:github\/search_code:args=[a-f0-9]{16}$/);
    assert.equal(mcp.phase, 'act');
    assert.match(device.target, /^device:phone-1\/camera\.snap:params=[a-f0-9]{16}$/);
    assert.equal(device.phase, 'act');
    assert.match(workflow.target, /^workflow:daily-report:input=[a-f0-9]{16}$/);
    assert.equal(workflow.phase, 'act');
});

test('unknown tools get a stable collision-resistant target without exposing sensitive or large values', () => {
    const first = resolveEvidenceToolSemantics(
        makeToolCall('future-tools-doSomething', {
            value: 1,
            password: 'top-secret',
            content: 'very long private content'
        })
    );
    const reordered = resolveEvidenceToolSemantics(
        makeToolCall('future-tools-doSomething', {
            content: 'very long private content',
            password: 'top-secret',
            value: 1
        })
    );
    const different = resolveEvidenceToolSemantics(
        makeToolCall('future-tools-doSomething', { value: 2, password: 'top-secret' })
    );

    assert.equal(first.target, reordered.target);
    assert.notEqual(first.target, different.target);
    assert.match(first.target, /^tool:future-tools-doSomething:args=[a-f0-9]{16}$/);
    assert.doesNotMatch(first.target, /top-secret|private content/);
    assert.notEqual(first.phase, 'other');
});

test('69-call experiment distribution no longer produces unknown targets or other phases', () => {
    const fixtures: ToolCall[] = [];
    for (let index = 0; index < 4; index++) {
        fixtures.push(makeToolCall('filemgr-readFile', { file_path: `/repo/file-${index}.md`, offset: index + 1 }));
    }
    fixtures.push(makeToolCall('skill-manager-LoadSkill', { bundleName: 'builtin', skillName: 'use-harmony' }));
    for (let index = 0; index < 7; index++) {
        fixtures.push(
            makeToolCall('todomgr-TodoWrite', {
                todos: [{ id: `todo-${index}`, title: 'Task', content: 'Details', status: 'pending' }]
            })
        );
    }
    fixtures.push(
        makeToolCall('terminal-executeBash', { command: 'node -e "console.log(1)"' }),
        makeToolCall('terminal-executeBash', { command: 'hdc list targets' }),
        makeToolCall('terminal-executeBash', { command: 'npm test' }, { result: 'Tests passed' }),
        makeToolCall('interaction-askUser', { questions: [{ question: 'Continue?' }] }),
        makeToolCall('filemgr-editFile', { filePath: '/repo/report.md', oldString: 'old', newString: 'new' })
    );

    const harmonyCounts: Record<string, number> = {
        snapshot: 6,
        visualAssert: 5,
        clickRef: 10,
        screenshot: 6,
        click: 6,
        findElement: 6,
        getElementState: 4,
        input: 5,
        hover: 1,
        scroll: 2,
        pressKey: 1
    };
    const harmonyArgs: Record<string, (index: number) => Record<string, unknown>> = {
        snapshot: (index) => ({ bundleName: 'app', sample: index }),
        visualAssert: (index) => ({ mode: 'theme', sample: index }),
        clickRef: (index) => ({ snapshotId: `s${index}`, ref: `e${index}`, position: 'center' }),
        screenshot: (index) => ({ region: { x1: index, y1: 2, x2: 30, y2: 40 }, ocr: true }),
        click: (index) => ({ x: index, y: index + 10 }),
        findElement: (index) => ({ role: 'button', name: `button-${index}` }),
        getElementState: (index) => ({ ref: `e${index}` }),
        input: (index) => ({ x: index, y: 20, text: `text-${index}`, mode: 'replace' }),
        hover: (index) => ({ x: index, y: 20 }),
        scroll: (index) => ({ direction: 'up', distance: index + 100 }),
        pressKey: () => ({ key: 'Escape' })
    };
    for (const [toolName, count] of Object.entries(harmonyCounts)) {
        for (let index = 0; index < count; index++) {
            fixtures.push(
                makeToolCall('skill-manager-CallSkillTool', {
                    bundleName: 'builtin',
                    skillName: 'use-harmony',
                    toolName,
                    toolArgs: harmonyArgs[toolName](index)
                })
            );
        }
    }

    assert.equal(fixtures.length, 69);
    const semantics = fixtures.map((call) => resolveEvidenceToolSemantics(call));
    assert.equal(semantics.filter((entry) => entry.target.includes('unknown')).length, 0);
    assert.equal(semantics.filter((entry) => entry.phase === 'other').length, 0);
    assert.equal(
        fixtures
            .map((call) => resolveEvidenceToolInvocation(call))
            .filter((invocation) => invocation.effectiveName.startsWith('skill:builtin/use-harmony/')).length,
        52
    );
});
