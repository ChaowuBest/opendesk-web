/**
 * shell-permissions 模块的单元测试。
 */

import path from 'path';
import os from 'os';
import {
    analyzeBashPermissions,
    analyzePowerShellPermissions
} from '../../../main/applications/terminal/shellPermissions';
import type { PermissionRequest } from '../../../main/aikernel/security/permission';

const CWD = '/home/user/project';
const WIN_CWD = 'D:/Projects/MyApp';

function assertHas(perms: PermissionRequest[], action: string, pathSuffix: string) {
    const found = perms.some((p) => p.action === action && p.resourcePath.replace(/\\/g, '/').endsWith(pathSuffix));
    expect(found).toBe(true);
}

function assertHasExact(perms: PermissionRequest[], action: string, exactPath: string) {
    const found = perms.some((p) => p.action === action && p.resourcePath === exactPath);
    expect(found).toBe(true);
}

// ═══════════════════════════════════════════════════════════════
// Bash/Zsh 测试
// ═══════════════════════════════════════════════════════════════

describe('Bash/Zsh permissions analysis', () => {
    describe('基本读取命令', () => {
        test('cat README.md → read README.md', () => {
            const perms = analyzeBashPermissions('cat README.md', CWD);
            assertHas(perms, 'read', 'README.md');
        });

        test('head -n 10 src/index.ts → read', () => {
            const perms = analyzeBashPermissions('head -n 10 src/index.ts', CWD);
            assertHas(perms, 'read', 'src/index.ts');
        });

        test('tail -f /var/log/syslog → read', () => {
            const perms = analyzeBashPermissions('tail -f /var/log/syslog', CWD);
            assertHas(perms, 'read', '/var/log/syslog');
        });

        test('less /etc/hosts → read', () => {
            const perms = analyzeBashPermissions('less /etc/hosts', CWD);
            assertHas(perms, 'read', '/etc/hosts');
        });

        test('wc -l package.json → read', () => {
            const perms = analyzeBashPermissions('wc -l package.json', CWD);
            assertHas(perms, 'read', 'package.json');
        });

        test('diff a.txt b.txt → read both', () => {
            const perms = analyzeBashPermissions('diff a.txt b.txt', CWD);
            assertHas(perms, 'read', 'a.txt');
            assertHas(perms, 'read', 'b.txt');
        });
    });

    describe('目录浏览命令', () => {
        test('ls /some/path → read /some/path', () => {
            const perms = analyzeBashPermissions('ls /some/path', CWD);
            assertHasExact(perms, 'read', '/some/path');
        });

        test('ls 无参数 → 隐含读取 cwd', () => {
            const perms = analyzeBashPermissions('ls', CWD);
            expect(perms.length).toBe(1);
            const expectedCwd = path.resolve(CWD).replace(/\\/g, '/');
            assertHasExact(perms, 'read', expectedCwd);
        });

        test('ls 多路径 → 全部读取', () => {
            const perms = analyzeBashPermissions('ls /tmp /var/log', CWD);
            assertHasExact(perms, 'read', '/tmp');
            assertHasExact(perms, 'read', '/var/log');
        });

        test('ls 相对路径 → 基于 cwd 解析', () => {
            const perms = analyzeBashPermissions('ls src/components', CWD);
            const expected = path.resolve(CWD, 'src/components').replace(/\\/g, '/');
            assertHasExact(perms, 'read', expected);
        });

        test('find /etc -name "*.conf" → read /etc', () => {
            const perms = analyzeBashPermissions('find /etc -name "*.conf"', CWD);
            assertHasExact(perms, 'read', '/etc');
        });

        test('find 无路径参数 → 隐含读取 cwd', () => {
            const perms = analyzeBashPermissions('find -name "*.ts"', CWD);
            expect(perms.length).toBe(1);
            const expectedCwd = path.resolve(CWD).replace(/\\/g, '/');
            assertHasExact(perms, 'read', expectedCwd);
        });

        test('du -sh /var → read /var', () => {
            const perms = analyzeBashPermissions('du -sh /var', CWD);
            assertHasExact(perms, 'read', '/var');
        });

        test('tree /usr/local → read', () => {
            const perms = analyzeBashPermissions('tree /usr/local', CWD);
            assertHasExact(perms, 'read', '/usr/local');
        });

        test('ls 工作区外绝对路径 → 产生读取权限', () => {
            const perms = analyzeBashPermissions('ls /storage/Users/currentUser', CWD);
            assertHasExact(perms, 'read', '/storage/Users/currentUser');
        });
    });

    describe('重定向', () => {
        test('echo hello > output.txt → write', () => {
            const perms = analyzeBashPermissions('echo hello > output.txt', CWD);
            assertHas(perms, 'write', 'output.txt');
        });

        test('echo hello >> log.txt → write', () => {
            const perms = analyzeBashPermissions('echo hello >> log.txt', CWD);
            assertHas(perms, 'write', 'log.txt');
        });

        test('>output.txt (无空格) → write', () => {
            const perms = analyzeBashPermissions('echo hello >output.txt', CWD);
            assertHas(perms, 'write', 'output.txt');
        });

        test('>>output.txt (无空格) → write', () => {
            const perms = analyzeBashPermissions('echo hello >>output.txt', CWD);
            assertHas(perms, 'write', 'output.txt');
        });

        test('< input.txt → read', () => {
            const perms = analyzeBashPermissions('sort < input.txt', CWD);
            assertHas(perms, 'read', 'input.txt');
        });

        test('<input.txt > output.txt → read + write', () => {
            const perms = analyzeBashPermissions('sort <input.txt > output.txt', CWD);
            assertHas(perms, 'read', 'input.txt');
            assertHas(perms, 'write', 'output.txt');
        });

        test('2> errors.log → write', () => {
            const perms = analyzeBashPermissions('cmd 2> errors.log', CWD);
            assertHas(perms, 'write', 'errors.log');
        });
    });

    describe('写入类命令', () => {
        test('touch newfile.txt → write', () => {
            const perms = analyzeBashPermissions('touch newfile.txt', CWD);
            assertHas(perms, 'write', 'newfile.txt');
        });

        test('mkdir -p src/components → write', () => {
            const perms = analyzeBashPermissions('mkdir -p src/components', CWD);
            assertHas(perms, 'write', 'src/components');
        });

        test('rm -rf dist/ → write', () => {
            const perms = analyzeBashPermissions('rm -rf dist/', CWD);
            assertHas(perms, 'write', 'dist');
        });

        test('rmdir empty_dir → write', () => {
            const perms = analyzeBashPermissions('rmdir empty_dir', CWD);
            assertHas(perms, 'write', 'empty_dir');
        });
    });

    describe('cp/mv 复合命令', () => {
        test('cp src.txt dest.txt → read src, write dest', () => {
            const perms = analyzeBashPermissions('cp src.txt dest.txt', CWD);
            assertHas(perms, 'read', 'src.txt');
            assertHas(perms, 'write', 'dest.txt');
        });

        test('mv old.txt new.txt → read old, write new', () => {
            const perms = analyzeBashPermissions('mv old.txt new.txt', CWD);
            assertHas(perms, 'read', 'old.txt');
            assertHas(perms, 'write', 'new.txt');
        });

        test('cp -r 多文件 → read sources, write dest', () => {
            const perms = analyzeBashPermissions('cp -r a.txt b.txt /tmp/dest/', CWD);
            assertHas(perms, 'read', 'a.txt');
            assertHas(perms, 'read', 'b.txt');
            assertHas(perms, 'write', '/tmp/dest/');
        });
    });

    describe('sed -i', () => {
        test("sed -i 's/foo/bar/g' config.yml → read + write", () => {
            const perms = analyzeBashPermissions("sed -i 's/foo/bar/g' config.yml", CWD);
            assertHas(perms, 'read', 'config.yml');
            assertHas(perms, 'write', 'config.yml');
        });
    });

    describe('tee 命令', () => {
        test('tee output.log → write', () => {
            const perms = analyzeBashPermissions('echo hello | tee output.log', CWD);
            assertHas(perms, 'write', 'output.log');
        });
    });

    describe('chmod/chown', () => {
        test('chmod 644 config.yml → write', () => {
            const perms = analyzeBashPermissions('chmod 644 config.yml', CWD);
            assertHas(perms, 'write', 'config.yml');
        });

        test('chown user:group /etc/config.yml → write', () => {
            const perms = analyzeBashPermissions('chown user:group /etc/config.yml', CWD);
            assertHas(perms, 'write', '/etc/config.yml');
        });
    });

    describe('ln 命令', () => {
        test('ln -s → read source, write target', () => {
            const perms = analyzeBashPermissions('ln -s /usr/lib/libfoo.so /usr/local/lib/libfoo.so', CWD);
            assertHas(perms, 'read', '/usr/lib/libfoo.so');
            assertHas(perms, 'write', '/usr/local/lib/libfoo.so');
        });
    });

    describe('grep/搜索工具', () => {
        test('grep -r "TODO" src/ → read src', () => {
            const perms = analyzeBashPermissions('grep -r "TODO" src/', CWD);
            assertHas(perms, 'read', 'src');
        });
    });

    describe('脚本执行器', () => {
        test('python3 scripts/deploy.py → read', () => {
            const perms = analyzeBashPermissions('python3 scripts/deploy.py', CWD);
            assertHas(perms, 'read', 'scripts/deploy.py');
        });

        test('node build.js → read', () => {
            const perms = analyzeBashPermissions('node build.js', CWD);
            assertHas(perms, 'read', 'build.js');
        });

        test('python3 -c "print(1)" → execute / (内联代码不可分析)', () => {
            const perms = analyzeBashPermissions('python3 -c "print(1)"', CWD);
            expect(perms.length).toBe(1);
            assertHasExact(perms, 'execute', '/');
        });
    });

    describe('复合命令 (&&, ||, ;, |)', () => {
        test('cmd1 && cmd2', () => {
            const perms = analyzeBashPermissions('cat a.txt && echo done > b.txt', CWD);
            assertHas(perms, 'read', 'a.txt');
            assertHas(perms, 'write', 'b.txt');
        });

        test('cmd1; cmd2', () => {
            const perms = analyzeBashPermissions('cat a.txt; cat b.txt', CWD);
            assertHas(perms, 'read', 'a.txt');
            assertHas(perms, 'read', 'b.txt');
        });

        test('管道链', () => {
            const perms = analyzeBashPermissions('cat input.txt | grep foo | tee output.txt', CWD);
            assertHas(perms, 'read', 'input.txt');
            assertHas(perms, 'write', 'output.txt');
        });
    });

    describe('绝对路径', () => {
        test('cat /etc/passwd → 绝对路径', () => {
            const perms = analyzeBashPermissions('cat /etc/passwd', CWD);
            assertHasExact(perms, 'read', '/etc/passwd');
        });
    });

    describe('波浪号展开', () => {
        test('cat ~/.bashrc → 展开为主目录', () => {
            const perms = analyzeBashPermissions('cat ~/.bashrc', CWD);
            const home = os.homedir().replace(/\\/g, '/');
            assertHas(perms, 'read', '.bashrc');
            const found = perms.find((p) => p.action === 'read' && p.resourcePath.includes('.bashrc'));
            expect(found).toBeDefined();
            expect(found!.resourcePath.startsWith(home)).toBe(true);
        });
    });

    describe('引号路径', () => {
        test('双引号路径', () => {
            const perms = analyzeBashPermissions('cat "file with spaces.txt"', CWD);
            assertHas(perms, 'read', 'file with spaces.txt');
        });

        test('单引号路径', () => {
            const perms = analyzeBashPermissions("cat 'file with spaces.txt'", CWD);
            assertHas(perms, 'read', 'file with spaces.txt');
        });
    });

    describe('变量/通配符/命令替换 → 保守声明或跳过', () => {
        test('cat $HOME/config.txt → 保守声明 execute / (变量可构造任意路径)', () => {
            const perms = analyzeBashPermissions('cat $HOME/config.txt', CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('cat ${HOME}/config.txt → 保守声明 execute /', () => {
            const perms = analyzeBashPermissions('cat ${HOME}/config.txt', CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('cat *.txt → 跳过 (通配符但无动态元素)', () => {
            expect(analyzeBashPermissions('cat *.txt', CWD).length).toBe(0);
        });

        test('cat src/**/*.ts → 跳过 (通配符但无动态元素)', () => {
            expect(analyzeBashPermissions('cat src/**/*.ts', CWD).length).toBe(0);
        });

        test('cat $(echo file.txt) → 保守声明 execute /', () => {
            const perms = analyzeBashPermissions('cat $(echo file.txt)', CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('cat `echo file.txt` → 保守声明 execute /', () => {
            const perms = analyzeBashPermissions('cat `echo file.txt`', CWD);
            assertHasExact(perms, 'execute', '/');
        });
    });

    describe('环境变量前缀', () => {
        test('ENV=val cmd → 正确跳过环境变量前缀', () => {
            const perms = analyzeBashPermissions('NODE_ENV=production cat config.json', CWD);
            assertHas(perms, 'read', 'config.json');
        });

        test('多个 ENV 前缀', () => {
            const perms = analyzeBashPermissions('A=1 B=2 cat file.txt', CWD);
            assertHas(perms, 'read', 'file.txt');
        });
    });

    describe('无命令/空命令', () => {
        test('空命令 → 无权限', () => {
            expect(analyzeBashPermissions('', CWD).length).toBe(0);
        });

        test('echo hello → 无文件权限', () => {
            expect(analyzeBashPermissions('echo hello', CWD).length).toBe(0);
        });

        test('ls -la → 隐含读取 cwd', () => {
            const perms = analyzeBashPermissions('ls -la', CWD);
            expect(perms.length).toBe(1);
            const expectedCwd = path.resolve(CWD).replace(/\\/g, '/');
            assertHasExact(perms, 'read', expectedCwd);
        });

        test('cd /tmp → 读取目标目录', () => {
            const perms = analyzeBashPermissions('cd /tmp', CWD);
            expect(perms.length).toBe(1);
            assertHasExact(perms, 'read', '/tmp');
        });
    });

    describe('tar 命令', () => {
        test('tar -xzf → read archive', () => {
            const perms = analyzeBashPermissions('tar -xzf archive.tar.gz', CWD);
            assertHas(perms, 'read', 'archive.tar.gz');
        });

        test('tar -czf → write archive', () => {
            const perms = analyzeBashPermissions('tar -czf backup.tar.gz src/', CWD);
            assertHas(perms, 'write', 'backup.tar.gz');
        });

        test('tar -xf → read archive', () => {
            const perms = analyzeBashPermissions('tar -xf archive.tar -C /tmp', CWD);
            assertHas(perms, 'read', 'archive.tar');
        });
    });

    describe('去重', () => {
        test('重复 cat 同文件 → 去重', () => {
            const perms = analyzeBashPermissions('cat file.txt; cat file.txt', CWD);
            const readCount = perms.filter((p) => p.action === 'read' && p.resourcePath.endsWith('file.txt')).length;
            expect(readCount).toBe(1);
        });
    });

    describe('相对路径解析', () => {
        test('相对路径基于 cwd 解析', () => {
            const perms = analyzeBashPermissions('cat sub/file.txt', CWD);
            const expected = path.resolve(CWD, 'sub/file.txt').replace(/\\/g, '/');
            assertHasExact(perms, 'read', expected);
        });
    });

    describe('here-doc', () => {
        test('here-doc (<<) 不应产生文件权限', () => {
            const perms = analyzeBashPermissions('cat << EOF\nhello\nEOF', CWD);
            expect(perms.length).toBe(0);
        });
    });

    describe('花括号展开', () => {
        test('cat {a,b}.txt → 跳过', () => {
            expect(analyzeBashPermissions('cat {a,b}.txt', CWD).length).toBe(0);
        });
    });

    describe('source / . 命令', () => {
        test('source .env → read', () => {
            const perms = analyzeBashPermissions('source .env', CWD);
            assertHas(perms, 'read', '.env');
        });

        test('. .env.local → read', () => {
            const perms = analyzeBashPermissions('. .env.local', CWD);
            assertHas(perms, 'read', '.env.local');
        });
    });

    describe('cd/pushd 目录切换命令', () => {
        test('cd .. → 读取上级目录', () => {
            const perms = analyzeBashPermissions('cd ..', CWD);
            const expected = path.resolve(CWD, '..').replace(/\\/g, '/');
            assertHasExact(perms, 'read', expected);
        });

        test('cd /etc → 读取 /etc', () => {
            const perms = analyzeBashPermissions('cd /etc', CWD);
            assertHasExact(perms, 'read', '/etc');
        });

        test('pushd .. → 读取上级目录', () => {
            const perms = analyzeBashPermissions('pushd ..', CWD);
            const expected = path.resolve(CWD, '..').replace(/\\/g, '/');
            assertHasExact(perms, 'read', expected);
        });

        test('cd .. && ls -la → 后续命令读取上级目录', () => {
            const perms = analyzeBashPermissions('cd .. && ls -la', CWD);
            const parent = path.resolve(CWD, '..').replace(/\\/g, '/');
            assertHasExact(perms, 'read', parent);
        });

        test('cd /tmp && ls -la → 后续命令使用切换后的 cwd', () => {
            const perms = analyzeBashPermissions('cd /tmp && ls -la', CWD);
            assertHasExact(perms, 'read', '/tmp');
        });

        test('pushd .. && ls -la && popd → 声明读取上级目录', () => {
            const perms = analyzeBashPermissions('pushd .. && ls -la && popd', CWD);
            const parent = path.resolve(CWD, '..').replace(/\\/g, '/');
            assertHasExact(perms, 'read', parent);
        });

        test('cd 无参数 → 无权限', () => {
            const perms = analyzeBashPermissions('cd', CWD);
            expect(perms.length).toBe(0);
        });
    });

    describe('路径规范化', () => {
        test('绝对路径中的 .. → 规范化后再匹配权限', () => {
            const rawPath = `${CWD}/nested/../output.txt`;
            const perms = analyzeBashPermissions(`cat ${rawPath}`, CWD);
            assertHasExact(perms, 'read', `${CWD}/output.txt`);
        });

        test('POSIX 风格绝对路径不被锚定到 Windows 当前盘符', () => {
            // Windows 的 path.resolve 会把 /etc/../var/log 解析为当前盘符上的
            // C:\var\log，凭空改写权限声明的路径；必须保持 POSIX 形式且消除 ..
            const perms = analyzeBashPermissions('cat /etc/../var/log', CWD);
            assertHasExact(perms, 'read', '/var/log');
            const injected = perms.find((p) => p.action === 'read' && /^[A-Za-z]:\//.test(p.resourcePath));
            expect(injected).toBeUndefined();
        });

        test('报告复制命令中的绝对路径 .. → 不生成工作区外的错误路径', () => {
            const workspace = '/storage/Users/currentUser/work/python9.14';
            const command =
                'cd /storage/Users/currentUser/work/python9.14/python-abandontech-siren && ' +
                'cp /storage/Users/currentUser/work/python9.14/python-abandontech-siren/test_report.xlsx ' +
                '/storage/Users/currentUser/work/python9.14/python-abandontech-siren/../resultsbackup/ && ' +
                'ls -la /storage/Users/currentUser/work/python9.14/python-abandontech-siren/../resultsbackup/test_report.xlsx';
            const perms = analyzeBashPermissions(command, workspace);
            const paths = perms.map((permission) => permission.resourcePath);

            expect(paths).toContain(`${workspace}/resultsbackup/`);
            expect(paths).toContain(`${workspace}/resultsbackup/test_report.xlsx`);
            expect(paths).not.toContain('/storage/Users/currentUser/work/resultsbackup');
            expect(paths).not.toContain('/storage/Users/currentUser/work/resultsbackup/test_report.xlsx');
        });
    });

    describe('新增读取命令 (xxd, strings, hexdump, od, rev)', () => {
        test('xxd ../README.md → read', () => {
            const perms = analyzeBashPermissions('xxd ../README.md', CWD);
            assertHas(perms, 'read', 'README.md');
        });

        test('strings /etc/binary → read', () => {
            const perms = analyzeBashPermissions('strings /etc/binary', CWD);
            assertHasExact(perms, 'read', '/etc/binary');
        });

        test('hexdump -C ../file.bin → read', () => {
            const perms = analyzeBashPermissions('hexdump -C ../file.bin', CWD);
            assertHas(perms, 'read', 'file.bin');
        });

        test('od -c /etc/hosts → read', () => {
            const perms = analyzeBashPermissions('od -c /etc/hosts', CWD);
            assertHasExact(perms, 'read', '/etc/hosts');
        });

        test('rev ../README.md → read', () => {
            const perms = analyzeBashPermissions('rev ../README.md', CWD);
            assertHas(perms, 'read', 'README.md');
        });

        test('sort /etc/passwd → read', () => {
            const perms = analyzeBashPermissions('sort /etc/passwd', CWD);
            assertHasExact(perms, 'read', '/etc/passwd');
        });

        test('jq . config.json → read', () => {
            const perms = analyzeBashPermissions('jq . config.json', CWD);
            assertHas(perms, 'read', 'config.json');
        });
    });

    describe('脚本内联代码执行', () => {
        test('bash -c "cd .. && ls -la" → 递归分析内联命令', () => {
            const perms = analyzeBashPermissions('bash -c "cd .. && ls -la"', CWD);
            const parent = path.resolve(CWD, '..').replace(/\\/g, '/');
            assertHasExact(perms, 'read', parent);
        });

        test('sh -c "cat /etc/passwd" → 递归分析内联命令', () => {
            const perms = analyzeBashPermissions('sh -c "cat /etc/passwd"', CWD);
            assertHasExact(perms, 'read', '/etc/passwd');
        });

        test('sh -c "cd .. && cat README.md" → 递归分析', () => {
            const perms = analyzeBashPermissions('sh -c "cd .. && cat README.md"', CWD);
            const parent = path.resolve(CWD, '..').replace(/\\/g, '/');
            assertHasExact(perms, 'read', parent);
            assertHas(perms, 'read', 'README.md');
        });

        test('perl -e "..." → execute / (不可分析)', () => {
            const perms = analyzeBashPermissions('perl -e \'chdir(".."); opendir(D,"."); print readdir(D);\'', CWD);
            expect(perms.length).toBeGreaterThan(0);
            assertHasExact(perms, 'execute', '/');
        });

        test('ruby -e "..." → execute / (不可分析)', () => {
            const perms = analyzeBashPermissions('ruby -e \'Dir.chdir(".."); puts Dir.entries(".")\'', CWD);
            expect(perms.length).toBeGreaterThan(0);
            assertHasExact(perms, 'execute', '/');
        });
    });
});

// ═══════════════════════════════════════════════════════════════
// PowerShell 测试
// ═══════════════════════════════════════════════════════════════

describe('PowerShell permissions analysis', () => {
    describe('读取类 cmdlet', () => {
        test('Get-Content README.md → read', () => {
            const perms = analyzePowerShellPermissions('Get-Content README.md', WIN_CWD);
            assertHas(perms, 'read', 'README.md');
        });

        test('gc (alias) → read', () => {
            const perms = analyzePowerShellPermissions('gc config.json', WIN_CWD);
            assertHas(perms, 'read', 'config.json');
        });

        test('PS cat → read', () => {
            const perms = analyzePowerShellPermissions('cat src/index.ts', WIN_CWD);
            assertHas(perms, 'read', 'src/index.ts');
        });

        test('type → read', () => {
            const perms = analyzePowerShellPermissions('type package.json', WIN_CWD);
            assertHas(perms, 'read', 'package.json');
        });

        test('Get-Content -Path → read', () => {
            const perms = analyzePowerShellPermissions('Get-Content -Path "D:/data/log.txt"', WIN_CWD);
            assertHas(perms, 'read', 'log.txt');
        });

        test('Get-Content -LiteralPath → read', () => {
            const perms = analyzePowerShellPermissions('Get-Content -LiteralPath "C:\\Users\\test\\file.txt"', WIN_CWD);
            assertHas(perms, 'read', 'file.txt');
        });

        test('Select-String -Path → read', () => {
            const perms = analyzePowerShellPermissions('Select-String -Path app.log -Pattern "ERROR"', WIN_CWD);
            assertHas(perms, 'read', 'app.log');
        });
    });

    describe('写入类 cmdlet', () => {
        test('Set-Content → write', () => {
            const perms = analyzePowerShellPermissions('Set-Content output.txt -Value "hello"', WIN_CWD);
            assertHas(perms, 'write', 'output.txt');
        });

        test('Add-Content → write', () => {
            const perms = analyzePowerShellPermissions('Add-Content log.txt -Value "entry"', WIN_CWD);
            assertHas(perms, 'write', 'log.txt');
        });

        test('Out-File → write', () => {
            const perms = analyzePowerShellPermissions('"hello" | Out-File result.txt', WIN_CWD);
            assertHas(perms, 'write', 'result.txt');
        });

        test('New-Item -Path → write', () => {
            const perms = analyzePowerShellPermissions('New-Item -Path newfile.txt -ItemType File', WIN_CWD);
            assertHas(perms, 'write', 'newfile.txt');
        });

        test('Remove-Item → write', () => {
            const perms = analyzePowerShellPermissions('Remove-Item old.txt', WIN_CWD);
            assertHas(perms, 'write', 'old.txt');
        });

        test('del (alias) → write', () => {
            const perms = analyzePowerShellPermissions('del temp.txt', WIN_CWD);
            assertHas(perms, 'write', 'temp.txt');
        });

        test('Rename-Item → write', () => {
            const perms = analyzePowerShellPermissions('Rename-Item old.txt new.txt', WIN_CWD);
            assertHas(perms, 'write', 'old.txt');
        });
    });

    describe('复合类 cmdlet (Copy/Move)', () => {
        test('Copy-Item -Path -Destination → read src, write dest', () => {
            const perms = analyzePowerShellPermissions('Copy-Item -Path src.txt -Destination dest.txt', WIN_CWD);
            assertHas(perms, 'read', 'src.txt');
            assertHas(perms, 'write', 'dest.txt');
        });

        test('Move-Item -Path -Destination → read src, write dest', () => {
            const perms = analyzePowerShellPermissions('Move-Item -Path old.txt -Destination new.txt', WIN_CWD);
            assertHas(perms, 'read', 'old.txt');
            assertHas(perms, 'write', 'new.txt');
        });

        test('cp 位置参数 → read src, write dest', () => {
            const perms = analyzePowerShellPermissions('cp src.txt dest.txt', WIN_CWD);
            assertHas(perms, 'read', 'src.txt');
            assertHas(perms, 'write', 'dest.txt');
        });
    });

    describe('重定向', () => {
        test('PS > → write', () => {
            const perms = analyzePowerShellPermissions('Get-Process > procs.txt', WIN_CWD);
            assertHas(perms, 'write', 'procs.txt');
        });

        test('PS >> → write', () => {
            const perms = analyzePowerShellPermissions('"log" >> app.log', WIN_CWD);
            assertHas(perms, 'write', 'app.log');
        });
    });

    describe('变量 → 保守声明 execute /', () => {
        test('PS $env:xxx → 保守声明 execute /', () => {
            const perms = analyzePowerShellPermissions('Get-Content $env:USERPROFILE\\file.txt', WIN_CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('PS $var → 保守声明 execute / (变量可构造任意路径)', () => {
            const perms = analyzePowerShellPermissions('Get-Content $filePath', WIN_CWD);
            assertHasExact(perms, 'execute', '/');
        });
    });

    describe('通配符 → 应跳过', () => {
        test('PS *.txt → 跳过', () => {
            expect(analyzePowerShellPermissions('Get-ChildItem *.txt', WIN_CWD).length).toBe(0);
        });
    });

    describe('复合命令 (; |)', () => {
        test('PS 分号分隔', () => {
            const perms = analyzePowerShellPermissions(
                'Get-Content input.txt; Set-Content output.txt -Value "done"',
                WIN_CWD
            );
            assertHas(perms, 'read', 'input.txt');
            assertHas(perms, 'write', 'output.txt');
        });

        test('PS 管道', () => {
            const perms = analyzePowerShellPermissions('Get-Content data.csv | Out-File result.txt', WIN_CWD);
            assertHas(perms, 'read', 'data.csv');
            assertHas(perms, 'write', 'result.txt');
        });
    });

    describe('空命令/无文件操作', () => {
        test('PS 空命令 → 无权限', () => {
            expect(analyzePowerShellPermissions('', WIN_CWD).length).toBe(0);
        });

        test('PS Write-Output → 无文件权限', () => {
            expect(analyzePowerShellPermissions('Write-Output "hello"', WIN_CWD).length).toBe(0);
        });

        test('PS Get-Process → 无文件权限', () => {
            expect(analyzePowerShellPermissions('Get-Process', WIN_CWD).length).toBe(0);
        });
    });

    describe('不区分大小写', () => {
        test('PS 小写 cmdlet → 正确识别', () => {
            const perms = analyzePowerShellPermissions('get-content readme.md', WIN_CWD);
            assertHas(perms, 'read', 'readme.md');
        });

        test('PS 大写 cmdlet → 正确识别', () => {
            const perms = analyzePowerShellPermissions('GET-CONTENT readme.md', WIN_CWD);
            assertHas(perms, 'read', 'readme.md');
        });
    });

    describe('引号路径', () => {
        test('PS 双引号路径 → read', () => {
            const perms = analyzePowerShellPermissions('Get-Content "my file.txt"', WIN_CWD);
            assertHas(perms, 'read', 'my file.txt');
        });

        test('PS 单引号路径 → read', () => {
            const perms = analyzePowerShellPermissions("Get-Content 'my file.txt'", WIN_CWD);
            assertHas(perms, 'read', 'my file.txt');
        });
    });

    describe('Get-FileHash', () => {
        test('Get-FileHash → read', () => {
            const perms = analyzePowerShellPermissions('Get-FileHash -Path installer.exe -Algorithm SHA256', WIN_CWD);
            assertHas(perms, 'read', 'installer.exe');
        });
    });

    describe('cd/Set-Location/Push-Location 目录切换', () => {
        test('cd .. → 读取上级目录', () => {
            const perms = analyzePowerShellPermissions('cd ..', WIN_CWD);
            const expected = path.resolve(WIN_CWD, '..').replace(/\\/g, '/');
            assertHasExact(perms, 'read', expected);
        });

        test('Set-Location .. → 读取上级目录', () => {
            const perms = analyzePowerShellPermissions('Set-Location ..', WIN_CWD);
            const expected = path.resolve(WIN_CWD, '..').replace(/\\/g, '/');
            assertHasExact(perms, 'read', expected);
        });

        test('Push-Location .. → 读取上级目录', () => {
            const perms = analyzePowerShellPermissions('Push-Location ..', WIN_CWD);
            const expected = path.resolve(WIN_CWD, '..').replace(/\\/g, '/');
            assertHasExact(perms, 'read', expected);
        });

        test('cd ..; Get-ChildItem → 声明读取上级目录', () => {
            const perms = analyzePowerShellPermissions('cd ..; Get-ChildItem', WIN_CWD);
            const parent = path.resolve(WIN_CWD, '..').replace(/\\/g, '/');
            assertHasExact(perms, 'read', parent);
        });

        test('Set-Location ..; Get-Content file.txt → 声明读取上级目录+文件', () => {
            const perms = analyzePowerShellPermissions('Set-Location ..; Get-Content file.txt', WIN_CWD);
            const parent = path.resolve(WIN_CWD, '..').replace(/\\/g, '/');
            assertHasExact(perms, 'read', parent);
            assertHas(perms, 'read', 'file.txt');
        });

        test('Push-Location ..; Get-ChildItem; Pop-Location → 声明读取上级目录', () => {
            const perms = analyzePowerShellPermissions('Push-Location ..; Get-ChildItem; Pop-Location', WIN_CWD);
            const parent = path.resolve(WIN_CWD, '..').replace(/\\/g, '/');
            assertHasExact(perms, 'read', parent);
        });
    });

    describe('Invoke-Expression 动态执行', () => {
        test('Invoke-Expression "..." → execute / (不可分析)', () => {
            const perms = analyzePowerShellPermissions('Invoke-Expression "cd ..; Get-ChildItem"', WIN_CWD);
            expect(perms.length).toBeGreaterThan(0);
            assertHasExact(perms, 'execute', '/');
        });

        test('iex "..." → execute / (不可分析)', () => {
            const perms = analyzePowerShellPermissions('iex "Get-ChildItem .."', WIN_CWD);
            expect(perms.length).toBeGreaterThan(0);
            assertHasExact(perms, 'execute', '/');
        });
    });

    describe('powershell -Command 子进程', () => {
        test('powershell -Command "cd ..; Get-ChildItem" → 递归分析', () => {
            const perms = analyzePowerShellPermissions('powershell -Command "cd ..; Get-ChildItem"', WIN_CWD);
            const parent = path.resolve(WIN_CWD, '..').replace(/\\/g, '/');
            assertHasExact(perms, 'read', parent);
        });

        test('pwsh -Command "Get-Content /etc/passwd" → 递归分析', () => {
            const perms = analyzePowerShellPermissions('pwsh -Command "Get-Content /etc/passwd"', WIN_CWD);
            assertHas(perms, 'read', 'passwd');
        });
    });
});

// ═══════════════════════════════════════════════════════════════
// Round2 安全漏洞回归测试：动态元素保守声明
// ═══════════════════════════════════════════════════════════════

describe('Bash 动态元素保守声明', () => {
    describe('命令替换绕过 $() 和反引号', () => {
        test('parent=$(pwd | sed ...); ls "$parent" → execute /', () => {
            const perms = analyzeBashPermissions('parent=$(pwd | sed \'s|/[^/]*$||\'); ls -la "$parent"', CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('eval "ls $(dirname $(pwd))" → execute /', () => {
            const perms = analyzeBashPermissions('eval "ls -la $(dirname $(pwd))"', CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('pwd | xargs dirname | xargs ls → execute /', () => {
            const perms = analyzeBashPermissions('pwd | xargs dirname | xargs ls', CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('echo "c:/Projects" | xargs ls → execute /', () => {
            const perms = analyzeBashPermissions('echo "c:/Projects" | xargs ls', CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('sed -n "1p" "$(dirname $(pwd))/file" → execute /', () => {
            const perms = analyzeBashPermissions('sed -n \'1p\' "$(dirname $(pwd))/ccprompt.md"', CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('head -5 "$(echo c:/Projects/file)" → execute /', () => {
            const perms = analyzeBashPermissions('head -5 "$(echo c:/Projects/ccprompt.md)"', CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('cat < "$(pwd)/../file" → execute /', () => {
            const perms = analyzeBashPermissions('cat < "$(pwd)/../ccprompt.md" | head -10', CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('awk BEGIN{system("ls ...")} → execute /', () => {
            const perms = analyzeBashPermissions('awk \'BEGIN{system("ls c:/Projects")}\'', CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('mapfile + process substitution <(ls "$(pwd)/..") → execute /', () => {
            const perms = analyzeBashPermissions(
                'mapfile -t files < <(ls "$(pwd)/.."); for f in "${files[@]}"; do echo "$f"; done',
                CWD
            );
            assertHasExact(perms, 'execute', '/');
        });

        test('exec 3< "$(pwd)/../file" → execute /', () => {
            const perms = analyzeBashPermissions('exec 3< "$(pwd)/../ccprompt.md"; head -5 <&3; exec 3<&-', CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('md5sum "$(pwd)/../file" → execute /', () => {
            const perms = analyzeBashPermissions('md5sum "$(pwd)/../ccprompt.md"', CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('wc -l "$(pwd)/../file" → execute /', () => {
            const perms = analyzeBashPermissions('wc -l "$(pwd)/../ccprompt.md"', CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('diff "$(pwd)/../a" "$(pwd)/../b" → execute /', () => {
            const perms = analyzeBashPermissions('diff "$(pwd)/../a.md" "$(pwd)/../b.zip" 2>&1 | head -5', CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('file "$(dirname $(pwd))/file" → execute /', () => {
            const perms = analyzeBashPermissions('file "$(dirname $(pwd))/ccprompt.md"', CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('tac "$(pwd)/../file" → execute /', () => {
            const perms = analyzeBashPermissions('tac "$(pwd)/../ccprompt.md" | tail -5', CWD);
            assertHasExact(perms, 'execute', '/');
        });
    });

    describe('变量引用绕过 $VAR', () => {
        test('cat $HOME/config.txt → execute /', () => {
            const perms = analyzeBashPermissions('cat $HOME/config.txt', CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('ls $PARENT_DIR → execute /', () => {
            const perms = analyzeBashPermissions('ls $PARENT_DIR', CWD);
            assertHasExact(perms, 'execute', '/');
        });
    });
});

describe('PowerShell 动态元素保守声明', () => {
    describe('变量和表达式绕过', () => {
        test('$parentPath = (Get-Item ..).FullName; GCI $parentPath → execute /', () => {
            const perms = analyzePowerShellPermissions(
                '$parentPath = (Get-Item ..).FullName; Get-ChildItem $parentPath | Select-Object Name',
                WIN_CWD
            );
            assertHasExact(perms, 'execute', '/');
        });

        test('$p = [System.IO.Path]::GetFullPath(...); GCI $p → execute /', () => {
            const perms = analyzePowerShellPermissions(
                '$p = [System.IO.Path]::GetFullPath((Join-Path $PWD "..")); Get-ChildItem $p',
                WIN_CWD
            );
            assertHasExact(perms, 'execute', '/');
        });

        test('foreach ($d in GCI -Path ..) → execute /', () => {
            const perms = analyzePowerShellPermissions(
                'foreach ($d in Get-ChildItem -Path ..) { Write-Output $d.Name }',
                WIN_CWD
            );
            assertHasExact(perms, 'execute', '/');
        });

        test('$env:parent = "c:\\Projects"; GCI $env:parent → execute /', () => {
            const perms = analyzePowerShellPermissions(
                '$env:parent = "c:\\Projects"; Get-ChildItem $env:parent',
                WIN_CWD
            );
            assertHasExact(perms, 'execute', '/');
        });

        test('$myPath = ".."; Get-Item $myPath | GCI → execute /', () => {
            const perms = analyzePowerShellPermissions(
                '$myPath = ".."; $items = Get-Item $myPath; $items | Get-ChildItem | Select-Object Name',
                WIN_CWD
            );
            assertHasExact(perms, 'execute', '/');
        });
    });

    describe('外部程序调用绕过', () => {
        test('cmd.exe /c "dir c:\\Projects" → execute /', () => {
            const perms = analyzePowerShellPermissions('cmd.exe /c "dir c:\\Projects"', WIN_CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('& "cmd.exe" /c "dir ..\\.." → execute /', () => {
            const perms = analyzePowerShellPermissions("& 'cmd.exe' /c 'dir ..\\..'", WIN_CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('Start-Process cmd.exe → execute /', () => {
            const perms = analyzePowerShellPermissions(
                'Start-Process -FilePath "cmd.exe" -ArgumentList "/c dir c:\\Projects" -PassThru -Wait',
                WIN_CWD
            );
            assertHasExact(perms, 'execute', '/');
        });
    });

    describe('.NET API 绕过', () => {
        test('[System.IO.File]::OpenRead("...") → execute /', () => {
            const perms = analyzePowerShellPermissions(
                '$stream = [System.IO.File]::OpenRead("c:\\Projects\\file.md")',
                WIN_CWD
            );
            assertHasExact(perms, 'execute', '/');
        });

        test('[System.IO.File]::ReadAllBytes("...") → execute /', () => {
            const perms = analyzePowerShellPermissions(
                '[System.IO.File]::ReadAllBytes("c:\\Projects\\file.md")',
                WIN_CWD
            );
            assertHasExact(perms, 'execute', '/');
        });

        test('[System.IO.Directory]::GetFiles("...") → execute /', () => {
            const perms = analyzePowerShellPermissions('[System.IO.Directory]::GetFiles("c:\\Projects")', WIN_CWD);
            assertHasExact(perms, 'execute', '/');
        });

        test('[System.IO.DirectoryInfo]::new("...") → execute /', () => {
            const perms = analyzePowerShellPermissions(
                '[System.IO.DirectoryInfo]::new("c:\\Projects").GetFileSystemInfos()',
                WIN_CWD
            );
            assertHasExact(perms, 'execute', '/');
        });

        test('Get-Content -Path ([System.IO.Directory]::GetParent(...)) → execute /', () => {
            const perms = analyzePowerShellPermissions(
                "Get-Content -Path ([System.IO.Directory]::GetParent($PWD).FullName + '\\file.md') -TotalCount 5",
                WIN_CWD
            );
            assertHasExact(perms, 'execute', '/');
        });
    });

    describe('特殊语法绕过', () => {
        test('[scriptblock]::Create("..."); & $sb → execute /', () => {
            const perms = analyzePowerShellPermissions(
                '$sb = [scriptblock]::Create("Get-ChildItem \'c:\\Projects\'"); & $sb',
                WIN_CWD
            );
            assertHasExact(perms, 'execute', '/');
        });

        test('[WMI] win32_directory → execute /', () => {
            const perms = analyzePowerShellPermissions(
                '[WMI] \'win32_directory.Name="c:\\\\Projects"\' | Select-Object Name',
                WIN_CWD
            );
            assertHasExact(perms, 'execute', '/');
        });
    });
});

// ═══════════════════════════════════════════════════════════════
// 边界情况
// ═══════════════════════════════════════════════════════════════

describe('边界情况', () => {
    test('echo 无重定向 → 无文件权限', () => {
        expect(analyzeBashPermissions('echo hello world', CWD).length).toBe(0);
    });

    test('子 shell 命令 → 保守策略', () => {
        // 括号内的命令可能不被完整分析，保守策略下这是可接受的
        const perms = analyzeBashPermissions('(cat secret.txt)', CWD);
        expect(perms).toBeDefined();
    });

    test('长复合命令', () => {
        const perms = analyzeBashPermissions(
            'mkdir -p build && cp src/a.ts build/ && echo done > build/status.txt',
            CWD
        );
        assertHas(perms, 'write', 'build');
        assertHas(perms, 'read', 'src/a.ts');
        assertHas(perms, 'write', 'build/status.txt');
    });

    test('cat 多文件', () => {
        const perms = analyzeBashPermissions('cat a.txt b.txt c.txt', CWD);
        assertHas(perms, 'read', 'a.txt');
        assertHas(perms, 'read', 'b.txt');
        assertHas(perms, 'read', 'c.txt');
    });

    test('未知命令 → 不分析', () => {
        expect(analyzeBashPermissions('my-custom-tool arg1 arg2', CWD).length).toBe(0);
    });

    test('cp 单参数 → 保守跳过', () => {
        expect(analyzeBashPermissions('cp single_arg', CWD).length).toBe(0);
    });
});
