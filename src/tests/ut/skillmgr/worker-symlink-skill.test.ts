import fs from 'fs';
import os from 'os';
import path from 'path';
import SkillsWorker from '../../../main/applications/skillmgr/service/worker.js';

function makeSkill(dir: string, name: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill\n---\n`, 'utf8');
}

describe('skill manager worker symlink scanning', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-worker-symlink-test-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('finds linked directories and terminates on cycles', async () => {
        const scanRoot = path.join(tempDir, 'scan-root');
        fs.mkdirSync(scanRoot);
        makeSkill(path.join(tempDir, 'linked-target'), 'linked-target');
        fs.symlinkSync(path.join(tempDir, 'linked-target'), path.join(scanRoot, 'linked-target'), 'dir');
        fs.symlinkSync(scanRoot, path.join(scanRoot, 'loop'), 'dir');
        const chunks = [];
        const worker = new SkillsWorker('skillmgr', tempDir);

        for await (const chunk of worker.scanDirectoryForSkills(scanRoot)) chunks.push(chunk);

        expect(chunks.at(-1)).toMatchObject({
            type: 'complete',
            skills: [expect.objectContaining({ path: path.join(scanRoot, 'linked-target'), type: 'directory' })]
        });
    });
});
