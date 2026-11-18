import { setRuntimeLocale } from '../../../locale/index.js';
import {
    PluginHostVersionError,
    parsePluginPlatformUnsupportedMessage
} from '../../../main/applications/pluginmgr/catalog-common.js';
import {
    classifyPluginInstallError,
    formatPluginInstallError,
    formatPluginInstallException,
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

    test('宿主版本过低时提示升级 OpenDesk', () => {
        setRuntimeLocale('zh-CN');

        expect(
            formatPluginInstallError({
                errorCode: 'host_version_too_old'
            })
        ).toBe('该插件要求的 OpenDesk 版本高于当前版本，无法安装。请将 OpenDesk 升级到最新版本后重试。');
    });

    test('宿主版本过高时提示寻找支持当前版本的插件', () => {
        setRuntimeLocale('zh-CN');

        expect(
            formatPluginInstallError({
                errorCode: 'host_version_too_new'
            })
        ).toBe('该插件要求的 OpenDesk 版本低于当前版本，无法安装。请检查插件是否有支持当前版本的新版本。');
    });

    test('英文环境下宿主版本错误同样本地化', () => {
        setRuntimeLocale('en-US');

        expect(
            formatPluginInstallError({
                errorCode: 'host_version_too_old'
            })
        ).toBe(
            'This plugin requires a newer version of OpenDesk and cannot be installed. Upgrade OpenDesk to the latest version and try again.'
        );
    });

    test('平台不匹配时文案带插件 id 与平台列表', () => {
        setRuntimeLocale('zh-CN');

        expect(
            formatPluginInstallError({
                errorCode: 'platform_unsupported',
                error: 'plugin.install_platform_unsupported:demo-plugin:win32, darwin'
            })
        ).toBe('插件 demo-plugin 不支持当前操作系统平台（仅支持 win32, darwin），无法安装。');
    });

    test('解析平台闸门结构化串', () => {
        expect(
            parsePluginPlatformUnsupportedMessage('plugin.install_platform_unsupported:demo-plugin:win32, darwin')
        ).toEqual({ id: 'demo-plugin', platforms: 'win32, darwin' });
        // 其它前缀 / 缺 id / 缺平台列表都不视为平台闸门错误
        expect(parsePluginPlatformUnsupportedMessage('plugin.install_host_version:too_old:0.3.0')).toBeUndefined();
        expect(parsePluginPlatformUnsupportedMessage('plugin.install_platform_unsupported:win32')).toBeUndefined();
        expect(parsePluginPlatformUnsupportedMessage(undefined)).toBeUndefined();
    });

    test('宿主版本错误即使发生在安装阶段也归类为版本问题', () => {
        // 分类顺序：先认版本错误再走 stage 兜底，否则界面拿不到升级引导的方向
        const error = new PluginHostVersionError('too_new', '≤ 0.3.0', '0.4.1');
        expect(classifyPluginInstallError(error, 'install')).toBe('host_version_too_new');
        expect(classifyPluginInstallError(error, 'validate')).toBe('host_version_too_new');
    });

    test('把宿主版本闸门的结构化异常翻译成本地化引导，其它错误交回调用方', () => {
        setRuntimeLocale('zh-CN');

        // 文案与市场安装弹窗一致：带上插件要求的范围与当前宿主版本
        expect(formatPluginInstallException(new PluginHostVersionError('too_old', '≥ 99.0.0', '0.4.1'))).toBe(
            '该插件需要 OpenDesk ≥ 99.0.0，当前版本 0.4.1 不满足要求。请将 OpenDesk 升级到最新版本后重试。'
        );
        // 非宿主版本错误返回 undefined：调用方原样展示（保留原始原因与堆栈）
        expect(formatPluginInstallException(new Error('disk full'))).toBeUndefined();
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
