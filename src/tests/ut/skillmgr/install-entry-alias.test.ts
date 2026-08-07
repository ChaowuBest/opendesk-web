import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { skillInstallManager } from '../../../main/applications/skillmgr/utils/skill-installer';
import { setCustomOpendeskDirectory } from '../../../main/utils/setting';

describe('skillmgr package entry aliases', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-skill-entry-alias-test-'));
        setCustomOpendeskDirectory(tempDir);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test.each(['skills.md', 'SKILLS.md'])('installs packages whose entry file is %s', async (entryFilename) => {
        const zipPath = path.join(tempDir, `${entryFilename.replace('.', '-')}.zip`);
        const zip = new AdmZip();
        zip.addFile(
            `cli/${entryFilename}`,
            Buffer.from(
                [
                    '---',
                    'name: cli',
                    'summary: Command-line productivity helpers for common development workflows.',
                    '---',
                    '',
                    '# CLI Skill'
                ].join('\n'),
                'utf8'
            )
        );
        zip.writeZip(zipPath);

        const result = await skillInstallManager.installFromLocalZip(zipPath, undefined, { force: true });

        expect(result.success).toBe(true);
        expect(result.name).toBe('cli');
        expect(fs.existsSync(path.join(tempDir, 'apps', 'skills', 'resources', 'cli', 'SKILL.md'))).toBe(true);
    });

    test('installs directories whose entry file is skills.md', async () => {
        const sourceDir = path.join(tempDir, 'cli-source');
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(
            path.join(sourceDir, 'skills.md'),
            [
                '---',
                'name: cli-directory',
                'summary: Command-line productivity helpers for common development workflows.',
                '---',
                '',
                '# CLI Skill'
            ].join('\n'),
            'utf8'
        );

        const result = await skillInstallManager.installFromDirectory(sourceDir, { force: true });

        expect(result.success).toBe(true);
        expect(result.name).toBe('cli-directory');
        expect(fs.existsSync(path.join(tempDir, 'apps', 'skills', 'resources', 'cli-directory', 'SKILL.md'))).toBe(
            true
        );
        expect(fs.existsSync(path.join(sourceDir, 'skills.md'))).toBe(true);
    });
});
