#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

interface CheckResult {
    type: 'error' | 'warning' | 'info';
    file: string;
    message: string;
    detail?: string;
}

const results: CheckResult[] = [];

const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

function log(color: keyof typeof colors, message: string) {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

function checkRelativeLinks(docPath: string, content: string): void {
    const relativeLinkRegex = /\[([^\]]*)\]\((\.\/[^)]+)\)/g;
    let match;

    while ((match = relativeLinkRegex.exec(content)) !== null) {
        const linkText = match[1];
        const linkPath = match[2];
        const resolvedPath = path.resolve(path.dirname(docPath), linkPath);

        if (!fs.existsSync(resolvedPath)) {
            results.push({
                type: 'error',
                file: path.relative(rootDir, docPath),
                message: `链接目标不存在: ${linkPath}`,
                detail: `链接文本: "${linkText}"`
            });
        }
    }
}

function checkImageReferences(docPath: string, content: string): void {
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
}

function checkCodeBlocks(docPath: string, content: string): void {
    const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let match;
    let blockCount = 0;

    while ((match = codeBlockRegex.exec(content)) !== null) {
        blockCount++;
        const lang = match[1] || '未指定';
        const code = match[2];

        if (code.trim().length === 0) {
            results.push({
                type: 'warning',
                file: path.relative(rootDir, docPath),
                message: `代码块 #${blockCount} 为空`,
                detail: `语言: ${lang}`
            });
        }
    }
}

function checkDocumentStructure(docPath: string): void {
    const content = fs.readFileSync(docPath, 'utf-8');

    if (!content.includes('## ')) {
        results.push({
            type: 'warning',
            file: path.relative(rootDir, docPath),
            message: '文档缺少二级标题结构'
        });
    }
}

function checkMarkdownFile(filePath: string): void {
    if (!fs.existsSync(filePath)) {
        return;
    }

    const content = fs.readFileSync(filePath, 'utf-8');

    checkRelativeLinks(filePath, content);
    checkImageReferences(filePath, content);
    checkCodeBlocks(filePath, content);
}

function checkVersionConsistency(): void {
    log('blue', '\n📦 检查版本号一致性...');

    const packageJsonPath = path.join(rootDir, 'package.json');
    const readmePath = path.join(rootDir, 'README.md');
    const readmeEnPath = path.join(rootDir, 'README_EN.md');

    if (!fs.existsSync(packageJsonPath)) {
        results.push({
            type: 'error',
            file: 'package.json',
            message: 'package.json 文件不存在'
        });
        return;
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
            results.push({
                type: 'info',
                file: 'README.md',
                message: `版本号一致: ${version}`
            });
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
            results.push({
                type: 'info',
                file: 'README_EN.md',
                message: `版本号一致: ${version}`
            });
        }
    }
}

function checkLicenseConsistency(): void {
    log('blue', '\n📄 检查许可证一致性...');

    const packageJsonPath = path.join(rootDir, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const packageLicense = packageJson.license;

    const readmePath = path.join(rootDir, 'README.md');
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
        results.push({
            type: 'error',
            file: 'LICENSE',
            message: 'LICENSE 文件不存在'
        });
    }
}

function findMarkdownFiles(dir: string): string[] {
    const files: string[] = [];

    if (!fs.existsSync(dir)) return files;

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            files.push(...findMarkdownFiles(fullPath));
        } else if (entry.name.endsWith('.md')) {
            files.push(fullPath);
        }
    }

    return files;
}

function generateReport(showInfo: boolean = true): boolean {
    const errors = results.filter((r) => r.type === 'error');
    const warnings = results.filter((r) => r.type === 'warning');
    const infos = results.filter((r) => r.type === 'info');

    if (errors.length > 0) {
        log('red', `\n❌ 错误 (${errors.length}):`);
        for (const e of errors) {
            console.log(`   ${colors.red}✗${colors.reset} [${e.file}] ${e.message}`);
            if (e.detail) {
                console.log(`     ${colors.yellow}→ ${e.detail}${colors.reset}`);
            }
        }
    }

    if (warnings.length > 0) {
        log('yellow', `\n⚠️  警告 (${warnings.length}):`);
        for (const w of warnings) {
            console.log(`   ${colors.yellow}!${colors.reset} [${w.file}] ${w.message}`);
            if (w.detail) {
                console.log(`     ${colors.yellow}→ ${w.detail}${colors.reset}`);
            }
        }
    }

    if (showInfo && infos.length > 0) {
        log('blue', `\nℹ️  信息 (${infos.length}):`);
        for (const i of infos) {
            console.log(`   ${colors.blue}•${colors.reset} [${i.file}] ${i.message}`);
        }
    }

    return errors.length === 0;
}

