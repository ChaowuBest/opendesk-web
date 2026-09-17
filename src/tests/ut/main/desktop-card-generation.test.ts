import {
    buildCardGenerationPrompt,
    extractHtmlFromAssistantText,
    getLastAssistantMessageText,
    normalizeCardData,
    summarizeCardPromptForTaskName
} from '../../../main/desktop/cardGeneration.js';

describe('desktop card generation helpers', () => {
    test("generation task uses the selected model's supported minimum reasoning effort", () => {
        const handler = readFileSync(new URL('../../../main/desktop/handlers.ts', import.meta.url), 'utf8');
        expect(handler).toContain(
            'task.reasoningEffort = LLM.getMinimalReasoningEffort(task.ensureValidModelOrFallback());'
        );
    });
    test('summarizeCardPromptForTaskName trims and truncates long prompts', () => {
        expect(summarizeCardPromptForTaskName('  每日天气  ')).toBe('每日天气');
        const long = 'a'.repeat(40);
        const summary = summarizeCardPromptForTaskName(long);
        expect(summary.length).toBe(32 + 3);
        expect(summary.endsWith('...')).toBe(true);
    });

    test('normalizeCardData returns arrays only', () => {
        expect(normalizeCardData(undefined)).toEqual([]);
        expect(normalizeCardData({})).toEqual([]);
        expect(normalizeCardData([1, 2])).toEqual([1, 2]);
    });

    test('extractHtmlFromAssistantText unwraps markdown code blocks', () => {
        const text = '说明\n```html\n<div class="card">hello</div>\n```\n';
        expect(extractHtmlFromAssistantText(text)).toBe('<div class="card">hello</div>');
    });

    test('extractHtmlFromAssistantText extracts full documents and fragments', () => {
        const doc = '<!doctype html><html><body><p>x</p></body></html>';
        expect(extractHtmlFromAssistantText(`前缀 ${doc} 后缀`)).toBe(doc);
        expect(extractHtmlFromAssistantText('纯文本说明 <section><p>内容</p></section> 结束')).toBe(
            '<section><p>内容</p></section>'
        );
        expect(extractHtmlFromAssistantText('没有任何标签')).toBe('没有任何标签');
    });

    test('getLastAssistantMessageText reads the latest assistant message with mixed content', () => {
        const task = {
            chat_context: {
                messages: [
                    { role: 'user', content: '需求' },
                    { role: 'assistant', content: [{ type: 'text', text: '<div>v1</div>' }] },
                    { role: 'user', content: '改一下' },
                    { role: 'assistant', content: '<div>v2</div>' }
                ]
            }
        };
        expect(getLastAssistantMessageText(task as any)).toBe('<div>v2</div>');
    });

    test('getLastAssistantMessageText returns empty string without assistant messages', () => {
        const task = { chat_context: { messages: [{ role: 'user', content: 'hi' }] } };
        expect(getLastAssistantMessageText(task as any)).toBe('');
        expect(getLastAssistantMessageText({ chat_context: { messages: [] } } as any)).toBe('');
    });

    test('buildCardGenerationPrompt embeds requirements, size, locale and theme', () => {
        const prompt = buildCardGenerationPrompt({
            prompt: '今日日程',
            width: 420.4,
            height: 320.6,
            locale: 'zh-CN',
            theme: 'dark'
        });
        expect(prompt).toContain('今日日程');
        expect(prompt).toContain('420px x 321px');
        expect(prompt).toContain('zh-CN');
        expect(prompt).toContain('深色');
        expect(prompt).toContain('当前卡片没有已有内容');

        const withHtml = buildCardGenerationPrompt({
            prompt: '天气',
            currentHtml: '<div>old</div>',
            width: 400,
            height: 300,
            theme: 'light'
        });
        expect(withHtml).toContain('<div>old</div>');
        expect(withHtml).toContain('浅色');
        expect(withHtml).toContain('界面语言：zh-CN');
    });
});
import { readFileSync } from 'node:fs';
