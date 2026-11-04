import { setRuntimeLocale } from '../../../locale/index.js';
import {
    formatPluginInstallError,
    formatPluginUninstallError
} from '../../../main/applications/pluginmgr/management/errors.js';

describe('plugin installation error messages', () => {
    afterEach(() => {
        setRuntimeLocale(null);
    });

    test('为非 OpenDesk 插件提供中文的可操作提示', () => {
        setRuntimeLocale('zh-CN');

        expect(
            formatPluginInstallError({
                errorCode: 'not_opendesk_plugin'
            })
        ).toBe('所选软件包不是有效的 OpenDesk 插件，未找到 OpenDesk 插件声明。');
    });

    test('为不可用的安装源提供英文提示', () => {
        setRuntimeLocale('en-US');

        expect(
            formatPluginInstallError({
                errorCode: 'source_unavailable'
            })
        ).toBe('Could not retrieve the plugin package. Check the package name, path, or URL and try again.');
    });

    test('Windows 未找到 Node.js 和 npm 时提供明确提示', () => {
        setRuntimeLocale('zh-CN');

        expect(
            formatPluginInstallError({
                errorCode: 'npm_unavailable'
            })
        ).toBe('未找到可用的 Node.js 和 npm，无法安装 npm 包或 URL 插件。');
    });

    test('未知错误不会直接向用户暴露底层错误', () => {
        setRuntimeLocale('zh-CN');

        expect(
            formatPluginInstallError({
                errorCode: 'unknown'
            })
        ).toBe('插件安装失败，请查看应用日志了解详细信息。');
    });
});

describe('plugin uninstall error messages', () => {
    afterEach(() => {
        setRuntimeLocale(null);
    });

    test('不能卸载的几种来源各有专用提示', () => {
        setRuntimeLocale('zh-CN');

        expect(formatPluginUninstallError('plugin.uninstall_builtin', 'demo')).toBe('demo 是内置插件，不能卸载');
        expect(formatPluginUninstallError('plugin.uninstall_invalid_path', 'demo')).toBe(
            'demo 的安装路径不在插件目录内，无法卸载'
        );
    });

    test('其余错误原样透出，缺失时回退到通用失败文案', () => {
        setRuntimeLocale('zh-CN');

        expect(formatPluginUninstallError('EPERM: operation not permitted', 'demo')).toBe(
            'EPERM: operation not permitted'
        );
        expect(formatPluginUninstallError(undefined, 'demo')).toBe('卸载失败');
    });
});
