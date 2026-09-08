#!/usr/bin/env node

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
    telemetry: ['utils', 'aikernel'],
    aikernel: ['utils', 'tui', 'telemetry'],
    services: ['utils', 'aikernel', 'telemetry'],
    applications: ['aikernel', 'services', 'tui', 'utils', 'plugins', 'telemetry']
};

// aikernel/types 只承载公共契约，所有层均可依赖；其自身仍由下方规则限制为不能依赖其他实现目录。
const SHARED_CONTRACT_LAYERS = ['aikernel/types'];
const AIKERNEL_TYPES_ROOT = path.resolve(process.cwd(), 'src', 'main', 'aikernel', 'types');

// 文件级例外：允许特定文件依赖白名单之外的层。
// 仅用于无法通过重构避免的合理跨层依赖，每条需注明理由。
const FILE_EXCEPTIONS = {
    // 导出功能需要读取 aikernel 的 GoalStates 来渲染目标状态，属于合理的跨层读取
    'src/main/utils/export.ts': ['aikernel'],
    // model-network.ts 是所有 LLM HTTP 请求的汇聚点，在此层插桩 span 最合理
    'src/main/utils/model-network.ts': ['telemetry'],
    // model-context.ts 通过 fetchModelUrl 查询模型元数据，包裹 withSpan 用于 trace
    'src/main/utils/model-context.ts': ['telemetry']
};

// 核心任务状态只能依赖通用 extension 生命周期，具体领域功能反向依赖 TaskState。
const FILE_FORBIDDEN_IMPORTS = {
    'src/main/aikernel/states/tasks.ts': [/\/goal\//]
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

function extractAikernelTypeImports(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const imports = [];
    const staticImportRegex = /(?:import|export)\s+(?:type\s+)?[\s\S]*?\s+from\s+['"](.+?)['"]/g;
    let match;
    while ((match = staticImportRegex.exec(content)) !== null) {
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

    if (resolved === AIKERNEL_TYPES_ROOT || resolved.startsWith(AIKERNEL_TYPES_ROOT + path.sep)) {
        return 'aikernel/types';
    }

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
    const allowedDeps = [...(LAYER_DEPS[currentLayer] || []), ...SHARED_CONTRACT_LAYERS];

    const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
    const fileExceptions = FILE_EXCEPTIONS[relativePath] || [];
    const forbiddenImports = FILE_FORBIDDEN_IMPORTS[relativePath] || [];

    if (filePath.startsWith(AIKERNEL_TYPES_ROOT + path.sep)) {
        for (const importPath of extractAikernelTypeImports(filePath)) {
            if (!importPath.startsWith('.')) continue;
            const resolved = path.resolve(path.dirname(filePath), importPath);
            if (resolved !== AIKERNEL_TYPES_ROOT && !resolved.startsWith(AIKERNEL_TYPES_ROOT + path.sep)) {
                violations.push({
                    file: filePath,
                    from: 'aikernel/types',
                    to: 'aikernel-outside-types',
                    import: importPath
                });
            }
        }
    }

    for (const importPath of imports) {
        if (forbiddenImports.some((pattern) => pattern.test(importPath))) {
            violations.push({
                file: filePath,
                from: currentLayer,
                to: 'forbidden-domain',
                import: importPath
            });
            continue;
        }
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
