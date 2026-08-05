/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import type { OpenDeskTUI } from '../entry.js';
import { ConfirmOverlay, InfoOverlay } from '../components/notice.js';
import { getFileCompletions } from '../components/file-completions.js';
import { skillRegistry } from '../../applications/skillmgr/utils/skill-registry.js';
import AdmZip from 'adm-zip';
import { cleanPathInput } from '../../../utils/path.js';
import path from 'path';
import fs from 'fs';
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';

export function registerExportCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'export',
        description: t('export.description'),
        getArgumentCompletions: (argPrefix: string) => {
            const parts = argPrefix.split(/\s+/);
            if (parts.length <= 1 && !argPrefix.includes(' ')) {
                const prefix = (parts[0] ?? '').toLowerCase();
                const options = [
                    { value: 'html', label: 'html', description: t('export.html.description') },
                    {
                        value: 'json',
                        label: 'json',
                        description: t('export.json.description')
                    },
                    { value: 'skill', label: 'skill', description: t('export.skill.description') }
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
                    const skills = skillRegistry.listSkills();
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
                    title: t('export.title'),
                    message: t('export.usage'),
                    closeLabel: t('common.close')
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
                    title: t('export.success.json'),
                    message: `${t('export.success.json.detail')}${absolutePath}`,
                    closeLabel: t('common.close')
                });
                info.show();
            };

            if (format === 'json') {
                if (!filePath) {
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    filePath = `opendesk-task-${timestamp}.json`;
                    logger.info(`Filename not specified, using auto-generated: ${filePath}`);
                }
                if (!filePath.endsWith('.json')) {
                    filePath += '.json';
                }
                const absolutePath = path.resolve(tui.workspace, filePath);
                if (fs.existsSync(absolutePath)) {
                    const confirm = new ConfirmOverlay(tui, {
                        title: t('export.file.exists'),
                        message: `${t('export.file.exists.detail')}${absolutePath}${t('export.file.exists.suffix')}`,
                        confirmLabel: t('common.cover'),
                        cancelLabel: t('common.cancel')
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
                logger.info(`Filename not specified, using auto-generated: ${filePath}`);
            }
            if (!filePath.endsWith('.html')) {
                filePath += '.html';
            }
            const absolutePath = path.resolve(tui.workspace, filePath);
            if (fs.existsSync(absolutePath)) {
                const confirm = new ConfirmOverlay(tui, {
                    title: t('export.file.exists'),
                    message: `${t('export.file.exists.detail')}${absolutePath}${t('export.file.exists.suffix')}`,
                    confirmLabel: t('common.cover'),
                    cancelLabel: t('common.cancel')
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
            title: t('export.skill.usage').split('：')[0],
            message: t('export.skill.usage'),
            closeLabel: t('common.close')
        });
        info.show();
        return;
    }

    const skills = skillRegistry.listSkills();
    const skill = skills.find((s: any) => s.name === skillName);
    if (!skill) {
        const info = new InfoOverlay(tui, {
            title: t('export.skill.not.found'),
            message: `${t('export.skill.not.found.detail')}${skillName}"${t('export.skill.not.found.suffix')}${skills.map((s: any) => s.name).join(', ') || '(' + t('common.none') + ')'}`,
            closeLabel: t('common.close')
        });
        info.show();
        return;
    }

    const skillsDir = skillRegistry.getSkillsDirectory();
    const skillDir = path.join(skillsDir, skill.name);
    if (!fs.existsSync(skillDir)) {
        const info = new InfoOverlay(tui, {
            title: t('export.skill.dir.not.exist'),
            message: `${t('export.skill.dir.not.exist.detail')}${skillDir}`,
            closeLabel: t('common.close')
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

    // 清理不可见的 Unicode 字符和首尾空白，避免 path.isAbsolute 误判
    const cleanedPath = cleanPathInput(zipPath);
    const absolutePath = path.isAbsolute(cleanedPath) ? cleanedPath : path.resolve(tui.workspace, cleanedPath);

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
                title: t('export.skill.success'),
                message: `${t('export.skill.success.detail')}${skill.name}${t('export.skill.success.suffix')}${absolutePath}`,
                closeLabel: t('common.close')
            });
            info.show();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`Export skill failed: ${message}`);
            const info = new InfoOverlay(tui, {
                title: t('export.skill.fail'),
                message: `${t('export.skill.fail.detail')}${message}`,
                closeLabel: t('common.close')
            });
            info.show();
        }
    };

    if (fs.existsSync(absolutePath)) {
        const confirm = new ConfirmOverlay(tui, {
            title: t('export.file.exists'),
            message: `${t('export.file.exists.detail')}${absolutePath}${t('export.file.exists.suffix')}`,
            confirmLabel: t('common.cover'),
            cancelLabel: t('common.cancel')
        });
        confirm.show(() => {
            doExport();
        });
    } else {
        doExport();
    }
}
