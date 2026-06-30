/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import type { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { getPlatform } from '../../../platforms/base.js';
import { CliPlatform } from '../../../platforms/cli.js';
import { setRuntimeLocale } from '../../../locale/index.js';
import { AgentRegistry } from '../../aikernel/agents/registry.js';
import { GlobalState } from '../../aikernel/states/global.js';
import { ApplicationRegistry, initializeRegistry, initializeRegistryWorker } from '../registry.js';
import { useCliTransport, useConsoleTransport } from '../../utils/logger.js';
import { setCustomOpendeskDirectory } from '../../utils/setting.js';
import { getTempDir, initTempDir } from '../../utils/temp.js';
import { SkillAnalyzer, type AnalyzeStatus } from './analyzer/analyze.js';
import { tryLoadOpendeskMeta } from './analyzer/metadata.js';
import {
    TEST_RESULTS_REPORT_MODAL_CLASS,
    TEST_RESULTS_REPORT_STYLE,
    buildSelectedSkillTestReportPage
} from './renderer/testResultsReportPage.js';
import { SkillRegistry } from './utils.js';
import {
    buildSkillRunSummary,
    formatTestCaseStats,
    getTestCaseStats,
    parseSkillNameList,
    parseTestCaseIndices,
    resolveSkillIdsByName,
    type SkillTestCliSkill
} from './skill-test-utils.js';

interface SkillTestGenOptions {
    all?: boolean;
    autoRun?: boolean;
    concurrency?: string | number;
    export?: string;
}

interface SkillTestRunOptions {
    all?: boolean;
    unpassed?: boolean;
    cases?: string;
    concurrency?: string | number;
    export?: string;
}

interface SkillSelectionItem {
    id: string;
    name: string;
    description: string;
    statsText: string;
    disabled: boolean;
}

type SkillTestMode = 'gen' | 'run';

let runtimeInitialized = false;

export function registerSkillTestCliSubcommands(skillCmd: Command): void {
    const testCmd = skillCmd.command('test').description('技能测试用例');

    testCmd.action(() => {
        testCmd.outputHelp();
    });

    testCmd
        .command('gen [names]')
        .description('生成技能测试用例')
        .option('--all', '为全部用户安装的技能生成测试用例')
        .option('--auto-run', '生成完成后自动运行测试用例')
        .option('--concurrency <n>', '并发数，默认 5', '5')
        .option('--export <path>', '导出路径；不指定时导出到临时目录')
        .action(async (names: string | undefined, opts: SkillTestGenOptions, command: Command) => {
            await runSkillTestCliAction(command, async () => {
                await initializeSkillTestRuntime(command);
                const skills = SkillRegistry.listSkills() as SkillTestCliSkill[];
                const selectedSkillIds = await resolveCliSkillIds(skills, names, !!opts.all, 'gen');
                const concurrency = parseConcurrency(opts.concurrency);

                const analyzer = await runAnalyzerWithProgress('生成', (runner) => {
                    return runner.generateTests(selectedSkillIds, concurrency);
                });

                if (opts.autoRun) {
                    const runAnalyzer = await runAnalyzerWithProgress('运行', (runner) => {
                        return runner.runTests(selectedSkillIds, concurrency);
                    });
                    console.log(buildSkillRunSummary(selectedSkillIds, skills, runAnalyzer.getStatus().results));
                    const exportDir = await exportSkillTestArtifacts(runAnalyzer, selectedSkillIds, true, opts.export);
                    console.log(`导出路径: ${exportDir}`);
                    return;
                }

                const exportDir = await exportSkillTestArtifacts(analyzer, selectedSkillIds, false, opts.export);
                console.log(`导出路径: ${exportDir}`);
            });
        });

    testCmd
        .command('run [names]')
        .description('运行技能测试用例')
        .option('--all', '运行全部用户安装的技能测试用例')
        .option('--unpassed', '只运行未通过的测试用例')
        .option('--cases <indices>', '逗号分隔的用例序号（1-based），仅限一个技能')
        .option('--concurrency <n>', '并发数，默认 5', '5')
        .option('--export <path>', '导出路径；不指定时导出到临时目录')
        .action(async (names: string | undefined, opts: SkillTestRunOptions, command: Command) => {
            await runSkillTestCliAction(command, async () => {
                await initializeSkillTestRuntime(command);
                const skills = SkillRegistry.listSkills() as SkillTestCliSkill[];
                const selectedSkillIds = await resolveCliSkillIds(skills, names, !!opts.all, 'run');
                const concurrency = parseConcurrency(opts.concurrency);
                const testCaseIndices = parseTestCaseIndices(opts.cases);

                if (testCaseIndices.length > 0 && selectedSkillIds.length !== 1) {
                    throw new Error('只能对一个技能指定用例');
                }

                const analyzer = await runAnalyzerWithProgress('运行', (runner) => {
                    if (testCaseIndices.length > 0) {
                        return runner.runSelectedTests(selectedSkillIds[0], testCaseIndices, concurrency);
                    }
                    if (opts.unpassed) {
                        return runner.runUnpassedTests(selectedSkillIds, concurrency);
                    }
                    return runner.runTests(selectedSkillIds, concurrency);
                });

                console.log(buildSkillRunSummary(selectedSkillIds, skills, analyzer.getStatus().results));
                const exportDir = await exportSkillTestArtifacts(analyzer, selectedSkillIds, true, opts.export);
                console.log(`导出路径: ${exportDir}`);
            });
        });
}

async function runSkillTestCliAction(command: Command, action: () => Promise<void>): Promise<void> {
    let exitCode = 0;
    try {
        await action();
    } catch (error) {
        console.error(`✗ ${(error as Error).message}`);
        const testCommand = command.parent;
        if (testCommand) {
            const commandName = command.name();
            if (commandName === 'gen' || commandName === 'run') {
                console.error(`  查看帮助: opendesk skill test ${commandName} --help`);
            }
        }
        exitCode = 1;
    }
    await flushSkillTestTaskSaves();
    process.exit(exitCode);
}

async function flushSkillTestTaskSaves(): Promise<void> {
    if (!runtimeInitialized) return;
    try {
        await GlobalState.getInstance().taskManagerState.flushAllPendingSaves();
    } catch {
        /* CLI 已完成主要工作，任务落盘失败不改变命令退出码。 */
    }
}

async function initializeSkillTestRuntime(command: Command): Promise<void> {
    useCliTransport();
    useConsoleTransport();

    const opts = command.optsWithGlobals() as Record<string, unknown>;
    if (typeof opts.configDirectory === 'string') {
        setCustomOpendeskDirectory(opts.configDirectory);
    }
    if (typeof opts.language === 'string') {
        setRuntimeLocale(opts.language);
    }

    const workspacePath = path.resolve(typeof opts.workspace === 'string' ? opts.workspace : '.');
    if (!fs.existsSync(workspacePath)) {
        throw new Error(`workspace ${workspacePath} does not exist`);
    }

    const platform = getPlatform();
    if (platform instanceof CliPlatform) {
        platform.setWorkspace(workspacePath);
    }

    const mounted = opts.skillmgrMountSkill;
    const mountedDirs = Array.isArray(mounted) ? mounted : mounted ? [mounted] : [];
    for (const dir of mountedDirs) {
        if (typeof dir === 'string') {
            SkillRegistry.addMountedDir(dir);
        }
    }

    initTempDir();

    if (runtimeInitialized) return;
    GlobalState.initialize();
    AgentRegistry.initBuiltinAgents();
    initializeRegistry();
    initializeRegistryWorker();
    GlobalState.getInstance().taskManagerState.toolsetProvider = {
        listAvailableToolsets: () => ApplicationRegistry.listAvailableToolsets()
    };
    runtimeInitialized = true;
}

async function resolveCliSkillIds(
    skills: SkillTestCliSkill[],
    names: string | undefined,
    all: boolean,
    mode: SkillTestMode
): Promise<string[]> {
    const parsedNames = parseSkillNameList(names);
    if (!all && parsedNames.length === 0) {
        return selectSkillsInteractively(skills, mode);
    }

    const skillIds = resolveSkillIdsByName(skills, parsedNames, all);
    if (skillIds.length === 0) {
        throw new Error('没有可操作的用户安装技能');
    }
    return skillIds;
}

function parseConcurrency(raw: string | number | undefined): number {
    const value = typeof raw === 'number' ? raw : Number(raw ?? 5);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('并发数必须是正整数');
    }
    return value;
}

