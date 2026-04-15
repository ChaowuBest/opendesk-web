import type { OpenDeskTUI } from '../entry.js';
import { ConfirmOverlay, InfoOverlay } from '../components/notice.js';
import { getFileCompletions } from '../components/file-completions.js';
import { SkillRegistry } from '../../applications/skillmgr/skillregistry.js';
import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs';
import { logger } from '../../utils/logger.js';

export function registerExportCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'export',
        description: '导出会话或技能：/export html|json <文件名>；/export skill <技能名> <路径.zip>',
        getArgumentCompletions: (argPrefix: string) => {
            const parts = argPrefix.split(/\s+/);
            if (parts.length <= 1 && !argPrefix.includes(' ')) {
                const prefix = (parts[0] ?? '').toLowerCase();
                const options = [
                    { value: 'html', label: 'html', description: '导出为 HTML 文件' },
                    {
                        value: 'json',
                        label: 'json',
                        description: '导出为 JSON（可与 /import 兼容）'
                    },
                    { value: 'skill', label: 'skill', description: '将技能导出为 zip 文件' }
                ];
                if (!prefix) return options;
                return options.filter((o) => o.value.startsWith(prefix));
            }
            const format = (parts[0] ?? '').toLowerCase();
            if ((format === 'html' || format === 'json') && argPrefix.includes(' ')) {
                const pathQuery = argPrefix.slice(argPrefix.indexOf(' ') + 1);
                return getFileCompletions(tui.workspace, pathQuery, {
                    valuePrefix: format + ' ',
                    extensions: format === 'json' ? ['.json'] : ['.html', '.htm']
                });
            }
            if (format === 'skill' && argPrefix.includes(' ')) {
                const afterSkill = argPrefix.slice(argPrefix.indexOf(' ') + 1);
                const skillSpaceIdx = afterSkill.indexOf(' ');
                if (skillSpaceIdx === -1) {
                    // 补全技能名称
                    const namePrefix = afterSkill.toLowerCase();
                    const skills = SkillRegistry.listSkills();
                    const items = skills
                        .filter(
                            (s: any) =>
                                !namePrefix ||
                                s.name.toLowerCase().startsWith(namePrefix) ||
                                s.name.toLowerCase().includes(namePrefix)
                        )
                        .map((s: any) => ({
                            value: 'skill ' + s.name,
                            label: s.name,
                            description: s.description?.slice(0, 60) || ''
                        }));
                    return items.length > 0 ? items : null;
                } else {
                    // 补全文件路径
                    const skillName = afterSkill.slice(0, skillSpaceIdx);
                    const pathQuery = afterSkill.slice(skillSpaceIdx + 1);
                    return getFileCompletions(tui.workspace, pathQuery, {
                        valuePrefix: `skill ${skillName} `,
                        extensions: ['.zip']
                    });
                }
            }
            return null;
        },
        execute: async (args: string) => {
            const trimmed = args.trim();
            const firstSpace = trimmed.indexOf(' ');
            const format = firstSpace === -1 ? trimmed.toLowerCase() : trimmed.slice(0, firstSpace).toLowerCase();
            const restArgs = firstSpace === -1 ? '' : trimmed.slice(firstSpace).trim();

            // /export skill <skillName> <path.zip>
            if (format === 'skill') {
                await handleExportSkill(tui, restArgs);
                return;
            }

            if (!tui.activeTaskId) {
                logger.warn('No active task to export');
                return;
            }

            const task = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!task) {
                logger.warn('Task not found');
                return;
            }

            let filePath = restArgs;

            if (format !== 'html' && format !== 'json') {
                const info = new InfoOverlay(tui, {
                    title: '导出',
                    message:
                        '用法：/export html <文件名> 或 /export json <文件名.json> 或 /export skill <技能名> <路径.zip>',
                    closeLabel: '确定'
                });
                info.show();
                return;
            }

            const doExportHtml = async (absolutePath: string) => {
                await tui.doExport(task, absolutePath);
            };

            const doExportJson = async (absolutePath: string) => {
                fs.writeFileSync(absolutePath, JSON.stringify(task.toJSON(), null, 4), {
                    encoding: 'utf8'
                });
                logger.info(`Task exported to JSON: ${absolutePath}`);
                const info = new InfoOverlay(tui, {
                    title: '导出成功',
                    message: `任务已导出为 JSON：\n${absolutePath}`,
                    closeLabel: '确定'
                });
                info.show();
            };

            if (format === 'json') {
                if (!filePath) {
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    filePath = `opendesk-task-${timestamp}.json`;
                    logger.info(`未指定文件名，将使用自动生成的文件名：${filePath}`);
                }
                if (!filePath.endsWith('.json')) {
                    filePath += '.json';
                }
                const absolutePath = path.resolve(tui.workspace, filePath);
                if (fs.existsSync(absolutePath)) {
                    const confirm = new ConfirmOverlay(tui, {
                        title: '文件已存在',
                        message: `文件 ${absolutePath} 已存在。是否覆盖？`,
                        confirmLabel: '覆盖',
                        cancelLabel: '取消'
                    });
                    confirm.show(() => {
                        doExportJson(absolutePath);
                    });
                } else {
                    await doExportJson(absolutePath);
                }
                return;
            }

            // format === 'html'
            if (!filePath) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                filePath = `opendesk-session-${timestamp}.html`;
                logger.info(`未指定文件名，将使用自动生成的文件名：${filePath}`);
            }
            if (!filePath.endsWith('.html')) {
                filePath += '.html';
            }
            const absolutePath = path.resolve(tui.workspace, filePath);
            if (fs.existsSync(absolutePath)) {
                const confirm = new ConfirmOverlay(tui, {
                    title: '文件已存在',
                    message: `文件 ${absolutePath} 已存在。是否覆盖？`,
                    confirmLabel: '覆盖',
                    cancelLabel: '取消'
                });
                confirm.show(async () => {
                    await doExportHtml(absolutePath);
                });
            } else {
                await doExportHtml(absolutePath);
            }
        }
    });
}

