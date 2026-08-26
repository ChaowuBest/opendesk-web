import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    saveAttachmentFile,
    saveAllAttachmentFiles
} from '../../../../main/applications/mailbox/service/attachment-files.js';

async function withTempDirectory(run) {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opendesk-mailbox-attachments-'));
    try {
        await run(directory);
    } finally {
        await fs.promises.rm(directory, { recursive: true, force: true });
    }
}

test('saveAttachmentFile copies one attachment to the selected path', async () => {
    await withTempDirectory(async (directory) => {
        const source = path.join(directory, 'source.txt');
        const destination = path.join(directory, 'saved.txt');
        await fs.promises.writeFile(source, 'mail attachment', 'utf8');

        const result = await saveAttachmentFile(source, destination);

        assert.equal(result, destination);
        assert.equal(await fs.promises.readFile(destination, 'utf8'), 'mail attachment');
    });
});

test('saveAttachmentFile treats saving onto the source as a no-op', async () => {
    await withTempDirectory(async (directory) => {
        const source = path.join(directory, 'source.txt');
        await fs.promises.writeFile(source, 'unchanged', 'utf8');

        assert.equal(await saveAttachmentFile(source, source), source);
        assert.equal(await fs.promises.readFile(source, 'utf8'), 'unchanged');
    });
});

test('saveAllAttachmentFiles saves every file and preserves existing files', async () => {
    await withTempDirectory(async (directory) => {
        const sourceDirectory = path.join(directory, 'source');
        const destinationDirectory = path.join(directory, 'destination');
        await fs.promises.mkdir(sourceDirectory);
        await fs.promises.mkdir(destinationDirectory);
        const first = path.join(sourceDirectory, 'first.txt');
        const second = path.join(sourceDirectory, 'second.txt');
        await fs.promises.writeFile(first, 'first', 'utf8');
        await fs.promises.writeFile(second, 'second', 'utf8');
        await fs.promises.writeFile(path.join(destinationDirectory, 'report.txt'), 'existing', 'utf8');

        const savedPaths = await saveAllAttachmentFiles(
            [
                { filename: 'report.txt', path: first },
                { filename: 'report.txt', path: second }
            ],
            destinationDirectory
        );

        assert.deepEqual(
            savedPaths.map((savedPath) => path.basename(savedPath)),
            ['report (2).txt', 'report (3).txt']
        );
        assert.equal(await fs.promises.readFile(path.join(destinationDirectory, 'report.txt'), 'utf8'), 'existing');
        assert.equal(await fs.promises.readFile(savedPaths[0], 'utf8'), 'first');
        assert.equal(await fs.promises.readFile(savedPaths[1], 'utf8'), 'second');
    });
});

test('saveAllAttachmentFiles keeps attachment filenames inside the selected directory', async () => {
    await withTempDirectory(async (directory) => {
        const source = path.join(directory, 'source.txt');
        const destinationDirectory = path.join(directory, 'destination');
        await fs.promises.writeFile(source, 'safe', 'utf8');
        await fs.promises.mkdir(destinationDirectory);

        const [savedPath] = await saveAllAttachmentFiles(
            [{ filename: '../outside.txt', path: source }],
            destinationDirectory
        );

        assert.equal(savedPath, path.join(destinationDirectory, 'outside.txt'));
        assert.equal(await fs.promises.readFile(savedPath, 'utf8'), 'safe');
    });
});

test('saveAllAttachmentFiles rejects a destination that is not a directory', async () => {
    await withTempDirectory(async (directory) => {
        const source = path.join(directory, 'source.txt');
        const destination = path.join(directory, 'destination.txt');
        await fs.promises.writeFile(source, 'source', 'utf8');
        await fs.promises.writeFile(destination, 'destination', 'utf8');

        await assert.rejects(
            saveAllAttachmentFiles([{ filename: 'source.txt', path: source }], destination),
            /not a directory/
        );
    });
});
