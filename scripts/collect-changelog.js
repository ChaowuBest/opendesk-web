#!/usr/bin/env node

/**
 * Collect changelog from commit messages
 *
 * Extract bullet points with tags from commit messages between a given commit and HEAD.
 *
 * Usage:
 *   node collect-changelog.js --last-commit <commit-ish> [-o <output-file>]
 *
 * Examples:
 *   node collect-changelog.js --last-commit v0.1.0 -o CHANGELOG.md
 *   node collect-changelog.js --last-commit v0.1.0  # output to stdout
 */

import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

// Pattern for bullet point with tag
const BULLET_TAG_PATTERN = /^[*-]\s+\[(bugfix|feature)(:\s*(cli|desktop))?\]\s+(.+)/;

function parseArgs() {
    const args = process.argv.slice(2);
    const result = {
        lastCommit: null,
        outputFile: null
    };

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--last-commit' && i + 1 < args.length) {
            result.lastCommit = args[i + 1];
            i++;
        } else if (args[i] === '-o' && i + 1 < args.length) {
            result.outputFile = args[i + 1];
            i++;
        }
    }

    return result;
}

function printUsage() {
    console.error('Usage: collect-changelog.js --last-commit <commit-ish> [-o <output-file>]');
    console.error('');
    console.error('Options:');
    console.error('  --last-commit  Starting commit (exclusive). Commits from this point to HEAD will be included.');
    console.error('  -o             Output file. If not specified, output to stdout.');
    console.error('');
    console.error('Examples:');
    console.error('  collect-changelog.js --last-commit v0.1.0 -o CHANGELOG.md');
    console.error('  collect-changelog.js --last-commit v0.1.0  # output to stdout');
}

function validateCommitRef(ref) {
    try {
        execSync(`git rev-parse --verify ${ref}`, { encoding: 'utf-8', stdio: 'pipe' });
        return true;
    } catch (error) {
        return false;
    }
}

function getCommitsSince(lastCommit) {
    const range = lastCommit ? `${lastCommit}..HEAD` : 'HEAD';

    // Validate commit reference exists
    if (lastCommit && !validateCommitRef(lastCommit)) {
        console.error(`Error: '${lastCommit}' is not a valid commit, tag, or branch.`);
        console.error('');
        console.error('Tips:');
        console.error('  - Use a valid commit hash (e.g., abc1234)');
        console.error('  - Use a valid tag (e.g., v0.1.0)');
        console.error('  - Use a valid branch name (e.g., main)');
        console.error('  - Use HEAD~N to go back N commits (e.g., HEAD~10)');
        console.error('');
        console.error('Available tags:');
        try {
            const tags = execSync('git tag -l', { encoding: 'utf-8' }).trim();
            if (tags) {
                console.error(
                    tags
                        .split('\n')
                        .map((t) => `  - ${t}`)
                        .join('\n')
                );
            } else {
                console.error('  (no tags found)');
            }
        } catch (e) {
            console.error('  (unable to list tags)');
        }
        process.exit(1);
    }

    const format = '%H%n%s%n%b%n---COMMIT_END---';

    let output;
    try {
        output = execSync(`git log --pretty=format:"${format}" ${range}`, {
            encoding: 'utf-8',
            maxBuffer: 50 * 1024 * 1024
        });
    } catch (error) {
        console.error('Error: Failed to get commits.');
        console.error(error.message);
        process.exit(1);
    }

    const commits = [];
    const commitBlocks = output.split('---COMMIT_END---').filter((b) => b.trim());

    for (const block of commitBlocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 2) continue;

        const hash = lines[0].trim();
        const subject = lines[1].trim();
        const bodyLines = lines.slice(2);

        // Extract bullets from body
        const bullets = [];
        for (const line of bodyLines) {
            const trimmed = line.trim();
            const match = trimmed.match(BULLET_TAG_PATTERN);
            if (match) {
                bullets.push({
                    type: match[1], // bugfix or feature
                    scope: match[3] || null, // cli, desktop, or null
                    description: match[4].trim()
                });
            }
        }

        if (bullets.length > 0) {
            commits.push({ hash, subject, bullets });
        }
    }

    return commits;
}

function groupByScope(commits) {
    const groups = {
        bugfix: { general: [], cli: [], desktop: [] },
        feature: { general: [], cli: [], desktop: [] }
    };

    for (const commit of commits) {
        for (const bullet of commit.bullets) {
            const scope = bullet.scope || 'general';
            groups[bullet.type][scope].push({
                description: bullet.description,
                hash: commit.hash,
                subject: commit.subject
            });
        }
    }

    return groups;
}

function generateChangelog(groups, lastCommit) {
    const lines = [];

    // Get current date
    const date = new Date().toISOString().split('T')[0];

    lines.push(`# Changelog\n`);
    lines.push(`Generated: ${date}`);
    if (lastCommit) {
        lines.push(`Since: ${lastCommit}`);
    }
    lines.push('');

    // Features section
    const hasFeatures = Object.values(groups.feature).some((arr) => arr.length > 0);
    if (hasFeatures) {
        lines.push('## ✨ Features\n');

        for (const item of groups.feature.general) {
            lines.push(`- ${item.description}`);
        }
        for (const item of groups.feature.cli) {
            lines.push(`- (CLI) ${item.description}`);
        }
        for (const item of groups.feature.desktop) {
            lines.push(`- (Desktop) ${item.description}`);
        }
        lines.push('');
    }

    // Bugfixes section
    const hasBugfixes = Object.values(groups.bugfix).some((arr) => arr.length > 0);
    if (hasBugfixes) {
        lines.push('## 🐛 Bug Fixes\n');

        for (const item of groups.bugfix.general) {
            lines.push(`- ${item.description}`);
        }
        for (const item of groups.bugfix.cli) {
            lines.push(`- (CLI) ${item.description}`);
        }
        for (const item of groups.bugfix.desktop) {
            lines.push(`- (Desktop) ${item.description}`);
        }
        lines.push('');
    }

    // Commit details
    lines.push('---\n');
    lines.push('## 📋 Commit Details\n');

    const allCommits = new Map();
    for (const type of ['feature', 'bugfix']) {
        for (const scope of ['general', 'cli', 'desktop']) {
            for (const item of groups[type][scope]) {
                if (!allCommits.has(item.hash)) {
                    allCommits.set(item.hash, item);
                }
            }
        }
    }

    for (const [hash, item] of allCommits) {
        const shortHash = hash.substring(0, 7);
        lines.push(`- [\`${shortHash}\`] ${item.subject}`);
    }

    return lines.join('\n');
}

function main() {
    const args = parseArgs();

    if (!args.lastCommit) {
        console.error('Error: --last-commit is required\n');
        printUsage();
        process.exit(1);
    }

    const commits = getCommitsSince(args.lastCommit);

    if (args.outputFile) {
        console.log(`Collecting commits since ${args.lastCommit}...`);
        console.log(`Found ${commits.length} commits with bullet tags`);
    }

    const groups = groupByScope(commits);
    const changelog = generateChangelog(groups, args.lastCommit);

    if (args.outputFile) {
        fs.writeFileSync(args.outputFile, changelog);
        console.log(`Changelog saved to ${args.outputFile}`);
    } else {
        console.log(changelog);
    }
}

main();
