import { virtualPathToHostPath } from '../../../main/applications/terminal/sandboxes/ask-path.js';
import {
    expandPermissionPattern,
    hostPatternToVirtual,
    policyText
} from '../../../main/applications/terminal/sandboxes/dynabox.js';
import { policyTextLinux } from '../../../main/applications/terminal/sandboxes/dynabox-policy.js';
import { createNodePolicyRules } from '../../../main/aikernel/security/policies/node.js';

describe('expandPermissionPattern', () => {
    test('{,/**} 展开为目录本身与子树', () => {
        expect(expandPermissionPattern('C:/work{,/**}')).toEqual(['C:/work', 'C:/work/**']);
    });
    test('普通 glob 原样返回', () => {
        expect(expandPermissionPattern('D:/data/**')).toEqual(['D:/data/**']);
    });
});

describe('hostPatternToVirtual', () => {
    test('盘符路径转虚拟前缀', () => {
        expect(hostPatternToVirtual('C:/work/a')).toBe('/C/work/a');
        expect(hostPatternToVirtual('d:\\x')).toBe('/D/x');
    });
    test('非盘符路径（UNC 等）返回 null', () => {
        expect(hostPatternToVirtual('//server/share')).toBeNull();
        expect(hostPatternToVirtual('/dev/null')).toBeNull();
    });
});

