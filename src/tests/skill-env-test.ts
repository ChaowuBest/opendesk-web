/**
 * 测试 Skill .env 环境变量注入功能
 *
 * 测试内容：
 * 1. dotenv.parse 解析 .env 内容
 * 2. Skill 构造函数自动加载 .env
 * 3. harnessContext.environ 合并与覆盖
 * 4. 完整链路模拟（Skill -> harnessContext.environ -> spawn env）
 *
 * 运行方式: npx tsx src/tests/skill-env-test.ts
 */

import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { Skill } from '../main/aikernel/skill';

const TEST_SKILLS_DIR = path.join(import.meta.dirname, 'skills');

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
    if (condition) {
        console.log(`  ✅ ${msg}`);
        passed++;
    } else {
        console.log(`  ❌ ${msg}`);
        failed++;
    }
}

console.log('\n=== Skill .env Environment Variable Tests ===\n');

// Test 1: dotenv.parse basic parsing
console.log('Test 1: dotenv.parse basic parsing');
{
    const content = `
# This is a comment
API_KEY=sk-12345
REGION=us-west-2
SECRET="my_secret"
SINGLE_QUOTED='single_value'
WITH_EQUALS=base64data==something

EMPTY_VALUE=
`;
    const env = dotenv.parse(content);
    assert(env['API_KEY'] === 'sk-12345', 'API_KEY parsed correctly');
    assert(env['REGION'] === 'us-west-2', 'REGION parsed correctly');
    assert(env['SECRET'] === 'my_secret', 'double-quoted value unquoted correctly');
    assert(env['SINGLE_QUOTED'] === 'single_value', 'single-quoted value unquoted correctly');
    assert(env['WITH_EQUALS'] === 'base64data==something', 'value with = signs preserved');
    assert(env['EMPTY_VALUE'] === '', 'empty value parsed as empty string');
    assert(env['# This is a comment'] === undefined, 'comments are ignored');
}

// Test 2: dotenv.parse edge cases
console.log('\nTest 2: dotenv.parse edge cases');
{
    const content = `
  SPACES_KEY  =  spaced_value  
VALID=valid
ANOTHER=  trimmed  
`;
    const env = dotenv.parse(content);
    assert(env['SPACES_KEY'] === 'spaced_value', 'key and value trimmed correctly');
    assert(env['VALID'] === 'valid', 'simple key=value parsed');
    assert(env['ANOTHER'] === 'trimmed', 'value whitespace trimmed');
}

// Test 3: load .env from test skill directory
console.log('\nTest 3: load .env from test skill directory');
{
    const skillDir = path.join(TEST_SKILLS_DIR, 'test-env-skill');
    const envContent = fs.readFileSync(path.join(skillDir, '.env'), 'utf-8');
    const env = dotenv.parse(envContent);
    assert(env['TEST_SKILL_API_KEY'] === 'sk-test-12345-env-injection', 'API key loaded from .env');
    assert(env['TEST_SKILL_REGION'] === 'cn-north-1', 'region loaded from .env');
    assert(env['TEST_SKILL_SECRET'] === 'my_secret_value', 'secret unquoted from .env');
    assert(env['TEST_SKILL_WITH_EQUALS'] === 'base64data==something', 'value with = preserved from .env');
    assert(env['TEST_SKILL_EMPTY'] === '', 'empty value from .env');
}

// Test 4: Skill constructor auto-loads .env
console.log('\nTest 4: Skill constructor auto-loads .env from directory');
{
    const skillDir = path.join(TEST_SKILLS_DIR, 'test-env-skill');
    const raw = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const skill = Skill.parseMd(raw);
    assert(Object.keys(skill.env).length === 0, 'parseMd without directory: env is empty');

    const skillWithDir = new Skill(skill.frontmatter, skill.body, skillDir);
    assert(
        skillWithDir.env['TEST_SKILL_API_KEY'] === 'sk-test-12345-env-injection',
        'Skill with directory: env loaded'
    );
    assert(skillWithDir.env['TEST_SKILL_REGION'] === 'cn-north-1', 'Skill with directory: region loaded');
}

// Test 5: Skill without .env (normal skill)
console.log('\nTest 5: Skill without .env has empty env');
{
    const skillDir = path.join(TEST_SKILLS_DIR, 'test-normal-skill');
    const raw = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const parsed = Skill.parseMd(raw);
    const skillWithDir = new Skill(parsed.frontmatter, parsed.body, skillDir);
    assert(Object.keys(skillWithDir.env).length === 0, 'normal skill without .env has empty env');
}

// Test 6: Simulate env merging into task harnessContext.environ
console.log('\nTest 6: Simulate env merging into task harnessContext.environ');
{
    const environ: Record<string, string> = {};

    const skill1Dir = path.join(TEST_SKILLS_DIR, 'test-env-skill');
    const skill1 = new Skill({ name: 'test-env', description: 'test env skill' }, '', skill1Dir);
    Object.assign(environ, skill1.env);
    assert(environ['TEST_SKILL_API_KEY'] === 'sk-test-12345-env-injection', 'first skill env merged');
    assert(environ['TEST_SKILL_REGION'] === 'cn-north-1', 'first skill region merged');

    // 第二个 skill 覆盖部分 key
    Object.assign(environ, {
        TEST_SKILL_REGION: 'ap-southeast-1',
        ANOTHER_KEY: 'another_value'
    });
    assert(environ['TEST_SKILL_REGION'] === 'ap-southeast-1', 'second skill overrides region');
    assert(environ['ANOTHER_KEY'] === 'another_value', 'second skill adds new key');
    assert(environ['TEST_SKILL_API_KEY'] === 'sk-test-12345-env-injection', 'first skill key still present');
}

// Test 7: Full chain simulation (Skill -> harnessContext.environ -> spawn env)
console.log('\nTest 7: Full chain simulation');
{
    const environ: Record<string, string> = {};
    const skillDir = path.join(TEST_SKILLS_DIR, 'test-env-skill');
    const skill = new Skill({ name: 'test-env', description: 'test env skill' }, '', skillDir);

    if (Object.keys(skill.env).length > 0) {
        Object.assign(environ, skill.env);
    }

    const spawnEnv = Object.keys(environ).length > 0 ? { ...process.env, ...environ } : process.env;

    assert(spawnEnv['TEST_SKILL_API_KEY'] === 'sk-test-12345-env-injection', 'spawn env has skill API key');
    assert(spawnEnv['TEST_SKILL_REGION'] === 'cn-north-1', 'spawn env has skill region');
    assert(spawnEnv['PATH'] !== undefined, 'spawn env still has system PATH');
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
