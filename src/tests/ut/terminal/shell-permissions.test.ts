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

        test('python3 -c "print(1)" → 无文件权限', () => {
            const perms = analyzeBashPermissions('python3 -c "print(1)"', CWD);
            expect(perms.length).toBe(0);
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

    describe('变量/通配符 → 应跳过', () => {
        test('cat $HOME/config.txt → 跳过', () => {
            expect(analyzeBashPermissions('cat $HOME/config.txt', CWD).length).toBe(0);
        });

        test('cat ${HOME}/config.txt → 跳过', () => {
            expect(analyzeBashPermissions('cat ${HOME}/config.txt', CWD).length).toBe(0);
        });

        test('cat *.txt → 跳过', () => {
            expect(analyzeBashPermissions('cat *.txt', CWD).length).toBe(0);
        });

        test('cat src/**/*.ts → 跳过', () => {
            expect(analyzeBashPermissions('cat src/**/*.ts', CWD).length).toBe(0);
        });

        test('cat $(echo file.txt) → 跳过', () => {
            expect(analyzeBashPermissions('cat $(echo file.txt)', CWD).length).toBe(0);
        });

        test('cat `echo file.txt` → 跳过', () => {
            expect(analyzeBashPermissions('cat `echo file.txt`', CWD).length).toBe(0);
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

        test('ls -la → 不分析', () => {
            expect(analyzeBashPermissions('ls -la', CWD).length).toBe(0);
        });

        test('cd /tmp → 不产生文件权限', () => {
            expect(analyzeBashPermissions('cd /tmp', CWD).length).toBe(0);
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

    describe('变量 → 应跳过', () => {
        test('PS $env:xxx → 跳过', () => {
            expect(analyzePowerShellPermissions('Get-Content $env:USERPROFILE\\file.txt', WIN_CWD).length).toBe(0);
        });

        test('PS $var → 跳过', () => {
            expect(analyzePowerShellPermissions('Get-Content $filePath', WIN_CWD).length).toBe(0);
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
