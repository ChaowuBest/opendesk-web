export interface ProviderTemplate {
    name: string;
    displayName: string;
    base_url: string;
}

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
    { name: 'openai', displayName: 'OpenAI', base_url: 'https://api.openai.com/v1' },
    { name: 'openrouter', displayName: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1' },
    { name: 'siliconflow', displayName: 'Siliconflow', base_url: 'https://api.siliconflow.cn/v1' },
    { name: 'deepseek', displayName: 'DeepSeek', base_url: 'https://api.deepseek.com' },
    { name: 'anthropic', displayName: 'Anthropic', base_url: 'https://api.anthropic.com/v1' },
    { name: 'google', displayName: 'Google AI', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai' },
];
