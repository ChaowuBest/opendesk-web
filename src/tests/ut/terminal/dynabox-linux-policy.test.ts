import { describe, expect, test } from '@jest/globals';
import {
    hostPatternToVirtualLinux,
    permissionRulesForSandboxLinux,
    policyTextLinux
} from '../../../main/applications/terminal/sandboxes/dynabox-policy.js';

describe('hostPatternToVirtualLinux', () => {
    test('透明路径恒等（保留宿主真实路径）', () => {
        expect(hostPatternToVirtualLinux('/home/tester/work')).toBe('/home/tester/work');
        expect(hostPatternToVirtualLinux('**')).toBe('/**');
    });
    test('相对路径（无 / 前缀）返回 null：避免导出非法 path 导致策略加载失败', () => {
        expect(hostPatternToVirtualLinux('src/**')).toBeNull();
        expect(hostPatternToVirtualLinux('foo/bar')).toBeNull();
    });
    test('相对路径规则被跳过（不会出现在导出的策略中）', () => {
        const rules = [
            { resourceType: 'file', action: 'read', pathPattern: 'src/**', effect: 'allow' },
            { resourceType: 'file', action: 'read', pathPattern: '/home/tester/work/**', effect: 'allow' }
        ] as any[];
        const lines = permissionRulesForSandboxLinux(rules).join('\n');
        expect(lines).toContain('/home/tester/work/**');
        expect(lines).not.toContain('src/**');
    });
});

