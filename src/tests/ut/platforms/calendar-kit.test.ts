import { describe, expect, test } from '@jest/globals';
import { NaiveCalendarKit, NaiveNativeBridge } from '../../../platforms/bridges/common.js';
import { NativeBridgeProxy } from '../../../platforms/bridges/renderer.js';

describe('unsupported native calendar capabilities', () => {
    test('state separates unsupported native calendars from local calendar availability', async () => {
        const kit = new NaiveCalendarKit();
        expect(await kit.getState()).toEqual({
            supported: false,
            readGranted: false,
            writeGranted: false,
            calendars: []
        });
        expect(kit.ownsEvent('local_123')).toBe(false);
        expect(kit.ownsEvent('android:1:2:3')).toBe(false);
        let changes = 0;
        const dispose = kit.onDidChange(() => changes++);
        dispose();
        dispose();
        expect(changes).toBe(0);
    });

    test('unsupported native operations fail explicitly instead of appearing successful', async () => {
        const kit = new NaiveCalendarKit();
        for (const operation of [
            () => kit.requestAccess(),
            () => kit.listEvents(1, 2),
            () => kit.addEvent('1', { subject: 'Meeting', startTime: 1, endTime: 2 }),
            () => kit.updateEvent('opaque', { subject: 'Updated' }),
            () => kit.deleteEvent('opaque')
        ]) {
            await expect(operation()).rejects.toMatchObject({ code: 'CALENDAR_UNAVAILABLE' });
        }
    });

    test.each([new NaiveNativeBridge(), new NativeBridgeProxy()])(
        'bridge defaults own a stable unsupported kit and never require native transport',
        async (bridge) => {
            const first = await bridge.getCalendarKit();
            expect(await bridge.getCalendarKit()).toBe(first);
            expect((await first.getState()).supported).toBe(false);
        }
    );
});
