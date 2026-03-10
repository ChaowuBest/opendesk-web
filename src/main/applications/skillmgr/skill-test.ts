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
 * Skill 测试框架协议
 * 
 * 测试目录结构:
 * skill-name/
 * ├── SKILL.md
 * ├── tests/
 * │   ├── TEST.md           # 测试配置文件
 * │   ├── cases/            # 测试用例目录
 * │   │   ├── environment.test.js
 * │   │   ├── basic.test.js
 * │   │   └── integration.test.js
 * │   └── fixtures/         # 测试数据
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { parse as parseYaml } from 'yaml';
import { logger } from '../../utils/logger.js';

const TESTS_DIR = 'tests';
const TEST_MD_FILENAME = 'TEST.md';
const CASES_DIR = 'cases';
const FIXTURES_DIR = 'fixtures';

const TEST_MD_DEFAULT_CONTENT = `---
version: "1.0"
minOpenDeskVersion: "0.1.0"
timeout: 300
requires:
  node: ">=18.0.0"
  os: ["win32", "darwin", "linux"]
---

# Skill 测试配置

本文件定义了技能测试的配置和依赖要求。

## 配置说明

- version: 测试框架版本
- minOpenDeskVersion: 最低 OpenDesk 版本要求
- timeout: 单个测试用例超时时间（秒）
- requires: 环境依赖要求
  - node: Node.js 版本要求
  - os: 支持的操作系统列表
  - tools: 需要的外部工具
`;

export interface TestRequires {
    node?: string;
    os?: string[];
    tools?: string[];
    env?: Record<string, string>;
    memory?: string;
    disk?: string;
}

export interface TestConfig {
    version: string;
    minOpenDeskVersion?: string;
    timeout?: number;
    requires?: TestRequires;
    metadata?: Record<string, any>;
}

export interface TestCase {
    name: string;
    file: string;
    type: 'environment' | 'functional' | 'integration' | 'stability';
    description?: string;
    skip?: boolean;
    only?: boolean;
}

export interface TestResult {
    name: string;
    file: string;
    status: 'passed' | 'failed' | 'skipped' | 'error';
    duration: number;
    message?: string;
    error?: string;
    details?: any;
}

export interface TestSuiteResult {
    skillId: string;
    skillName: string;
    config: TestConfig | null;
    environment: {
        compatible: boolean;
        checks: EnvironmentCheck[];
    };
    tests: TestResult[];
    summary: {
        total: number;
        passed: number;
        failed: number;
        skipped: number;
        error: number;
        duration: number;
    };
}

export interface EnvironmentCheck {
    name: string;
    required: string | string[] | undefined;
    actual: string;
    passed: boolean;
    message: string;
}

function parseTestConfig(raw: string): TestConfig | null {
    if (!raw || !raw.trim()) return null;
    
    const trimmed = raw.trim();
    if (!trimmed.startsWith('---')) return null;
    
    const secondDash = trimmed.indexOf('\n---', 3);
    if (secondDash === -1) return null;
    
    const frontmatterRaw = trimmed.slice(3, secondDash).trim();
    
    try {
        const parsed = parseYaml(frontmatterRaw) as TestConfig;
        return parsed;
    } catch (e) {
        logger.error(`Failed to parse TEST.md: ${e}`);
        return null;
    }
}

function loadTestConfig(testsDir: string): TestConfig | null {
    const testMdPath = path.join(testsDir, TEST_MD_FILENAME);
    
    if (!fs.existsSync(testMdPath)) {
        return null;
    }
    
    try {
        const raw = fs.readFileSync(testMdPath, 'utf8');
        return parseTestConfig(raw);
    } catch (e) {
        logger.error(`Failed to read TEST.md: ${e}`);
        return null;
    }
}

