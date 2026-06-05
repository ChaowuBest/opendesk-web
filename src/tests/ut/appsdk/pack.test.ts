import AdmZip from 'adm-zip';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { packOpenDeskApp } from '../../../../packages/appsdk/src/pack';

function makeTempDir(name: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `opendesk-${name}-`));
}

function writeApp(dir: string, manifestOverrides: Record<string, unknown> = {}): void {
    fs.mkdirSync(path.join(dir, 'renderer'), { recursive: true });
    const manifest = {
        schemaVersion: 1,
        bundleName: 'packed.app',
        displayName: 'Packed App',
        versionName: 'v1',
        entry: 'renderer/index.html',
        icon: 'icon.png',
        ...manifestOverrides
    };
    fs.writeFileSync(path.join(dir, 'opendesk-app.json'), JSON.stringify(manifest, null, 4), 'utf-8');
    fs.writeFileSync(path.join(dir, 'renderer', 'index.html'), '<!doctype html><h1>packed</h1>', 'utf-8');
    fs.writeFileSync(path.join(dir, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
}

describe('opendesk appsdk packer', () => {
    let workDir: string;

    beforeEach(() => {
        workDir = makeTempDir('appsdk-pack');
    });

    afterEach(() => {
        fs.rmSync(workDir, { recursive: true, force: true });
    });

    test('packs a valid app directory into a zip with manifest, entry, and icon', () => {
        const sourceDir = path.join(workDir, 'app');
        const outPath = path.join(workDir, 'packed.zip');
        fs.mkdirSync(sourceDir, { recursive: true });
        writeApp(sourceDir);

        packOpenDeskApp(sourceDir, outPath);

        const zip = new AdmZip(outPath);
        expect(zip.getEntry('opendesk-app.json')).toBeTruthy();
        expect(zip.getEntry('renderer/index.html')).toBeTruthy();
        expect(zip.getEntry('icon.png')).toBeTruthy();
        const manifest = JSON.parse(zip.readAsText('opendesk-app.json'));
        expect(manifest.bundleName).toBe('packed.app');
    });

    test('rejects missing entry file', () => {
        const sourceDir = path.join(workDir, 'missing-entry');
        fs.mkdirSync(sourceDir, { recursive: true });
        writeApp(sourceDir, { entry: 'renderer/missing.html' });

        expect(() => packOpenDeskApp(sourceDir, path.join(workDir, 'missing.zip'))).toThrow(/entry file not found/);
    });

    test('rejects unsafe manifest paths before writing a zip', () => {
        const sourceDir = path.join(workDir, 'unsafe-entry');
        const outPath = path.join(workDir, 'unsafe.zip');
        fs.mkdirSync(sourceDir, { recursive: true });
        writeApp(sourceDir, { entry: '../outside.html' });

        expect(() => packOpenDeskApp(sourceDir, outPath)).toThrow(/Unsafe package path/);
        expect(fs.existsSync(outPath)).toBe(false);
    });

    test('rejects invalid bundle names', () => {
        const sourceDir = path.join(workDir, 'bad-bundle');
        fs.mkdirSync(sourceDir, { recursive: true });
        writeApp(sourceDir, { bundleName: 'Bad Bundle' });

        expect(() => packOpenDeskApp(sourceDir, path.join(workDir, 'bad.zip'))).toThrow(/bundleName must use/);
    });
});
