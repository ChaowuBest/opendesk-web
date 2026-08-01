'use strict';

/**
 * Build the macOS Speech.framework helper used by the Darwin native bridge.
 *
 * The helper consists of two binaries packaged inside an .app bundle:
 *
 *   opendesk-speech-helper          (launcher, C)
 *   opendesk-speech-helper-daemon   (daemon, Swift)
 *
 * The launcher uses responsibility_spawnattrs_setdisclaim() to make the
 * daemon its own "responsible process" for TCC. This is required because
 * macOS TCC checks the responsible process's Info.plist for privacy usage
 * descriptions, and the responsible process is typically the IDE (e.g.
 * VS Code) when launching from its terminal – not the Electron app.
 *
 * The .app bundle's Info.plist contains NSMicrophoneUsageDescription and
 * NSSpeechRecognitionUsageDescription so TCC accepts the daemon's requests.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const helperDir = path.join(projectRoot, 'native', 'darwin', 'speech-helper');
const launcherSourcePath = path.join(helperDir, 'launcher.c');
const swiftSourcePath = path.join(helperDir, 'SpeechHelper.swift');
const plistPath = path.join(helperDir, 'Info.plist');

// Standalone binaries (kept for direct execution / debugging)
const launcherBinary = path.join(helperDir, 'opendesk-speech-helper');
const daemonBinary = path.join(helperDir, 'opendesk-speech-helper-daemon');

// .app bundle layout
const appBundlePath = path.join(helperDir, 'opendesk-speech-helper.app');
const appContentsPath = path.join(appBundlePath, 'Contents');
const appMacOSPath = path.join(appContentsPath, 'MacOS');
const appLauncherPath = path.join(appMacOSPath, 'opendesk-speech-helper');
const appDaemonPath = path.join(appMacOSPath, 'opendesk-speech-helper-daemon');
const appPlistPath = path.join(appContentsPath, 'Info.plist');

if (process.platform !== 'darwin') {
    console.log('[darwin-speech] skipping helper build on non-darwin platform');
    process.exit(0);
}

if (!fs.existsSync('/usr/bin/swiftc')) {
    console.error(
        '[darwin-speech] /usr/bin/swiftc not found; install Xcode Command Line Tools before building OpenDesk for macOS'
    );
    process.exit(1);
}

fs.mkdirSync(helperDir, { recursive: true });

// 1. Compile the C launcher
execFileSync('/usr/bin/clang', ['-O', launcherSourcePath, '-o', launcherBinary], {
    cwd: projectRoot,
    stdio: 'inherit'
});
fs.chmodSync(launcherBinary, 0o755);

// 2. Compile the Swift daemon
execFileSync(
    '/usr/bin/swiftc',
    [
        '-O',
        swiftSourcePath,
        '-o',
        daemonBinary,
        '-framework',
        'Speech',
        '-framework',
        'AVFoundation',
        '-Xlinker',
        '-sectcreate',
        '-Xlinker',
        '__TEXT',
        '-Xlinker',
        '__info_plist',
        '-Xlinker',
        plistPath
    ],
    {
        cwd: projectRoot,
        stdio: 'inherit'
    }
);
fs.chmodSync(daemonBinary, 0o755);

// 3. Assemble the .app bundle
fs.rmSync(appBundlePath, { recursive: true, force: true });
fs.mkdirSync(appMacOSPath, { recursive: true });
fs.copyFileSync(launcherBinary, appLauncherPath);
fs.copyFileSync(daemonBinary, appDaemonPath);
fs.copyFileSync(plistPath, appPlistPath);
fs.chmodSync(appLauncherPath, 0o755);
fs.chmodSync(appDaemonPath, 0o755);

// 4. Ad-hoc sign the bundle (deep, so both binaries are sealed)
try {
    execFileSync('/usr/bin/codesign', ['--sign', '-', '--force', '--deep', appBundlePath], {
        cwd: projectRoot,
        stdio: 'inherit'
    });
} catch {
    console.warn('[darwin-speech] codesign failed; TCC may still reject the helper');
}

console.log(`[darwin-speech] built ${path.relative(projectRoot, appLauncherPath)}`);
