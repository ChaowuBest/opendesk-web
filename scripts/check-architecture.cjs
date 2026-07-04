#!/usr/bin/env node

/**
 * 架构约束检查脚本 (OpenDesk)
 *
 * 白名单机制：LAYER_DEPS 定义每个层允许依赖的层列表，
 * 不在白名单中的跨层依赖视为违规。
 * 未出现在 LAYER_DEPS 中的层不做检查。
 */

const fs = require('fs');
const path = require('path');

const LAYER_DEPS = {
    utils: [],
    aikernel: ['utils', 'tui'],
    services: ['utils', 'aikernel'],
    applications: ['aikernel', 'services', 'tui', 'utils', 'plugins']
};

// 文件级例外：允许特定文件依赖白名单之外的层。
// 仅用于无法通过重构避免的合理跨层依赖，每条需注明理由。
const FILE_EXCEPTIONS = {
    // 导出功能需要读取 aikernel 的 GoalStates 来渲染目标状态，属于合理的跨层读取
    'src/main/utils/export.ts': ['aikernel']
};

const colors = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m'
};

function log(color, message) {
    console.log(`${color}${message}${colors.reset}`);
}

function extractImports(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const imports = [];

    // ES6 import (排除 import type)
    const esImportRegex = /import\s+(?!type\s+).*?\s+from\s+['"](.+?)['"]/g;
    let match;
    while ((match = esImportRegex.exec(content)) !== null) {
        imports.push(match[1]);
    }

    const dynamicImportRegex = /import\s*\(\s*['"](.+?)['"]\s*\)/g;
    while ((match = dynamicImportRegex.exec(content)) !== null) {
        imports.push(match[1]);
    }

    const requireRegex = /require\s*\(\s*['"](.+?)['"]\s*\)/g;
    while ((match = requireRegex.exec(content)) !== null) {
        imports.push(match[1]);
    }

    return imports;
}

function getLayer(filePath) {
    const mainIndex = filePath.indexOf(path.join('src', 'main') + path.sep);
    if (mainIndex === -1) return null;

    const relativePath = filePath.substring(mainIndex + path.join('src', 'main').length + 1);
    const firstDir = relativePath.split(path.sep)[0];

    if (firstDir.includes('.')) return null;

    return LAYER_DEPS.hasOwnProperty(firstDir) ? firstDir : null;
}

function getTargetLayer(importPath, currentFile) {
    if (!importPath.startsWith('.')) return 'external';

    const currentDir = path.dirname(currentFile);
    const resolved = path.resolve(currentDir, importPath);

    const mainIndex = resolved.indexOf(path.join('src', 'main') + path.sep);
    if (mainIndex === -1) return null;

    const relativePath = resolved.substring(mainIndex + path.join('src', 'main').length + 1);
    return relativePath.split(path.sep)[0];
}

function checkFile(filePath) {
    const violations = [];
    const currentLayer = getLayer(filePath);

    if (!currentLayer) return violations;

    const imports = extractImports(filePath);
    const allowedDeps = LAYER_DEPS[currentLayer] || [];

    const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
    const fileExceptions = FILE_EXCEPTIONS[relativePath] || [];

    for (const importPath of imports) {
        const targetLayer = getTargetLayer(importPath, filePath);

        if (targetLayer && targetLayer !== 'external' && targetLayer !== currentLayer) {
            if (!allowedDeps.includes(targetLayer) && !fileExceptions.includes(targetLayer)) {
                violations.push({
                    file: filePath,
                    from: currentLayer,
                    to: targetLayer,
                    import: importPath
                });
            }
        }
    }

    return violations;
}

function getSourceFiles(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;

    const files = fs.readdirSync(dir);

    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
            if (!file.startsWith('.') && file !== 'node_modules') {
                getSourceFiles(filePath, fileList);
            }
        } else if (file.endsWith('.ts') || file.endsWith('.js')) {
            if (!file.endsWith('.d.ts') && !file.endsWith('.test.ts') && !file.endsWith('.spec.ts')) {
                fileList.push(filePath);
            }
        }
    }

    return fileList;
}

function main() {
    log(colors.blue, '🏗️  检查架构约束 (OpenDesk)...');

    const mainDir = path.join(__dirname, '..', 'src', 'main');

    if (!fs.existsSync(mainDir)) {
        log(colors.red, '❌ src/main 目录不存在');
        process.exit(1);
    }

    const layersToCheck = Object.keys(LAYER_DEPS);
    let allFiles = [];
    for (const layer of layersToCheck) {
        const layerDir = path.join(mainDir, layer);
        allFiles = allFiles.concat(getSourceFiles(layerDir));
    }

    const allViolations = [];

    for (const file of allFiles) {
        const violations = checkFile(file);
        allViolations.push(...violations);
    }

    if (allViolations.length > 0) {
        log(colors.red, `\n❌ 发现 ${allViolations.length} 个架构违规:\n`);

        for (const v of allViolations) {
            console.log(`  ${colors.red}✗${colors.reset} ${path.relative(process.cwd(), v.file)}`);
            console.log(`    ${colors.yellow}→${colors.reset} "${v.from}" 层不允许依赖 "${v.to}" 层`);
            console.log(`    import: ${v.import}\n`);
        }

        log(colors.yellow, '\n💡 提示：请检查 LAYER_DEPS 中的白名单配置，不在白名单中的跨层依赖视为违规');

        log(colors.yellow, `\n⚠️  发现架构违规（${allViolations.length} 处），请逐步修复`);
        process.exit(0);
    } else {
        log(colors.green, `✅ 架构检查通过（检查了 ${allFiles.length} 个文件）`);
        process.exit(0);
    }
}

main();
