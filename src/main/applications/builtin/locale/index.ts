import { getLocale } from '../../../../locale/index.js';
import { zhCn } from './zh-cn.js';
import { enUs } from './en-us.js';

const translations: Record<string, Record<string, string>> = {
    'zh-CN': zhCn,
    'en-US': enUs
};

export function t(key: string): string {
    const locale = getLocale();
    return translations[locale]?.[key] ?? translations['zh-CN']?.[key] ?? key;
}