function discoverTestCases(testsDir: string): TestCase[] {
    const casesDir = path.join(testsDir, CASES_DIR);
    const cases: TestCase[] = [];
    
    if (!fs.existsSync(casesDir) || !fs.statSync(casesDir).isDirectory()) {
        return cases;
    }
    
    const entries = fs.readdirSync(casesDir, { withFileTypes: true });
    
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        
        const ext = path.extname(entry.name).toLowerCase();
        if (!['.js', '.mjs', '.cjs', '.ts'].includes(ext)) continue;
        
        if (!entry.name.includes('.test.') && !entry.name.includes('.spec.')) continue;
        
        const filePath = path.join(casesDir, entry.name);
        const name = path.basename(entry.name, ext);
        
        let type: TestCase['type'] = 'functional';
        if (name.includes('environment') || name.includes('env')) {
            type = 'environment';
        } else if (name.includes('integration') || name.includes('e2e')) {
            type = 'integration';
        } else if (name.includes('stability') || name.includes('stress')) {
            type = 'stability';
        }
        
        cases.push({
            name,
            file: filePath,
            type,
        });
    }
    
    return cases.sort((a, b) => {
        const typeOrder = { environment: 0, functional: 1, integration: 2, stability: 3 };
        return (typeOrder[a.type] ?? 4) - (typeOrder[b.type] ?? 4);
    });
}

function checkNodeVersion(required?: string): EnvironmentCheck {
    const actual = process.versions.node;
    
    if (!required) {
        return {
            name: 'Node.js',
            required: undefined,
            actual: `v${actual}`,
            passed: true,
            message: '无版本要求',
        };
    }
    
    const cleanRequired = required.replace(/[<>=]/g, '').trim();
    const requiredParts = cleanRequired.split('.').map(Number);
    const actualParts = actual.split('.').map(Number);
    
    let passed = true;
    for (let i = 0; i < Math.max(requiredParts.length, actualParts.length); i++) {
        const req = requiredParts[i] ?? 0;
        const act = actualParts[i] ?? 0;
        if (act < req) {
            passed = false;
            break;
        } else if (act > req) {
            break;
        }
    }
    
    return {
        name: 'Node.js',
        required,
        actual: `v${actual}`,
        passed,
        message: passed ? '版本满足要求' : `需要 ${required}，当前 v${actual}`,
    };
}

function checkOS(required?: string[]): EnvironmentCheck {
    const actual = process.platform;
    
    if (!required || required.length === 0) {
        return {
            name: '操作系统',
            required: undefined,
            actual,
            passed: true,
            message: '无操作系统要求',
        };
    }
    
    const passed = required.includes(actual);
    
    return {
        name: '操作系统',
        required,
        actual,
        passed,
        message: passed ? '操作系统兼容' : `需要 ${required.join('/')}，当前 ${actual}`,
    };
}

async function checkTool(name: string): Promise<boolean> {
    return new Promise((resolve) => {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        const child = spawn(cmd, [name], { shell: true });
        
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
    });
}

async function checkTools(required?: string[]): Promise<EnvironmentCheck[]> {
    if (!required || required.length === 0) {
        return [{
            name: '外部工具',
            required: undefined,
            actual: '无要求',
            passed: true,
            message: '无外部工具要求',
        }];
    }
    
    const checks: EnvironmentCheck[] = [];
    
    for (const tool of required) {
        const available = await checkTool(tool);
        checks.push({
            name: `工具: ${tool}`,
            required,
            actual: available ? '已安装' : '未安装',
            passed: available,
            message: available ? `${tool} 可用` : `${tool} 未安装`,
        });
    }
    
    return checks;
}

