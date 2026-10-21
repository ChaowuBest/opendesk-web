import { describe, expect, test } from '@jest/globals';
import { FSStorage } from '../../../main/applications/filemgr/storage.js';

describe('FileMgr failed-enumeration cleanup', () => {
    test('protects original source references in failed ranges and cleans healthy siblings', async () => {
        const storage = Object.create(FSStorage.prototype);
        const makeRow = (item_id: string) => ({
            item_id,
            root_refs: JSON.stringify(['/root', '/other']),
            ref_count: 2
        });
        const failed = makeRow('/root/failed/old.txt');
        const sibling = makeRow('/root/failed-backup/old.txt');
        const scanned = makeRow('/root/healthy/current.txt');
        const updates: unknown[] = [];
        storage.storage = {
            search: async () => ({ items: [failed, sibling, scanned].map((item) => ({ item })) }),
            delete: async () => {
                throw new Error('other source must protect rows');
            },
            update: async (items: unknown[]) => {
                updates.push(...items);
            }
        };
        await storage.removeDeletedFiles('/root', new Set([scanned.item_id]), {
            failedDirectories: new Set(['/root/failed/'])
        });
        expect(updates).toEqual([
            { item_id: sibling.item_id, item_type: 'file', root_refs: '["/other"]', ref_count: 1 }
        ]);
        expect(failed.root_refs).toBe('["/root","/other"]');
    });

    test('propagates cleanup failure instead of returning successful deletion', async () => {
        const storage = Object.create(FSStorage.prototype);
        const error = new Error('delete failed');
        storage.storage = {
            search: async () => ({
                items: [{ item: { item_id: '/root/gone.txt', root_refs: '["/root"]', ref_count: 1 } }]
            }),
            delete: async () => {
                throw error;
            }
        };
        await expect(storage.removeDeletedFiles('/root', new Set())).rejects.toBe(error);
    });
});
