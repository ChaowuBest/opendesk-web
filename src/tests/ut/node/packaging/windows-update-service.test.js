import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '../../../../..');
const serviceDirectory = path.join(projectRoot, 'resources', 'windows-update-service');
const builderPath = path.join(projectRoot, 'scripts', 'windows-update-service', 'build-service.mjs');

test(
    'Windows update service core rejects unsafe requests and serializes installation work',
    { skip: process.platform !== 'win32' },
    () => {
        const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-update-service-test-'));
        try {
            const result = spawnSync(process.execPath, [builderPath, '--test-only', '--output-dir', outputDirectory], {
                cwd: projectRoot,
                encoding: 'utf8'
            });
            assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
            assert.match(result.stdout, /PASS protocol-validation/);
            assert.match(result.stdout, /PASS caller-identity/);
            assert.match(result.stdout, /PASS source-path-policy/);
            assert.match(result.stdout, /PASS protected-trust-required/);
            assert.match(result.stdout, /PASS checksum-mismatch/);
            assert.match(result.stdout, /PASS replay-deduplication/);
            assert.match(result.stdout, /PASS machine-wide-mutex/);
            assert.match(result.stdout, /PASS installer-exit-codes/);
            assert.match(result.stdout, /PASS health-gated-cleanup/);
            assert.match(result.stdout, /PASS cleanup-failure-retry/);
        } finally {
            fs.rmSync(outputDirectory, { recursive: true, force: true });
        }
    }
);

test('service host exposes only the bounded v1 protocol over a restricted local named pipe', () => {
    const host = fs.readFileSync(path.join(serviceDirectory, 'OpenDeskUpdateService.cs'), 'utf8');
    const protocol = fs.readFileSync(path.join(serviceDirectory, 'UpdateProtocol.cs'), 'utf8');
    const security = fs.readFileSync(path.join(serviceDirectory, 'UpdateSecurity.cs'), 'utf8');

    assert.match(host, /OpenDesk\.UpdateService\.v1/);
    assert.match(host, /PipeSecurity/);
    assert.match(host, /WellKnownSidType\.AuthenticatedUserSid/);
    assert.match(host, /WellKnownSidType\.NetworkSid/);
    assert.match(host, /GetNamedPipeClientProcessId/);
    assert.match(host, /OpenProcessToken/);
    assert.match(host, /UTF8Encoding/);
    assert.match(host, /request_completed/);
    assert.match(protocol, /queryStatus/);
    assert.match(protocol, /submitUpdate/);
    assert.match(protocol, /reportHealthy/);
    assert.doesNotMatch(protocol, /arguments|commandLine|shell/i);
    assert.match(security, /ReparsePoint/);
    assert.doesNotMatch(security, /TestTrustedVersion|TestTrustedSha256/);
    assert.match(host, /new UpdatePackageSecurity\([\s\S]*false\)/);
    assert.match(security, /WinVerifyTrust/);
    const engine = fs.readFileSync(path.join(serviceDirectory, 'UpdateEngine.cs'), 'utf8');
    assert.match(engine, /Arguments = "\/quiet \/norestart"/);
    assert.match(engine, /Arguments = "\/repair \/quiet \/norestart CleanupOldVersions=1"/);
    assert.match(engine, /cleanup_pending/);
    assert.match(engine, /cleanup_completed/);
    assert.match(engine, /ProtectedPackagePath/);
    assert.doesNotMatch(host + protocol + security, /OPENDESK_UPDATE_ALLOW_UNVERIFIED/);
});

test('prototype platform MSI owns the service and a protected machine cache without stopping it on repair', () => {
    const builder = fs.readFileSync(
        path.join(projectRoot, 'scripts', 'windows-installer', 'build-installer.mjs'),
        'utf8'
    );

    assert.match(builder, /OpenDeskUpdateService\.exe/);
    assert.match(builder, /<ServiceInstall[\s\S]*Name="OpenDeskUpdateService"[\s\S]*Start="auto"/);
    assert.match(builder, /<ServiceControl[\s\S]*Start="install"[\s\S]*Stop="uninstall"[\s\S]*Remove="uninstall"/);
    assert.match(builder, /Component Id="OpenDeskUpdateServiceComponent"[^>]+NeverOverwrite="yes"/);
    assert.match(builder, /PermissionEx[\s\S]*User="SYSTEM"[\s\S]*GenericAll="yes"/);
    assert.match(builder, /PermissionEx[\s\S]*User="Administrators"[\s\S]*GenericAll="yes"/);
    assert.doesNotMatch(builder, /ServiceControl[^>]*Stop="both"/);
    assert.doesNotMatch(builder, /OPENDESK_TEST_TRUSTED_VERSION|OPENDESK_TEST_TRUSTED_SHA256/);
    assert.doesNotMatch(builder, /TrustedSignerThumbprints|signtool\.exe|additional-version/);
});