function checkMemory(required?: string): EnvironmentCheck {
    const totalMem = os.totalmem();
    const totalGB = totalMem / (1024 * 1024 * 1024);
    
    if (!required) {
        return {
            name: '内存',
            required: undefined,
            actual: `${totalGB.toFixed(1)}GB`,
            passed: true,
            message: '无内存要求',
        };
    }
    
    // 解析内存要求（支持 MB/GB）
    const match = required.match(/(\d+(?:\.\d+)?)([MG]B)/i);
    if (!match) {
        return {
            name: '内存',
            required,
            actual: `${totalGB.toFixed(1)}GB`,
            passed: false,
            message: `无效的内存格式: ${required}`,
        };
    }
    
    const [, value, unit] = match;
    const num = parseFloat(value);
    const requiredGB = unit.toLowerCase() === 'mb' ? num / 1024 : num;
    const passed = totalGB >= requiredGB;
    
    return {
        name: '内存',
        required,
        actual: `${totalGB.toFixed(1)}GB`,
        passed,
        message: passed ? '内存满足要求' : `需要 ${required}，当前 ${totalGB.toFixed(1)}GB`,
    };
}

function checkDisk(required?: string): EnvironmentCheck {
    const skillDir = getSkillsDirectory();
    let freeGB = 0;
    
    try {
        const stat = fs.statfsSync ? fs.statfsSync(skillDir) : null;
        if (stat) {
            freeGB = (stat.bsize * stat.bfree) / (1024 * 1024 * 1024);
        } else {
            freeGB = 100;
        }
    } catch {
        freeGB = 100;
    }
    
    if (!required) {
        return {
            name: '磁盘空间',
            required: undefined,
            actual: `${freeGB.toFixed(1)}GB`,
            passed: true,
            message: '无磁盘空间要求',
        };
    }
    
    // 解析容量要求（支持 MB/GB）
    const match = required.match(/(\d+(?:\.\d+)?)([MG]B)/i);
    if (!match) {
        return {
            name: '磁盘空间',
            required,
            actual: `${freeGB.toFixed(1)}GB`,
            passed: false,
            message: `无效的容量格式: ${required}`,
        };
    }
    
    const [, value, unit] = match;
    const num = parseFloat(value);
    const requiredGB = unit.toLowerCase() === 'mb' ? num / 1024 : num;
    const passed = freeGB >= requiredGB;
    
    return {
        name: '磁盘空间',
        required,
        actual: `${freeGB.toFixed(1)}GB 可用`,
        passed,
        message: passed ? '磁盘空间满足要求' : `需要 ${required}，当前 ${freeGB.toFixed(1)}GB 可用`,
    };
}

function getSkillsDirectory(): string {
    const appDir = process.env.APPDATA
        ? path.join(process.env.APPDATA, 'opendesk')
        : path.join(process.env.HOME || '', '.opendesk');
    return path.join(appDir, 'apps', 'skills', 'resources');
}

async function checkEnvironment(config: TestConfig | null): Promise<{ compatible: boolean; checks: EnvironmentCheck[] }> {
    const checks: EnvironmentCheck[] = [];
    
    checks.push(checkNodeVersion(config?.requires?.node));
    checks.push(checkOS(config?.requires?.os));
    checks.push(checkMemory(config?.requires?.memory));
    checks.push(checkDisk(config?.requires?.disk));
    
    const toolChecks = await checkTools(config?.requires?.tools);
    checks.push(...toolChecks);
    
    const compatible = checks.every(c => c.passed);
    
    return { compatible, checks };
}

