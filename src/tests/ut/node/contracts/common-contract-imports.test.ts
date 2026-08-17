import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const sourceRoot = path.join(projectRoot, 'src');

const legacyContracts = new Map<string, Set<string>>([
    [
        path.join(sourceRoot, 'main/aikernel/security/permission'),
        new Set([
            'PermissionAction',
            'PermissionEffect',
            'PermissionRequest',
            'PermissionResourceType',
            'PermissionRule'
        ])
    ],
    [path.join(sourceRoot, 'main/utils/setting'), new Set(['ReasoningEffort'])],
    [path.join(sourceRoot, 'common/reasoning-effort'), new Set(['ReasoningEffort'])],
    [
        path.join(sourceRoot, 'main/aikernel/messages'),
        new Set([
            'CompactBoundaryMetadata',
            'CompactBoundaryStrategy',
            'CompactBoundaryTrigger',
            'CompactSummarizedRange',
            'RuntimeMetadata',
            'ToolCallMicrocompactMetadata',
            'ToolResultStorageMetadata',
            'UsageFields'
        ])
    ]
]);

function exportedContractNames(sourceFile: ts.SourceFile): string[] {
    const names: string[] = [];
    for (const statement of sourceFile.statements) {
        if (
            ts.isTypeAliasDeclaration(statement) &&
            statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        ) {
            names.push(statement.name.text);
        }
        if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            names.push(...statement.exportClause.elements.map((element) => element.name.text));
        }
    }
    return names;
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
        entries.map(async (entry) => {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) return listTypeScriptFiles(entryPath);
            return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
        })
    );
    return nested.flat();
}

test('runtime message classes implement Base-prefixed contracts', async () => {
    const file = path.join(sourceRoot, 'main/aikernel/messages.ts');
    const source = await readFile(file, 'utf8');
    for (const className of ['SystemMessage', 'UserMessage', 'AssistantMessage', 'CompactSeparatorMessage']) {
        assert.match(source, new RegExp(`class\\s+${className}\\s+implements\\s+Base${className}\\b`));
    }
});

test('Base prefix is reserved for contracts implemented by runtime classes', async () => {
    const exportedBaseContracts = new Set<string>();
    for (const file of await listTypeScriptFiles(path.join(sourceRoot, 'main/aikernel/types'))) {
        const source = await readFile(file, 'utf8');
        const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        for (const statement of sourceFile.statements) {
            if (
                (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
                statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
                statement.name.text.startsWith('Base')
            ) {
                exportedBaseContracts.add(statement.name.text);
            }
        }
    }

    const implementedBaseContracts = new Set<string>();
    const runtimeMessagesFile = path.join(sourceRoot, 'main/aikernel/messages.ts');
    const runtimeMessagesSource = await readFile(runtimeMessagesFile, 'utf8');
    const runtimeMessages = ts.createSourceFile(
        runtimeMessagesFile,
        runtimeMessagesSource,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    );
    for (const statement of runtimeMessages.statements) {
        if (!ts.isClassDeclaration(statement)) continue;
        for (const clause of statement.heritageClauses ?? []) {
            if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
            for (const contract of clause.types) {
                const name = contract.expression.getText(runtimeMessages);
                if (name.startsWith('Base')) implementedBaseContracts.add(name);
            }
        }
    }

    assert.deepEqual([...exportedBaseContracts].sort(), [...implementedBaseContracts].sort());
});

test('legacy runtime modules re-export shared contracts', async () => {
    for (const [modulePath, contractNames] of legacyContracts) {
        const file = `${modulePath}.ts`;
        const source = await readFile(file, 'utf8');
        const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const exportedNames = new Set(exportedContractNames(sourceFile));
        assert.deepEqual(
            [...contractNames].filter((name) => !exportedNames.has(name)),
            [],
            `${path.relative(projectRoot, file)} is missing compatibility re-exports`
        );
    }
});