describe('policyText', () => {
    const base = (rules: string) =>
        `version = 1\ndefault = "deny"\n[ask]\nendpoint = "http://127.0.0.1:1/decide"\ntoken = "t"\ntimeout_ms = 330000\ncache_ttl_seconds = 0\ngrant_ttl_seconds = 0\n${rules}`;

    test('deny 排在 ask/allow 之前；execute 不导出；all 拆分为 read+write', () => {
        const rules = [
            { resourceType: 'file', action: 'read', pathPattern: 'D:/private/**', effect: 'deny' },
            { resourceType: 'file', action: 'write', pathPattern: 'D:/data/**', effect: 'allow' },
            { resourceType: 'file', action: '*', pathPattern: 'C:/proj/**', effect: 'ask' },
            { resourceType: 'file', action: 'execute', pathPattern: 'E:/bin/**', effect: 'allow' },
            { resourceType: 'registry', action: 'read', pathPattern: 'HKLM/xx', effect: 'deny' }
        ] as any[];
        const text = policyText('http://ep/decide', 'tok', rules as any);
        // deny 最先
        const denyIdx = text.indexOf('perm = "deny"\n'.replace('\n', '')) >= 0 ? text.indexOf('/D/private/**') : -1;
        expect(denyIdx).toBeGreaterThanOrEqual(0);
        // execute 不导出到原生策略
        expect(text).not.toContain('E:/bin/**');
        // all 拆为 read + write
        expect(text).toContain('access = "write"');
        expect(text).toContain('access = "read"');
    });

    test('非盘符模式被跳过，通配根被转换', () => {
        const rules = [
            { resourceType: 'file', action: 'read', pathPattern: '/dev/null', effect: 'deny' },
            { resourceType: 'file', action: 'read', pathPattern: '**', effect: 'allow' }
        ] as any[];
        const text = policyText('http://ep/decide', 't', rules as any);
        expect(text).toContain('path = "/**"');
        expect(text).not.toContain('/dev/null');
    });

    test('系统维护路径（组件存储/缓存/Recent/PowerShell 框架写）放通；回收站不放通（回收站 deny 更具体）', () => {
        const text = policyText('http://ep/decide', 't', undefined, 'C:\\Users\\tester');
        for (const p of [
            '/C/Windows/system32/catroot**',
            '/C/Windows/Temp/**',
            '/C/ProgramData/Microsoft/Windows/Caches/**',
            '/C/Users/*/AppData/Local/Microsoft/Windows/Caches/**',
            '/C/Users/*/AppData/Roaming/Microsoft/Windows/Recent/**',
            '/C/Users/*/AppData/Local/Microsoft/Windows/PowerShell/**'
        ]) {
            expect(text).toContain(`path = ${JSON.stringify(p)}`);
        }
        // 家目录根 / Roaming 根不放通（避免关键配置被静默覆盖的风险）——写探测由
        // hook 按"目录写探测/已存在目录创建"降级为 read（见 hooks_file/hooks_nt）
        expect(text).not.toContain('path = "/C/Users/*"');
        expect(text).not.toContain('/C/Users/*/AppData/Roaming"');
        // 回收站是误删数据的恢复区，不放通 write（--del-to-trash 经 SHFileOperation
        // 内部操作不受策略判定，不需要放通回收站）
        expect(text).not.toContain('/C/$RECYCLE.BIN');
        // 放行规则须是 write allow，且排在兜底 write ask 之前导出（most-specific
        // 下判定按 spec 取优、与位置无关；此处只固化可读的导出顺序）
        const recentAt = text.indexOf('/AppData/Roaming/Microsoft/Windows/Recent/**');
        const block = text.slice(recentAt - 40, recentAt + 120);
        expect(block).toContain('access = "write"');
        expect(block).toContain('perm = "allow"');
        const fallbackAskAt = text.indexOf('access = "write"\nperm = "ask"');
        expect(recentAt).toBeLessThan(fallbackAskAt);
    });

    test('home 提供时生成缓存目录写放行规则（虚路径）', () => {
        const text = policyText('http://ep/decide', 't', undefined, 'C:\\Users\\tester');
        expect(text).toContain('path = "/C/Users/tester/.cache/opendesk-sandbox/**"');
        const ruleStart = text.indexOf('.cache/opendesk-sandbox');
        const ruleBlock = text.slice(ruleStart - 40, ruleStart + 120);
        expect(ruleBlock).toContain('access = "write"');
        expect(ruleBlock).toContain('perm = "allow"');
    });

    test('Windows 从 Node 策略导出 .npmrc 权限，不在终端层维护平台副本', () => {
        const home = 'C:/Users/tester';
        const text = policyText('http://ep/decide', 't', createNodePolicyRules(home), home);
        expect(text).toContain('path = "/C/Users/tester/.npmrc"\naccess = "read"\nperm = "ask"');
        expect(text).toContain('path = "/C/Users/tester/.npmrc"\naccess = "write"\nperm = "ask"');
        expect(text).not.toContain('path = "/C/Users/tester/.npmrc"\naccess = "read"\nperm = "allow"');
        expect(text).not.toContain('path = "/C/Users/tester/.npmrc"\naccess = "write"\nperm = "allow"');
    });

    test('home 提供时生成宿主 Temp 写放行规则（共享 Temp 别名落点）', () => {
        const text = policyText('http://ep/decide', 't', undefined, 'C:\\Users\\tester');
        expect(text).toContain('path = "/C/Users/tester/AppData/Local/Temp/**"');
        const ruleStart = text.indexOf('/AppData/Local/Temp/**');
        const ruleBlock = text.slice(ruleStart - 40, ruleStart + 120);
        expect(ruleBlock).toContain('access = "write"');
        expect(ruleBlock).toContain('perm = "allow"');
        // 放行规则排在兜底 write ask 之前导出（判定按 spec 取优、与位置无关，
        // 此处只固化可读的导出顺序）
        expect(text.indexOf('/AppData/Local/Temp/**')).toBeLessThan(text.indexOf('perm = "ask"'));
    });

    test('home 缺失时不生成缓存目录规则', () => {
        expect(policyText('http://ep/decide', 't')).not.toContain('opendesk-sandbox');
        expect(policyText('http://ep/decide', 't')).not.toContain('AppData/Local/Temp');
    });

    test('opendeskDataDir 提供时生成 OpenDesk 数据目录（logs/artifacts/tasks）写放行（排在兜底 write ask 之前导出）', () => {
        const text = policyText(
            'http://ep/decide',
            't',
            undefined,
            'C:\\Users\\tester',
            'C:\\Users\\tester\\AppData\\Roaming\\opendesk'
        );
        for (const p of [
            '/C/Users/tester/AppData/Roaming/opendesk/logs/**',
            '/C/Users/tester/AppData/Roaming/opendesk/artifacts/**',
            '/C/Users/tester/AppData/Roaming/opendesk/tasks/**'
        ]) {
            expect(text).toContain(`path = ${JSON.stringify(p)}`);
        }
        const idx = text.indexOf('/opendesk/logs/**');
        const ruleBlock = text.slice(idx - 40, idx + 120);
        expect(ruleBlock).toContain('access = "write"');
        expect(ruleBlock).toContain('perm = "allow"');
        const fallbackAskAt = text.indexOf('access = "write"\nperm = "ask"');
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(fallbackAskAt);
    });

    test('opendeskDataDir 缺失时由 home 推导 OpenDesk 数据目录写放行', () => {
        const text = policyText('http://ep/decide', 't', undefined, 'C:\\Users\\tester');
        expect(text).toContain('path = "/C/Users/tester/AppData/Roaming/opendesk/logs/**"');
        expect(text).toContain('path = "/C/Users/tester/AppData/Roaming/opendesk/artifacts/**"');
        expect(text).toContain('path = "/C/Users/tester/AppData/Roaming/opendesk/tasks/**"');
    });

    test('home 与 opendeskDataDir 均缺失时无 OpenDesk 数据目录规则', () => {
        const text = policyText('http://ep/decide', 't');
        expect(text).not.toContain('/opendesk/logs');
    });

    test('Python 字节码缓存不得通过全盘 __pycache__ 通配规则写入', () => {
        const text = policyText('http://ep/decide', 't', undefined, 'C:\\Users\\tester');
        expect(text).not.toContain('path = "/C/**/__pycache__/**"');
        expect(text).toContain('path = "/C/Users/tester/.cache/opendesk-sandbox/**"\naccess = "write"\nperm = "allow"');
    });

    test('Windows AppInstaller 诊断日志目录写放行', () => {
        const text = policyText('http://ep/decide', 't');
        expect(text).toContain('path = "/C/Users/*/AppData/Local/Packages/*/LocalState/DiagOutputDir/**"');
    });

    test('OpenDesk 数据目录放行不影响家目录根与 Roaming 根不放通的约束', () => {
        const text = policyText('http://ep/decide', 't', undefined, 'C:\\Users\\tester');
        expect(text).not.toContain('path = "/C/Users/*"');
        expect(text).not.toContain('/C/Users/tester/AppData/Roaming"');
    });

    test('追加只读兜底与写入问询、执行放行的兜底规则', () => {
        const text = policyText('http://ep/decide', 't', undefined);
        expect(text.indexOf('access = "read"')).toBeGreaterThanOrEqual(0);
        expect(text).toContain('perm = "ask"');
        expect(text).toContain('path = "/**"');
    });

    test('PowerShell 启动运行时豁免：证书缓存写/PSModulePath 读/LocalLow-Temp 写不触发 ask（回归：删除命令时冒大量奇怪路径 ask）', () => {
        // 复现自 task_muui9c74_ikhu：沙箱内启动 PowerShell 执行 Remove-Item 时，
        // hook 对 CryptnetUrlCache 的 GUID 哈希文件（read/write）、
        // Documents\\WindowsPowerShell\\Modules（PSModulePath 逐目录 stat read）、
        // LocalLow\\Temp\\__PSScriptPolicyTest_*.ps1（执行策略检测临时脚本 write）
        // 反复发起 ask——这些是每次启动必然访问的运行时路径，须豁免。
        const text = policyText('http://ep/decide', 't', undefined, 'C:\\Users\\tester');
        // 证书签名校验缓存：read 已由 LocalLow/Microsoft/** read 覆盖，write 须放行
        for (const p of ['/C/Users/*/AppData/LocalLow/Microsoft/CryptnetUrlCache/**']) {
            const at = text.indexOf(`path = ${JSON.stringify(p)}`);
            expect(at).toBeGreaterThanOrEqual(0);
            expect(text.slice(at - 40, at + 120)).toContain('access = "write"');
            expect(text.slice(at - 40, at + 120)).toContain('perm = "allow"');
        }
        // PowerShell 执行策略检测临时脚本落盘区（LocalLow\\Temp）
        for (const p of ['/C/Users/*/AppData/LocalLow/Temp/**']) {
            const at = text.indexOf(`path = ${JSON.stringify(p)}`);
            expect(at).toBeGreaterThanOrEqual(0);
            expect(text.slice(at - 40, at + 120)).toContain('access = "write"');
            expect(text.slice(at - 40, at + 120)).toContain('perm = "allow"');
        }
        // PSModulePath 用户模块目录（PowerShell 5.1 与 7 各一）：模块搜索逐目录 stat
        // 须放行 read——目录本身与子树都要（stat 命中目录本身，读文件命中子树）
        for (const p of [
            '/C/Users/tester/Documents/WindowsPowerShell/Modules',
            '/C/Users/tester/Documents/WindowsPowerShell/Modules/**',
            '/C/Users/tester/Documents/PowerShell/Modules',
            '/C/Users/tester/Documents/PowerShell/Modules/**'
        ]) {
            const at = text.indexOf(`path = ${JSON.stringify(p)}`);
            expect(at).toBeGreaterThanOrEqual(0);
            expect(text.slice(at - 40, at + 120)).toContain('access = "read"');
            expect(text.slice(at - 40, at + 120)).toContain('perm = "allow"');
        }
        // 放行规则排在兜底 write ask 之前导出（判定按 spec 取优、与位置无关）
        const fallbackAskAt = text.indexOf('access = "write"\nperm = "ask"');
        expect(text.indexOf('CryptnetUrlCache')).toBeLessThan(fallbackAskAt);
        expect(text.indexOf('/AppData/LocalLow/Temp/**')).toBeLessThan(fallbackAskAt);
    });

    test('Windows Shell desktop.ini 全卷读放行（回归：standard 模式 jest worker 逐个弹 desktop.ini ask）', () => {
        // 复现自 task_mvdeo8ba：沙箱内 jest worker（Windows Shell 组件初始化）
        // 启动时逐个读取已知文件夹（Desktop/Documents/...）与 Program Files 等
        // 任意位置的 desktop.ini（一次 jest 运行 22 个 worker 累计 646 次），
        // 不在运行时读放行清单内时逐次命中 /** read ask 弹窗。这是 Windows
        // Shell 的进程启动/文件夹浏览固定行为，按语义类别整类放行；写仍由兜底
        // ask 管控（desktop.ini 可劫持文件夹视图，不允许静默写入）。
        const text = policyText('http://ep/decide', 't', undefined, 'C:\\Users\\tester');
        const at = text.indexOf('path = "/**/desktop.ini"');
        expect(at).toBeGreaterThanOrEqual(0);
        expect(text.slice(at - 40, at + 120)).toContain('access = "read"');
        expect(text.slice(at - 40, at + 120)).toContain('perm = "allow"');
        // 放行须排在 /** read ask 兜底块之前导出（文本内首个 read ask 是调试实例
        // 凭据规则，不能用 indexOf('perm = "ask"') 当锚点）
        const fallbackReadAskAt = text.indexOf('path = "/**"\naccess = "read"');
        expect(fallbackReadAskAt).toBeGreaterThan(0);
        expect(at).toBeLessThan(fallbackReadAskAt);
        // 不逐文件夹/用户名硬编码枚举
        expect(text).not.toContain('/Users/*/Desktop/desktop.ini');
        // home 缺失时同样生成（desktop.ini 放行不依赖 home 推导）
        expect(policyText('http://ep/decide', 't')).toContain('path = "/**/desktop.ini"');
        // 仅 Windows 生成：Linux/OH 策略无此规则（desktop.ini 是 Windows Shell 特有）
        const linuxText = policyTextLinux('http://ep/decide', 't', '/work', undefined, '/home/tester');
        expect(linuxText).not.toContain('desktop.ini');
    });

    test('用户显式 deny 优先于 desktop.ini 全卷读放行（deny 更具体/更严，与导出顺序无关）', () => {
        // 运行时放行不能吞掉用户对特定目录的显式拒绝：原生 most-specific 语义下
        // /C/keys/desktop.ini 同时命中 /C/keys/** deny 与 /**/desktop.ini allow，
        // 前者更长，判定为 deny（原生 sandbox.exe debug-rules 实测）。这里仍固化
        // "deny 规则块先导出"的文本顺序（便于阅读），但不作为判定依据。
        const rules = [{ resourceType: 'file', action: 'read', pathPattern: 'C:/keys/**', effect: 'deny' }] as any[];
        const text = policyText('http://ep/decide', 't', rules, 'C:\\Users\\tester');
        const denyAt = text.indexOf('path = "/C/keys/**"');
        const iniAt = text.indexOf('path = "/**/desktop.ini"');
        expect(denyAt).toBeGreaterThanOrEqual(0);
        expect(iniAt).toBeGreaterThan(denyAt);
    });

    test('git 运行时读放行与凭据规则已迁移至 security/policies（策略文本由引擎规则导出）', () => {
        // git 规则单一来源在 security/policies/git.ts（app 策略注入 standard 模式
        // 引擎），沙箱文本由 enforcer.getRules() 经 rulesToLines 导出。
        // 导出行为回归见 src/tests/ut/aikernel/app-policies.test.ts；
        // 此处仅确认 policyText 未再内联 git 专用清单（终端侧无重复维护）。
        const text = policyText('http://ep/decide', 't', undefined, 'C:\\Users\\tester');
        expect(text).not.toContain('GIT_CREDENTIAL_HOME_PATHS');
    });

    test('virtualPathToHostPath 回转（ask 路径 → 宿主路径）', () => {
        expect(virtualPathToHostPath('/C/Users/a.txt')).toBe('C:/Users/a.txt');
        expect(virtualPathToHostPath('/C/a/../b')).toBeNull();
    });
});