function runFullCheck(): void {
    log('cyan', '🔍 OpenDesk 文档新鲜度检查（完整模式）');
    log('cyan', '━'.repeat(40));

    checkVersionConsistency();

    log('blue', '\n📚 检查文档目录...');
    const docsDir = path.join(rootDir, 'docs');
    if (fs.existsSync(docsDir)) {
        const mdFiles = findMarkdownFiles(docsDir);
        for (const file of mdFiles) {
            checkMarkdownFile(file);
            checkDocumentStructure(file);
        }
        results.push({
            type: 'info',
            file: 'docs/',
            message: `已检查 ${mdFiles.length} 个 Markdown 文件`
        });
    }

    log('blue', '\n🔗 检查 README 链接...');
    const readmePath = path.join(rootDir, 'README.md');
    const readmeEnPath = path.join(rootDir, 'README_EN.md');

    if (fs.existsSync(readmePath)) {
        checkMarkdownFile(readmePath);
    }
    if (fs.existsSync(readmeEnPath)) {
        checkMarkdownFile(readmeEnPath);
    }

    checkLicenseConsistency();

    log('cyan', '\n' + '='.repeat(60));
    log('cyan', '📊 文档新鲜度检查报告');
    log('cyan', '='.repeat(60));

    const success = generateReport(true);

    log('cyan', '\n' + '='.repeat(60));

    if (success) {
        log('green', '✅ 检查完成: 所有文档新鲜度检查通过');
        process.exit(0);
    } else {
        const errors = results.filter((r) => r.type === 'error');
        const warnings = results.filter((r) => r.type === 'warning');
        log('red', `❌ 检查完成: ${errors.length} 个错误, ${warnings.length} 个警告`);
        process.exit(1);
    }
}

function runIncrementalCheck(files: string[]): void {
    log('cyan', `📝 增量文档检查 (${files.length} 个文件)...`);

    const mdFiles = files.filter((f) => f.endsWith('.md'));
    const hasPackageJson = files.some((f) => f.endsWith('package.json'));

    for (const file of mdFiles) {
        const absolutePath = path.isAbsolute(file) ? file : path.join(rootDir, file);
        checkMarkdownFile(absolutePath);
    }

    if (hasPackageJson) {
        const packageJsonPath = path.join(rootDir, 'package.json');
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        const version = packageJson.version;

        const readmePath = path.join(rootDir, 'README.md');
        const readmeEnPath = path.join(rootDir, 'README_EN.md');

        const versionBadgeRegex = /版本-([0-9]+\.[0-9]+\.[0-9]+)/;
        const versionBadgeRegexEn = /Version-([0-9]+\.[0-9]+\.[0-9]+)/;

        if (fs.existsSync(readmePath)) {
            const readmeContent = fs.readFileSync(readmePath, 'utf-8');
            const match = readmeContent.match(versionBadgeRegex);
            if (match && match[1] !== version) {
                results.push({
                    type: 'error',
                    file: 'README.md',
                    message: `版本号不一致`,
                    detail: `package.json: ${version}, README.md: ${match[1]}`
                });
            }
        }

        if (fs.existsSync(readmeEnPath)) {
            const readmeEnContent = fs.readFileSync(readmeEnPath, 'utf-8');
            const match = readmeEnContent.match(versionBadgeRegexEn);
            if (match && match[1] !== version) {
                results.push({
                    type: 'error',
                    file: 'README_EN.md',
                    message: `版本号不一致`,
                    detail: `package.json: ${version}, README_EN.md: ${match[1]}`
                });
            }
        }
    }

    const success = generateReport(false);

    if (success) {
        log('green', '✅ 文档检查通过');
        process.exit(0);
    } else {
        log('red', '❌ 文档检查失败');
        process.exit(1);
    }
}

function printUsage(): void {
    console.log(`
用法:
  tsx scripts/docs-freshness.ts              完整检查（检查所有文档）
  tsx scripts/docs-freshness.ts <files...>   增量检查（只检查指定文件）

示例:
  npm run check:docs                         完整检查
  tsx scripts/docs-freshness.ts README.md    只检查 README.md
  tsx scripts/docs-freshness.ts package.json 检查版本号一致性
`);
}

function main(): void {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        printUsage();
        process.exit(0);
    }

    if (args.length === 0) {
        runFullCheck();
    } else {
        runIncrementalCheck(args);
    }
}

main();