/**
 * 处理 /export skill <skillName> <path.zip>
 */
async function handleExportSkill(tui: OpenDeskTUI, restArgs: string): Promise<void> {
    const parts = restArgs.trim().split(/\s+/);
    const skillName = parts[0] || '';
    let zipPath = parts.slice(1).join(' ').trim();

    if (!skillName) {
        const info = new InfoOverlay(tui, {
            title: '导出技能',
            message: '用法：/export skill <技能名> <路径.zip>\n例如：/export skill my-skill ./my-skill.zip',
            closeLabel: '确定'
        });
        info.show();
        return;
    }

    const skills = SkillRegistry.listSkills();
    const skill = skills.find((s: any) => s.name === skillName);
    if (!skill) {
        const info = new InfoOverlay(tui, {
            title: '导出失败',
            message: `未找到技能 "${skillName}"。\n已安装的技能：${skills.map((s: any) => s.name).join(', ') || '（无）'}`,
            closeLabel: '确定'
        });
        info.show();
        return;
    }

    const skillsDir = SkillRegistry.getSkillsDirectory();
    const skillDir = path.join(skillsDir, skill.name);
    if (!fs.existsSync(skillDir)) {
        const info = new InfoOverlay(tui, {
            title: '导出失败',
            message: `技能目录不存在：${skillDir}`,
            closeLabel: '确定'
        });
        info.show();
        return;
    }

    if (!zipPath) {
        zipPath = `${skill.name}.zip`;
    }
    if (!zipPath.endsWith('.zip')) {
        zipPath += '.zip';
    }

    const absolutePath = path.isAbsolute(zipPath) ? zipPath : path.resolve(tui.workspace, zipPath);

    const doExport = () => {
        try {
            const parentDir = path.dirname(absolutePath);
            if (!fs.existsSync(parentDir)) {
                fs.mkdirSync(parentDir, { recursive: true });
            }
            const zip = new AdmZip();
            zip.addLocalFolder(skillDir);
            zip.writeZip(absolutePath);
            logger.info(`Skill "${skill.name}" exported to: ${absolutePath}`);
            const info = new InfoOverlay(tui, {
                title: '导出成功',
                message: `技能 "${skill.name}" 已导出到：\n${absolutePath}`,
                closeLabel: '确定'
            });
            info.show();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`Export skill failed: ${message}`);
            const info = new InfoOverlay(tui, {
                title: '导出失败',
                message: `导出技能失败：${message}`,
                closeLabel: '确定'
            });
            info.show();
        }
    };

    if (fs.existsSync(absolutePath)) {
        const confirm = new ConfirmOverlay(tui, {
            title: '文件已存在',
            message: `文件 ${absolutePath} 已存在。是否覆盖？`,
            confirmLabel: '覆盖',
            cancelLabel: '取消'
        });
        confirm.show(() => {
            doExport();
        });
    } else {
        doExport();
    }
}
