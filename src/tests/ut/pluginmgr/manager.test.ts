import fs from 'fs';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import { jest } from '@jest/globals';
import { create as createTar } from 'tar';
import {
    installPlugin,
    listInstalledPlugins,
    resolveNpmInvocation,
    setPluginEnabled,
    uninstallPlugin,
    verifyInstalledPlugin
} from '../../../main/applications/pluginmgr/management/manager.js';
import { discoverPlugins } from '../../../main/applications/pluginmgr/discovery/discovery.js';
import {
    getPluginsDirectory,
    getPluginRegistryPath,
    getPluginStagingDirectory,
    getPluginTrashDirectory
} from '../../../main/applications/pluginmgr/management/paths.js';
import { getPluginRecord, upsertPluginRecord } from '../../../main/applications/pluginmgr/management/registry.js';
import { setPlatform, type AbstractPlatform } from '../../../platforms/base.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

async function writePluginTgz(archivePath: string, pluginDirectory: string): Promise<void> {
    await createTar(
        {
            cwd: path.dirname(pluginDirectory),
            file: archivePath,
            gzip: true
        },
        [path.basename(pluginDirectory)]
    );
}

describe('pluginmgr managed installation', () => {
    let configDirectory: string;
    let npmArgs: string[];
    let previousBuiltinDirectory: string | undefined;

    beforeEach(() => {
        configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-plugin-install-'));
        npmArgs = [];
        // 隔离内置插件目录，避免发现到仓库里真实的内置插件
        previousBuiltinDirectory = process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = path.join(configDirectory, 'builtin-empty');
        // 附加插件目录经 Setting 读取 externalPaths，必须指向隔离目录，否则会带上开发机的真实配置
        setCustomOpendeskDirectory(configDirectory);
        Setting.clearCache();
    });

    afterEach(() => {
        if (previousBuiltinDirectory === undefined) delete process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        else process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = previousBuiltinDirectory;
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(configDirectory, { recursive: true, force: true });
    });

    const simulateNpmInstall = async (args: string[], stagingDirectory: string): Promise<void> => {
        npmArgs = args;
        const packageName = '@example/review-helper';
        const pluginDirectory = path.join(stagingDirectory, 'node_modules', '@example', 'review-helper');
        fs.mkdirSync(pluginDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(stagingDirectory, 'package.json'),
            JSON.stringify({
                name: 'opendesk-plugin-staging',
                private: true,
                version: '1.0.0',
                dependencies: {
                    [packageName]: '1.0.0'
                }
            })
        );
        fs.writeFileSync(
            path.join(pluginDirectory, 'package.json'),
            JSON.stringify({
                name: packageName,
                version: '1.0.0'
            })
        );
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'review-helper',
                entry: './index.js',
                apiVersion: 1,
                capabilities: ['tool']
            })
        );
        fs.writeFileSync(path.join(pluginDirectory, 'index.js'), `export default { id: 'review-helper', setup() {} };`);
    };

    test('在隔离前缀中安装并写入注册表', async () => {
        const result = await installPlugin('@example/review-helper@1.0.0', {
            configDirectory,
            runNpm: simulateNpmInstall
        });

        expect(result).toEqual({ success: true, id: 'review-helper' });
        expect(npmArgs).toContain('--ignore-scripts');
        expect(npmArgs).toContain('--install-links=true');
        expect(listInstalledPlugins(configDirectory)).toEqual([
            expect.objectContaining({
                id: 'review-helper',
                source: 'local',
                path: path.join('review-helper', 'node_modules', '@example', 'review-helper'),
                enabled: true
            })
        ]);
        expect(
            fs.existsSync(
                path.join(
                    getPluginsDirectory(configDirectory),
                    'review-helper',
                    'node_modules',
                    '@example',
                    'review-helper'
                )
            )
        ).toBe(true);
        expect(verifyInstalledPlugin('review-helper', configDirectory)).toMatchObject({
            integrityStatus: 'verified',
            allowed: true
        });
    });

    test('直接安装仅包含 manifest 的插件目录而不调用 npm', async () => {
        const sourceDirectory = path.join(configDirectory, 'external-plugin');
        const skillDirectory = path.join(sourceDirectory, 'skills', 'review');
        let npmCalled = false;
        const runNpm = async () => {
            npmCalled = true;
            throw new Error('npm should not run for a plugin directory');
        };
        fs.mkdirSync(skillDirectory, { recursive: true });
        fs.writeFileSync(path.join(sourceDirectory, 'index.mjs'), 'export default {};');
        fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), '# Review');
        fs.writeFileSync(
            path.join(sourceDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'test-external-plugin',
                version: '1.0.0',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: ['skill'],
                resources: {
                    skills: ['./skills/review']
                }
            })
        );

        const result = await installPlugin(sourceDirectory, {
            configDirectory,
            runNpm
        });

        expect(result).toEqual({ success: true, id: 'test-external-plugin' });
        expect(npmCalled).toBe(false);
        expect(getPluginRecord('test-external-plugin', configDirectory)).toMatchObject({
            source: 'local',
            path: 'test-external-plugin',
            spec: sourceDirectory
        });
        expect(
            fs.existsSync(
                path.join(getPluginsDirectory(configDirectory), 'test-external-plugin', 'skills', 'review', 'SKILL.md')
            )
        ).toBe(true);
        expect(fs.existsSync(path.join(getPluginsDirectory(configDirectory), 'test-external-plugin', 'plugin'))).toBe(
            false
        );
    });

    test('直接安装带运行时依赖的插件目录会安装依赖', async () => {
        const sourceDirectory = path.join(configDirectory, 'local-package-plugin');
        let npmCalled = false;
        let npmCwd = '';
        fs.mkdirSync(sourceDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(sourceDirectory, 'package.json'),
            JSON.stringify({
                name: 'local-package-plugin',
                version: '1.0.0',
                dependencies: {
                    'runtime-dependency': '1.0.0'
                }
            })
        );
        fs.writeFileSync(
            path.join(sourceDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'local-package-plugin',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(path.join(sourceDirectory, 'index.mjs'), 'export default {};');

        const result = await installPlugin(sourceDirectory, {
            configDirectory,
            runNpm: async (args, cwd) => {
                npmCalled = true;
                npmCwd = cwd;
                expect(args).toContain('--omit=dev');
                expect(args).toContain('--no-optional');
                expect(args).toContain('--ignore-scripts');
            }
        });

        expect(result).toEqual({ success: true, id: 'local-package-plugin' });
        expect(npmCalled).toBe(true);
        expect(path.dirname(npmCwd)).toBe(getPluginStagingDirectory(configDirectory));
    });

    test('仅依赖宿主 SDK 的插件目录安装时不调用 npm', async () => {
        const sourceDirectory = path.join(configDirectory, 'sdk-only-plugin');
        fs.mkdirSync(sourceDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(sourceDirectory, 'package.json'),
            JSON.stringify({
                name: 'hello-plugin',
                version: '0.1.0',
                type: 'module',
                dependencies: {
                    '@bitclub.ai/opendesk-plugin-sdk': '^0.1.0'
                }
            })
        );
        fs.writeFileSync(
            path.join(sourceDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'hello-plugin',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(
            path.join(sourceDirectory, 'index.mjs'),
            "export default { id: 'hello-plugin', setup() {} };\n"
        );

        const result = await installPlugin(sourceDirectory, {
            configDirectory,
            runNpm: async () => {
                throw new Error('npm should not run when a plugin only depends on the host-provided SDK');
            }
        });

        expect(result).toEqual({ success: true, id: 'hello-plugin' });
    });

    test('依赖 SDK 与第三方包的插件目录只安装第三方依赖', async () => {
        const sourceDirectory = path.join(configDirectory, 'sdk-plus-deps-plugin');
        fs.mkdirSync(sourceDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(sourceDirectory, 'package.json'),
            JSON.stringify({
                name: 'hello-plugin',
                version: '0.1.0',
                type: 'module',
                dependencies: {
                    '@bitclub.ai/opendesk-plugin-sdk': '^0.1.0',
                    'runtime-dependency': '1.0.0'
                }
            })
        );
        fs.writeFileSync(
            path.join(sourceDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'hello-plugin',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(
            path.join(sourceDirectory, 'index.mjs'),
            "export default { id: 'hello-plugin', setup() {} };\n"
        );

        const npmArgsResult: string[] = [];
        const result = await installPlugin(sourceDirectory, {
            configDirectory,
            runNpm: async (args) => {
                npmArgsResult.push(...args);
            }
        });

        expect(result).toEqual({ success: true, id: 'hello-plugin' });
        expect(npmArgsResult).toContain('runtime-dependency@1.0.0');
        expect(npmArgsResult).not.toContain('@bitclub.ai/opendesk-plugin-sdk@^0.1.0');
        expect(npmArgsResult).toContain('--no-save');
    });

    test('从本地 ZIP 安装插件并去除压缩包根目录层级', async () => {
        const zipPath = path.join(configDirectory, 'review-helper.zip');
        const archive = new AdmZip();
        archive.addFile(
            'review-helper/package.json',
            Buffer.from(
                JSON.stringify({
                    name: 'zip-review-helper',
                    version: '1.0.0',
                    dependencies: {
                        'runtime-dependency': '1.0.0'
                    }
                })
            )
        );
        archive.addFile(
            'review-helper/opendesk.plugin.json',
            Buffer.from(
                JSON.stringify({
                    id: 'zip-review-helper',
                    entry: './index.mjs',
                    apiVersion: 1,
                    capabilities: []
                })
            )
        );
        archive.addFile(
            'review-helper/index.mjs',
            Buffer.from("export default { id: 'zip-review-helper', setup() {} };\n")
        );
        archive.writeZip(zipPath);

        let installedZipDependencies = false;
        const result = await installPlugin(zipPath, {
            configDirectory,
            runNpm: async (args) => {
                installedZipDependencies = true;
                npmArgs = args;
            }
        });

        expect(result).toEqual({ success: true, id: 'zip-review-helper' });
        expect(installedZipDependencies).toBe(true);
        expect(npmArgs).toEqual([
            'install',
            '--no-save',
            '--install-links=true',
            '--no-bin-links',
            '--omit=dev',
            '--no-optional',
            '--audit=false',
            '--ignore-scripts',
            '--package-lock=false',
            'runtime-dependency@1.0.0'
        ]);
        expect(fs.existsSync(path.join(getPluginsDirectory(configDirectory), 'zip-review-helper', 'index.mjs'))).toBe(
            true
        );
        expect(
            fs.existsSync(path.join(getPluginsDirectory(configDirectory), 'zip-review-helper', 'review-helper'))
        ).toBe(false);
    });

    test('从 URL ZIP 安装插件时安装运行时依赖', async () => {
        const archive = new AdmZip();
        archive.addFile(
            'package.json',
            Buffer.from(
                JSON.stringify({
                    name: 'url-zip-review-helper',
                    version: '1.0.0',
                    dependencies: {
                        'runtime-dependency': '1.0.0'
                    }
                })
            )
        );
        archive.addFile(
            'opendesk.plugin.json',
            Buffer.from(
                JSON.stringify({
                    id: 'url-zip-review-helper',
                    entry: './index.mjs',
                    apiVersion: 1,
                    capabilities: []
                })
            )
        );
        archive.addFile('index.mjs', Buffer.from("export default { id: 'url-zip-review-helper', setup() {} };\n"));
        let npmCalled = false;

        const result = await installPlugin('https://example.com/url-review-helper.zip', {
            configDirectory,
            fetch: async () => new Response(archive.toBuffer(), { status: 200 }),
            runNpm: async (args) => {
                npmCalled = true;
                expect(args).toContain('--omit=dev');
                expect(args).toContain('--ignore-scripts');
            }
        });

        expect(result).toEqual({ success: true, id: 'url-zip-review-helper' });
        expect(npmCalled).toBe(true);
    });

    test('从 URL ZIP 安装插件时默认使用平台网络层', async () => {
        const archive = new AdmZip();
        archive.addFile(
            'package.json',
            Buffer.from(JSON.stringify({ name: 'platform-fetch-plugin', version: '1.0.0' }))
        );
        archive.addFile(
            'opendesk.plugin.json',
            Buffer.from(
                JSON.stringify({
                    id: 'platform-fetch-plugin',
                    entry: './index.mjs',
                    apiVersion: 1,
                    capabilities: []
                })
            )
        );
        archive.addFile('index.mjs', Buffer.from('export default {};'));
        const platformFetch = jest.fn(async () => new Response(archive.toBuffer(), { status: 200 }));
        setPlatform({
            fetch: platformFetch,
            getInjectedEnviron: () => new Map()
        } as unknown as AbstractPlatform);
        const globalFetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('global fetch should not run'));

        try {
            const result = await installPlugin('https://example.com/platform-fetch-plugin.zip', {
                configDirectory,
                runNpm: async () => {
                    throw new Error('npm should not run for a ZIP without runtime dependencies');
                }
            });

            expect(result).toEqual({ success: true, id: 'platform-fetch-plugin' });
            expect(platformFetch).toHaveBeenCalledWith('https://example.com/platform-fetch-plugin.zip');
            expect(globalFetch).not.toHaveBeenCalled();
        } finally {
            globalFetch.mockRestore();
        }
    });

    test('无运行时依赖的 ZIP 不要求 npm', async () => {
        const zipPath = path.join(configDirectory, 'no-dependencies.zip');
        const archive = new AdmZip();
        archive.addFile('package.json', Buffer.from(JSON.stringify({ name: 'zip-no-dependencies', version: '1.0.0' })));
        archive.addFile(
            'opendesk.plugin.json',
            Buffer.from(
                JSON.stringify({
                    id: 'zip-no-dependencies',
                    entry: './index.mjs',
                    apiVersion: 1,
                    capabilities: []
                })
            )
        );
        archive.addFile('index.mjs', Buffer.from("export default { id: 'zip-no-dependencies', setup() {} };\n"));
        archive.writeZip(zipPath);

        const result = await installPlugin(zipPath, {
            configDirectory,
            runNpm: async () => {
                throw new Error('npm should not run for a ZIP without runtime dependencies');
            }
        });

        expect(result).toEqual({ success: true, id: 'zip-no-dependencies' });
    });

    test('带运行时依赖的本地 TGZ 与 ZIP 使用相同的依赖安装流程', async () => {
        const sourceRoot = path.join(configDirectory, 'tgz-source');
        const pluginDirectory = path.join(sourceRoot, 'package');
        const tgzPath = path.join(configDirectory, 'review-helper.tgz');
        fs.mkdirSync(pluginDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'package.json'),
            JSON.stringify({
                name: 'tgz-review-helper',
                version: '1.0.0',
                dependencies: {
                    'runtime-dependency': '1.0.0'
                }
            })
        );
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'tgz-review-helper',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(path.join(pluginDirectory, 'index.mjs'), 'export default {};');
        await writePluginTgz(tgzPath, pluginDirectory);

        let dependencyInstallDirectory = '';
        const result = await installPlugin(tgzPath, {
            configDirectory,
            runNpm: async (args, cwd) => {
                npmArgs = args;
                dependencyInstallDirectory = cwd;
            }
        });

        expect(result).toEqual({ success: true, id: 'tgz-review-helper' });
        expect(npmArgs).toEqual([
            'install',
            '--no-save',
            '--install-links=true',
            '--no-bin-links',
            '--omit=dev',
            '--no-optional',
            '--audit=false',
            '--ignore-scripts',
            '--package-lock=false',
            'runtime-dependency@1.0.0'
        ]);
        expect(path.basename(dependencyInstallDirectory)).toMatch(/^install-/);
        expect(getPluginRecord('tgz-review-helper', configDirectory)).toMatchObject({
            source: 'local',
            path: 'tgz-review-helper',
            spec: tgzPath
        });
    });

    test('无运行时依赖的 URL TGZ 不要求 npm', async () => {
        const sourceRoot = path.join(configDirectory, 'url-tgz-source');
        const pluginDirectory = path.join(sourceRoot, 'package');
        const tgzPath = path.join(configDirectory, 'url-review-helper.tgz');
        fs.mkdirSync(pluginDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'package.json'),
            JSON.stringify({ name: 'url-tgz-review-helper', version: '1.0.0' })
        );
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'url-tgz-review-helper',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(path.join(pluginDirectory, 'index.mjs'), 'export default {};');
        await writePluginTgz(tgzPath, pluginDirectory);
        const result = await installPlugin('https://example.com/url-review-helper.tgz', {
            configDirectory,
            fetch: async () => new Response(fs.readFileSync(tgzPath), { status: 200 }),
            runNpm: async () => {
                throw new Error('npm should not run for a TGZ without runtime dependencies');
            }
        });

        expect(result).toEqual({ success: true, id: 'url-tgz-review-helper' });
    });

    test('Windows 通过 node.exe 启动 npm CLI 而不直接 spawn npm.cmd', () => {
        const nodeDirectory = path.join(configDirectory, 'nodejs');
        const nodeExecutable = path.join(nodeDirectory, 'node.exe');
        const npmCli = path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
        fs.mkdirSync(path.dirname(npmCli), { recursive: true });
        fs.writeFileSync(nodeExecutable, '');
        fs.writeFileSync(npmCli, '');

        expect(
            resolveNpmInvocation(['install', '@example/plugin'], 'win32', {
                Path: nodeDirectory
            })
        ).toEqual({
            executable: nodeExecutable,
            args: [npmCli, 'install', '@example/plugin']
        });
    });

    test.each(['darwin', 'openharmony'] as const)('%s 从 PATH 解析可执行的 npm', (platform) => {
        const binDirectory = path.join(configDirectory, `${platform}-bin`);
        const npmExecutable = path.join(binDirectory, 'npm');
        fs.mkdirSync(binDirectory, { recursive: true });
        fs.writeFileSync(npmExecutable, '');
        fs.chmodSync(npmExecutable, 0o755);

        expect(
            resolveNpmInvocation(['install', '@example/plugin'], platform, {
                PATH: binDirectory
            })
        ).toEqual({
            executable: npmExecutable,
            args: ['install', '@example/plugin']
        });
    });

    test('将无法获取安装源归类为用户可理解的错误', async () => {
        const result = await installPlugin('missing-package', {
            configDirectory,
            runNpm: async () => {
                throw new Error('npm ERR! code E404');
            }
        });

        expect(result).toMatchObject({
            success: false,
            errorCode: 'source_unavailable'
        });
        expect(result.error).toContain('E404');
    });

    test('识别缺少 OpenDesk 声明的普通 npm 包', async () => {
        const result = await installPlugin('ordinary-package', {
            configDirectory,
            runNpm: async (_args, stagingDirectory) => {
                const pluginDirectory = path.join(stagingDirectory, 'node_modules', 'ordinary-package');
                fs.mkdirSync(pluginDirectory, { recursive: true });
                fs.writeFileSync(
                    path.join(stagingDirectory, 'package.json'),
                    JSON.stringify({
                        name: 'opendesk-plugin-staging',
                        private: true,
                        version: '1.0.0',
                        dependencies: {
                            'ordinary-package': '1.0.0'
                        }
                    })
                );
                fs.writeFileSync(
                    path.join(pluginDirectory, 'package.json'),
                    JSON.stringify({
                        name: 'ordinary-package',
                        version: '1.0.0'
                    })
                );
            }
        });

        expect(result).toMatchObject({
            success: false,
            errorCode: 'not_opendesk_plugin'
        });
    });

    test('识别不兼容的插件 API 版本', async () => {
        const result = await installPlugin('future-plugin', {
            configDirectory,
            runNpm: async (_args, stagingDirectory) => {
                const pluginDirectory = path.join(stagingDirectory, 'node_modules', 'future-plugin');
                fs.mkdirSync(pluginDirectory, { recursive: true });
                fs.writeFileSync(
                    path.join(stagingDirectory, 'package.json'),
                    JSON.stringify({
                        name: 'opendesk-plugin-staging',
                        private: true,
                        version: '1.0.0',
                        dependencies: {
                            'future-plugin': '1.0.0'
                        }
                    })
                );
                fs.writeFileSync(
                    path.join(pluginDirectory, 'package.json'),
                    JSON.stringify({
                        name: 'future-plugin',
                        version: '1.0.0'
                    })
                );
                fs.writeFileSync(
                    path.join(pluginDirectory, 'opendesk.plugin.json'),
                    JSON.stringify({
                        entry: './index.js',
                        apiVersion: 999,
                        capabilities: []
                    })
                );
                fs.writeFileSync(path.join(pluginDirectory, 'index.js'), 'export default {};');
            }
        });

        expect(result).toMatchObject({
            success: false,
            errorCode: 'incompatible_api'
        });
    });

    test('启停插件并将卸载内容移动到回收目录', async () => {
        await installPlugin('@example/review-helper@1.0.0', {
            configDirectory,
            runNpm: simulateNpmInstall
        });

        expect(setPluginEnabled('review-helper', false, configDirectory)).toBe(true);
        expect(listInstalledPlugins(configDirectory)[0]?.enabled).toBe(false);
        await expect(uninstallPlugin('review-helper', configDirectory)).resolves.toEqual({ success: true });
        expect(listInstalledPlugins(configDirectory)).toEqual([]);
        expect(fs.readdirSync(getPluginTrashDirectory(configDirectory))).toHaveLength(1);
    });

    test('Windows 暂时锁定托管目录时重试移动到回收目录', async () => {
        await installPlugin('@example/review-helper@1.0.0', {
            configDirectory,
            runNpm: simulateNpmInstall
        });
        const error = new Error('directory is temporarily locked') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        const rename = jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(error);
        let attempts = 0;

        try {
            await expect(uninstallPlugin('review-helper', configDirectory)).resolves.toEqual({ success: true });
            attempts = rename.mock.calls.length;
        } finally {
            rename.mockRestore();
        }

        expect(attempts).toBe(2);
        expect(listInstalledPlugins(configDirectory)).toEqual([]);
    });

    test('为自动发现的本地插件保存启停策略', () => {
        const pluginDirectory = path.join(getPluginsDirectory(configDirectory), 'local-review');
        fs.mkdirSync(pluginDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'local-review',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(path.join(pluginDirectory, 'index.mjs'), `export default { id: 'local-review', setup() {} };`);

        expect(setPluginEnabled('local-review', false, configDirectory)).toBe(true);
        expect(getPluginRecord('local-review', configDirectory)).toMatchObject({
            id: 'local-review',
            source: 'local',
            path: 'local-review',
            enabled: false
        });
        expect(discoverPlugins({ configDirectory }).candidates).toEqual([]);

        expect(setPluginEnabled('local-review', true, configDirectory)).toBe(true);
        expect(discoverPlugins({ configDirectory }).candidates).toEqual([
            expect.objectContaining({
                id: 'local-review',
                source: 'local',
                spec: pluginDirectory
            })
        ]);
    });

    test('为只读内置插件保存启停策略而不移动插件文件', () => {
        const builtinDirectory = path.join(configDirectory, 'builtin');
        const pluginDirectory = path.join(builtinDirectory, 'builtin-review');
        const previous = process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        fs.mkdirSync(pluginDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'builtin-review',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(
            path.join(pluginDirectory, 'index.mjs'),
            `export default { id: 'builtin-review', setup() {} };`
        );
        process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = builtinDirectory;

        try {
            expect(setPluginEnabled('builtin-review', false, configDirectory)).toBe(true);
            expect(getPluginRecord('builtin-review', configDirectory)).toMatchObject({
                id: 'builtin-review',
                source: 'builtin',
                path: 'builtin-review',
                enabled: false
            });
            expect(discoverPlugins({ configDirectory, builtinDirectories: [builtinDirectory] }).candidates).toEqual([]);
            expect(fs.existsSync(pluginDirectory)).toBe(true);

            expect(setPluginEnabled('builtin-review', true, configDirectory)).toBe(true);
            expect(discoverPlugins({ configDirectory, builtinDirectories: [builtinDirectory] }).candidates).toEqual([
                expect.objectContaining({
                    id: 'builtin-review',
                    source: 'builtin'
                })
            ]);
        } finally {
            if (previous === undefined) delete process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
            else process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = previous;
        }
    });

    test('卸载手工放入 plugins 目录且无注册表记录的插件', async () => {
        const pluginDirectory = path.join(getPluginsDirectory(configDirectory), 'manual-review');
        fs.mkdirSync(pluginDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'manual-review',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(path.join(pluginDirectory, 'index.mjs'), `export default {};`);

        await expect(uninstallPlugin('manual-review', configDirectory)).resolves.toEqual({ success: true });
        expect(fs.existsSync(pluginDirectory)).toBe(false);
        expect(fs.readdirSync(getPluginTrashDirectory(configDirectory))).toHaveLength(1);
        expect(discoverPlugins({ configDirectory }).candidates).toEqual([]);
    });

    test('卸载手工放入的单文件插件', async () => {
        const pluginFile = path.join(getPluginsDirectory(configDirectory), 'single.mjs');
        fs.mkdirSync(getPluginsDirectory(configDirectory), { recursive: true });
        fs.writeFileSync(pluginFile, `export default { id: 'single', setup() {} };`);
        fs.writeFileSync(
            path.join(getPluginsDirectory(configDirectory), 'single.opendesk.plugin.json'),
            JSON.stringify({
                id: 'single',
                entry: './single.mjs',
                apiVersion: 1,
                capabilities: []
            })
        );

        await expect(uninstallPlugin('single', configDirectory)).resolves.toEqual({ success: true });
        expect(fs.existsSync(pluginFile)).toBe(false);
        expect(fs.readdirSync(getPluginTrashDirectory(configDirectory))).toHaveLength(1);
    });

    test('拒绝卸载内置插件且不移动其文件', async () => {
        const builtinDirectory = path.join(configDirectory, 'builtin');
        const pluginDirectory = path.join(builtinDirectory, 'builtin-review');
        const previous = process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
        fs.mkdirSync(pluginDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'builtin-review',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(
            path.join(pluginDirectory, 'index.mjs'),
            `export default { id: 'builtin-review', setup() {} };`
        );
        process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = builtinDirectory;

        try {
            await expect(uninstallPlugin('builtin-review', configDirectory)).resolves.toEqual({
                success: false,
                error: 'plugin.uninstall_builtin'
            });
            expect(fs.existsSync(pluginDirectory)).toBe(true);
        } finally {
            if (previous === undefined) delete process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY;
            else process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = previous;
        }
    });

    test('拒绝卸载附加插件目录里的插件', async () => {
        const sourceDirectory = path.join(configDirectory, 'dev-plugin');
        fs.mkdirSync(sourceDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(sourceDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'dev-plugin',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(path.join(sourceDirectory, 'index.mjs'), `export default {};`);

        // 附加插件目录（settings 的 externalPaths 与 --plugins-directory 同一概念）
        const previous = process.env.OPENDESK_PLUGINS_DIRECTORY;
        process.env.OPENDESK_PLUGINS_DIRECTORY = sourceDirectory;
        try {
            expect(setPluginEnabled('dev-plugin', true, configDirectory)).toBe(true);
            await expect(uninstallPlugin('dev-plugin', configDirectory)).resolves.toEqual({
                success: false,
                error: 'plugin.uninstall_builtin'
            });
            expect(fs.existsSync(sourceDirectory)).toBe(true);
        } finally {
            if (previous === undefined) delete process.env.OPENDESK_PLUGINS_DIRECTORY;
            else process.env.OPENDESK_PLUGINS_DIRECTORY = previous;
        }
    });

    test('兼容卸载旧版注册表中 source 为 managed 的记录', async () => {
        const containerDirectory = path.join(getPluginsDirectory(configDirectory), 'legacy');
        const pluginDirectory = path.join(containerDirectory, 'node_modules', 'legacy-helper');
        fs.mkdirSync(pluginDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(pluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'legacy-helper',
                entry: './index.js',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(path.join(pluginDirectory, 'index.js'), `export default {};`);
        // 直接写盘模拟旧版注册表：schema 必须仍能解析，读取时把 managed 归并为 local
        const registryPath = getPluginRegistryPath(configDirectory);
        fs.mkdirSync(path.dirname(registryPath), { recursive: true });
        fs.writeFileSync(
            registryPath,
            JSON.stringify({
                schemaVersion: 1,
                plugins: [
                    {
                        id: 'legacy-helper',
                        source: 'managed',
                        path: path.join('legacy', 'node_modules', 'legacy-helper'),
                        enabled: true,
                        options: {}
                    }
                ]
            })
        );

        expect(getPluginRecord('legacy-helper', configDirectory)).toMatchObject({
            source: 'local',
            enabled: true
        });
        await expect(uninstallPlugin('legacy-helper', configDirectory)).resolves.toEqual({ success: true });
        expect(fs.existsSync(containerDirectory)).toBe(false);
        expect(listInstalledPlugins(configDirectory)).toEqual([]);
    });

    test('附加目录撤掉后残留的 builtin 记录不会阻止安装同名插件', async () => {
        const sourceDirectory = path.join(configDirectory, 'dev-plugin');
        fs.mkdirSync(sourceDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(sourceDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'dev-plugin',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(path.join(sourceDirectory, 'index.mjs'), `export default {};`);
        // 记录指向已经撤掉的附加目录：插件文件不在磁盘上，安装不该被这条残留记录挡住
        upsertPluginRecord(
            {
                id: 'dev-plugin',
                source: 'builtin',
                path: path.join(configDirectory, 'gone-plugins', 'dev-plugin'),
                enabled: false,
                options: {}
            },
            configDirectory
        );

        const result = await installPlugin(sourceDirectory, {
            configDirectory,
            runNpm: async () => {
                throw new Error('npm should not run for a plugin without runtime dependencies');
            }
        });

        expect(result).toEqual({ success: true, id: 'dev-plugin' });
        expect(getPluginRecord('dev-plugin', configDirectory)).toMatchObject({ source: 'local' });
    });

    test('同 ID 的被禁用内置插件仍然阻止安装', async () => {
        const builtinDirectory = path.join(configDirectory, 'builtin');
        const builtinPluginDirectory = path.join(builtinDirectory, 'dev-plugin');
        fs.mkdirSync(builtinPluginDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(builtinPluginDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'dev-plugin',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(path.join(builtinPluginDirectory, 'index.mjs'), `export default {};`);
        const sourceDirectory = path.join(configDirectory, 'dev-plugin-src');
        fs.mkdirSync(sourceDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(sourceDirectory, 'opendesk.plugin.json'),
            JSON.stringify({
                id: 'dev-plugin',
                entry: './index.mjs',
                apiVersion: 1,
                capabilities: []
            })
        );
        fs.writeFileSync(path.join(sourceDirectory, 'index.mjs'), `export default {};`);

        process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = builtinDirectory;
        try {
            // 禁用后内置插件不再出现在发现结果里，冲突判定改由注册表记录兜住
            expect(setPluginEnabled('dev-plugin', false, configDirectory)).toBe(true);

            const result = await installPlugin(sourceDirectory, {
                configDirectory,
                runNpm: async () => {
                    throw new Error('npm should not run for a plugin without runtime dependencies');
                }
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('plugin.install_builtin_conflict');
        } finally {
            process.env.OPENDESK_BUILTIN_PLUGINS_DIRECTORY = path.join(configDirectory, 'builtin-empty');
        }
    });
});
