import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { z } from 'zod';

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TREE_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 128;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

const ArtifactManifestSchema = z
    .object({
        schemaVersion: z.literal(1),
        format: z.literal('opendesk-builtin-plugin-zip-v1'),
        pluginId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/),
        pluginVersion: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z._-]*$/),
        projectRepository: z.string().url(),
        generatorSchemaVersion: z.literal(1),
        archive: z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]*\.zip$/),
        archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
        archiveBytes: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
        treeSha256: z.string().regex(/^[a-f0-9]{64}$/),
        releaseManifestSha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional()
    })
    .strict();

export type BuiltinPluginArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

function sha256File(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listFiles(root: string): string[] {
    const files: string[] = [];
    const visit = (directory: string): void => {
        for (const entry of fs
            .readdirSync(directory, { withFileTypes: true })
            .sort((left, right) =>
                Buffer.from(left.name.normalize('NFC'), 'utf8').compare(
                    Buffer.from(right.name.normalize('NFC'), 'utf8')
                )
            )) {
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(fullPath);
            else if (entry.isFile())
                files.push(path.relative(root, fullPath).split(path.sep).join('/').normalize('NFC'));
            else throw new Error(`plugin.builtin_artifact_non_regular_output:${fullPath}`);
        }
    };
    visit(root);
    return files;
}

export function canonicalPluginTreeSha256(root: string): string {
    const hash = crypto.createHash('sha256');
    for (const relative of listFiles(root)) {
        hash.update(Buffer.from(relative, 'utf8'));
        hash.update(Buffer.from([0]));
        hash.update(sha256File(path.join(root, relative)).toLowerCase(), 'ascii');
        hash.update('\n', 'ascii');
    }
    return hash.digest('hex');
}

function normalizeArchivePath(entryName: string): string {
    if (!entryName || entryName.includes('\\') || entryName.includes('\0')) {
        throw new Error(`plugin.builtin_artifact_path_invalid:${entryName}`);
    }
    const normalized = entryName.normalize('NFC');
    if (/^(?:[A-Za-z]:|\/)/.test(normalized)) {
        throw new Error(`plugin.builtin_artifact_path_invalid:${entryName}`);
    }
    const parts = normalized.split('/');
    if (
        parts.some(
            (part) =>
                !part ||
                part === '.' ||
                part === '..' ||
                part.endsWith('.') ||
                part.endsWith(' ') ||
                part.includes(':') ||
                WINDOWS_RESERVED_NAME.test(part)
        )
    ) {
        throw new Error(`plugin.builtin_artifact_path_invalid:${entryName}`);
    }
    return parts.join('/');
}

function readManifest(container: string): BuiltinPluginArtifactManifest {
    const filePath = path.join(container, 'artifact-manifest.json');
    let value: unknown;
    try {
        value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    } catch (error) {
        throw new Error(`plugin.builtin_artifact_manifest_invalid:${error instanceof Error ? error.message : error}`);
    }
    const parsed = ArtifactManifestSchema.safeParse(value);
    if (!parsed.success) throw new Error(`plugin.builtin_artifact_manifest_invalid:${parsed.error.message}`);
    return parsed.data;
}

export function materializeBuiltinPluginZip(container: string, destination: string): BuiltinPluginArtifactManifest {
    const manifest = readManifest(container);
    if (manifest.pluginId !== path.basename(container)) {
        throw new Error(`plugin.builtin_artifact_container_mismatch:${manifest.pluginId}`);
    }
    const archivePath = path.join(container, manifest.archive);
    if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
        throw new Error(`plugin.builtin_artifact_missing:${path.basename(container)}`);
    }
    const expectedContainerFiles = ['artifact-manifest.json', manifest.archive].sort();
    const actualContainerFiles = fs
        .readdirSync(container, { withFileTypes: true })
        .map((entry) => {
            if (!entry.isFile()) throw new Error(`plugin.builtin_artifact_unknown_entry:${entry.name}`);
            return entry.name;
        })
        .sort();
    if (JSON.stringify(actualContainerFiles) !== JSON.stringify(expectedContainerFiles)) {
        throw new Error(`plugin.builtin_artifact_file_set_invalid:${JSON.stringify(actualContainerFiles)}`);
    }

    const archiveStat = fs.statSync(archivePath);
    if (archiveStat.size !== manifest.archiveBytes || archiveStat.size > MAX_ARCHIVE_BYTES) {
        throw new Error('plugin.builtin_artifact_archive_size_invalid');
    }
    if (sha256File(archivePath) !== manifest.archiveSha256) {
        throw new Error('plugin.builtin_artifact_archive_hash_mismatch');
    }

    let entries: AdmZip.IZipEntry[];
    try {
        entries = new AdmZip(archivePath).getEntries();
    } catch (error) {
        throw new Error(
            `plugin.builtin_artifact_archive_invalid:${error instanceof Error ? error.message : String(error)}`
        );
    }
    if (entries.length === 0 || entries.length > MAX_ENTRIES) {
        throw new Error('plugin.builtin_artifact_entry_count_invalid');
    }
    const collisionKeys = new Set<string>();
    let totalBytes = 0;
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of entries) {
        if (entry.isDirectory) throw new Error(`plugin.builtin_artifact_directory_entry_forbidden:${entry.entryName}`);
        const unixType = (entry.attr >>> 16) & 0xf000;
        if (unixType && unixType !== 0x8000) {
            throw new Error(`plugin.builtin_artifact_non_regular_entry:${entry.entryName}`);
        }
        const relative = normalizeArchivePath(entry.entryName);
        const collisionKey = relative.toLocaleLowerCase('en-US');
        if (collisionKeys.has(collisionKey)) throw new Error(`plugin.builtin_artifact_path_collision:${relative}`);
        collisionKeys.add(collisionKey);
        if (entry.header.size > MAX_ENTRY_BYTES) throw new Error(`plugin.builtin_artifact_entry_too_large:${relative}`);
        totalBytes += entry.header.size;
        if (totalBytes > MAX_TREE_BYTES) throw new Error('plugin.builtin_artifact_tree_too_large');
        const data = entry.getData();
        if (data.length !== entry.header.size)
            throw new Error(`plugin.builtin_artifact_entry_size_mismatch:${relative}`);
        const outputPath = path.join(destination, ...relative.split('/'));
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, data);
    }
    if (canonicalPluginTreeSha256(destination) !== manifest.treeSha256) {
        throw new Error('plugin.builtin_artifact_tree_hash_mismatch');
    }
    return manifest;
}