async function runAnalyzerWithProgress(
    label: string,
    start: (analyzer: SkillAnalyzer) => Promise<AnalyzeStatus>
): Promise<SkillAnalyzer> {
    let resolveDone: (status: AnalyzeStatus) => void = () => {};
    const done = new Promise<AnalyzeStatus>((resolve) => {
        resolveDone = resolve;
    });
    const analyzer = createProgressAnalyzer(label, (status) => {
        if (!status.running) {
            resolveDone(status);
        }
    });

    const initial = await start(analyzer);
    if (initial.running) {
        await done;
    }
    return analyzer;
}

function createProgressAnalyzer(label: string, onStatus?: (status: AnalyzeStatus) => void): SkillAnalyzer {
    let lastProgress = '';
    return new SkillAnalyzer((status) => {
        const progress = `${label}进度: ${status.completed}/${status.total}`;
        if (progress !== lastProgress) {
            process.stdout.write(`\r${progress}`);
            lastProgress = progress;
        }
        if (!status.running) {
            process.stdout.write('\n');
        }
        onStatus?.(status);
    });
}

async function exportSkillTestArtifacts(
    analyzer: SkillAnalyzer,
    skillIds: string[],
    includeRunReport: boolean,
    outputPath?: string
): Promise<string> {
    const exportDir = outputPath
        ? path.resolve(outputPath)
        : fs.mkdtempSync(path.join(getTempDir(), 'opendesk-skill-test-'));
    fs.mkdirSync(exportDir, { recursive: true });

    const analyzePageResult = await analyzer.exportAnalyzePage(path.join(exportDir, 'index.html'), skillIds);
    if (!analyzePageResult.success) {
        throw new Error(`导出技能测试信息页面失败: ${analyzePageResult.error}`);
    }

    const metadataResult = await analyzer.exportMetadatas(skillIds, path.join(exportDir, 'metadatas.zip'));
    if (!metadataResult.success) {
        console.error(`元数据导出失败: ${metadataResult.errors.join('；')}`);
    } else if (metadataResult.errors.length > 0) {
        console.error(`元数据导出部分失败: ${metadataResult.errors.join('；')}`);
    }

    if (includeRunReport) {
        const skills = SkillRegistry.listSkills() as SkillTestCliSkill[];
        const report = buildSelectedSkillTestReportPage({
            skillIds,
            skills,
            results: analyzer.getStatus().results
        });
        if (report.hasTestInfo) {
            fs.writeFileSync(path.join(exportDir, 'test-report.html'), wrapTestReportHtml(report.html), 'utf-8');
        }
    }

    return exportDir;
}

