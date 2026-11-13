import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildInteractiveTerminalProfiles,
    shellArguments
} from '../../../../main/applications/terminal/interactive/profiles.js';

test('interactive profiles exclude sandbox variants and add Windows command prompt', () => {
    const profiles = buildInteractiveTerminalProfiles(
        'win32',
        [
            {
                kind: 'powershell',
                path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
                sandboxed: false
            },
            { kind: 'powershell', path: 'C:\\sandbox\\powershell.exe', sandboxed: true },
            { kind: 'bash', path: 'C:\\Program Files\\Git\\bin\\bash.exe', sandboxed: false }
        ],
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
    );

    assert.deepEqual(
        profiles.map((profile) => profile.kind),
        ['powershell', 'bash', 'cmd']
    );
    assert.equal(
        profiles.some((profile) => profile.path.includes('sandbox')),
        false
    );
});

test('interactive profiles deduplicate powershell variants and prefer PowerShell 7', () => {
    // Windows 扫描会同时得到 powershell.exe (5.1) 与 pwsh.exe (7)，kind 相同；
    // 下拉框按 kind 展示 label，保留两个会让用户看到两个同名 "PowerShell"。
    const profiles = buildInteractiveTerminalProfiles(
        'win32',
        [
            {
                kind: 'powershell',
                path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
                sandboxed: false
            },
            { kind: 'powershell', path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', sandboxed: false },
            { kind: 'bash', path: 'C:\\Program Files\\Git\\bin\\bash.exe', sandboxed: false }
        ],
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
    );

    assert.deepEqual(
        profiles.map((profile) => profile.kind),
        ['powershell', 'bash', 'cmd']
    );
    assert.ok(profiles[0].path.endsWith('pwsh.exe'));
});

test('interactive profiles keep a single profile per shell kind on POSIX', () => {
    const profiles = buildInteractiveTerminalProfiles('darwin', [
        { kind: 'zsh', path: '/bin/zsh', sandboxed: false },
        { kind: 'zsh', path: '/usr/bin/zsh', sandboxed: false },
        { kind: 'bash', path: '/bin/bash', sandboxed: false },
        { kind: 'bash', path: '/usr/local/bin/bash', sandboxed: false }
    ]);

    assert.deepEqual(
        profiles.map((profile) => profile.kind),
        ['zsh', 'bash']
    );
});

test('interactive shell arguments use login shells for POSIX profiles', () => {
    assert.deepEqual(shellArguments({ id: 'bash:/bin/bash', kind: 'bash', path: '/bin/bash' }, 'darwin'), ['-l']);
    assert.deepEqual(
        shellArguments({ id: 'powershell:C:/pwsh.exe', kind: 'powershell', path: 'C:/pwsh.exe' }, 'win32'),
        ['-NoLogo']
    );
    assert.deepEqual(shellArguments({ id: 'cmd:C:/cmd.exe', kind: 'cmd', path: 'C:/cmd.exe' }, 'win32'), []);
});
