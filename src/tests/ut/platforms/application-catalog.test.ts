import { expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const applications = [
    ['mailbox', 'MailboxApplication'],
    ['filemgr', 'FileMgrApplication'],
    ['calendar', 'CalendarApplication'],
    ['notes', 'NotesApplication'],
    ['browser', 'BrowserApplication'],
    ['search', 'SearchApplication'],
    ['terminal', 'TerminalApplication'],
    ['skillmgr', 'SkillMgrApplication'],
    ['pluginmgr', 'PluginMgrApplication'],
    ['appmgr', 'AppMgrApplication'],
    ['mcpmgr', 'McpMgrApplication'],
    ['acpmgr', 'AcpMgrApplication'],
    ['todomgr', 'TodoMgrApplication'],
    ['channelmgr', 'ChannelMgrApplication'],
    ['knowledgebase', 'KnowledgeBaseApplication'],
    ['devicemgr', 'DeviceMgrApplication'],
    ['builtin', 'BuiltinApplication'],
    ['agentgate', 'AgentGateApplication'],
    ['adminconsole', 'AdminConsoleApplication'],
    ['agentoffice', 'AgentOfficeApplication'],
    ['workflowMgr', 'WorkflowMgrApplication'],
    ['benchmark', 'BenchmarkApplication']
];
const classes = applications.map(([, name]) => Object.defineProperty(class {}, 'name', { value: name }));
for (const [index, [directory, name]] of applications.entries()) {
    jest.unstable_mockModule(`../../../main/applications/${directory}/app.js`, () => ({ [name]: classes[index] }));
}
const { getGuiApplicationClasses } = await import('../../../platforms/applications.js');

function loadPlatformCatalogMethod(file: string, className: string, extra: Record<string, unknown> = {}) {
    const source = readFileSync(new URL(`../../../platforms/${file}.ts`, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(`${file}.ts`, source, ts.ScriptTarget.ES2022, true);
    const declaration = ast.statements.find(
        (node) => ts.isClassDeclaration(node) && node.name?.text === className
    ) as ts.ClassDeclaration;
    const method = declaration.members.find(
        (node) => ts.isMethodDeclaration(node) && node.name.getText(ast) === 'getApplicationClasses'
    );
    expect(method).toBeDefined();
    const script = ts.transpileModule(`class Host { ${method!.getText(ast)} }; new Host().getApplicationClasses();`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText;
    return runInNewContext(script, { getGuiApplicationClasses, ...extra });
}

test('the common GUI catalog preserves the worker application set and registration order', () => {
    expect(getGuiApplicationClasses()).toEqual(classes);
    expect(new Set(getGuiApplicationClasses()).size).toBe(classes.length);
});

test('each host receives a fresh catalog array', () => {
    const first = getGuiApplicationClasses();
    first.pop();
    expect(getGuiApplicationClasses()).toEqual(classes);
});

test('the actual WorkerPlatform method consumes the common catalog', () => {
    expect(loadPlatformCatalogMethod('worker', 'WorkerPlatform')).toEqual(classes);
});

test('the actual ElectronPlatform method adds Slides only for its configured host', () => {
    class SlidesApplication {}
    expect(loadPlatformCatalogMethod('electron', 'ElectronPlatform', { SlidesApplication })).toEqual([
        ...classes,
        SlidesApplication
    ]);
    expect(getGuiApplicationClasses()).not.toContain(SlidesApplication);
});
