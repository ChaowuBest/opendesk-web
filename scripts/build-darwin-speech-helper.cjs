'use strict';

/**
 * Build the macOS Speech.framework helper used by the Darwin native bridge.
 *
 * The helper is intentionally kept outside the Electron bundle graph because it
 * links Apple frameworks directly and is copied as an extra resource by Forge.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const helperDir = path.join(projectRoot, 'native', 'darwin', 'speech-helper');
const sourcePath = path.join(helperDir, 'SpeechHelper.swift');
const plistPath = path.join(helperDir, 'Info.plist');
const binaryPath = path.join(helperDir, 'opendesk-speech-helper');

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

execFileSync(
    '/usr/bin/swiftc',
    [
        '-O',
        sourcePath,
        '-o',
        binaryPath,
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

fs.chmodSync(binaryPath, 0o755);
console.log(`[darwin-speech] built ${path.relative(projectRoot, binaryPath)}`);
