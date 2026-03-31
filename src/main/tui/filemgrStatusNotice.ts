import { ApplicationRegistry } from "../applications/registry";
import { Setting } from "../utils/setting.js";
import { logger } from "../utils/logger.js";

export function getFilemgrStatusNotice(modelNotConfiguredMode: boolean): string {
    if (modelNotConfiguredMode || !ApplicationRegistry.isRegistryReady()) {
        return '';
    }

    const setting = Setting.getInstance();
    const filemgrConfig = (setting.getData() as any).applications?.filemgr;
    const entries = filemgrConfig?.entries ?? [];

    if (entries.length === 0) {
        logger.warn('文件搜索未启用：运行 /config -> 文件扫描配置 添加扫描目录');
        return '⚠ 文件扫描目录未配置';
    }

    try {
        setting.getDefaultEmbeddingModelInstance();
    } catch {
        logger.warn('文件检索向量功能未启用：请在 /config -> 默认模型配置 设置“向量嵌入模型”');
        return '⚠ 向量嵌入模型未配置';
    }

    return '';
}
