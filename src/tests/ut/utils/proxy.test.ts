import { afterEach, expect, test } from '@jest/globals';
import { isHostInNoProxy, isHostInNoProxyList } from '../../../main/utils/proxy.js';

const originalNoProxy = process.env.NO_PROXY;
const originalLowerNoProxy = process.env.no_proxy;

afterEach(() => {
    if (originalNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = originalNoProxy;
    if (originalLowerNoProxy === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = originalLowerNoProxy;
});

test('wildcard domain bypass matches subdomains without matching the apex or unrelated domains', () => {
    expect(isHostInNoProxyList('mail.huawei.com', 993, '*.huawei.com')).toBe(true);
    expect(isHostInNoProxyList('imap.mail.huawei.com', 993, '*.huawei.com')).toBe(true);
    expect(isHostInNoProxyList('MAIL.HUAWEI.COM.', 993, '*.Huawei.COM.')).toBe(true);
    for (const host of ['huawei.com', 'nothuawei.com', 'mail.huawei.com.evil.example']) {
        expect(isHostInNoProxyList(host, 993, '*.huawei.com')).toBe(false);
    }
});

test('wildcard domain bypass respects an optional port', () => {
    expect(isHostInNoProxyList('mail.huawei.com', 993, 'localhost, *.huawei.com:993')).toBe(true);
    expect(isHostInNoProxyList('mail.huawei.com', 465, 'localhost, *.huawei.com:993')).toBe(false);
});

test('wildcard bypass covers IP prefixes and multiple wildcard segments', () => {
    expect(isHostInNoProxyList('192.168.1.20', 993, '192.168.*')).toBe(true);
    expect(isHostInNoProxyList('192.168.200.8', 993, '192.168.*:993')).toBe(true);
    expect(isHostInNoProxyList('192.168.200.8', 465, '192.168.*:993')).toBe(false);
    expect(isHostInNoProxyList('192.169.1.20', 993, '192.168.*')).toBe(false);
    expect(isHostInNoProxyList('10.20.30.40', 993, '10.*.*.*')).toBe(true);
});

test('existing domain suffix, wildcard-all and IPv6 bypass rules keep their semantics', () => {
    expect(isHostInNoProxyList('huawei.com', 993, '.huawei.com')).toBe(true);
    expect(isHostInNoProxyList('mail.huawei.com', 993, 'huawei.com')).toBe(true);
    expect(isHostInNoProxyList('mail.example.com', 993, '*')).toBe(true);
    expect(isHostInNoProxyList('::1', 993, '[::1]:993')).toBe(true);
    expect(isHostInNoProxyList('::1', 465, '[::1]:993')).toBe(false);
});

test('environment proxy bypass uses the same wildcard matching for URLs', () => {
    process.env.NO_PROXY = 'localhost,*.huawei.com:8443';
    expect(isHostInNoProxy('https://mail.huawei.com:8443/inbox')).toBe(true);
    expect(isHostInNoProxy('https://mail.huawei.com:9443/inbox')).toBe(false);
    delete process.env.NO_PROXY;
    process.env.no_proxy = '*.huawei.com';
    expect(isHostInNoProxy('https://mail.huawei.com/inbox')).toBe(true);
});
