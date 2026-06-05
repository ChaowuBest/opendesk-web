#!/usr/bin/env node
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

const BUNDLE_NAME_MESSAGE =
    'bundleName must use lowercase letters, numbers, dots, or hyphens; start with a lowercase letter; and not end with or repeat separators.';
const BundleNameSchema = z
    .string()
    .min(2, BUNDLE_NAME_MESSAGE)
    .max(128, BUNDLE_NAME_MESSAGE)
    .regex(/^[a-z][a-z0-9]*(?:[.-]?[a-z0-9]+)*$/, BUNDLE_NAME_MESSAGE);

const ManifestSchema = z.object({
    schemaVersion: z.literal(1),
    bundleName: BundleNameSchema,
    displayName: z.string().min(1),
    versionName: z.string().min(1),
    entry: z.string().min(1),
    icon: z.string().optional(),
    description: z.string().optional(),
    skills: z.array(z.string()).optional(),
    permissions: z.array(z.string()).optional()
});

function assertRelativeSafe(relPath: string): void {
    if (path.isAbsolute(relPath) || relPath.split(/[\\/]+/).includes('..')) {
        throw new Error(`Unsafe package path: ${relPath}`);
    }
}

function addDirectory(zip: AdmZip, sourceDir: string, rootDir: string): void {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const fullPath = path.join(sourceDir, entry.name);
        const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
        assertRelativeSafe(relPath);
        if (entry.isDirectory()) {
            addDirectory(zip, fullPath, rootDir);
        } else if (entry.isFile()) {
            zip.addLocalFile(fullPath, path.dirname(relPath) === '.' ? '' : path.dirname(relPath));
        }
    }
}

export function packOpenDeskApp(sourceDir: string, outPath: string): void {
    const manifestPath = path.join(sourceDir, 'opendesk-app.json');
    if (!fs.existsSync(manifestPath)) {
        throw new Error('opendesk-app.json not found');
    }
    const manifest = ManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
    assertRelativeSafe(manifest.entry);
    if (!fs.existsSync(path.join(sourceDir, manifest.entry))) {
        throw new Error(`entry file not found: ${manifest.entry}`);
    }
    if (manifest.icon) {
        assertRelativeSafe(manifest.icon);
        if (!fs.existsSync(path.join(sourceDir, manifest.icon))) {
            throw new Error(`icon file not found: ${manifest.icon}`);
        }
    }

    const zip = new AdmZip();
    addDirectory(zip, sourceDir, sourceDir);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    zip.writeZip(outPath);
}

function main(): void {
    const [, , command, sourceDirArg, ...rest] = process.argv;
    if (command !== 'pack' || !sourceDirArg) {
        console.error('Usage: opendesk-appsdk pack <app-dir> --out <app.zip>');
        process.exit(1);
    }
    const outIndex = rest.indexOf('--out');
    const outPathArg = outIndex >= 0 ? rest[outIndex + 1] : undefined;
    if (!outPathArg) {
        console.error('Missing --out <app.zip>');
        process.exit(1);
    }
    packOpenDeskApp(path.resolve(sourceDirArg), path.resolve(outPathArg));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    main();
}
