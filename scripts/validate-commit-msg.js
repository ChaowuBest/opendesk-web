#!/usr/bin/env node

/**
 * Validate commit message body format
 *
 * Rules:
 * - If a line in body starts with '*' or '-', it must follow the format:
 *   [*|-] [bugfix|feature][: cli|desktop] <description>
 *
 * Valid formats:
 *   * [bugfix] fix something
 *   - [feature] add new feature
 *   * [bugfix: cli] fix cli issue
 *   * [bugfix: desktop] fix desktop issue
 *   - [feature: cli] add cli feature
 *   - [feature: desktop] add desktop feature
 */

import fs from 'fs';
import path from 'path';

// Valid tag patterns
const VALID_TAGS = [
    /\[bugfix\]/,
    /\[feature\]/,
    /\[bugfix:\s*cli\]/,
    /\[bugfix:\s*desktop\]/,
    /\[feature:\s*cli\]/,
    /\[feature:\s*desktop\]/
];

// Pattern for bullet point with tag
const BULLET_TAG_PATTERN = /^[*-]\s+\[(bugfix|feature)(:\s*(cli|desktop))?\]\s+.+/;

function validateCommitMsg(msgFile) {
    const content = fs.readFileSync(msgFile, 'utf-8');
    const lines = content.split('\n');

    // Find body lines (skip subject and empty lines after subject)
    let bodyStarted = false;
    const errors = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip until we find an empty line (marks end of subject)
        if (!bodyStarted) {
            if (line.trim() === '') {
                bodyStarted = true;
            }
            continue;
        }

        // Skip empty lines and trailers (e.g., Signed-off-by, Reviewed-by)
        if (line.trim() === '' || /^[A-Za-z-]+:/.test(line)) {
            continue;
        }

        // Check if line starts with bullet point
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('-')) {
            // Validate the bullet format
            if (!BULLET_TAG_PATTERN.test(trimmed)) {
                errors.push({
                    line: i + 1,
                    content: line,
                    message: 'Invalid bullet format. Expected: [*|-] [bugfix|feature][: cli|desktop] <description>'
                });
            }
        }
    }

    return errors;
}

function main() {
    const msgFile = process.argv[2];

    if (!msgFile) {
        console.error('Usage: validate-commit-msg.js <commit-msg-file>');
        process.exit(1);
    }

    const errors = validateCommitMsg(msgFile);

    if (errors.length > 0) {
        console.error('\n❌ Commit message body contains invalid bullet points:\n');
        errors.forEach((err) => {
            console.error(`  Line ${err.line}: ${err.content}`);
            console.error(`  Error: ${err.message}\n`);
        });
        console.error('Valid formats:');
        console.error('  * [bugfix] description');
        console.error('  - [feature] description');
        console.error('  * [bugfix: cli] description');
        console.error('  * [bugfix: desktop] description');
        console.error('  - [feature: cli] description');
        console.error('  - [feature: desktop] description\n');
        process.exit(1);
    }

    process.exit(0);
}

main();
