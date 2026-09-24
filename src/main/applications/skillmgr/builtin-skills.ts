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

/**
 * 随安装包分发的内置技能目录解析。
 *
 * 目录定位：仓库源码中的 resources/skills。
 * - 开发态（electron-vite dev / CLI / tsx）：从当前模块目录向上回溯到应用根，命中 <appRoot>/resources/skills
 * - Electron 发布态：forge extraResource 把 resources/skills 复制到 <安装目录>/resources/skills，经 process.resourcesPath 命中
 * - 鸿蒙 HAP：整个仓库进入 resources/app，从模块目录上溯到 resources/app 后命中其 resources/skills
 *
 * 该目录中的技能在 skillmgr 中归入「内置技能」分组：可以被禁用，不能被删除。
 * 目录解析模式与 pluginmgr/management/paths.ts 的内置插件目录保持一致。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const BUILTIN_SKILLS_DIRECTORY_ENV = 'OPENDESK_BUILTIN_SKILLS_DIRECTORY';

// 内置技能相对于应用根目录的位置。鸿蒙 HAP 把整个仓库放进 resources/app，
// 源目录 resources/skills 随之可用，因此源目录本身即可作为唯一相对位置。
const BUILTIN_SKILLS_APP_RELATIVE_PATHS = [path.join('resources', 'skills')];

function isDirectory(target: string): boolean {
    return fs.existsSync(target) && fs.statSync(target).isDirectory();
}

/** Electron 发布态：resources/skills 由 forge extraResource 落到 resourcesPath/skills */
function electronResourcesSkillsDirectory(): string | undefined {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    return resourcesPath ? path.join(resourcesPath, 'skills') : undefined;
}

/**
 * 从给定目录向上回溯，逐层产出可能的应用根目录。
 * 仅把含 package.json 的层级视为应用根，避免上溯过程中误命中
 * 无关目录（全局安装的 CLI、monorepo 中的兄弟项目等）。
 * 覆盖三种布局，无需写死任何绝对路径：
 *   - electron-vite dev：dist/main/chunks/ → 上溯到仓库根
 *   - CLI bundle：dist/cli/ → 上溯到仓库/包根
 *   - 鸿蒙 HAP：resources/app/dist/main/chunks/ → 上溯到 resources/app
 */
export function* appRootCandidatesFrom(startDirectory: string): Generator<string> {
    let directory = path.resolve(startDirectory);
    for (let depth = 0; depth < 8; depth++) {
        if (fs.existsSync(path.join(directory, 'package.json'))) yield directory;
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
}

function findBuiltinSkillsDirectoryFrom(startDirectory: string): string | undefined {
    for (const appRoot of appRootCandidatesFrom(startDirectory)) {
        for (const relative of BUILTIN_SKILLS_APP_RELATIVE_PATHS) {
            const candidate = path.join(appRoot, relative);
            if (isDirectory(candidate)) return candidate;
        }
    }
    return undefined;
}

/**
 * 解析内置技能根目录：
 * 1. OPENDESK_BUILTIN_SKILLS_DIRECTORY 环境变量（测试与特殊部署覆盖）
 * 2. Electron 发布态 process.resourcesPath/skills（extraResource 落点）
 * 3. 从当前模块目录上溯应用根命中 <appRoot>/resources/skills
 * 全部落空时返回 undefined，表示当前环境没有内置技能目录，调用方按无技能处理。
 */
export function getBuiltinSkillsDirectory(): string | undefined {
    const configured = process.env[BUILTIN_SKILLS_DIRECTORY_ENV];
    if (configured) {
        const resolved = path.resolve(configured);
        if (isDirectory(resolved)) return resolved;
    }

    const packaged = electronResourcesSkillsDirectory();
    if (packaged && isDirectory(packaged)) return packaged;

    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    return findBuiltinSkillsDirectoryFrom(moduleDirectory);
}

/**
 * 列出内置技能根目录下的技能子目录（仅直接子目录；目录不存在时返回空数组）。
 * 内置技能约定为扁平布局：resources/skills/<skill-name>/SKILL.md。
 */
export function listBuiltinSkillDirectories(): string[] {
    const root = getBuiltinSkillsDirectory();
    if (!root) return [];
    try {
        return fs
            .readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => path.join(root, entry.name));
    } catch {
        return [];
    }
}

/**
 * 内置技能的平台限定配置：按技能名列出允许加载的平台，未列出的技能在所有平台加载。
 * 平台名与 getPlatform().getName() 一致（electron / cli / worker）。
 */
const BUILTIN_SKILL_PLATFORMS: Readonly<Record<string, readonly string[]>> = {
    // 可视化技能依赖宿主 UI 的内联图形预览，CLI 没有渲染能力，不注入技能与系统 prompt 介绍
    'analysis-result-visualizer': ['electron']
};

/** 判断指定名称的内置技能是否适用于给定平台 */
export function isBuiltinSkillAvailableOnPlatform(skillName: string, platformName: string): boolean {
    const platforms = BUILTIN_SKILL_PLATFORMS[skillName];
    return platforms === undefined || platforms.includes(platformName);
}
