import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
    DEFAULT_UPDATE_FEED_URL,
    UPDATE_CHECK_INTERVAL_MS,
    resolveUpdateCacheDirectory
} from '../../../../main/updater/config.js';

test('uses the temporary public-news-compatible feed and a four-hour polling interval', () => {
    assert.equal(DEFAULT_UPDATE_FEED_URL, 'http://114.212.84.8:18080/news/');
    assert.equal(UPDATE_CHECK_INTERVAL_MS, 4 * 60 * 60 * 1000);
});

test('stores update artifacts in the platform user-data Cache directory', () => {
    assert.equal(
        resolveUpdateCacheDirectory('C:\\Users\\tester\\AppData\\Roaming\\opendesk'),
        path.join('C:\\Users\\tester\\AppData\\Roaming\\opendesk', 'Cache')
    );
    assert.equal(
        resolveUpdateCacheDirectory('/Users/tester/Library/Application Support/opendesk'),
        path.join('/Users/tester/Library/Application Support/opendesk', 'Cache')
    );
});
