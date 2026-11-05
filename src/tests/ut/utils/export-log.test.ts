import { afterEach, describe, expect, jest, test } from '@jest/globals';
import type { ExportDestinationHost } from '../../../common/export.js';
import { exportLogEntries } from '../../../main/utils/export-log.js';
import { LogStream } from '../../../main/utils/logger.js';

describe('shared log export operation', () => {
    afterEach(() => jest.restoreAllMocks());

    test.each([
        [{ scope: 'filtered', filter: ' warning ' }, 'warning', /^opendesk-filtered-logs-.*\.txt$/],
        [{ scope: 'all', filter: 'ignored' }, '', /^opendesk-logs-.*\.txt$/],
        [{ scope: 'unknown', filter: 'ignored' }, '', /^opendesk-logs-.*\.txt$/]
    ])('normalizes options %p once for every host', async (options, filter, namePattern) => {
        const formatEntries = jest.fn(() => 'serialized logs');
        jest.spyOn(LogStream, 'getStream').mockReturnValue({ formatEntries } as unknown as LogStream);
        const destination = { id: 'provider-token' };
        const host: ExportDestinationHost = {
            selectDestination: jest.fn(async () => destination),
            write: jest.fn(async () => undefined),
            commit: jest.fn(async () => ({ displayName: 'logs.txt' })),
            release: jest.fn(async () => undefined)
        };

        expect(await exportLogEntries(options, host)).toEqual({
            canceled: false,
            receipt: { displayName: 'logs.txt' }
        });
        expect(host.selectDestination).toHaveBeenCalledWith({
            title: expect.any(String),
            suggestedName: expect.stringMatching(namePattern as RegExp),
            mimeType: 'text/plain',
            extensions: ['txt']
        });
        expect(formatEntries).toHaveBeenCalledWith({ filter });
        expect(host.write).toHaveBeenCalledWith(destination, 'serialized logs');
    });
});