describe('policyTextLinux', () => {
    test('LD_PRELOAD 版不含 [[roots]]（身份命名空间，无路径映射）', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work');
        expect(text).not.toContain('[[roots]]');
        expect(text).not.toContain('virtual = "/"');
        // 规则 path 直接用宿主真实路径
        expect(text).toContain('path = "/home/tester/work/**"\naccess = "write"\nperm = "allow"');
    });
    test('全盘 write deny（readonly 模式）：不追加工作区 write allow、外读兜底改为 deny、temp 读写放行', () => {
        const rules = [
            { resourceType: 'file', action: 'read', pathPattern: '/home/tester/work/**', effect: 'allow' },
            { resourceType: 'file', action: 'write', pathPattern: '**', effect: 'deny' }
        ] as any[];
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work', rules);
        // 全盘 write deny 规则在位（** 经 hostPatternToVirtualLinux 映射为 /**）
        expect(text).toContain('path = "/**"\naccess = "write"\nperm = "deny"');
        // 工作区 write allow 被跳过（否则 most-specific 下顶掉全盘 deny，readonly 写保护失效）
        expect(text).not.toContain('path = "/home/tester/work/**"\naccess = "write"\nperm = "allow"');
        // 非 write 的用户规则仍导出
        expect(text).toContain('path = "/home/tester/work/**"\naccess = "read"\nperm = "allow"');
        // 外读兜底改为 deny（readonly 不弹窗外读：工作区外读写全部拒绝）
        expect(text).toContain('path = "/**"\naccess = "read"\nperm = "deny"');
        // 临时目录读写放行（shell 管道/heredoc 必需；泛化清单）
        expect(text).toContain('path = "/tmp/**"\naccess = "write"\nperm = "allow"');
        expect(text).toContain('path = "/tmp/**"\naccess = "read"\nperm = "allow"');
        expect(text).toContain('path = "/private/var/folders/**"\naccess = "write"\nperm = "allow"');
        expect(text).toContain('path = "/dev/shm/**"\naccess = "write"\nperm = "allow"');
    });
    test('临时目录读写放行（非 readonly 也生效：管道/heredoc/编译器落盘区泛化清单）', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work');
        for (const p of ['/tmp/**', '/var/tmp/**', '/private/var/tmp/**', '/private/var/folders/**', '/dev/shm/**']) {
            expect(text).toContain(`path = "${p}"\naccess = "write"\nperm = "allow"`);
            expect(text).toContain(`path = "${p}"\naccess = "read"\nperm = "allow"`);
        }
    });
    test('standard（无全盘 read allow 规则）：外读兜底为 ask（"工作空间外需确认"）+ 系统路径/shell rc/temp 读放行', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work', undefined, '/home/tester');
        if (!text.includes('.zshenv')) {
            console.log(
                '[DUMP] zshenv missing; all paths:\n' +
                    text
                        .split('\n')
                        .filter((l) => l.startsWith('path = '))
                        .join('\n')
            );
        }
        // 兜底 ask（外读需确认的落实）
        expect(text).toContain('path = "/**"\naccess = "read"\nperm = "ask"');
        // 系统运行时路径读放行（PATH 搜索的 stat 是 read，全盘 ask 会让 shell 不可用）
        expect(text).toContain('path = "/usr/**"\naccess = "read"\nperm = "allow"');
        expect(text).toContain('path = "/bin/**"\naccess = "read"\nperm = "allow"');
        // shell rc 文件读放行
        expect(text).toContain('path = "/home/tester/.zshenv"\naccess = "read"\nperm = "allow"');
        // temp 读放行
        expect(text).toContain('path = "/tmp/**"\naccess = "read"\nperm = "allow"');
        // git 凭据/配置规则已迁移至 security/policies/git.ts（app 策略注入引擎），
        // 沙箱文本由 enforcer.getRules() 导出（回归见 ut/aikernel/app-policies.test.ts）；
        // 无 home 传入时（本用例未传）不含 git 规则。
    });
    test('系统运行时读前缀补全：/system、/lib32、/sys、/proc、/run、/data/service（回归：启动探测路径触发 ask 风暴）', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work');
        // 与 OH 版共用同一清单：进程启动时系统库必读这些路径；缺失则每次 spawn
        // 都对 /system 等触发一次 ask（兜底 ask 不缓存），命令异常缓慢
        for (const prefix of ['/system', '/sys', '/proc', '/run', '/data/service', '/lib32']) {
            expect(text).toContain(`path = "${prefix}/**"\naccess = "read"\nperm = "allow"`);
            expect(text).toContain(`path = "${prefix}"\naccess = "read"\nperm = "allow"`);
        }
    });
    test('stat 家族由 native deny-only 承载：策略不再包含 stat 驱动的补丁规则（PATH 展开/祖先目录/静态 selinux）', () => {
        // stat/access/readlink/opendir 等元数据读在 native preload 层统一为
        // deny-only（不参与 allow/ask），见 preload.c 的 gate_meta_read——bash
        // 的 PATH 搜索 stat、cwd 祖先链 stat、/selinux 探测都不再需要策略放行
        // 规则。此处断言这些补丁未死灰复燃（防止回归成"策略膨胀 + 两处维护"）。
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work');
        // 工作区祖先目录（bash $PWD 验证 stat 的对象）不应有 read allow
        expect(text).not.toContain('path = "/home"\naccess = "read"\nperm = "allow"');
        expect(text).not.toContain('path = "/home/tester"\naccess = "read"\nperm = "allow"');
        // 静态 /selinux 前缀规则不应出现（SELinux 探测是 access/stat，native 已豁免）
        expect(text).not.toContain('path = "/selinux/**"\naccess = "read"\nperm = "allow"');
    });

    test('solo/unlimited（用户含全盘 read allow）：读/写兜底均为 allow（同长平局 ask 会架空全放行语义）', () => {
        const soloRules = [
            { resourceType: 'file', action: 'write', pathPattern: '**', effect: 'allow' },
            { resourceType: 'file', action: 'read', pathPattern: '**', effect: 'allow' },
            { resourceType: 'file', action: 'execute', pathPattern: '**', effect: 'allow' }
        ] as any[];
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work', soloRules);
        // 读/写兜底 allow（不是 ask）
        expect(text).toContain('path = "/**"\naccess = "read"\nperm = "allow"');
        expect(text).not.toContain('path = "/**"\naccess = "read"\nperm = "ask"');
        expect(text).toContain('path = "/**"\naccess = "write"\nperm = "allow"');
        expect(text).not.toContain('path = "/**"\naccess = "write"\nperm = "ask"');
    });
    test('家目录敏感路径读 deny（默认读放行兜底下的收窄）', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work', undefined, '/home/tester');
        expect(text).toContain('path = "/home/tester/.ssh/**"\naccess = "read"\nperm = "deny"');
        expect(text).toContain('path = "/home/tester/.aws/**"\naccess = "read"\nperm = "deny"');
        expect(text).toContain('path = "/home/tester/.gnupg/**"\naccess = "read"\nperm = "deny"');
    });
    test('/dev 终端与黑洞设备读写放行（对齐 core tty_dev/null 内建语义：重定向与终端 IO 不弹窗）', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work');
        for (const p of ['/dev/null', '/dev/tty', '/dev/console', '/dev/ptmx']) {
            expect(text).toContain(`path = "${p}"\naccess = "write"\nperm = "allow"`);
            expect(text).toContain(`path = "${p}"\naccess = "read"\nperm = "allow"`);
        }
        expect(text).toContain('path = "/dev/pts/**"\naccess = "write"\nperm = "allow"');
    });
    test('readonly：/dev/null 与 /dev/tty 写仍放行（黑洞重定向与终端 IO 非持久化写入）', () => {
        const rules = [
            { resourceType: 'file', action: 'read', pathPattern: '/home/tester/work/**', effect: 'allow' },
            { resourceType: 'file', action: 'write', pathPattern: '**', effect: 'deny' }
        ] as any[];
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work', rules);
        expect(text).toContain('path = "/dev/null"\naccess = "write"\nperm = "allow"');
        expect(text).toContain('path = "/dev/tty"\naccess = "write"\nperm = "allow"');
    });
    test('PATH 工具链目录读放行（nvm/pyenv 等家目录工具链的打开读取；区别于已移除的 stat 补丁）', () => {
        // 注入固定 PATH：真实 PATH 随宿主/机器漂移（Windows 宿主为盘符路径，
        // 按 ':' 切分后没有 '/' 开头的段，断言必然失败）；桩值同时覆盖应放行
        // 的绝对段与应忽略的盘符段、空段。
        const originalPath = process.env.PATH;
        process.env.PATH = '/home/tester/.nvm/versions/node/v20/bin:/usr/local/bin::C:\\Windows\\System32';
        try {
            const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work');
            for (const dir of ['/home/tester/.nvm/versions/node/v20/bin', '/usr/local/bin']) {
                expect(text).toContain(`path = "${dir}"\naccess = "read"\nperm = "allow"`);
                expect(text).toContain(`path = "${dir}/**"\naccess = "read"\nperm = "allow"`);
            }
            // 盘符段（非 '/' 开头）与空段不导出
            expect(text).not.toContain('C:\\Windows\\System32');
        } finally {
            if (originalPath === undefined) {
                delete process.env.PATH;
            } else {
                process.env.PATH = originalPath;
            }
        }
    });
    test('工具链缓存目录（~/.cache/opendesk-sandbox）写入放行（与 linux-sandbox env 重定向一致）', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work', undefined, '/home/tester');
        expect(text).toContain('path = "/home/tester/.cache/opendesk-sandbox/**"\naccess = "write"\nperm = "allow"');
    });
    test('.gitconfig 写放行规则完整（回归：曾含字面 ... 且缺 access/perm 导致策略解析失败）', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work', undefined, '/home/tester');
        expect(text).toContain('path = "/home/tester/.gitconfig"\naccess = "write"\nperm = "allow"');
        expect(text).not.toContain('...');
        // 生成的策略不应出现"只有 path 无 access/perm"的残缺规则
        for (const line of text.split('\n').filter((l) => l.startsWith('path = '))) {
            const idx = text.indexOf(line);
            const block = text.slice(idx, idx + 200);
            expect(block).toMatch(/access = ".+"/);
            expect(block).toMatch(/perm = ".+"/);
        }
    });
    test('权限规则按真实路径导出、deny 优先、execute 不导出', () => {
        const rules = [
            { resourceType: 'file', action: 'read', pathPattern: '/home/tester/work/**', effect: 'allow' },
            { resourceType: 'file', action: 'write', pathPattern: '/home/tester/secret/**', effect: 'deny' },
            { resourceType: 'file', action: 'execute', pathPattern: '/home/tester/tools/**', effect: 'deny' }
        ] as any[];
        const lines = permissionRulesForSandboxLinux(rules).join('\n');
        const denyIndex = lines.indexOf('path = "/home/tester/secret/**"');
        const allowIndex = lines.indexOf('path = "/home/tester/work/**"');
        expect(denyIndex).toBeGreaterThanOrEqual(0);
        expect(allowIndex).toBeGreaterThan(denyIndex);
        expect(lines).not.toContain('"execute"');
    });
    test('兜底规则：读询问（standard 外读确认）、写询问、执行放行', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work');
        expect(text).toContain('path = "/**"\naccess = "read"\nperm = "ask"');
        expect(text).toContain('path = "/**"\naccess = "write"\nperm = "ask"');
        expect(text).toContain('path = "/**"\naccess = "execute"\nperm = "allow"');
    });
});