async function runTestCase(testCase: TestCase, skillDir: string, timeout: number): Promise<TestResult> {
    const startTime = Date.now();
    
    if (testCase.skip) {
        return {
            name: testCase.name,
            file: testCase.file,
            status: 'skipped',
            duration: 0,
            message: '测试被跳过',
        };
    }
    
    return new Promise((resolve) => {
        const ext = path.extname(testCase.file).toLowerCase();
        const isJs = ext === '.js' || ext === '.mjs' || ext === '.cjs';
        
        if (!isJs) {
            resolve({
                name: testCase.name,
                file: testCase.file,
                status: 'skipped',
                duration: Date.now() - startTime,
                message: '不支持的测试文件类型',
            });
            return;
        }
        
        const timeoutMs = timeout * 1000;
        let resolved = false;
        
        const child = spawn(process.execPath, [testCase.file], {
            cwd: skillDir,
            env: {
                ...process.env,
                SKILL_DIR: skillDir,
                TEST_TYPE: testCase.type,
                NODE_ENV: 'test',
            },
            shell: process.platform === 'win32',
        });
        
        let stdout = '';
        let stderr = '';
        
        child.stdout?.on('data', (data) => {
            stdout += data.toString();
        });
        
        child.stderr?.on('data', (data) => {
            stderr += data.toString();
        });
        
        const timeoutId = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                child.kill();
                resolve({
                    name: testCase.name,
                    file: testCase.file,
                    status: 'failed',
                    duration: timeoutMs,
                    message: `测试超时 (${timeout}s)`,
                    error: stderr || stdout,
                });
            }
        }, timeoutMs);
        
        child.on('error', (err) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeoutId);
                resolve({
                    name: testCase.name,
                    file: testCase.file,
                    status: 'error',
                    duration: Date.now() - startTime,
                    error: err.message,
                });
            }
        });
        
        child.on('close', (code) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeoutId);
                
                const duration = Date.now() - startTime;
                
                if (code === 0) {
                    resolve({
                        name: testCase.name,
                        file: testCase.file,
                        status: 'passed',
                        duration,
                        message: '测试通过',
                        details: stdout,
                    });
                } else {
                    const output = stdout + '\n' + stderr;
                    const match = output.match(/(?:Error|FAIL|失败)[:：]?\s*(.+?)(?:\n|$)/i);
                    const errorMsg = match ? match[1].trim() : `退出码 ${code}`;
                    
                    resolve({
                        name: testCase.name,
                        file: testCase.file,
                        status: 'failed',
                        duration,
                        message: errorMsg,
                        error: stderr || stdout,
                    });
                }
            }
        });
    });
}

export async function runSkillTests(skillId: string): Promise<TestSuiteResult | null> {
    const skillsDir = getSkillsDirectory();
    const skillDir = path.join(skillsDir, skillId);
    
    if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
        logger.error(`Skill not found: ${skillId}`);
        return null;
    }
    
    const testsDir = path.join(skillDir, TESTS_DIR);
    
    if (!fs.existsSync(testsDir) || !fs.statSync(testsDir).isDirectory()) {
        return {
            skillId,
            skillName: skillId,
            config: null,
            environment: {
                compatible: true,
                checks: [{
                    name: '测试目录',
                    required: undefined,
                    actual: '不存在',
                    passed: false,
                    message: '该技能没有测试用例',
                }],
            },
            tests: [],
            summary: {
                total: 0,
                passed: 0,
                failed: 0,
                skipped: 0,
                error: 0,
                duration: 0,
            },
        };
    }
    
    const config = loadTestConfig(testsDir);
    const testCases = discoverTestCases(testsDir);
    
    const environment = await checkEnvironment(config);
    
    const results: TestResult[] = [];
    const timeout = config?.timeout ?? 300;
    const startTime = Date.now();
    
    for (const testCase of testCases) {
        if (!environment.compatible && testCase.type !== 'environment') {
            results.push({
                name: testCase.name,
                file: testCase.file,
                status: 'skipped',
                duration: 0,
                message: '环境不兼容，跳过测试',
            });
            continue;
        }
        
        const result = await runTestCase(testCase, skillDir, timeout);
        results.push(result);
    }
    
    const duration = Date.now() - startTime;
    
    const summary = {
        total: results.length,
        passed: results.filter(r => r.status === 'passed').length,
        failed: results.filter(r => r.status === 'failed').length,
        skipped: results.filter(r => r.status === 'skipped').length,
        error: results.filter(r => r.status === 'error').length,
        duration,
    };
    
    return {
        skillId,
        skillName: config?.metadata?.name ?? skillId,
        config,
        environment,
        tests: results,
        summary,
    };
}

export function hasTests(skillId: string): boolean {
    const skillsDir = getSkillsDirectory();
    const testsDir = path.join(skillsDir, skillId, TESTS_DIR);
    return fs.existsSync(testsDir) && fs.statSync(testsDir).isDirectory();
}

