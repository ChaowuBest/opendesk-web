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

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    parseSkillMd,
    validateSkillName,
    validateSkillDescription,
    validateSkillFrontmatter,
    parseAndValidateSkillMd,
} from '../../../main/aikernel/skill.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function runSkillParserTests(): Promise<boolean> {
    console.log('\n=== 运行技能解析器测试 ===\n');

    try {
        // 1. 读取示例技能
        const exampleSkillPath = path.join(
            __dirname,
            '../../../main/applications/skills/resources/example/SKILL.md'
        );

        console.log('1. 读取示例技能:', exampleSkillPath);
        const skillContent = fs.readFileSync(exampleSkillPath, 'utf8');
        console.log('   ✓ 成功读取\n');

        // 2. 测试 parseSkillMd
        console.log('2. 测试 parseSkillMd...');
        const parseResult = parseSkillMd(skillContent);
        if ('error' in parseResult) {
            console.error('   ✗ 解析失败:', parseResult.error);
            return Promise.resolve(false);
        }

        console.log('   ✓ 解析成功');
        console.log('   - 技能名称:', parseResult.frontmatter.name);
        console.log('   - 描述:', parseResult.frontmatter.description);
        console.log('   - 正文长度:', parseResult.body.length, '字符\n');

        // 3. 测试 validateSkillName
        console.log('3. 测试 validateSkillName...');
        const nameValidation = validateSkillName(parseResult.frontmatter.name);
        if (!nameValidation.valid) {
            console.error('   ✗ 名称验证失败:', nameValidation.error);
            return Promise.resolve(false);
        }
        console.log('   ✓ 名称验证通过');

        // 4. 测试 validateSkillDescription
        console.log('4. 测试 validateSkillDescription...');
        const descValidation = validateSkillDescription(parseResult.frontmatter.description);
        if (!descValidation.valid) {
            console.error('   ✗ 描述验证失败:', descValidation.error);
            return Promise.resolve(false);
        }
        console.log('   ✓ 描述验证通过');

        // 5. 测试 validateSkillFrontmatter
        console.log('5. 测试 validateSkillFrontmatter...');
        const frontmatterValidation = validateSkillFrontmatter(parseResult.frontmatter);
        if (!frontmatterValidation.valid) {
            console.error('   ✗ Frontmatter 验证失败:', frontmatterValidation.error);
            return Promise.resolve(false);
        }
        console.log('   ✓ Frontmatter 验证通过');

        console.log('\n6. 测试 parseAndValidateSkillMd...');
        const fullResult = parseAndValidateSkillMd(skillContent);
        if (!fullResult.valid) {
            console.error('   ✗ 完整解析与验证失败:', fullResult.error);
            return Promise.resolve(false);
        }

        console.log('   ✓ 完整解析与验证成功');
        console.log('   - 技能名称:', fullResult.name);
        console.log('   - 描述:', fullResult.description);
        console.log('   - 正文长度:', fullResult.body?.length, '字符');
        console.log('   - 有 metadata:', !!fullResult.frontmatter?.metadata);
        console.log('   - fillipdesk.handler:', !!fullResult.frontmatter?.fillipdesk?.handler);

        console.log('\n=== 技能解析器测试通过 ===');
        return Promise.resolve(true);
    } catch (err) {
        console.error('\n✗ 技能解析器测试失败:', err);
        return Promise.resolve(false);
    }
}