// 原生 glob 的尾部 `**` 只覆盖子树、不匹配目录自身（四平台一致），所以 allow 的
// `X/**` 必须在生成侧补一条 `X`，否则目录自身会落到更宽的兜底规则上。
describe('policyText: allow 的 X/** 自动附带 X', () => {
    const countPath = (text: string, pattern: string): number =>
        text.split('\n').filter((line) => line === `path = ${JSON.stringify(pattern)}`).length;
    // readonly 签名：全盘 write deny 且无全盘 read allow
    const readonlyRules = [{ resourceType: 'file', action: 'write', pathPattern: '**', effect: 'deny' }] as any[];

    test('readonly：/C/Windows/** read allow 附带 /C/Windows 本身（否则 dir C:\\Windows 被全盘 deny）', () => {
        const text = policyText('http://ep/decide', 't', readonlyRules);
        expect(text).toContain('path = "/C/Windows/**"');
        expect(countPath(text, '/C/Windows')).toBe(1);
        expect(text).toContain('path = "/C/Windows"\naccess = "read"\nperm = "allow"');
    });

    test('allow 的 X/** 按 access 各补一条（write 与 read 互不替代）', () => {
        const text = policyText('http://ep/decide', 't', undefined, 'C:\\Users\\tester');
        const temp = '/C/Users/tester/AppData/Local/Temp';
        expect(text).toContain(`path = "${temp}/**"\naccess = "write"\nperm = "allow"`);
        expect(text).toContain(`path = "${temp}"\naccess = "write"\nperm = "allow"`);
        expect(text).toContain(`path = "${temp}"\naccess = "read"\nperm = "allow"`);
    });

    test('deny 侧不补：敏感目录 X/** read deny 不附带 X（目录仍可列、只拦内容）', () => {
        const text = policyTextLinux('http://ep/decide', 't', '/home/tester/work', undefined, '/home/tester');
        expect(text).toContain('path = "/home/tester/.ssh/**"\naccess = "read"\nperm = "deny"');
        expect(countPath(text, '/home/tester/.ssh')).toBe(0);
        // 用户规则里的即 write deny 同理
        const winText = policyText('http://ep/decide', 't', [
            { resourceType: 'file', action: 'read', pathPattern: 'C:/keys/**', effect: 'deny' }
        ] as any[]);
        expect(countPath(winText, '/C/keys')).toBe(0);
    });

    test('/** allow 附带根 /（execute 兜底同样生效）', () => {
        const text = policyText('http://ep/decide', 't', undefined);
        expect(text).toContain('path = "/**"\naccess = "execute"\nperm = "allow"');
        expect(text).toContain('path = "/"\naccess = "execute"\nperm = "allow"');
    });

    test('已显式成对声明的不重复补（用户 {,/**} 规则）', () => {
        const rules = [
            { resourceType: 'file', action: 'read', pathPattern: 'C:/proj{,/**}', effect: 'allow' }
        ] as any[];
        const text = policyText('http://ep/decide', 't', rules);
        expect(text).toContain('path = "/C/proj/**"\naccess = "read"\nperm = "allow"');
        expect(countPath(text, '/C/proj')).toBe(1);
    });
});
