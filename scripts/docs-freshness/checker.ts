/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at:
 *          http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface CheckResult {
    type: 'error' | 'warning' | 'info';
    file: string;
    message: string;
    detail?: string;
}

export interface ScanResult {
    path: string;
    size: number;
    modified: Date;
}

export function findMarkdownFiles(dir: string, excludeDirs: string[] = ['node_modules', '.git']): string[] {
    const files: string[] = [];

    if (!fs.existsSync(dir)) return files;

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (!excludeDirs.includes(entry.name) && !entry.name.startsWith('.')) {
                files.push(...findMarkdownFiles(fullPath, excludeDirs));
            }
        } else if (entry.name.endsWith('.md')) {
            files.push(fullPath);
        }
    }

    return files;
}

export function scanDocs(rootDir: string): ScanResult[] {
    const files = findMarkdownFiles(rootDir);

    return files.map((f) => ({
        path: path.relative(rootDir, f),
        size: fs.statSync(f).size,
        modified: fs.statSync(f).mtime
    }));
}

export function checkRelativeLinks(docPath: string, content: string, rootDir: string): CheckResult[] {
    const results: CheckResult[] = [];
    const relativeLinkRegex = /\[([^\]]*)\]\((\.\/[^)]+)\)/g;
    let match;

    while ((match = relativeLinkRegex.exec(content)) !== null) {
        const linkText = match[1];
        const linkPath = match[2];

        // Strip the #anchor fragment before checking file existence
        const hashIndex = linkPath.indexOf('#');
        const filePathPart = hashIndex >= 0 ? linkPath.slice(0, hashIndex) : linkPath;
        const anchorPart = hashIndex >= 0 ? linkPath.slice(hashIndex + 1) : null;

        const resolvedPath = path.resolve(path.dirname(docPath), filePathPart);

        if (!fs.existsSync(resolvedPath)) {
            results.push({
                type: 'error',
                file: path.relative(rootDir, docPath),
                message: `链接目标不存在: ${linkPath}`,
                detail: `链接文本: "${linkText}"`
            });
            continue;
        }

        // For markdown files, verify the anchor exists as a heading
        if (anchorPart && resolvedPath.endsWith('.md')) {
            const targetContent = fs.readFileSync(resolvedPath, 'utf-8');
            const headingAnchors = extractMarkdownAnchors(targetContent);
            if (!headingAnchors.has(anchorPart)) {
                results.push({
                    type: 'warning',
                    file: path.relative(rootDir, docPath),
                    message: `链接锚点不存在: ${linkPath}`,
                    detail: `链接文本: "${linkText}", 目标文件中未找到锚点 #${anchorPart}`
                });
            }
        }
    }

    return results;
}

/**
 * Extract all GitHub-style heading anchors from markdown content.
 * GitHub generates anchors by: lowercasing, replacing spaces with hyphens,
 * and removing non-alphanumeric characters (except hyphens and CJK characters).
 */
