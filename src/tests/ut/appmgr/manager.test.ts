import AdmZip from 'adm-zip';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting';
import {
    AppManagerStore,
    appEntryUrl,
    getManagedAppsDirectory,
    toPublicUserApp
} from '../../../main/applications/appmgr/manager';
import { ExternalManifestApplication } from '../../../main/applications/appmgr/external';
import { ApplicationRegistry } from '../../../main/applications/registry';

function makeTempDir(name: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `opendesk-${name}-`));
}

function writeAppPackage(
    dir: string,
    options: {
        bundleName?: string;
        displayName?: string;
        versionName?: string;
        entry?: string;
        icon?: string;
        skills?: string[];
        description?: string;
    } = {}
): void {
    const manifest = {
        schemaVersion: 1,
        bundleName: options.bundleName ?? 'sample-app',
        displayName: options.displayName ?? 'Sample App',
        versionName: options.versionName ?? 'v1',
        entry: options.entry ?? 'renderer/index.html',
        icon: options.icon ?? 'icon.png',
        description: options.description ?? 'sample app',
        skills: options.skills ?? []
    };
    fs.mkdirSync(path.join(dir, 'renderer'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'opendesk-app.json'), JSON.stringify(manifest, null, 4), 'utf-8');
    fs.writeFileSync(path.join(dir, 'renderer', 'index.html'), '<!doctype html><h1>sample</h1>', 'utf-8');
    fs.writeFileSync(path.join(dir, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    if (manifest.skills.length > 0) {
        fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'skills', 'manage.md'),
            ['---', 'name: sample-skill', 'description: sample skill description', '---', '', '# Sample Skill'].join(
                '\n'
            ),
            'utf-8'
        );
    }
}

function zipDirectory(sourceDir: string, zipPath: string): void {
    const zip = new AdmZip();
    zip.addLocalFolder(sourceDir);
    zip.writeZip(zipPath);
}

/**
 * 在沙箱里执行模板生成的 renderer/main.js，返回组件真正写入的 innerHTML 与 alert 调用记录。
 * 若 displayName 逃逸了 JS 模板字面量，注入代码会在这里真实执行并被记录下来。
 */
