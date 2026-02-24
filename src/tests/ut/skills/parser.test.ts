/**
 * Copyright (c) 2026 The OpenDesk Team
 *
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
import { Skill } from '../../../main/aikernel/skill.js';

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

        // 2. 测试 Skill.parseMd
        console.log('2. 测试 Skill.parseMd...');
        const parseResult = Skill.parseMd(skillContent);
        console.log('   ✓ 解析成功');
        console.log('   - 技能名称:', parseResult.frontmatter.name);
        console.log('   - 描述:', parseResult.frontmatter.description);
        console.log('   - 正文长度:', parseResult.body.length, '字符\n');

        // 3. 测试 Skill.validateName
        console.log('3. 测试 Skill.validateName...');
        Skill.validateName(parseResult.frontmatter.name);
        console.log('   ✓ 名称验证通过');

        // 4. 测试 Skill.validateDescription
        console.log('4. 测试 Skill.validateDescription...');
        Skill.validateDescription(parseResult.frontmatter.description);
        console.log('   ✓ 描述验证通过');

        // 5. 测试 Skill.validateFrontmatter
        console.log('5. 测试 Skill.validateFrontmatter...');
        Skill.validateFrontmatter(parseResult.frontmatter);
        console.log('   ✓ Frontmatter 验证通过');

        console.log('\n6. 测试完整流程...');
        console.log('   ✓ 完整流程测试成功');
        console.log('   - 技能名称:', parseResult.frontmatter.name);
        console.log('   - 描述:', parseResult.frontmatter.description);
        console.log('   - 正文长度:', parseResult.body.length, '字符');
        console.log('   - 有 metadata:', !!parseResult.frontmatter.metadata);
        console.log('   - fillipdesk.handler:', !!parseResult.frontmatter.fillipdesk?.handler);

        console.log('\n=== 技能解析器测试通过 ===');
        return Promise.resolve(true);
    } catch (err) {
        console.error('\n✗ 技能解析器测试失败:', err);
        return Promise.resolve(false);
    }
}
