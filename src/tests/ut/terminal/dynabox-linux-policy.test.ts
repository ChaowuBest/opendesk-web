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
    test('macOS 系统运行时读前缀（回归：npx 每次执行都弹 /System /Library /var/db/timezone 读 ask）', () => {
        // darwin 真实事故：npm/npx 执行时 LaunchServices 初始化读
        // /System/Library/Frameworks/.../LaunchServices.framework/Resources/Info.plist、
        // os_log 读 /Library/Preferences/Logging/com.apple.diagnosticd.filter.plist、
        // node ICU 初始化读 /var/db/timezone/icutz/icutz44l.dat——均落到外读 ask。
        // 根因有二：清单只有小写 /system（OHOS 布局），macOS 为大写 /System，大小写
        // 敏感匹配永不命中；/Library 仅含 CommandLineTools 子前缀、/var/db/timezone 缺失。
        // Linux/OHOS 无这些路径，规则闲置无害。
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work');
        for (const prefix of ['/System', '/Library', '/var/db/timezone']) {
            expect(text).toContain(`path = "${prefix}/**"\naccess = "read"\nperm = "allow"`);
            expect(text).toContain(`path = "${prefix}"\naccess = "read"\nperm = "allow"`);
        }
    });
    test('OpenHarmony /data/app 应用数据根读放行（回归：鸿蒙 PC 工具链弹 ask；OS 层隔离兜底）', () => {
        // 鸿蒙真实事故：npm install 读 npm/python 工具链自身代码（/data/app/node.org/
        // node_v24.13.0/...、/data/app/python.org/...）逐次弹 ask。工具链以独立
        // bundle 装在 /data/app 下，故放行整棵应用数据根 read——不再随工具链迁移
        // 逐个枚举。
        // 安全依据（真机实测）：OpenDesk 是 normal_hap 域普通应用（uid 20020178、
        // CapEff=0x2a 无特权），dynobox 拦截层不越权 OS 的 DAC+SELinux；第三方
        // bundle 数据在内核层即被隔离（shell 实测 ls /data/app/el2/100/* 全部
        // Permission denied），策略放行只消除弹窗、不扩大真实可读面。
        // 边界：若未来 OpenDesk 脱离 normal_hap 域升为特权应用，应重新收紧该前缀。
        // 只放 read（工具链代码只读）；写（篡改任意应用数据）仍走兜底 ask/deny。
        // Linux/darwin 无 /data/app，规则不命中，无副作用。
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work');
        expect(text).toContain('path = "/data/app/**"\naccess = "read"\nperm = "allow"');
        expect(text).toContain('path = "/data/app"\naccess = "read"\nperm = "allow"');
        // 只读放行：不得出现对 /data/app 的 write allow（防篡改任意应用数据）
        expect(text).not.toContain('path = "/data/app/**"\naccess = "write"\nperm = "allow"');
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
    test('PATH 工具链安装根数据目录读放行（<prefix>/share、<prefix>/lib；鸿蒙 lycium bash locale 场景）', () => {
        // 回归：鸿蒙 PC 上 lycium 编译的 bash 装在 /home/lycium/lycium/usr/bash/arm64-v8a/，
        // 启动读 share/locale/locale.alias 等数据文件，只放行 bin/** 会逐次触发 read ask。
        const originalPath = process.env.PATH;
        process.env.PATH =
            '/home/lycium/lycium/usr/bash/arm64-v8a/bin:/usr/local/bin:/opt/homebrew/bin:/home/tester/tools';
        try {
            const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work');
            // bin 自身仍放行
            expect(text).toContain(
                'path = "/home/lycium/lycium/usr/bash/arm64-v8a/bin/**"\naccess = "read"\nperm = "allow"'
            );
            // 安装根数据目录追加放行：share（locale/terminfo/completion 等）
            expect(text).toContain(
                'path = "/home/lycium/lycium/usr/bash/arm64-v8a/share/**"\naccess = "read"\nperm = "allow"'
            );
            // 安装根数据目录追加放行：lib（loadable builtins/运行时库）
            expect(text).toContain(
                'path = "/home/lycium/lycium/usr/bash/arm64-v8a/lib/**"\naccess = "read"\nperm = "allow"'
            );
            // 已被系统前缀（/usr、/opt）覆盖的安装根不重复导出（/usr/local、/opt/homebrew）
            expect(text).not.toContain('path = "/usr/local/share/**"');
            expect(text).not.toContain('path = "/opt/homebrew/share/**"');
            // 非 bin/sbin 命名的 PATH 目录视为自身即安装根，其 share 也放行
            expect(text).toContain('path = "/home/tester/tools/share/**"\naccess = "read"\nperm = "allow"');
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
    test('Python 字节码缓存目录（__pycache__）写放行（对齐 Windows /C/**/__pycache__/**）', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work');
        expect(text).toContain('path = "/**/__pycache__/**"\naccess = "write"\nperm = "allow"');
        // 放行规则须早于兜底 write ask 命中（first-match 语义）
        expect(text.indexOf('/**/__pycache__/**')).toBeLessThan(
            text.indexOf('path = "/**"\naccess = "write"\nperm = "ask"')
        );
    });
    test('readonly 模式不导出 __pycache__ 写放行（全盘 write deny 下 deny 无害，不架空写保护）', () => {
        const rules = [
            { resourceType: 'file', action: 'read', pathPattern: '/home/tester/work/**', effect: 'allow' },
            { resourceType: 'file', action: 'write', pathPattern: '**', effect: 'deny' }
        ] as any[];
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work', rules);
        expect(text).not.toContain('path = "/**/__pycache__/**"\naccess = "write"\nperm = "allow"');
    });
    test('darwin exec 重签缓存（~/Library/Caches/com.opendesk.sandbox）读写放行', () => {
        // 回归：darwin 沙箱内 exec 平台二进制时 dylib 复制+ad-hoc 重签到该目录，
        // dyld 随后加载副本本体与 Info.plist；策略无规则时命中 /** read ask，
        // standard 下 grep|head 这类平台二进制链每次 exec 都弹"奇怪的 cache 读"审批。
        // 读写都放行：该目录是 OpenDesk 框架自身的 exec 重签缓存（SHA-256 内容寻址，
        // 命名与源二进制强绑定），沙箱内篡改副本只会让自身 exec 的重签链路失效，
        // 不影响宿主（宿主启动 shell 用 TS 侧 prepareShellForSandbox 独立重签）。
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work', undefined, '/Users/tester');
        expect(text).toContain(
            'path = "/Users/tester/Library/Caches/com.opendesk.sandbox/**"\naccess = "read"\nperm = "allow"'
        );
        expect(text).toContain(
            'path = "/Users/tester/Library/Caches/com.opendesk.sandbox/**"\naccess = "write"\nperm = "allow"'
        );
    });
    test('darwin 工具链缓存整树（~/Library/Caches/**）读写放行（node-gyp/electron/pip 等）', () => {
        // 回归：npm install 编译原生模块（node-screenshots 等）时 node-gyp 读写
        // ~/Library/Caches/node-gyp/26.3.0/installVersion、python 运行时等工具链
        // 缓存路径；策略无规则时命中 /** read/write ask，standard 下每次编译都弹窗。
        // ~/Library/Caches 是 macOS 可再生缓存目录（系统随时可清理、不含凭据），
        // 与 exec 重签缓存（com.opendesk.sandbox）同哲学，整树读写放行免去逐次 ask。
        // Linux/OHOS 家目录无此路径，规则不命中，无副作用。
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work', undefined, '/Users/tester');
        expect(text).toContain('path = "/Users/tester/Library/Caches/**"\naccess = "read"\nperm = "allow"');
        expect(text).toContain('path = "/Users/tester/Library/Caches/**"\naccess = "write"\nperm = "allow"');
        // 回收站不在缓存树内，写保护不受影响
        expect(text).not.toContain('"/Users/tester/.Trash/**"');
    });
    test('readonly 模式下 exec 重签缓存读仍放行（全盘 read deny 会令平台二进制 exec 起不来）', () => {
        // 重签副本是系统二进制的运行时替身（等效 /usr/bin 读需求）：副本读被
        // deny 时 dyld 加载失败，readonly 下连基础命令都无法执行
        const rules = [
            { resourceType: 'file', action: 'read', pathPattern: '/home/tester/work/**', effect: 'allow' },
            { resourceType: 'file', action: 'write', pathPattern: '**', effect: 'deny' }
        ] as any[];
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work', rules, '/Users/tester');
        expect(text).toContain(
            'path = "/Users/tester/Library/Caches/com.opendesk.sandbox/**"\naccess = "read"\nperm = "allow"'
        );
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
    test('根目录 "/" 目录项读放行（node/OpenSSL 启动早期 open("/") 不触发 ask 挂起）', () => {
        // 回归：darwin 沙箱内 npm install 时 node 启动早期 OpenSSL 初始化会
        // open("/")（与 openssl.cnf 配置加载同批次），standard 模式兜底 read ask
        // 挂起 300s 后 fail-closed deny，node 的 V8 tracing 初始化随之崩溃。
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work');
        // 只放行根目录本身（path="/" 不展开子路径）
        expect(text).toContain('path = "/"\naccess = "read"\nperm = "allow"');
        // 兜底 ask 仍在（子路径外读照常询问）
        expect(text).toContain('path = "/**"\naccess = "read"\nperm = "ask"');
    });
    test('兜底规则：读询问（standard 外读确认）、写询问、执行放行', () => {
        const text = policyTextLinux('http://127.0.0.1:1/decide', 't', '/home/tester/work');
        expect(text).toContain('path = "/**"\naccess = "read"\nperm = "ask"');
        expect(text).toContain('path = "/**"\naccess = "write"\nperm = "ask"');
        expect(text).toContain('path = "/**"\naccess = "execute"\nperm = "allow"');
    });
});
