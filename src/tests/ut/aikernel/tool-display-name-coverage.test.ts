import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { enUs } from '../../../locale/en-us.js';
import { zhCn } from '../../../locale/zh-cn.js';

const DYNAMIC_TOOL_FILES = new Set([
    'src/main/applications/mcpmgr/mcp-tool.ts',
    'src/main/applications/pluginmgr/runtime/mcp.ts',
    'src/main/applications/pluginmgr/runtime/tool-provider.ts'
]);

function findTypeScriptFiles(directory: string): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) return findTypeScriptFiles(filePath);
        return entry.isFile() && entry.name.endsWith('.ts') ? [filePath] : [];
    });
}

function findSuperCall(node: ts.Node): ts.CallExpression | undefined {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) return node;
    let result: ts.CallExpression | undefined;
    ts.forEachChild(node, (child) => {
        result ??= findSuperCall(child);
    });
    return result;
}

function findStringConstants(sourceFile: ts.SourceFile): Map<string, string> {
    const constants = new Map<string, string>();
    for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (
                ts.isIdentifier(declaration.name) &&
                declaration.initializer &&
                ts.isStringLiteralLike(declaration.initializer)
            ) {
                constants.set(declaration.name.text, declaration.initializer.text);
            }
        }
    }
    return constants;
}

function resolveDisplayNameKey(argument: ts.Expression, constants: Map<string, string>): string | undefined {
    if (ts.isStringLiteralLike(argument)) return argument.text;
    if (ts.isIdentifier(argument)) return constants.get(argument.text);
    return undefined;
}

function scanStaticToolDisplayNames(): { missing: string[]; displayNameKeys: string[] } {
    const root = process.cwd();
    const sourceRoot = path.join(root, 'src/main');
    const missing: string[] = [];
    const displayNameKeys = new Set<string>();

    for (const filePath of findTypeScriptFiles(sourceRoot)) {
        const relativePath = path.relative(root, filePath);
        if (DYNAMIC_TOOL_FILES.has(relativePath)) continue;

        const source = fs.readFileSync(filePath, 'utf8');
        const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const constants = findStringConstants(sourceFile);

        function visit(node: ts.Node): void {
            if (
                ts.isNewExpression(node) &&
                ['BaseTool', 'RendererTool'].includes(node.expression.getText(sourceFile)) &&
                (node.arguments?.length ?? 0) < 4
            ) {
                const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
                missing.push(`${relativePath}:${line + 1}:${node.expression.getText(sourceFile)}`);
            } else if (
                ts.isNewExpression(node) &&
                ['BaseTool', 'RendererTool'].includes(node.expression.getText(sourceFile)) &&
                node.arguments?.[3]
            ) {
                const displayNameKey = resolveDisplayNameKey(node.arguments[3], constants);
                if (displayNameKey) displayNameKeys.add(displayNameKey);
            }
            if (ts.isClassDeclaration(node)) {
                if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword)) {
                    ts.forEachChild(node, visit);
                    return;
                }
                const baseNames =
                    node.heritageClauses?.flatMap((clause) =>
                        clause.types.map((type) => type.expression.getText(sourceFile))
                    ) ?? [];
                const toolBaseName = baseNames.find((name) =>
                    ['BaseTool', 'HarmonyBaseTool', 'InteractiveTool', 'NodeCommandTool'].includes(name)
                );
                if (toolBaseName) {
                    const constructor = node.members.find(ts.isConstructorDeclaration);
                    const superCall = constructor ? findSuperCall(constructor) : undefined;
                    const requiredArgumentCount = toolBaseName === 'NodeCommandTool' ? 6 : 4;
                    if (superCall && superCall.arguments.length < requiredArgumentCount) {
                        missing.push(`${relativePath}:${node.name?.text ?? '<anonymous>'}`);
                    } else if (superCall) {
                        const displayNameKey = resolveDisplayNameKey(
                            superCall.arguments[requiredArgumentCount - 1],
                            constants
                        );
                        if (displayNameKey) displayNameKeys.add(displayNameKey);
                    }
                }
            }
            ts.forEachChild(node, visit);
        }

        visit(sourceFile);
    }

    return {
        missing: missing.sort(),
        displayNameKeys: [...displayNameKeys].sort()
    };
}

describe('built-in tool display names', () => {
    test('terminal tools declare localized display names', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/main/applications/terminal/tools.ts'), 'utf8');
        const displayNameKeys = [
            'tools.terminal.executeBash.name',
            'tools.terminal.executeZsh.name',
            'tools.terminal.executePowerShell.name'
        ];

        for (const displayNameKey of displayNameKeys) {
            expect(source).toContain(`'${displayNameKey}'`);
            expect(zhCn[displayNameKey]).toBeTruthy();
            expect(enUs[displayNameKey]).toBeTruthy();
        }
    });

    test('every static built-in tool explicitly declares a display name', () => {
        expect(scanStaticToolDisplayNames().missing).toEqual([]);
    });

    test('every static built-in tool display name is localized', () => {
        for (const displayNameKey of scanStaticToolDisplayNames().displayNameKeys) {
            expect(zhCn[displayNameKey]).toBeTruthy();
            expect(enUs[displayNameKey]).toBeTruthy();
        }
    });
});
