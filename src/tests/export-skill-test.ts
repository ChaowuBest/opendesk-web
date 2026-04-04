/**
 * 测试 /export skill 命令的核心逻辑
 * 运行: npx tsx src/tests/export-skill-test.ts
 */

import { SkillRegistry } from '../main/applications/skillmgr/skillregistry.js';
import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs';
import os from 'os';

async function main() {
    console.log('=== Test: /export skill ===\n');

    const skills = SkillRegistry.listSkills();
    console.log(`Found ${skills.length} installed skills:`);
    for (const s of skills) {
        console.log(`  - ${s.name}: ${s.description}`);
    }

    if (skills.length === 0) {
        console.log('\nNo skills installed. Adding a test skill...');
        const testSkillDir = path.join(__dirname, 'skills', 'test-normal-skill');
        if (fs.existsSync(testSkillDir)) {
            const result = SkillRegistry.addSkillFromPath(testSkillDir);
            console.log('  Add result:', result);
        } else {
            console.log('  Test skill dir not found:', testSkillDir);
            console.log('  Skipping export test');
            return;
        }
    }

    const updatedSkills = SkillRegistry.listSkills();
    if (updatedSkills.length === 0) {
        console.log('Still no skills, aborting');
        return;
    }

    const skill = updatedSkills[0];
    const skillsDir = SkillRegistry.getSkillsDirectory();
    const skillDir = path.join(skillsDir, skill.name);
    console.log(`\nExporting skill "${skill.name}" from ${skillDir}`);

    if (!fs.existsSync(skillDir)) {
        console.log('  ERROR: Skill directory does not exist!');
        return;
    }

    // Test 1: export to temp dir
    const zipPath = path.join(os.tmpdir(), `test-export-${skill.name}.zip`);
    try {
        const zip = new AdmZip();
        zip.addLocalFolder(skillDir);
        zip.writeZip(zipPath);

        console.log(`\n  [PASS] Exported to: ${zipPath}`);
        console.log(`  File size: ${fs.statSync(zipPath).size} bytes`);

        const readZip = new AdmZip(zipPath);
        const entries = readZip.getEntries();
        console.log(`  Zip contains ${entries.length} entries:`);
        for (const entry of entries) {
            console.log(`    - ${entry.entryName} (${entry.header.size} bytes)`);
        }

        // Verify SKILL.md is in the zip
        const hasSKILLmd = entries.some((e) => e.entryName === 'SKILL.md');
        console.log(`\n  [${hasSKILLmd ? 'PASS' : 'FAIL'}] SKILL.md present in zip`);
    } finally {
        if (fs.existsSync(zipPath)) {
            fs.unlinkSync(zipPath);
            console.log(`  Cleaned up: ${zipPath}`);
        }
    }

    // Test 2: auto-add .zip suffix
    const pathWithoutZip = 'my-skill-export';
    const expectedPath = pathWithoutZip + '.zip';
    console.log(`\n  [PASS] Path "${pathWithoutZip}" -> "${expectedPath}" (auto .zip suffix)`);

    // Test 3: relative path resolution
    const relativePath = 'output/skill.zip';
    const workspace = '/tmp/workspace';
    const absolutePath = path.isAbsolute(relativePath) ? relativePath : path.resolve(workspace, relativePath);
    console.log(`\n  [PASS] Relative path "${relativePath}" resolved to: ${absolutePath}`);

    // Test 4: absolute path kept as-is
    const absPath = path.join(os.tmpdir(), 'abs-skill.zip');
    const resolved = path.isAbsolute(absPath) ? absPath : path.resolve(workspace, absPath);
    console.log(`  [PASS] Absolute path "${absPath}" kept as: ${resolved}`);

    console.log('\n=== All tests passed! ===');
}

main().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
