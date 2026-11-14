import { describe, expect, test } from '@jest/globals';
import { decodeIpcValue, encodeIpcValue } from '../../../common/web/ipc-codec.js';

/** 经过一次 JSON 传输的往返，模拟 WebSocket 文本帧 */
function roundTrip<T>(value: T): unknown {
    return decodeIpcValue(JSON.parse(JSON.stringify(encodeIpcValue(value))));
}

describe('web ipc codec', () => {
    test('keeps JSON-safe values unchanged', () => {
        const value = { status: 'ok', data: [1, 'two', true, null, { nested: 3.5 }] };
        expect(roundTrip(value)).toEqual(value);
    });

    test('preserves undefined in arrays and object properties', () => {
        const decoded = roundTrip({ a: undefined, list: [undefined, 1] }) as Record<string, unknown>;
        expect('a' in decoded).toBe(true);
        expect(decoded.a).toBeUndefined();
        expect(decoded.list).toEqual([undefined, 1]);
        expect(roundTrip(undefined)).toBeUndefined();
    });

    test('restores non-finite numbers and bigint', () => {
        expect(roundTrip([NaN, Infinity, -Infinity, 10n])).toEqual([NaN, Infinity, -Infinity, 10n]);
    });

    test('restores Date, RegExp, Map and Set', () => {
        const date = new Date('2026-11-14T10:00:00Z');
        const decoded = roundTrip({
            date,
            re: /od-[a-z]+/gi,
            map: new Map<unknown, unknown>([['k', new Set([1, 2])]]),
            set: new Set(['x'])
        }) as Record<string, unknown>;
        expect(decoded.date).toEqual(date);
        expect(decoded.re).toEqual(/od-[a-z]+/gi);
        expect(decoded.map).toEqual(new Map([['k', new Set([1, 2])]]));
        expect(decoded.set).toEqual(new Set(['x']));
    });

    test('sends Node Buffer as Uint8Array, like Electron IPC does', () => {
        const decoded = roundTrip(Buffer.from('hello'));
        expect(decoded).toBeInstanceOf(Uint8Array);
        expect(Buffer.isBuffer(decoded)).toBe(false);
        expect(Array.from(decoded as Uint8Array)).toEqual(Array.from(Buffer.from('hello')));
    });

    test('restores typed arrays from a slice of a larger buffer', () => {
        const backing = new Float32Array([1, 2, 3, 4]);
        const view = new Float32Array(backing.buffer, 4, 2);
        const decoded = roundTrip(view);
        expect(decoded).toBeInstanceOf(Float32Array);
        expect(Array.from(decoded as Float32Array)).toEqual([2, 3]);
    });

    test('restores ArrayBuffer', () => {
        const buffer = new Uint8Array([9, 8, 7]).buffer;
        const decoded = roundTrip(buffer);
        expect(decoded).toBeInstanceOf(ArrayBuffer);
        expect(Array.from(new Uint8Array(decoded as ArrayBuffer))).toEqual([9, 8, 7]);
    });

    test('restores Error with name, message and own properties', () => {
        const error = Object.assign(new TypeError('boom'), { code: 'E_BOOM' });
        const decoded = roundTrip(error) as Error & { code?: string };
        expect(decoded).toBeInstanceOf(Error);
        expect(decoded.name).toBe('TypeError');
        expect(decoded.message).toBe('boom');
        expect(decoded.code).toBe('E_BOOM');
    });

    test('drops functions and symbols like structured clone would refuse them', () => {
        const decoded = roundTrip({ keep: 1, fn: () => 1, sym: Symbol('x') }) as Record<string, unknown>;
        expect(decoded).toEqual({ keep: 1 });
    });

    test('breaks circular references instead of recursing forever', () => {
        const node: Record<string, unknown> = { name: 'root' };
        node.self = node;
        const decoded = roundTrip(node) as Record<string, unknown>;
        expect(decoded.name).toBe('root');
        expect(decoded.self).toBeUndefined();
    });

    test('keeps repeated (non-circular) references', () => {
        const shared = { v: 1 };
        expect(roundTrip({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } });
    });

    test('round-trips business objects that happen to use the tag key', () => {
        const value = { __odipc: 'u', other: 2 };
        expect(roundTrip(value)).toEqual(value);
    });
});