function wrapTestReportHtml(reportHtml: string): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>技能测试运行统计</title>
<style>
body { margin: 0; padding: 24px; background: #fbfbfb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.analyze-modal-dialog { width: min(790px, calc(100vw - 48px)); margin: 0 auto; }
.analyze-modal-body { padding: 0; }
${TEST_RESULTS_REPORT_STYLE}
</style>
</head>
<body>
<div class="analyze-modal-dialog ${TEST_RESULTS_REPORT_MODAL_CLASS}">
    <div class="analyze-modal-body">${reportHtml}</div>
</div>
</body>
</html>`;
}

async function selectSkillsInteractively(skills: SkillTestCliSkill[], mode: SkillTestMode): Promise<string[]> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('未指定技能名称，请传入 names 或使用 --all');
    }

    const items = buildSelectionItems(skills, mode);
    if (items.length === 0) {
        throw new Error('没有可操作的用户安装技能');
    }
    if (mode === 'run' && items.every((item) => item.disabled)) {
        throw new Error('没有可运行测试用例的技能');
    }

    return new Promise<string[]>((resolve, reject) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        const selected = new Set<string>();
        let query = '';
        let cursor = firstSelectableIndex(items);
        let renderedLines = 0;

        const cleanup = () => {
            stdin.off('keypress', onKeypress);
            if (stdin.isTTY) {
                stdin.setRawMode(false);
            }
            stdout.write('\x1b[?25h');
        };

        const finish = () => {
            if (selected.size === 0) {
                const filtered = getFilteredSelectionItems(items, query);
                const item = filtered[cursor];
                if (!item || item.disabled) return;
                selected.add(item.id);
            }
            cleanup();
            stdout.write('\n');
            resolve([...selected]);
        };

        const cancel = () => {
            cleanup();
            stdout.write('\n');
            reject(new Error('已取消选择'));
        };

        const onKeypress = (str: string, key: readline.Key) => {
            if (key.ctrl && key.name === 'c') {
                cancel();
                return;
            }
            if (key.name === 'escape') {
                cancel();
                return;
            }
            if (key.name === 'return' || key.name === 'enter') {
                finish();
                return;
            }
            if (key.name === 'backspace') {
                query = query.slice(0, -1);
                cursor = firstSelectableIndex(getFilteredSelectionItems(items, query));
                render();
                return;
            }
            if (key.name === 'up') {
                cursor = moveSelectionCursor(getFilteredSelectionItems(items, query), cursor, -1);
                render();
                return;
            }
            if (key.name === 'down') {
                cursor = moveSelectionCursor(getFilteredSelectionItems(items, query), cursor, 1);
                render();
                return;
            }
            if (key.name === 'space') {
                const filtered = getFilteredSelectionItems(items, query);
                const item = filtered[cursor];
                if (item && !item.disabled) {
                    if (selected.has(item.id)) selected.delete(item.id);
                    else selected.add(item.id);
                }
                render();
                return;
            }
            if (str && str >= ' ' && !key.ctrl && !key.meta) {
                query += str;
                cursor = firstSelectableIndex(getFilteredSelectionItems(items, query));
                render();
            }
        };

        const render = () => {
            if (renderedLines > 0) {
                stdout.write(`\x1b[${renderedLines}F\x1b[J`);
            }

            const filtered = getFilteredSelectionItems(items, query);
            if (cursor >= filtered.length) {
                cursor = firstSelectableIndex(filtered);
            }

            const title =
                mode === 'run'
                    ? '? 选择要测试的技能 (输入关键词过滤, 空格选择, 回车确认):'
                    : '? 选择要生成测试用例的技能 (输入关键词过滤, 空格选择, 回车确认):';
            const lines = [title, `  搜索: ${query || '(空)'}`];

            if (filtered.length === 0) {
                lines.push('  未找到匹配的技能');
            } else {
                for (let index = 0; index < filtered.length; index++) {
                    const item = filtered[index];
                    const pointer = index === cursor ? '›' : ' ';
                    const marker = item.disabled ? '-' : selected.has(item.id) ? '◉' : '◯';
                    const stats = item.statsText ? `  ${item.statsText}` : '';
                    const disabled = item.disabled ? '  （无可运行用例，不可选）' : '';
                    lines.push(`${pointer} ${marker} ${item.name}${stats}${disabled}`);
                }
            }

            lines.push(`  已选择 ${selected.size} 个`);
            stdout.write('\x1b[?25l' + lines.join('\n') + '\n');
            renderedLines = lines.length;
        };

        readline.emitKeypressEvents(stdin);
        stdin.setRawMode(true);
        stdin.on('keypress', onKeypress);
        render();
    });
}

function buildSelectionItems(skills: SkillTestCliSkill[], mode: SkillTestMode): SkillSelectionItem[] {
    return skills.map((skill) => {
        const testCases = loadSkillTestCases(skill.id);
        const stats = getTestCaseStats(testCases);
        return {
            id: skill.id,
            name: skill.name || skill.id,
            description: skill.description || '',
            statsText: formatTestCaseStats(testCases),
            disabled: mode === 'run' && stats.total === 0
        };
    });
}

function loadSkillTestCases(skillId: string): unknown[] {
    const detail = SkillRegistry.getSkillDetail(skillId);
    if (!detail?.skillDir) return [];
    const meta = tryLoadOpendeskMeta(detail.skillDir);
    if (!meta.success) return [];
    return meta.data.testCases ?? [];
}

function getFilteredSelectionItems(items: SkillSelectionItem[], query: string): SkillSelectionItem[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return items;
    return items.filter((item) => {
        return (
            item.name.toLowerCase().includes(normalized) ||
            item.id.toLowerCase().includes(normalized) ||
            item.description.toLowerCase().includes(normalized)
        );
    });
}

function firstSelectableIndex(items: SkillSelectionItem[]): number {
    const index = items.findIndex((item) => !item.disabled);
    return index >= 0 ? index : 0;
}

function moveSelectionCursor(items: SkillSelectionItem[], cursor: number, direction: -1 | 1): number {
    if (items.length === 0) return 0;
    let next = cursor;
    for (let i = 0; i < items.length; i++) {
        next = (next + direction + items.length) % items.length;
        if (!items[next].disabled) return next;
    }
    return cursor;
}
