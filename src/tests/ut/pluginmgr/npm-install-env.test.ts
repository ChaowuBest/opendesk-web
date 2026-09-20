import { stripNpmScriptPolicyEnv } from '../../../main/applications/pluginmgr/management/dependencies.js';

// npm 11.19+（RFC npm/rfcs#868）在 project 级安装中只要 CLI/env 层携带
// allow-scripts 就抛 EALLOWSCRIPTS，而 `npm run` 会把用户 .npmrc 里的
// allow-scripts 以 npm_config_allow_scripts 环境变量注入子进程，导致
// 插件依赖安装（project 级 npm install）全部失败。
describe('npm 安装子进程环境净化', () => {
    test('剔除 allow-scripts 环境变量（含大小写变体，npm 前缀匹配不区分大小写）', () => {
        const env = stripNpmScriptPolicyEnv({
            npm_config_allow_scripts: '@bitclub.ai/opendesk-cli,esbuild',
            NPM_CONFIG_ALLOW_SCRIPTS: '@bitclub.ai/opendesk-cli,esbuild',
            npm_config_registry: 'https://registry.npmmirror.com',
            PATH: '/usr/bin:/bin'
        });

        expect(Object.keys(env).some((key) => /^npm_config_allow_scripts$/i.test(key))).toBe(false);
    });

    test('保留其余 npm 配置与系统环境变量', () => {
        const source = {
            npm_config_registry: 'https://registry.npmmirror.com',
            npm_config_cache: '/tmp/npm-cache',
            npm_config_strict_ssl: 'false',
            PATH: '/usr/bin:/bin',
            LANG: 'C.UTF-8'
        };

        expect(stripNpmScriptPolicyEnv(source)).toEqual(source);
    });
});
