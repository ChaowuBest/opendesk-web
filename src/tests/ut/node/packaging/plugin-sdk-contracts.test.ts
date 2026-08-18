import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const pluginPackageRoot = path.join(projectRoot, 'packages/plugin-sdk');
const require = createRequire(import.meta.url);
const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const tscCli = require.resolve('typescript/bin/tsc');

test('published plugin SDK contains self-contained OpenDesk contracts', async () => {
    await execFileAsync(process.execPath, [npmCli, 'run', 'build'], {
        cwd: pluginPackageRoot,
        windowsHide: true
    });

    const declarationFiles = ['index.d.ts', 'package.d.ts', 'cli.d.ts'];
    const declarations = await Promise.all(
        declarationFiles.map((file) => readFile(path.join(pluginPackageRoot, 'dist', file), 'utf8'))
    );
    const declarationText = declarations.join('\n');

    for (const exportedType of [
        'ChatMessage',
        'PermissionRequest',
        'PermissionRule',
        'ReasoningEffort',
        'ToolDefinition',
        'ToolExecutionContext',
        'ToolResultWriter'
    ]) {
        assert.match(declarationText, new RegExp(`\\b${exportedType}\\b`));
    }
    assert.doesNotMatch(declarationText, /(?:\.\.\/)+src\/common|packages\/plugin\/src/);

    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'opendesk-plugin-sdk-contracts-'));
    try {
        const packageDirectory = path.join(fixtureRoot, 'node_modules/@bitclub.ai/opendesk-plugin-sdk');
        await mkdir(packageDirectory, { recursive: true });
        await writeFile(
            path.join(packageDirectory, 'package.json'),
            await readFile(path.join(pluginPackageRoot, 'package.json'), 'utf8')
        );
        await mkdir(path.join(packageDirectory, 'dist'));
        await Promise.all(
            ['index.d.ts', 'package.d.ts', 'cli.d.ts'].map(async (file) => {
                await writeFile(
                    path.join(packageDirectory, 'dist', file),
                    await readFile(path.join(pluginPackageRoot, 'dist', file), 'utf8')
                );
            })
        );
        await cp(path.join(projectRoot, 'node_modules/zod'), path.join(fixtureRoot, 'node_modules/zod'), {
            recursive: true
        });
        await writeFile(
            path.join(fixtureRoot, 'plugin.ts'),
            [
                "import { tool, type ChatMessage, type PermissionRequest, type PermissionRule, type ReasoningEffort, type ToolDefinition } from '@bitclub.ai/opendesk-plugin-sdk';",
                '',
                'declare const message: ChatMessage;',
                'declare const request: PermissionRequest;',
                'declare const rule: PermissionRule;',
                "const effort: ReasoningEffort = 'medium';",
                'const definition = tool({',
                "    name: 'write-report',",
                "    description: 'write a report',",
                '    args: { path: tool.schema.string() },',
                "    agentIds: ['main'],",
                '    serialExecution: true,',
                '    getDeclaredPermissions(args) {',
                "        return [{ resourceType: 'file', action: 'write', resourcePath: args.path }];",
                '    },',
                '    async execute(args, context, result) {',
                '        result.attachResult(args.path);',
                '        result.updateResultObject({ aborted: context.abort.aborted });',
                '    },',
                '    async stop() {}',
                '});',
                'const publicDefinition: ToolDefinition<typeof definition.parameters> = definition;',
                'void [message, request, rule, effort, publicDefinition];'
            ].join('\n')
        );
        await writeFile(
            path.join(fixtureRoot, 'tsconfig.json'),
            JSON.stringify(
                {
                    compilerOptions: {
                        module: 'NodeNext',
                        moduleResolution: 'NodeNext',
                        strict: true,
                        noEmit: true,
                        skipLibCheck: true
                    },
                    files: ['plugin.ts']
                },
                null,
                4
            )
        );

        await execFileAsync(process.execPath, [tscCli, '-p', path.join(fixtureRoot, 'tsconfig.json')], {
            cwd: fixtureRoot,
            windowsHide: true
        });
    } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
    }
});