export function listTestableSkills(): string[] {
    const skillsDir = getSkillsDirectory();
    
    if (!fs.existsSync(skillsDir)) {
        return [];
    }
    
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    
    return entries
        .filter(e => e.isDirectory())
        .filter(e => {
            const testsDir = path.join(skillsDir, e.name, TESTS_DIR);
            return fs.existsSync(testsDir) && fs.statSync(testsDir).isDirectory();
        })
        .map(e => e.name);
}

export function createTestTemplate(skillDir: string): void {
    const testsDir = path.join(skillDir, TESTS_DIR);
    const casesDir = path.join(testsDir, CASES_DIR);
    const fixturesDir = path.join(testsDir, FIXTURES_DIR);
    
    fs.mkdirSync(testsDir, { recursive: true });
    fs.mkdirSync(casesDir, { recursive: true });
    fs.mkdirSync(fixturesDir, { recursive: true });
    
    const testMdPath = path.join(testsDir, TEST_MD_FILENAME);
    if (!fs.existsSync(testMdPath)) {
        fs.writeFileSync(testMdPath, TEST_MD_DEFAULT_CONTENT, 'utf8');
    }
    
    const envTestPath = path.join(casesDir, 'environment.test.js');
    if (!fs.existsSync(envTestPath)) {
        fs.writeFileSync(envTestPath, `/**
 * 环境检测测试用例
 * 测试当前系统环境是否满足技能运行要求
 */

console.log('开始环境检测...');

// 检测 Node.js 版本
console.log(\`Node.js 版本: \${process.version}\`);

// 检测操作系统
console.log(\`操作系统: \${process.platform}\`);

// 检测内存
const os = require('os');
const totalMem = os.totalmem() / (1024 * 1024 * 1024);
console.log(\`总内存: \${totalMem.toFixed(1)}GB\`);

// 检测技能目录
const skillDir = process.env.SKILL_DIR;
console.log(\`技能目录: \${skillDir}\`);

// 检测必要的文件
const fs = require('fs');
const path = require('path');

const skillMdPath = path.join(skillDir, 'SKILL.md');
if (fs.existsSync(skillMdPath)) {
    console.log('SKILL.md 存在');
} else {
    console.error('错误: SKILL.md 不存在');
    process.exit(1);
}

console.log('环境检测完成');
process.exit(0);
`, 'utf8');
    }
    
    const basicTestPath = path.join(casesDir, 'basic.test.js');
    if (!fs.existsSync(basicTestPath)) {
        fs.writeFileSync(basicTestPath, `/**
 * 基础功能测试用例
 * 测试技能的核心功能是否正常工作
 */

console.log('开始基础功能测试...');

const skillDir = process.env.SKILL_DIR;
const fs = require('fs');
const path = require('path');

// 读取 SKILL.md
const skillMdPath = path.join(skillDir, 'SKILL.md');
const content = fs.readFileSync(skillMdPath, 'utf8');

// 验证 frontmatter
if (!content.startsWith('---')) {
    console.error('错误: SKILL.md 缺少 YAML frontmatter');
    process.exit(1);
}

const secondDash = content.indexOf('\\n---', 3);
if (secondDash === -1) {
    console.error('错误: SKILL.md frontmatter 格式错误');
    process.exit(1);
}

console.log('SKILL.md 格式验证通过');

// 检查必要字段
const frontmatter = content.slice(3, secondDash);
if (!frontmatter.includes('name:')) {
    console.error('错误: SKILL.md 缺少 name 字段');
    process.exit(1);
}

if (!frontmatter.includes('description:')) {
    console.error('错误: SKILL.md 缺少 description 字段');
    process.exit(1);
}

console.log('SKILL.md 必要字段验证通过');

console.log('基础功能测试完成');
process.exit(0);
`, 'utf8');
    }
}

export const SkillTestFramework = {
    runSkillTests,
    hasTests,
    listTestableSkills,
    createTestTemplate,
    checkEnvironment,
    loadTestConfig,
    discoverTestCases,
};