function extractMarkdownAnchors(content: string): Set<string> {
    const anchors = new Set<string>();
    const headingRegex = /^#{1,6}\s+(.+)$/gm;
    let match;

    while ((match = headingRegex.exec(content)) !== null) {
        const heading = match[1].trim();
        // Remove markdown formatting (links, images, bold, etc.)
        const text = heading
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> text
            .replace(/[*_`~]/g, '') // emphasis/code
            .trim();
        // GitHub anchor generation: lowercase, spaces -> -, remove special chars
        const anchor = text
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^\w\u4e00-\u9fff-]/g, '');
        if (anchor) {
            anchors.add(anchor);
        }
    }

    return anchors;
}

export function checkImageReferences(docPath: string, content: string, rootDir: string): CheckResult[] {
    const results: CheckResult[] = [];
    const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let match;

    while ((match = imageRegex.exec(content)) !== null) {
        const altText = match[1];
        const imgPath = match[2];

        if (imgPath.startsWith('http://') || imgPath.startsWith('https://')) {
            continue;
        }

        const resolvedPath = path.resolve(path.dirname(docPath), imgPath);

        if (!fs.existsSync(resolvedPath)) {
            results.push({
                type: 'warning',
                file: path.relative(rootDir, docPath),
                message: `图片资源不存在: ${imgPath}`,
                detail: `alt 文本: "${altText}"`
            });
        }
    }

    return results;
}

export function checkVersionConsistency(rootDir: string): CheckResult[] {
    const results: CheckResult[] = [];
    const packageJsonPath = path.join(rootDir, 'package.json');
    const readmePath = path.join(rootDir, 'README.md');
    const readmeEnPath = path.join(rootDir, 'README_EN.md');

    if (!fs.existsSync(packageJsonPath)) {
        results.push({ type: 'error', file: 'package.json', message: 'package.json 文件不存在' });
        return results;
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const version = packageJson.version;

    const versionBadgeRegex = /版本-([0-9]+\.[0-9]+\.[0-9]+)/;
    const versionBadgeRegexEn = /Version-([0-9]+\.[0-9]+\.[0-9]+)/;

    if (fs.existsSync(readmePath)) {
        const readmeContent = fs.readFileSync(readmePath, 'utf-8');
        const match = readmeContent.match(versionBadgeRegex);

        if (!match) {
            results.push({
                type: 'warning',
                file: 'README.md',
                message: '未找到版本号徽章',
                detail: `期望格式: 版本-${version}`
            });
        } else if (match[1] !== version) {
            results.push({
                type: 'error',
                file: 'README.md',
                message: `版本号不一致`,
                detail: `package.json: ${version}, README.md: ${match[1]}`
            });
        } else {
            results.push({ type: 'info', file: 'README.md', message: `版本号一致: ${version}` });
        }
    }

    if (fs.existsSync(readmeEnPath)) {
        const readmeEnContent = fs.readFileSync(readmeEnPath, 'utf-8');
        const match = readmeEnContent.match(versionBadgeRegexEn);

        if (!match) {
            results.push({
                type: 'warning',
                file: 'README_EN.md',
                message: '未找到版本号徽章',
                detail: `期望格式: Version-${version}`
            });
        } else if (match[1] !== version) {
            results.push({
                type: 'error',
                file: 'README_EN.md',
                message: `版本号不一致`,
                detail: `package.json: ${version}, README_EN.md: ${match[1]}`
            });
        } else {
            results.push({ type: 'info', file: 'README_EN.md', message: `版本号一致: ${version}` });
        }
    }

    return results;
}

export function checkLicenseConsistency(rootDir: string): CheckResult[] {
    const results: CheckResult[] = [];
    const packageJsonPath = path.join(rootDir, 'package.json');
    const readmePath = path.join(rootDir, 'README.md');

    if (!fs.existsSync(packageJsonPath)) return results;

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const packageLicense = packageJson.license;

    if (fs.existsSync(readmePath)) {
        const readme = fs.readFileSync(readmePath, 'utf-8');
        const licenseRegex = /\[([^\]]+)\]\(\.\/LICENSE\)/;
        const match = readme.match(licenseRegex);

        if (match) {
            const readmeLicense = match[1];
            if (!readmeLicense.toLowerCase().includes(packageLicense.toLowerCase())) {
                results.push({
                    type: 'warning',
                    file: 'README.md',
                    message: 'README 中的许可证名称可能与 package.json 不一致',
                    detail: `README: ${readmeLicense}, package.json: ${packageLicense}`
                });
            }
        }
    }

    const licensePath = path.join(rootDir, 'LICENSE');
    if (!fs.existsSync(licensePath)) {
        results.push({ type: 'error', file: 'LICENSE', message: 'LICENSE 文件不存在' });
    }

    return results;
}

export function checkSourceFileRefs(docPath: string, content: string, rootDir: string): CheckResult[] {
    const results: CheckResult[] = [];
    const relFile = path.relative(rootDir, docPath);
    const reported = new Set<string>();

    const refRegex = /\[`?([^`\]]*)`?\]\((src\/[^)#\s]+)\)/g;
    let match;
    while ((match = refRegex.exec(content)) !== null) {
        const refPath = match[2].replace(/:\d+$/, '');
        if (reported.has(refPath)) continue;
        const resolved = path.join(rootDir, refPath);
        if (!fs.existsSync(resolved)) {
            reported.add(refPath);
            results.push({
                type: 'warning',
                file: relFile,
                message: `引用的源码路径不存在: ${refPath}`,
                detail: `建议: 确认文件是否已重命名或移动，更新文档中的路径`
            });
        }
    }

    const inlineRefRegex = /(?:^|[`\s(])(src\/[\w./-]+\.(?:ts|js|tsx|jsx|json|css|html))(?::\d+)?(?:[`\s).,]|$)/gm;
    while ((match = inlineRefRegex.exec(content)) !== null) {
        const refPath = match[1];
        if (reported.has(refPath)) continue;
        const resolved = path.join(rootDir, refPath);
        if (!fs.existsSync(resolved)) {
            reported.add(refPath);
            results.push({
                type: 'warning',
                file: relFile,
                message: `引用的源码路径不存在: ${refPath}`,
                detail: `建议: 确认文件是否已重命名或移动，更新文档中的路径`
            });
        }
    }

    return results;
}

export function checkNpmScriptRefs(docPath: string, content: string, rootDir: string): CheckResult[] {
    const results: CheckResult[] = [];
    const relFile = path.relative(rootDir, docPath);

    const packageJsonPath = path.join(rootDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return results;

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const scripts = packageJson.scripts || {};

    const scriptRefRegex = /npm run ([a-zA-Z0-9_:.-]+)/g;
    let match;
    const seen = new Set<string>();

    while ((match = scriptRefRegex.exec(content)) !== null) {
        let scriptName = match[1];
        scriptName = scriptName.replace(/[`"',;)}\].]+$/, '');
        if (scriptName.startsWith('--') || !scriptName) continue;

        if (seen.has(scriptName)) continue;
        seen.add(scriptName);

        if (!scripts[scriptName]) {
            results.push({
                type: 'warning',
                file: relFile,
                message: `引用的 npm 脚本不存在: npm run ${scriptName}`,
                detail: `建议: 在 package.json scripts 中添加 "${scriptName}" 或更新文档`
            });
        }
    }

    return results;
}

/** 去掉源码里的块注释与行注释，避免注释中提到的注册器名被当成已注册 */
function stripCodeComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * 取出 BUILTIN_COMMAND_REGISTRARS 数组字面量的内容。
 * 不用正则是因为该声明带箭头函数的类型注解（`Array<(tui: ...) => void>`），
 * `[^=]*` 这类写法会在注解里的 `=` 上断掉。按方括号配对取值更稳。
 */
function extractRegistrarArray(source: string): string | undefined {
    const anchor = source.indexOf('BUILTIN_COMMAND_REGISTRARS');
    if (anchor < 0) return undefined;
    const start = source.indexOf('[', anchor);
    if (start < 0) return undefined;
    let depth = 0;
    for (let i = start; i < source.length; i++) {
        const char = source[i];
        if (char === '[') depth++;
        else if (char === ']') {
            depth--;
            if (depth === 0) return source.slice(start + 1, i);
        }
    }
    return undefined;
}

/**
 * 需要与内置命令保持一致的 CLI 文档。中英文档都要查：
 * 只查中文时英文文档会悄悄漂移（列出已删除的命令、缺少新命令），而英文用户照着做会失败。
 */
const CLI_GUIDE_FILES = ['docs/cliguide.md', 'docs/cliguide_en.md'];

export function checkSlashCommandDocs(rootDir: string): CheckResult[] {
    const results: CheckResult[] = [];

    const commandsIndexPath = path.join(rootDir, 'src', 'main', 'tui', 'commands', 'index.ts');
    if (!fs.existsSync(commandsIndexPath)) return results;

    const indexContent = fs.readFileSync(commandsIndexPath, 'utf-8');

    // 只有两种写法算「真的注册了」：
    // 1. 作为表驱动数组 BUILTIN_COMMAND_REGISTRARS 的元素（见 commands/index.ts）
    // 2. 直接调用 registerXxxCommand(tui)（旧结构，保留兼容）
    // 不能在整个文件里泛匹配 registerXxxCommand —— 那样 import 行也算数，
    // 而「加了 import 却忘记加入注册器数组」正是表驱动设计下最容易犯、也最该被检查出来的错。
    const registrarArray = extractRegistrarArray(indexContent);
    const registrarSource = registrarArray === undefined ? indexContent : stripCodeComments(registrarArray);
    // registerAllCommands 是聚合函数而不是命令，需排除
    const codeCmdRegex =
        registrarArray === undefined
            ? /register(?!All)([A-Z]\w*?)Commands?\(tui\)/g
            : /register(?!All)([A-Z]\w*?)Commands?\b/g;
    const registeredCmds = new Set<string>();
    for (const match of registrarSource.matchAll(codeCmdRegex)) {
        const name = match[1]
            .replace(/([A-Z])/g, '-$1')
            .toLowerCase()
            .replace(/^-/, '')
            .replace(/-command$/, '');
        registeredCmds.add(name);
    }

    for (const relGuide of CLI_GUIDE_FILES) {
        const guidePath = path.join(rootDir, relGuide);
        if (!fs.existsSync(guidePath)) continue;

        const guideContent = fs.readFileSync(guidePath, 'utf-8');
        const documentedCmds = new Set<string>();
        for (const match of guideContent.matchAll(/\|\s*`\/(\w+)`/g)) {
            documentedCmds.add(match[1]);
        }

        const guideName = path.basename(relGuide);

        for (const cmd of registeredCmds) {
            const normalizedCmd = cmd.replace(/-/g, '');
            const found = [...documentedCmds].some((d) => d.toLowerCase() === normalizedCmd || d.toLowerCase() === cmd);
            if (!found) {
                results.push({
                    type: 'warning',
                    file: relGuide,
                    message: `斜杠命令 /${cmd} 已注册但未在文档中列出`,
                    detail: `建议: 在 ${guideName} 的命令列表表格中添加 /${cmd} 的说明`
                });
            }
        }

        for (const cmd of documentedCmds) {
            const found = [...registeredCmds].some(
                (r) => r.replace(/-/g, '') === cmd.toLowerCase() || r === cmd.toLowerCase()
            );
            if (!found) {
                results.push({
                    type: 'warning',
                    file: relGuide,
                    message: `文档中列出的 /${cmd} 命令在代码中未找到注册`,
                    detail: `建议: 确认命令是否已被移除，若是则从 ${guideName} 中删除`
                });
            }
        }

        if (documentedCmds.size > 0 && registeredCmds.size > 0) {
            const docCount = documentedCmds.size;
            const codeCount = registeredCmds.size;
            results.push({
                type: 'info',
                file: relGuide,
                message:
                    docCount < codeCount
                        ? `斜杠命令: 文档 ${docCount} 个 / 代码 ${codeCount} 个 (文档待补充)`
                        : `斜杠命令: 文档 ${docCount} 个 / 代码 ${codeCount} 个`
            });
        }
    }

    return results;
}

export function checkMarkdownFile(filePath: string, rootDir: string): CheckResult[] {
    const results: CheckResult[] = [];

    if (!fs.existsSync(filePath)) return results;

    const content = fs.readFileSync(filePath, 'utf-8');

    results.push(...checkRelativeLinks(filePath, content, rootDir));
    results.push(...checkImageReferences(filePath, content, rootDir));
    results.push(...checkSourceFileRefs(filePath, content, rootDir));
    results.push(...checkNpmScriptRefs(filePath, content, rootDir));

    return results;
}

export interface FullCheckResult {
    errors: CheckResult[];
    warnings: CheckResult[];
    infos: CheckResult[];
    fileCount: number;
}

export function runFullCheck(rootDir: string): FullCheckResult {
    const results: CheckResult[] = [];
    let fileCount = 0;

    results.push(...checkVersionConsistency(rootDir));

    const docsDir = path.join(rootDir, 'docs');
    if (fs.existsSync(docsDir)) {
        const mdFiles = findMarkdownFiles(docsDir);
        fileCount += mdFiles.length;
        for (const file of mdFiles) {
            results.push(...checkMarkdownFile(file, rootDir));
        }
    }

    const readmePath = path.join(rootDir, 'README.md');
    const readmeEnPath = path.join(rootDir, 'README_EN.md');

    if (fs.existsSync(readmePath)) {
        results.push(...checkMarkdownFile(readmePath, rootDir));
        fileCount++;
    }
    if (fs.existsSync(readmeEnPath)) {
        results.push(...checkMarkdownFile(readmeEnPath, rootDir));
        fileCount++;
    }

    results.push(...checkLicenseConsistency(rootDir));
    results.push(...checkSlashCommandDocs(rootDir));

    results.push({ type: 'info', file: 'docs/', message: `已检查 ${fileCount} 个 Markdown 文件` });

    return {
        errors: results.filter((r) => r.type === 'error'),
        warnings: results.filter((r) => r.type === 'warning'),
        infos: results.filter((r) => r.type === 'info'),
        fileCount
    };
}

export function fixVersion(rootDir: string, filePath: string): { success: boolean; message: string } {
    const packageJsonPath = path.join(rootDir, 'package.json');

    if (!fs.existsSync(packageJsonPath)) {
        return { success: false, message: 'package.json 不存在' };
    }

    if (!fs.existsSync(filePath)) {
        return { success: false, message: `文件不存在: ${filePath}` };
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const version = packageJson.version;

    let content = fs.readFileSync(filePath, 'utf-8');

    const cnBadge = /版本-([0-9]+\.[0-9]+\.[0-9]+)/;
    const enBadge = /Version-([0-9]+\.[0-9]+\.[0-9]+)/;

    let replaced = false;
    if (cnBadge.test(content)) {
        content = content.replace(cnBadge, `版本-${version}`);
        replaced = true;
    }
    if (enBadge.test(content)) {
        content = content.replace(enBadge, `Version-${version}`);
        replaced = true;
    }

    if (!replaced) {
        return { success: false, message: '未找到版本号徽章' };
    }

    fs.writeFileSync(filePath, content);
    return { success: true, message: `已更新版本号为 ${version}` };
}

export interface FixResult {
    fixed: { file: string; message: string }[];
    skipped: { file: string; message: string }[];
}

export function fixAll(rootDir: string): FixResult {
    const result: FixResult = { fixed: [], skipped: [] };

    const checkResult = runFullCheck(rootDir);
    const versionErrors = checkResult.errors.filter((e) => e.message.includes('版本号不一致'));

    for (const err of versionErrors) {
        const filePath = path.join(rootDir, err.file);
        const fix = fixVersion(rootDir, filePath);
        if (fix.success) {
            result.fixed.push({ file: err.file, message: fix.message });
        } else {
            result.skipped.push({ file: err.file, message: fix.message });
        }
    }

    const linkErrors = checkResult.errors.filter((e) => e.message.includes('链接目标不存在'));
    for (const err of linkErrors) {
        result.skipped.push({ file: err.file, message: `${err.message} (需手动修复)` });
    }

    const imgWarnings = checkResult.warnings.filter((e) => e.message.includes('图片资源不存在'));
    for (const w of imgWarnings) {
        result.skipped.push({ file: w.file, message: `${w.message} (需手动修复)` });
    }

    return result;
}

export interface ScanFileInfo {
    path: string;
    size: number;
}

export function scanDocFiles(rootDir: string): ScanFileInfo[] {
    const files: string[] = [];

    const docsDir = path.join(rootDir, 'docs');
    if (fs.existsSync(docsDir)) {
        files.push(...findMarkdownFiles(docsDir));
    }

    const readmePath = path.join(rootDir, 'README.md');
    const readmeEnPath = path.join(rootDir, 'README_EN.md');
    if (fs.existsSync(readmePath)) files.push(readmePath);
    if (fs.existsSync(readmeEnPath)) files.push(readmeEnPath);

    return files.map((f) => ({
        path: path.relative(rootDir, f),
        size: fs.statSync(f).size
    }));
}
