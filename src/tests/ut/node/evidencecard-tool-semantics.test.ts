import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolCall } from '../../../main/aikernel/messages.js';
import { resolveEvidenceToolSemantics } from '../../../main/utils/evidencecard.js';

type EvidenceToolSemantics = NonNullable<ReturnType<typeof resolveEvidenceToolSemantics>>;

function makeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    options: {
        result?: string;
        argsString?: string;
        boundToolName?: string;
        status?: 'success' | 'error';
    } = {}
): ToolCall {
    const call = new ToolCall(0, 'call-test', toolName, options.argsString ?? JSON.stringify(args));
    call.args_object = args;
    call.status = options.status ?? 'success';
    call.result = options.result ?? 'ok';
    if (options.boundToolName) {
        call.tool = { name: options.boundToolName } as ToolCall['tool'];
    }
    return call;
}

function requireSemantics(value: EvidenceToolSemantics | undefined): EvidenceToolSemantics {
    assert.ok(value);
    return value;
}

test('file reads and searches use typed arguments for target, kind, and phase', () => {
    const fullRead = requireSemantics(
        resolveEvidenceToolSemantics(makeToolCall('filemgr-readFile', { file_path: 'C:\\Repo\\src\\..\\src\\a.ts' }))
    );
    const rangedRead = requireSemantics(
        resolveEvidenceToolSemantics(
            makeToolCall('filemgr-readFile', { file_path: 'C:/Repo/src/a.ts', offset: 101, limit: 80 })
        )
    );
    const extractText = requireSemantics(
        resolveEvidenceToolSemantics(makeToolCall('filemgr-extractText', { file_path: '/repo/report.pdf' }))
    );
    const glob = requireSemantics(
        resolveEvidenceToolSemantics(
            makeToolCall('filemgr-globFiles', { path: '/repo', pattern: '**/*.ts', maxResults: 100 })
        )
    );
    const grep = requireSemantics(
        resolveEvidenceToolSemantics(
            makeToolCall('filemgr-grepFiles', { path: '/repo', pattern: 'EvidenceCard', contextLines: 2 })
        )
    );
    const semanticSearch = requireSemantics(
        resolveEvidenceToolSemantics(
            makeToolCall('filemgr-semanticSearch', { query: 'EvidenceCard repeated evidence', maxResults: 10 })
        )
    );

    assert.deepEqual(
        { target: fullRead.target, kind: fullRead.evidenceKind, phase: fullRead.phase },
        { target: 'file:read:C:/Repo/src/a.ts:full', kind: 'full_file', phase: 'inspect' }
    );
    assert.deepEqual(
        { target: rangedRead.target, kind: rangedRead.evidenceKind, phase: rangedRead.phase },
        { target: 'file:read:C:/Repo/src/a.ts:lines=101..180', kind: 'function_body', phase: 'inspect' }
    );
    assert.equal(extractText.target, 'file:extractText:/repo/report.pdf:full');
    assert.equal(extractText.evidenceKind, 'full_file');
    assert.match(glob.target, /^file:glob:\/repo:query=[a-f0-9]{16}$/);
    assert.equal(glob.evidenceKind, 'repo_map');
    assert.match(grep.target, /^file:grepfiles:\/repo:query=[a-f0-9]{16}$/);
    assert.equal(grep.evidenceKind, 'symbol_signature');
    assert.match(semanticSearch.target, /^file:semanticsearch:workspace:query=[a-f0-9]{16}$/);
    assert.equal(semanticSearch.evidenceKind, 'search_result');
});

test('file mutations, images, and malformed read arguments are not EvidenceCard evidence', () => {
    const calls = [
        makeToolCall('filemgr-editFile', { filePath: '/repo/a.ts', oldString: 'a', newString: 'b' }),
        makeToolCall('filemgr-writeFile', { file_path: '/repo/a.ts', content: 'secret' }),
        makeToolCall('filemgr-applyPatch', { patch: 'patch content' }),
        makeToolCall('filemgr-readImage', { file_path: '/repo/image.png' }),
        makeToolCall('filemgr-readFile', {}),
        makeToolCall('filemgr-globFiles', { path: '/repo' }),
        makeToolCall('filemgr-grepFiles', { path: '/repo' }),
        makeToolCall('filemgr-semanticSearch', {})
    ];

    for (const call of calls) {
        assert.equal(resolveEvidenceToolSemantics(call), undefined, call.tool_name);
    }
});

