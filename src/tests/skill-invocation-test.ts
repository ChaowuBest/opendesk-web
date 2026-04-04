/**
 * 测试 Skill 的 user-invocable / disable-model-invocation 属性
 * 以及 /skillname 的解析和加载逻辑
 *
 * 运行方式: npx tsx src/tests/skill-invocation-test.ts
 */

import path from 'path';
import fs from 'fs';
import { Skill } from '../main/aikernel/skill';

const TEST_SKILLS_DIR = path.join(import.meta.dirname, 'skills');

function parseTestSkill(dirName: string): Skill {
    const skillDir = path.join(TEST_SKILLS_DIR, dirName);
    const raw = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    return Skill.parseMd(raw);
}

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

console.log('\n=== Skill Invocation Type Tests ===\n');

// Test 1: Normal skill
console.log('Test 1: Normal skill (test-normal)');
{
    const skill = parseTestSkill('test-normal-skill');
    assert(skill.frontmatter.name === 'test-normal', 'name is test-normal');
    assert(skill.isUserInvocable === true, 'isUserInvocable should be true (default)');
    assert(skill.isModelInvocable === true, 'isModelInvocable should be true (default)');
}

// Test 2: Manual-only skill
console.log('\nTest 2: Manual-only skill (test-manual-only)');
{
    const skill = parseTestSkill('test-manual-only');
    assert(skill.frontmatter.name === 'test-manual-only', 'name is test-manual-only');
    assert(skill.isUserInvocable === true, 'isUserInvocable should be true');
    assert(skill.isModelInvocable === false, 'isModelInvocable should be false (disable-model-invocation: true)');
    assert(skill.frontmatter['argument-hint'] === '[optional-arg]', 'argument-hint should be parsed');
}

// Test 3: Hidden skill
console.log('\nTest 3: Hidden skill (test-hidden)');
{
    const skill = parseTestSkill('test-hidden-skill');
    assert(skill.frontmatter.name === 'test-hidden', 'name is test-hidden');
    assert(skill.isUserInvocable === false, 'isUserInvocable should be false');
    assert(skill.isModelInvocable === true, 'isModelInvocable should be true (default)');
}

// Test 4: Fully hidden skill
console.log('\nTest 4: Fully hidden skill (test-fully-hidden)');
{
    const skill = parseTestSkill('test-fully-hidden');
    assert(skill.frontmatter.name === 'test-fully-hidden', 'name is test-fully-hidden');
    assert(skill.isUserInvocable === false, 'isUserInvocable should be false');
    assert(skill.isModelInvocable === false, 'isModelInvocable should be false');
}

// Test 5: /skillname pattern extraction
console.log('\nTest 5: /skillname pattern extraction from user message');
{
    const extractSkillNames = (message: string): string[] => {
        const pattern = /(?:^|\s)\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?=\s|$)/g;
        const names: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = pattern.exec(message)) !== null) {
            names.push(m[1]);
        }
        return names;
    };

    // Test basic extraction
    assert(
        JSON.stringify(extractSkillNames('/test-normal do something')) === '["test-normal"]',
        'extract /test-normal at start of message'
    );
    assert(
        JSON.stringify(extractSkillNames('I want to use /test-manual-only to solve a problem')) ===
            '["test-manual-only"]',
        'extract /test-manual-only in middle of message'
    );
    assert(
        JSON.stringify(extractSkillNames('/test-normal and /test-manual-only both')) ===
            '["test-normal","test-manual-only"]',
        'extract multiple skill names'
    );
    assert(JSON.stringify(extractSkillNames('no slash commands here')) === '[]', 'no skill names found in plain text');
    assert(JSON.stringify(extractSkillNames('/test-normal')) === '["test-normal"]', 'extract /test-normal alone');
}

// Test 6: isUserInvocable filter
console.log('\nTest 6: User-invocable filtering');
{
    const allSkills = [
        parseTestSkill('test-normal-skill'),
        parseTestSkill('test-manual-only'),
        parseTestSkill('test-hidden-skill'),
        parseTestSkill('test-fully-hidden')
    ];

    const userInvocable = allSkills.filter((s) => s.isUserInvocable);
    assert(userInvocable.length === 2, `should have 2 user-invocable skills, got ${userInvocable.length}`);
    assert(
        userInvocable.some((s) => s.frontmatter.name === 'test-normal'),
        'test-normal should be user-invocable'
    );
    assert(
        userInvocable.some((s) => s.frontmatter.name === 'test-manual-only'),
        'test-manual-only should be user-invocable'
    );

    const modelInvocable = allSkills.filter((s) => s.isModelInvocable);
    assert(modelInvocable.length === 2, `should have 2 model-invocable skills, got ${modelInvocable.length}`);
    assert(
        modelInvocable.some((s) => s.frontmatter.name === 'test-normal'),
        'test-normal should be model-invocable'
    );
    assert(
        modelInvocable.some((s) => s.frontmatter.name === 'test-hidden'),
        'test-hidden should be model-invocable'
    );
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
