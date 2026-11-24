import { X509Certificate } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { BrowserManager } from '../../../common/embedBrowserUse/main.js';
import { BrowserApplication } from '../../../main/applications/browser/app.js';
import { BrowserCertificateExceptions } from '../../../main/applications/browser/certificates.js';

const pem = `-----BEGIN CERTIFICATE-----
MIIBRDCB96ADAgECAhQjEDNVy5MsPb3mCrRyCDiEEA2GfjAFBgMrZXAwGDEWMBQG
A1UEAwwNb3BlbmRlc2stdGVzdDAeFw0yNjExMjMwODE2MThaFw0zNjExMjAwODE2
MThaMBgxFjAUBgNVBAMMDW9wZW5kZXNrLXRlc3QwKjAFBgMrZXADIQDMOeKrRaPk
LSKhlnCRDrwSXJJyapEqPFkAVTXJSJuVMKNTMFEwHQYDVR0OBBYEFHYjle19bzLJ
fSN4fEpr7kbwmLIlMB8GA1UdIwQYMBaAFHYjle19bzLJfSN4fEpr7kbwmLIlMA8G
A1UdEwEB/wQFMAMBAf8wBQYDK2VwA0EAEHsETA/NEa/kJOr+oxwqWgn3bemHi86P
Co9NQgOROpApvqRRdC88LxPmPpj2qCDBA/VPHqLAY5i4eZzp5+VVAg==
-----END CERTIFICATE-----`;

test('lists a binary DER import and trusts it in the existing browser session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opendesk-cert-'));
    const browser = new BrowserApplication();
    const store = browser as unknown as { _getCertStorePath(): Promise<string>; _getCertsDir(): Promise<string> };
    const storePath = join(directory, 'certificates.json');
    jest.spyOn(store, '_getCertStorePath').mockResolvedValue(storePath);
    jest.spyOn(store, '_getCertsDir').mockResolvedValue(directory);
    const setCertificateVerifyProc = jest.fn<Electron.Session['setCertificateVerifyProc']>();
    const session = jest.spyOn(BrowserManager, 'browserSession', 'get').mockReturnValue({
        setCertificateVerifyProc
    } as unknown as Electron.Session);
    try {
        await browser.initCertificateVerifier();
        const result = await browser.importBrowserCertificate(new X509Certificate(pem).raw);
        expect(result).toMatchObject({ success: true, cert: { commonName: 'opendesk-test' } });
        expect(await browser.getBrowserCertificates()).toEqual([result.cert]);
        const verify = setCertificateVerifyProc.mock.lastCall?.[0];
        const finish = jest.fn();
        const request = { certificate: { data: pem } } as Electron.Request;
        verify!({ ...request, verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID' }, finish);
        expect(finish).toHaveBeenCalledWith(0);
        verify!({ ...request, verificationResult: 'net::ERR_CERT_REVOKED' }, finish);
        expect(finish).toHaveBeenLastCalledWith(-3);
        expect(browser.matchesBrowserCertificate(pem, 'net::ERR_CERT_REVOKED')).toBe(false);
        await expect(browser.importBrowserCertificate('invalid certificate')).resolves.toMatchObject({
            success: false
        });

        await expect(browser.removeBrowserCertificate(result.cert!.fingerprint256)).resolves.toMatchObject({
            success: true
        });
        expect(await browser.getBrowserCertificates()).toEqual([]);
        verify!({ ...request, verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID' }, finish);
        expect(finish).toHaveBeenLastCalledWith(-3);
        await writeFile(storePath, '{bad json');
        const error = await browser.getBrowserCertificates().catch((failure: Error) => failure.message);
        await expect(browser.importBrowserCertificate(pem)).resolves.toEqual({ success: false, message: error });
    } finally {
        session.mockRestore();
        await rm(directory, { recursive: true, force: true });
    }
});

const url = 'https://192.168.1.8:8443/';
const untrusted = 'ERR_CERT_AUTHORITY_INVALID';

test('requires consent and remembers it for same-origin navigation during this run', () => {
    const policy = new BrowserCertificateExceptions();
    const tab = {};
    expect(policy.handleError(tab, url, untrusted, 'cert-A')).toBe(false);
    expect(policy.confirm(tab, url, policy.getChallenge(tab, url)!)).toBe(true);
    policy.navigationStarted(tab, url);
    expect(policy.handleError(tab, url, untrusted, 'cert-A')).toBe(true);
    expect(policy.handleError({}, url + 'next', untrusted, 'cert-A')).toBe(true);
    expect(policy.handleError(tab, 'https://192.168.1.8:9443/', untrusted, 'cert-A')).toBe(false);
    expect(policy.allowsSubresource(url, url + 'app.js', untrusted, 'cert-A')).toBe(true);
    expect(policy.allowsSubresource('https://example.org/', url + 'app.js', untrusted, 'cert-A')).toBe(false);
    expect(new BrowserCertificateExceptions().handleError(tab, url, untrusted, 'cert-A')).toBe(false);
});

test.each([
    [untrusted, 'cert-B'],
    ['ERR_CERT_DATE_INVALID', 'cert-A']
])('requires new consent when the certificate or error changes (%s, %s)', (error, fingerprint) => {
    const policy = new BrowserCertificateExceptions();
    const tab = {};
    policy.handleError(tab, url, untrusted, 'cert-A');
    policy.confirm(tab, url, policy.getChallenge(tab, url)!);
    expect(policy.handleError(tab, url, untrusted, 'cert-A')).toBe(true);
    expect(policy.handleError(tab, url, error, fingerprint)).toBe(false);
});

test.each([
    ['https://example.org/', untrusted],
    [url, 'ERR_CERT_REVOKED']
])('offers no continuation for %s with %s', (target, error) => {
    const policy = new BrowserCertificateExceptions();
    const tab = {};
    policy.handleError(tab, target, error, 'cert-A');
    expect(policy.getChallenge(tab, target)).toBeUndefined();
});

test('rejects the confirmation from a warning replaced at the same address', () => {
    const policy = new BrowserCertificateExceptions();
    const tab = {};
    policy.handleError(tab, url, untrusted, 'cert-A');
    const oldChallenge = policy.getChallenge(tab, url)!;
    policy.handleError(tab, url, untrusted, 'cert-B');
    expect(policy.confirm(tab, url, oldChallenge)).toBe(false);
    expect(policy.confirm(tab, url, policy.getChallenge(tab, url)!)).toBe(true);
});