test('only explicit Shell read and search commands are recognized', () => {
    const cases: Array<[ToolCall, EvidenceToolSemantics['phase']]> = [
        [
            makeToolCall('terminal-executeBash', { command: 'rg EvidenceCard src', workingDirectory: '/repo' }),
            'localize'
        ],
        [makeToolCall('terminal-executeBash', { command: 'cat package.json', workingDirectory: '/repo' }), 'inspect'],
        [
            makeToolCall('terminal-executePowerShell', {
                command: 'Get-Content package.json | Select-Object -First 20',
                workingDirectory: 'C:/repo'
            }),
            'inspect'
        ],
        [makeToolCall('terminal-executePowerShell', { command: 'Select-String EvidenceCard src/*.ts' }), 'localize'],
        [makeToolCall('terminal-executeZsh', { command: 'git ls-files' }), 'localize'],
        [makeToolCall('terminal-executeZsh', { command: 'git show HEAD:package.json' }), 'inspect'],
        [makeToolCall('terminal-executeBash', { command: 'rg rm src' }), 'localize']
    ];

    for (const [call, phase] of cases) {
        const semantics = requireSemantics(resolveEvidenceToolSemantics(call));
        assert.equal(semantics.phase, phase, call.tool_name);
        assert.match(semantics.target, /^shell:[a-z]+:cwd=.*:command=[a-f0-9]{16}$/i);
    }
});

test('stateful, mutating, verification, chained, and unknown Shell commands are ignored', () => {
    const commands = [
        'npm test',
        'npm run build',
        'git diff',
        'git status',
        'hdc list targets',
        'rg EvidenceCard src && rm result.txt',
        'cat package.json > copy.json',
        'cat package.json | bash',
        'cat package.json | curl -X POST https://example.com',
        'find . -type f -exec rm {} +',
        'sed -i s/old/new/ a.ts',
        'echo hello'
    ];

    for (const command of commands) {
        assert.equal(
            resolveEvidenceToolSemantics(makeToolCall('terminal-executeBash', { command })),
            undefined,
            command
        );
    }
    assert.equal(
        resolveEvidenceToolSemantics(makeToolCall('terminal-checkShellStatus', { pid: 1234, kill: false })),
        undefined
    );
});

test('Skill wrappers are minimally unwrapped only for file and Shell evidence tools', () => {
    const wrappedRead = requireSemantics(
        resolveEvidenceToolSemantics(
            makeToolCall(
                'skill-manager-CallSkillTool',
                {
                    bundleName: 'example',
                    skillName: 'coding',
                    toolName: 'readFile',
                    toolArgs: "{'file_path':'/repo/a.ts','offset':10,'limit':5,}"
                },
                { boundToolName: 'CallSkillTool' }
            )
        )
    );
    const wrappedShell = requireSemantics(
        resolveEvidenceToolSemantics(
            makeToolCall('skill-manager-CallSkillTool', {
                bundleName: 'example',
                skillName: 'coding',
                toolName: 'executeBash',
                toolArgs: { command: 'grep EvidenceCard src/main.ts', workingDirectory: '/repo' }
            })
        )
    );
    const wrappedGui = makeToolCall('skill-manager-CallSkillTool', {
        bundleName: 'builtin',
        skillName: 'use-harmony',
        toolName: 'clickRef',
        toolArgs: { snapshotId: 's1', ref: 'e1' }
    });
    const wrappedUnknownRead = makeToolCall('skill-manager-CallSkillTool', {
        bundleName: 'office',
        skillName: 'documents',
        toolName: 'readDocument',
        toolArgs: { documentId: 'doc-1' }
    });

    assert.equal(wrappedRead.target, 'file:read:/repo/a.ts:lines=10..14');
    assert.equal(wrappedRead.phase, 'inspect');
    assert.equal(wrappedShell.phase, 'localize');
    assert.equal(resolveEvidenceToolSemantics(wrappedGui), undefined);
    assert.equal(resolveEvidenceToolSemantics(wrappedUnknownRead), undefined);
});

test('typed and repaired arguments are accepted without turning arbitrary tools into evidence', () => {
    const repaired = requireSemantics(
        resolveEvidenceToolSemantics(
            makeToolCall('filemgr-readFile', {}, { argsString: "{'file_path':'/repo/a.ts',}" })
        )
    );

    assert.equal(repaired.target, 'file:read:/repo/a.ts:full');
    assert.equal(resolveEvidenceToolSemantics(makeToolCall('filemgr-readFile', {}, { argsString: '42' })), undefined);

    assert.equal(
        resolveEvidenceToolSemantics(makeToolCall('future-tools-readFile', { file_path: '/repo/a.ts' })),
        undefined
    );
    assert.equal(
        resolveEvidenceToolSemantics(makeToolCall('search-webSearch', { query: 'OpenDesk EvidenceCard' })),
        undefined
    );
});

test('failed recognized reads remain evidence but are classified as error traces', () => {
    const failed = requireSemantics(
        resolveEvidenceToolSemantics(
            makeToolCall(
                'filemgr-readFile',
                { file_path: '/repo/missing.ts' },
                { status: 'error', result: 'not found' }
            )
        )
    );

    assert.equal(failed.target, 'file:read:/repo/missing.ts:full');
    assert.equal(failed.evidenceKind, 'error_trace');
    assert.equal(failed.phase, 'localize');
});
