import { parseAndValidateSkillMd } from '../../../main/applications/skillmgr/skill-schema';

describe('skillmgr skill markdown parsing', () => {
    test('uses fallback name for markdown files without frontmatter', () => {
        const result = parseAndValidateSkillMd(
            [
                '# AgentMemory Skill',
                '',
                'Persistent memory system for AI agents. Remember facts, learn from experience, and track entities across sessions.'
            ].join('\n'),
            'agent-memory'
        );

        expect(result.valid).toBe(true);
        expect(result.name).toBe('agent-memory');
        expect(result.description).toBe(
            'Persistent memory system for AI agents. Remember facts, learn from experience, and track entities across sessions.'
        );
    });

    test('repairs unquoted colons in frontmatter values', () => {
        const result = parseAndValidateSkillMd(
            [
                '---',
                'slug: clawquest-agent-mine-openclaw',
                'name: ClawQuest: Agent Mine - OpenClaw Managed Mining',
                'description: Managed mining over public game APIs using X-Api-Code authentication.',
                '---',
                '',
                '# ClawQuest'
            ].join('\n')
        );

        expect(result.valid).toBe(true);
        expect(result.name).toBe('ClawQuest: Agent Mine - OpenClaw Managed Mining');
    });

    test('ignores merge conflict markers in frontmatter', () => {
        const result = parseAndValidateSkillMd(
            [
                '---',
                'name: obsidian-daily',
                'description: Manage Obsidian Daily Notes via obsidian-cli.',
                '<<<<<<< Updated upstream',
                'metadata:',
                '  author: github.com/bastos',
                '=======',
                '>>>>>>> Stashed changes',
                '---',
                '',
                '# Obsidian Daily Notes'
            ].join('\n')
        );

        expect(result.valid).toBe(true);
        expect(result.name).toBe('obsidian-daily');
    });

    test('ignores stray backticks attached to the opening frontmatter fence', () => {
        const result = parseAndValidateSkillMd(
            [
                '---`',
                'name: wecom',
                'description: Send messages to WeCom via webhooks using MCP protocol.',
                '---',
                '',
                '# WeCom Skill'
            ].join('\n')
        );

        expect(result.valid).toBe(true);
        expect(result.name).toBe('wecom');
    });

    test('falls back to top-level scalar fields when YAML indentation is malformed', () => {
        const result = parseAndValidateSkillMd(
            [
                '---',
                'name: 命理大师',
                '  version: 1.2.6',
                '  description: 全体系命理大师',
                'metadata:',
                '  displayName: "命理大师"',
                '---',
                '',
                '# 命理大师'
            ].join('\n'),
            'university-applications'
        );

        expect(result.valid).toBe(true);
        expect(result.name).toBe('命理大师');
        expect(result.description).toBe('A skill imported into OpenDesk');
    });

    test('does not treat markdown separators as a frontmatter closing fence', () => {
        const result = parseAndValidateSkillMd(
            [
                '---',
                'name: gogcli',
                'description: Google Workspace CLI for Gmail, Calendar, Drive, Sheets, Docs, Slides, Contacts, Tasks, People, Groups, Keep.',
                '',
                '# gogcli - Google Workspace CLI',
                '',
                '---',
                '',
                '## Overview'
            ].join('\n')
        );

        expect(result.valid).toBe(true);
        expect(result.name).toBe('gogcli');
        expect(result.description).toBe(
            'Google Workspace CLI for Gmail, Calendar, Drive, Sheets, Docs, Slides, Contacts, Tasks, People, Groups, Keep.'
        );
    });

    test('skips an empty frontmatter block before a valid one', () => {
        const result = parseAndValidateSkillMd(
            [
                '---',
                '---',
                'slug: douyin-copy-extract',
                'name: douyin_copy_extract',
                'description: 粘贴短视频分享链接，一键提取标题、简介、口播文案。',
                '---',
                '',
                '# 技能逻辑'
            ].join('\n')
        );

        expect(result.valid).toBe(true);
        expect(result.name).toBe('douyin_copy_extract');
        expect(result.description).toBe('粘贴短视频分享链接，一键提取标题、简介、口播文案。');
    });
});