function evaluateGeneratedRenderer(codePath: string): { html: string; alerts: string[] } {
    const source = fs.readFileSync(path.join(codePath, 'renderer', 'main.js'), 'utf-8');
    const alerts: string[] = [];
    let component: { innerHTML?: string; connectedCallback?: () => void } | undefined;
    const sandbox: Record<string, unknown> = {
        HTMLElement: class {},
        customElements: {
            define(_name: string, ctor: new () => { innerHTML?: string; connectedCallback?: () => void }) {
                component = new ctor();
                component.connectedCallback?.();
            }
        },
        alert: (message: string) => alerts.push(message)
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    return { html: component?.innerHTML ?? '', alerts };
}

describe('AppManagerStore', () => {
    let appDataDir: string;
    let workDir: string;

    beforeEach(() => {
        appDataDir = makeTempDir('appmgr-data');
        workDir = makeTempDir('appmgr-work');
        setCustomOpendeskDirectory(appDataDir);
        Setting.clearCache();
    });

    afterEach(() => {
        fs.rmSync(appDataDir, { recursive: true, force: true });
        fs.rmSync(workDir, { recursive: true, force: true });
        Setting.clearCache();
    });

    test('createApp creates an active app with an initial version and preview URL', () => {
        const { app, version } = AppManagerStore.createApp({
            bundleName: 'created.app',
            displayName: 'Created App',
            description: 'created from template'
        });

        expect(app.bundleName).toBe('created.app');
        expect(app.displayName).toBe('Created App');
        expect(app.active).toBe(true);
        expect(app.currentVersionId).toBe(version.versionId);
        expect(version.parentVersionId).toBeNull();
        expect(version.versionId).toHaveLength(12);
        expect(fs.existsSync(path.join(version.codePath, 'renderer', 'index.html'))).toBe(true);
        expect(fs.existsSync(path.join(getManagedAppsDirectory(), 'created.app', 'icon.png'))).toBe(true);
        expect(appEntryUrl(app)).toContain(`opendesk-app://created.app/${version.versionId}/renderer/index.html`);
    });

    test('createApp keeps template-literal injection payloads in displayName inert', () => {
        const { version } = AppManagerStore.createApp({
            bundleName: 'inject.app',
            displayName: 'X${alert(1)}Y'
        });

        const { html, alerts } = evaluateGeneratedRenderer(version.codePath);
        expect(alerts).toEqual([]);

        const mainJs = fs.readFileSync(path.join(version.codePath, 'renderer', 'main.js'), 'utf-8');
        // 生成的 main.js 用模板字面量拼接 innerHTML，插值序列必须被消解
        expect(mainJs).not.toContain('${');
        expect(html).toContain('X&#36;{alert(1)}Y');
    });

    test('createApp keeps backtick injection payloads in displayName inert', () => {
        const { version } = AppManagerStore.createApp({
            bundleName: 'inject2.app',
            displayName: 'A`</h1><img src=x onerror=alert(1)>'
        });

        const { html, alerts } = evaluateGeneratedRenderer(version.codePath);
        expect(alerts).toEqual([]);
        expect(html).toContain('&#96;');
        expect(html).not.toContain('<img');
    });

    test('createApp escapes HTML metacharacters in the generated page title', () => {
        const { version } = AppManagerStore.createApp({
            bundleName: 'inject3.app',
            displayName: '</title><script>alert(1)</script>'
        });

        const indexHtml = fs.readFileSync(path.join(version.codePath, 'renderer', 'index.html'), 'utf-8');
        expect(indexHtml).not.toContain('<script>alert(1)</script>');
        expect(indexHtml).toContain('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    // 反斜杠不是 HTML 特殊字符，但在生成的模板字面量里是转义符：
    // 不消解会让 main.js 语法错误（C:\Users\x）或静默吞掉反斜杠（我的\应用）。
    test.each(['C:\\Users\\x', '我的\\应用', 'path\\'])(
        'createApp keeps backslash in displayName intact: %s',
        (displayName) => {
            const { version } = AppManagerStore.createApp({ bundleName: 'inject4.app', displayName });

            const { html } = evaluateGeneratedRenderer(version.codePath);
            expect(html).toContain('&#92;');
        }
    );

    test('createApp reports a readable error for invalid bundle names', () => {
        expect(() =>
            AppManagerStore.createApp({
                bundleName: 'Bad Bundle',
                displayName: 'Bad App'
            })
        ).toThrow(/包名只能包含小写字母、数字、点号和连字符/);
    });

    test('installFromZip installs a valid app and records additional versions as children of current version', () => {
        const sourceV1 = path.join(workDir, 'source-v1');
        const sourceV2 = path.join(workDir, 'source-v2');
        fs.mkdirSync(sourceV1, { recursive: true });
        fs.mkdirSync(sourceV2, { recursive: true });
        writeAppPackage(sourceV1, { bundleName: 'zip-app', displayName: 'Zip App', versionName: 'Version A' });
        writeAppPackage(sourceV2, { bundleName: 'zip-app', displayName: 'Zip App 2', versionName: 'Version B' });
        const zipV1 = path.join(workDir, 'v1.zip');
        const zipV2 = path.join(workDir, 'v2.zip');
        zipDirectory(sourceV1, zipV1);
        zipDirectory(sourceV2, zipV2);

        const first = AppManagerStore.installFromZip(zipV1);
        const second = AppManagerStore.installFromZip(zipV2);
        const installed = AppManagerStore.getAppOrThrow('zip-app');

        expect(first.version.parentVersionId).toBeNull();
        expect(second.version.parentVersionId).toBe(first.version.versionId);
        expect(installed.currentVersionId).toBe(second.version.versionId);
        expect(installed.versions.map((version) => version.versionName)).toEqual(['Version A', 'Version B']);
        expect(installed.displayName).toBe('Zip App 2');
        expect(toPublicUserApp(installed)).toMatchObject({
            bundleName: 'zip-app',
            name: 'Zip App 2',
            source: 'user',
            removable: true,
            active: true
        });
    });

    test('setActive, setCurrentVersion, updateMetadata, and deleteApp persist expected changes', () => {
        const first = AppManagerStore.createApp({ bundleName: 'managed-app', displayName: 'Managed App' });
        const sourceV2 = path.join(workDir, 'source-v2');
        fs.mkdirSync(sourceV2, { recursive: true });
        writeAppPackage(sourceV2, {
            bundleName: 'managed-app',
            displayName: 'Managed App',
            versionName: 'Second Version'
        });
        const second = AppManagerStore.installFromDirectory(sourceV2);
        const iconSourcePath = path.join(workDir, 'new-icon.png');
        fs.writeFileSync(iconSourcePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));

        AppManagerStore.setActive('managed-app', false);
        AppManagerStore.setCurrentVersion('managed-app', first.version.versionId);
        AppManagerStore.updateMetadata({
            bundleName: 'managed-app',
            displayName: 'Renamed App',
            description: 'new description',
            iconSourcePath
        });
        const updated = AppManagerStore.getAppOrThrow('managed-app');

        expect(second.version.parentVersionId).toBe(first.version.versionId);
        expect(updated.active).toBe(false);
        expect(updated.currentVersionId).toBe(first.version.versionId);
        expect(updated.displayName).toBe('Renamed App');
        expect(updated.description).toBe('new description');
        expect(fs.readFileSync(updated.iconPath!)).toEqual(fs.readFileSync(iconSourcePath));

        expect(AppManagerStore.deleteApp('managed-app')).toEqual({ success: true });
        expect(AppManagerStore.getApp('managed-app')).toBeUndefined();
        expect(fs.existsSync(path.join(getManagedAppsDirectory(), 'managed-app'))).toBe(false);
    });

    test('installFromZip rejects unsafe zip entries and cleans failed extraction directories', () => {
        const source = path.join(workDir, 'unsafe-source');
        fs.mkdirSync(source, { recursive: true });
        writeAppPackage(source, { bundleName: 'unsafe-app' });
        const zipPath = path.join(workDir, 'unsafe.zip');
        const zip = new AdmZip();
        zip.addLocalFolder(source);
        zip.addFile('C:/evil.txt', Buffer.from('owned'));
        zip.writeZip(zipPath);

        expect(() => AppManagerStore.installFromZip(zipPath)).toThrow(/Unsafe app package path/);
        expect(AppManagerStore.getApp('unsafe-app')).toBeUndefined();
        expect(fs.existsSync(path.join(getManagedAppsDirectory(), 'unsafe-app'))).toBe(false);
        expect(fs.existsSync(path.join(appDataDir, 'appmgr', 'C:', 'evil.txt'))).toBe(false);
    });

    test('installFromZip rejects manifests that point outside the package', () => {
        const source = path.join(workDir, 'bad-manifest-source');
        fs.mkdirSync(source, { recursive: true });
        writeAppPackage(source, { bundleName: 'bad-entry-app', entry: '../outside.html' });
        const zipPath = path.join(workDir, 'bad-entry.zip');
        zipDirectory(source, zipPath);

        expect(() => AppManagerStore.installFromZip(zipPath)).toThrow(/Unsafe app package path/);
        expect(AppManagerStore.getApp('bad-entry-app')).toBeUndefined();
    });

    test('ExternalManifestApplication exposes manifest, entry URL, and declared static skills', async () => {
        const source = path.join(workDir, 'skill-source');
        fs.mkdirSync(source, { recursive: true });
        writeAppPackage(source, {
            bundleName: 'skill-app',
            displayName: 'Skill App',
            skills: ['skills/manage.md']
        });
        const { app } = AppManagerStore.installFromDirectory(source);
        const externalApp = new ExternalManifestApplication(app);

        expect(externalApp.toJSON()).toMatchObject({
            bundleName: 'skill-app',
            source: 'user',
            active: true
        });
        expect(externalApp.getManifest()).toMatchObject({
            bundleName: 'skill-app',
            displayName: 'Skill App'
        });
        expect(externalApp.getEntryUrl()).toBe(appEntryUrl(app));

        const skills = await externalApp.getSkills();
        expect(skills).toHaveLength(1);
        expect(skills[0].frontmatter.name).toBe('sample-skill');
    });

    test('ApplicationRegistry reloadExternalApplications registers active apps and removes inactive apps', () => {
        const originalApplications = new Map(ApplicationRegistry.applications);
        const originalExternalBundles = new Set(ApplicationRegistry.externalApplicationBundles);
        try {
            ApplicationRegistry.applications.clear();
            ApplicationRegistry.externalApplicationBundles.clear();
            AppManagerStore.createApp({ bundleName: 'registry-app', displayName: 'Registry App' });

            ApplicationRegistry.reloadExternalApplications();
            const registered = ApplicationRegistry.getApplication('registry-app');
            expect(registered).toBeInstanceOf(ExternalManifestApplication);
            expect(ApplicationRegistry.getApplicationList()).toContainEqual(
                expect.objectContaining({
                    bundleName: 'registry-app',
                    source: 'user',
                    active: true
                })
            );

            AppManagerStore.setActive('registry-app', false);
            ApplicationRegistry.reloadExternalApplications();
            expect(ApplicationRegistry.getApplication('registry-app')).toBeUndefined();
        } finally {
            ApplicationRegistry.applications = originalApplications;
            ApplicationRegistry.externalApplicationBundles = originalExternalBundles;
        }
    });
});
