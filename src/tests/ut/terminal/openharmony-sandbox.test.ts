import { describe, expect, test } from '@jest/globals';
import { policyTextOpenHarmony } from '../../../main/applications/terminal/sandboxes/dynabox-policy.js';

describe('policyTextOpenHarmony', () => {
    test('不含 [[roots]]（OH 版 native 会拒绝 roots），含 [ask] 与 token', () => {
        const text = policyTextOpenHarmony('http://127.0.0.1:1/decide', 'secret-token', '/data/home/work');
        expect(text).not.toContain('[[roots]]');
        expect(text).toContain('[ask]');
        expect(text).toContain('endpoint = "http://127.0.0.1:1/decide"');
        expect(text).toContain('token = "secret-token"');
        expect(text).toContain('default = "deny"');
    });

    test('工作区写放行与兜底规则（真实路径语义；外读 ask 兜底 + 系统路径读放行）', () => {
        const text = policyTextOpenHarmony('e', 't', '/data/home/work');
        expect(text).toContain('path = "/data/home/work/**"\naccess = "write"\nperm = "allow"');
        expect(text).toContain('path = "/**"\naccess = "read"\nperm = "ask"');
        expect(text).toContain('path = "/**"\naccess = "write"\nperm = "ask"');
        expect(text).toContain('path = "/**"\naccess = "execute"\nperm = "allow"');
        // 系统运行时路径读放行（PATH 搜索的 stat 是 read）
        expect(text).toContain('path = "/usr/**"\naccess = "read"\nperm = "allow"');
    });

    test('家目录敏感路径 deny 与工具链缓存写放行（OH 上同样收窄）', () => {
        const text = policyTextOpenHarmony('e', 't', '/data/home/work', undefined, '/data/home');
        expect(text).toContain('path = "/data/home/.ssh/**"\naccess = "read"\nperm = "deny"');
        expect(text).toContain('path = "/data/home/.gnupg/**"\naccess = "read"\nperm = "deny"');
        expect(text).toContain('path = "/data/home/.cache/opendesk-sandbox/**"\naccess = "write"\nperm = "allow"');
    });

    test('家目录 npm 配置 .npmrc 与缓存 .npm/** 读写放行（npm 命令不弹 ask）', () => {
        const text = policyTextOpenHarmony('e', 't', '/data/home/work', undefined, '/data/home');
        expect(text).toContain('path = "/data/home/.npmrc"\naccess = "read"\nperm = "allow"');
        expect(text).toContain('path = "/data/home/.npmrc"\naccess = "write"\nperm = "allow"');
        // npm 缓存目录（_cacache/_logs/_locks）：npm install 下载/解压包写
        // ~/.npm/_cacache/tmp/* 临时文件，只放行 .npmrc 仍会落兜底 ask（回归：
        // mac 实测弹 ~/.npm/_cacache/tmp/<uuid> 读取）
        expect(text).toContain('path = "/data/home/.npm/**"\naccess = "read"\nperm = "allow"');
        expect(text).toContain('path = "/data/home/.npm/**"\naccess = "write"\nperm = "allow"');
    });

    test('Python 字节码缓存目录（__pycache__）写放行（对齐 Windows /C/**/__pycache__/**）', () => {
        // /data/app/python.org/.../encodings/_pycache__/*.pyc 等在 Python 安装
        // 目录下生成：全盘通配放行写入，免去每次 import 都触发写 ask 弹窗
        const text = policyTextOpenHarmony('e', 't', '/data/home/work');
        expect(text).toContain('path = "/**/__pycache__/**"\naccess = "write"\nperm = "allow"');
        // 放行规则须早于兜底 write ask 命中（first-match 语义）
        expect(text.indexOf('/**/__pycache__/**')).toBeLessThan(
            text.indexOf('path = "/**"\naccess = "write"\nperm = "ask"')
        );
    });

    test('家目录工具链安装根（<home>/usr/local）读取放行（pyvenv.cfg/python3._pth/pyc 缓存不弹 ask）', () => {
        // 回归：鸿蒙 PC 上 python 等工具链装在用户目录
        // /storage/Users/currentUser/usr/local/，node-gyp 探测读 pyvenv.cfg、
        // 解释器启动读 python3._pth 与 encodings/_pycache__/*.pyc，不放行则
        // 每条 npm install 命令都弹 read ask
        const text = policyTextOpenHarmony('e', 't', '/data/home/work', undefined, '/storage/Users/currentUser');
        expect(text).toContain('path = "/storage/Users/currentUser/usr/local/**"\naccess = "read"\nperm = "allow"');
        // 只放读：不得出现该目录的 write allow（工具链目录防持久化篡改）
        expect(text).not.toContain(
            'path = "/storage/Users/currentUser/usr/local/**"\naccess = "write"\nperm = "allow"'
        );
    });

    test('权限规则按真实路径导出、deny 优先于 allow', () => {
        const rules = [
            { resourceType: 'file', action: 'read', pathPattern: '/data/home/work/**', effect: 'allow' },
            { resourceType: 'file', action: 'write', pathPattern: '/data/home/secret/**', effect: 'deny' }
        ] as any[];
        const text = policyTextOpenHarmony('e', 't', '/data/home/work', rules, '/data/home');
        const denyIndex = text.indexOf('path = "/data/home/secret/**"');
        const allowIndex = text.indexOf('path = "/data/home/work/**"');
        expect(denyIndex).toBeGreaterThanOrEqual(0);
        expect(allowIndex).toBeGreaterThan(denyIndex);
    });

    test('writableDirs（temp/cache）写放行规则位于兜底 write ask 之前', () => {
        const text = policyTextOpenHarmony('e', 't', '/data/home/work', undefined, '/data/home', [
            '/data/storage/el2/temp',
            '/data/storage/el2/cache'
        ]);
        const tempWrite = 'path = "/data/storage/el2/temp/**"\naccess = "write"\nperm = "allow"';
        const cacheWrite = 'path = "/data/storage/el2/cache/**"\naccess = "write"\nperm = "allow"';
        // 读同样放行：系统 smart shell 桥接 FIFO（smartshell_fifo_<pid>）位于应用沙箱
        // cache 目录，沙箱内命令读它拿 I/O；只放行写会落到兜底 read ask，开启沙箱后
        // 每条命令都弹一次权限询问（回归：README 承诺"总是可读可写"）
        const tempRead = 'path = "/data/storage/el2/temp/**"\naccess = "read"\nperm = "allow"';
        const cacheRead = 'path = "/data/storage/el2/cache/**"\naccess = "read"\nperm = "allow"';
        expect(text).toContain(tempWrite);
        expect(text).toContain(cacheWrite);
        expect(text).toContain(tempRead);
        expect(text).toContain(cacheRead);
        // 顺序：可写目录规则必须早于兜底 /** write ask（first-match 才生效）
        const tempIdx = text.indexOf('path = "/data/storage/el2/temp/**"');
        const writeAskIdx = text.indexOf('path = "/**"\naccess = "write"\nperm = "ask"');
        const readAskIdx = text.indexOf('path = "/**"\naccess = "read"\nperm = "ask"');
        expect(tempIdx).toBeGreaterThanOrEqual(0);
        expect(writeAskIdx).toBeGreaterThan(tempIdx);
        expect(readAskIdx).toBeGreaterThan(tempIdx);
        expect(text).not.toContain('[[roots]]');
    });

    test('系统运行时读前缀补全：/system、/lib32、/sys、/proc、/data/service（回归：任务中启动探测路径触发 ask 风暴）', () => {
        const text = policyTextOpenHarmony('e', 't', '/data/home/work', undefined, '/data/home');
        // OH 系统运行时根 /system 与 /lib32：此前清单缺失导致每次 spawn 进程
        // 的 hilog/SELinux/崩溃处理探测都落入 /** read ask 兜底（cache_ttl=0
        // 不缓存），find/ls/cat 等命令被海量无关 ask 拖到超时
        for (const prefix of ['/system', '/sys', '/proc', '/data/service', '/lib32']) {
            expect(text).toContain(`path = "${prefix}/**"\naccess = "read"\nperm = "allow"`);
            expect(text).toContain(`path = "${prefix}"\naccess = "read"\nperm = "allow"`);
        }
        // 系统前缀只放行 read：write 兜底仍是 ask（不放大写授权面）
        expect(text).toContain('path = "/**"\naccess = "write"\nperm = "ask"');
        // read allow 规则须位于兜底 read ask 之前（first-match/most-specific 语义下放行生效）
        const systemIdx = text.indexOf('path = "/system/**"\naccess = "read"\nperm = "allow"');
        const readAskIdx = text.indexOf('path = "/**"\naccess = "read"\nperm = "ask"');
        expect(systemIdx).toBeGreaterThanOrEqual(0);
        expect(systemIdx).toBeLessThan(readAskIdx);
    });
});
