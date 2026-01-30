import { logger } from '../../../../utils/logger.js';
import { ImageAnalyzeManager, KEYFRAME_DETECTION } from './imageAnalyzeManager.js';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import sharp from 'sharp';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { RecallMapper } from '../persistence/RecallMapper.js';
import { RecallExtraction } from '../entities/RecallExtraction.js';
import { v4 as uuidv4 } from 'uuid';
import PQueue from 'p-queue';

/**
 * 快照处理器
 * 负责快照处理的业务流程编排：
 * - 判重决策（与上一帧或已有关键帧比较）
 * - 关键帧标记
 * - PDF生成
 * - 与 repository 交互
 */
class SnapshotProcessor {
    constructor(repository, vectorStorage = null) {
        // 使用 Repository 代替直接的数据库实例
        this.repository = repository;
        this.vectorStorage = vectorStorage;  // 新增

        // 创建异步处理队列（并发数为2）
        this.memoryQueue = new PQueue({ concurrency: 2 });  // 新增
    }

    /**
     * 判断当前快照是否与上一快照重复（用于录制时的连续帧判重）
     * @param {Object} currentSnapshot - 当前快照 { hash, imagePath }
     * @param {Object} previousSnapshot - 上一快照 { hash, imagePath }
     * @param {Object} [thresholds] - 阈值配置
     * @returns {Promise<boolean>} true=重复（应跳过），false=不重复（应保存）
     */
    async isDuplicateOfPrevious(currentSnapshot, previousSnapshot, thresholds = {}) {
        if (!previousSnapshot || !currentSnapshot) {
            return false; // 没有上一帧，肯定不重复
        }

        const result = await ImageAnalyzeManager.compareImages(
            currentSnapshot.hash,
            currentSnapshot.imagePath,
            previousSnapshot.hash,
            previousSnapshot.imagePath,
            thresholds
        );

        if (result.isSimilar) {
            logger.debug(`[SnapshotProcessor] Frame is duplicate - hammingDistance: ${result.hammingDistance}, SSIM: ${result.ssimValue?.toFixed(3)}`);
        } else {
            logger.debug(`[SnapshotProcessor] Frame is different - hammingDistance: ${result.hammingDistance}, SSIM: ${result.ssimValue?.toFixed(3)}`);
        }

        return result.isSimilar;
    }

    /**
     * 判断当前快照是否应该成为关键帧
     * @param {Object} currentSnapshot - 当前快照 { hash, imagePath }
     * @param {Array<Object>} existingKeyframes - 已有关键帧列表 [{ hash, imagePath }, ...]
     * @param {Object} [thresholds] - 阈值配置
     * @returns {Promise<boolean>} true=是关键帧，false=不是关键帧
     */
    async isKeyframe(currentSnapshot, existingKeyframes, thresholds = {}) {
        if (!currentSnapshot) {
            return false;
        }

        // 如果没有关键帧，第一个总是关键帧
        if (!existingKeyframes || existingKeyframes.length === 0) {
            logger.debug('[SnapshotProcessor] First frame is always a keyframe');
            return true;
        }

        // 与所有已有关键帧比较
        for (const keyframe of existingKeyframes) {
            const result = await ImageAnalyzeManager.compareImages(
                currentSnapshot.hash,
                currentSnapshot.imagePath,
                keyframe.hash,
                keyframe.imagePath,
                thresholds
            );

            if (result.isSimilar) {
                logger.debug(`[SnapshotProcessor] Frame rejected as keyframe - SSIM: ${result.ssimValue?.toFixed(3)} with existing keyframe`);
                return false; // 与某个关键帧相似，不是关键帧
            }
        }

        logger.debug('[SnapshotProcessor] Frame accepted as keyframe - different from all existing keyframes');
        return true; // 与所有关键帧都不相似，是关键帧
    }

    /**
     * @deprecated 已废弃：状态管理已移至业务层
     * 获取图像分析器实例（向后兼容）
     */
    getImageAnalyzer() {
        logger.warn('[SnapshotProcessor] getImageAnalyzer() is deprecated. Use isDuplicateOfPrevious() or isKeyframe() instead.');
        // 返回一个兼容对象，避免立即崩溃
        return {
            reset: async () => {
                logger.warn('[SnapshotProcessor] ImageAnalyzeManager.reset() is deprecated - no longer needed');
            },
            calculateImageHash: async (imageBuffer) => {
                return await ImageAnalyzeManager.calculateImageHash(imageBuffer);
            }
        };
    }

    /**
     * 处理活动的PDF生成（基于已标记的关键帧）
     * @param {string} activityId 活动ID
     */
    async processActivityResults(activityId) {
        try {
            // 使用 Repository 获取活动信息
            const activityEntity = await this.repository.findActivityById(activityId);
            if (!activityEntity) {
                throw new Error(`Activity not found: ${activityId}`);
            }

            // 转换为数据库格式（后续方法需要）
            const activity = RecallMapper.activityToDb(activityEntity);

            // 使用 Repository 获取所有关键帧快照
            const keyframeEntities = await this.repository.findKeyframesByActivity(activityId);
            const keyframes = keyframeEntities.map(s => RecallMapper.snapshotToDb(s));

            // 如果没有关键帧，查询所有快照并报告
            if (keyframes.length === 0) {
                const allSnapshotEntities = await this.repository.findSnapshotsByActivity(activityId);
                logger.warn(`[SnapshotProcessor] No keyframes found, but activity has ${allSnapshotEntities.length} total snapshots`);

                // 检查是否有快照标记了 isKeyframe
                const markedSnapshots = allSnapshotEntities.filter(s => s.isKeyframe);
                logger.warn(`[SnapshotProcessor] Snapshots with isKeyframe=true: ${markedSnapshots.length}`);

                // 如果有快照但没有关键帧，记录详细信息
                if (allSnapshotEntities.length > 0 && markedSnapshots.length === 0) {
                    logger.warn(`[SnapshotProcessor] All ${allSnapshotEntities.length} snapshots failed keyframe detection - check detection thresholds`);
                }

                // 更新状态并返回
                await this.repository.updateActivityFields(activityId, {
                    pdfStatus: 'no_keyframes',
                    'metadata.pdf.processedAt': Date.now(),
                    'metadata.pdf.totalSnapshots': allSnapshotEntities.length
                });
                return;
            }

            const pdfPath = await this._generateActivityPDF(activityId, activity, keyframes);

            // 更新活动状态
            if (pdfPath) {
                await this.repository.updateActivityFields(activityId, {
                    pdfPath: path.relative(activity.activityPath, pdfPath),
                    pdfStatus: 'completed',
                    keyframeCount: keyframes.length,
                    'metadata.pdf.completedAt': Date.now()
                });
            }

        } catch (error) {
            logger.error(`[SnapshotProcessor] Processing failed: ${error.message}`, error);

            // 更新活动状态为失败
            await this.repository.updateActivityFields(activityId, {
                pdfStatus: 'failed',
                'metadata.pdf.error': error.message,
                'metadata.pdf.failedAt': Date.now()
            });
        }
    }

    /**
     * 根据文本内容分类页面类型
     * @param {string} text 提取的文本
     * @returns {string} 页面类型
     */
    _classifyPageType(text) {
        const lowerText = text.toLowerCase();

        // 标题页特征
        if (lowerText.includes('title') || lowerText.includes('标题') ||
            lowerText.includes('主题') || text.length < 100) {
            return 'title';
        }

        // 总结页特征
        if (lowerText.includes('summary') || lowerText.includes('总结') ||
            lowerText.includes('结论') || lowerText.includes('conclusion') ||
            lowerText.includes('thank') || lowerText.includes('谢谢')) {
            return 'summary';
        }

        // 议程页特征
        if (lowerText.includes('agenda') || lowerText.includes('议程') ||
            lowerText.includes('目录') || lowerText.includes('outline')) {
            return 'agenda';
        }

        // 默认为内容页
        return 'content';
    }

    /**
     * 生成活动PDF文档
     * @param {string} activityId 活动ID
     * @param {Object} activity 活动对象
     * @param {Array} keyframes 关键帧列表
     * @returns {Promise<string|null>} PDF文件路径
     */
    async _generateActivityPDF(activityId, activity, keyframes) {
        try {
            // 创建PDF文档
            const pdfDoc = await PDFDocument.create();

            // 注册fontkit以支持自定义字体的完整Unicode编码（支持中文）
            pdfDoc.registerFontkit(fontkit);

            // 嵌入支持中文的字体
            let normalFont;
            try {
                // 尝试嵌入支持中文的字体
                normalFont = await this._embedChineseFont(pdfDoc);
            } catch (error) {
                logger.error(`[SnapshotProcessor] CRITICAL: Failed to embed Chinese font, falling back to standard fonts: ${error.message}`);
                logger.error(`[SnapshotProcessor] Stack trace: ${error.stack}`);
                // 回退到标准字体（仅英文）
                normalFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
            }

            // OCR功能已禁用，不提取文本内容

            // 添加封面页
            await this._addCoverPage(pdfDoc, activity, keyframes.length, normalFont);

            // 添加内容页（每个关键帧一页）
            for (let i = 0; i < keyframes.length; i++) {
                const keyframe = keyframes[i];
                await this._addContentPage(pdfDoc, activity, keyframe, null, i + 1, keyframes.length, normalFont);
            }

            // 保存PDF
            const pdfFileName = `${activity.activityName.replace(/[/\\?%*:|"<>]/g, '_')}_activity.pdf`;
            const pdfPath = path.join(activity.activityPath, pdfFileName);

            const pdfBytes = await pdfDoc.save();
            // 使用异步写入，避免阻塞事件循环
            await fsPromises.writeFile(pdfPath, pdfBytes);
            return pdfPath;

        } catch (error) {
            logger.error(`[SnapshotProcessor] Failed to generate PDF: ${error.message}`);
            return null;
        }
    }

    /**
     * 添加PDF封面页
     */
    async _addCoverPage(pdfDoc, activity, keyframeCount, font) {
        const page = pdfDoc.addPage([595, 842]); // A4 size
        const { width, height } = page.getSize();

        const startDate = new Date(activity.startTime);
        const endDate = activity.endTime ? new Date(activity.endTime) : new Date();
        const durationMinutes = Math.round((activity.duration || 0) / 1000 / 60);

        // 标题背景
        page.drawRectangle({
            x: 0,
            y: height - 150,
            width: width,
            height: 150,
            color: rgb(0.2, 0.4, 0.6)
        });

        // 标题
        this._safeDrawText(page, '活动记录', {
            x: 50,
            y: height - 80,
            size: 32,
            font: font,
            color: rgb(1, 1, 1)
        });

        // 活动名称
        const activityName = activity.activityName || '未命名活动';
        this._safeDrawText(page, activityName, {
            x: 50,
            y: height - 120,
            size: 16,
            font: font,
            color: rgb(0.9, 0.9, 0.9)
        });

        // 活动信息区域
        const infoStartY = height - 220;
        const lineHeight = 30;

        this._safeDrawText(page, '活动信息', {
            x: 50,
            y: infoStartY,
            size: 14,
            font: font,
            color: rgb(0.2, 0.2, 0.2)
        });

        // 分隔线
        page.drawLine({
            start: { x: 50, y: infoStartY - 10 },
            end: { x: width - 50, y: infoStartY - 10 },
            thickness: 1,
            color: rgb(0.8, 0.8, 0.8)
        });

        const infoItems = [
            { label: '开始时间', value: startDate.toLocaleString('zh-CN') },
            { label: '结束时间', value: endDate.toLocaleString('zh-CN') },
            { label: '活动时长', value: `${durationMinutes} 分钟` },
            { label: '关键页面', value: `${keyframeCount} 页` },
            { label: '生成时间', value: new Date().toLocaleString('zh-CN') }
        ];

        let currentY = infoStartY - 40;
        for (const item of infoItems) {
            this._safeDrawText(page, `${item.label}:`, {
                x: 50,
                y: currentY,
                size: 11,
                font: font,
                color: rgb(0.4, 0.4, 0.4)
            });

            this._safeDrawText(page, item.value, {
                x: 150,
                y: currentY,
                size: 11,
                font: font,
                color: rgb(0.2, 0.2, 0.2)
            });

            currentY -= lineHeight;
        }

        // 底部说明
        this._safeDrawText(page, '由 FillipDesk Recall 自动生成', {
            x: 50,
            y: 50,
            size: 10,
            font: font,
            color: rgb(0.6, 0.6, 0.6)
        });
    }

    /**
     * 添加PDF内容页
     */
    async _addContentPage(pdfDoc, activity, keyframe, extraction, pageNum, totalPages, font) {
        const page = pdfDoc.addPage([595, 842]); // A4 size
        const { width, height } = page.getSize();

        // 页面顶部信息栏
        page.drawRectangle({
            x: 0,
            y: height - 40,
            width: width,
            height: 40,
            color: rgb(0.95, 0.95, 0.95)
        });

        // 页码
        this._safeDrawText(page, `第 ${pageNum} 页 / 共 ${totalPages} 页`, {
            x: 50,
            y: height - 28,
            size: 10,
            font: font,
            color: rgb(0.4, 0.4, 0.4)
        });

        // 时间戳
        const timestamp = new Date(keyframe.createdAt);
        this._safeDrawText(page, timestamp.toLocaleString('zh-CN'), {
            x: width - 150,
            y: height - 28,
            size: 10,
            font: font,
            color: rgb(0.4, 0.4, 0.4)
        });

        // 嵌入关键帧图像
        const imageAreaTop = height - 60;
        const imageAreaHeight = 400;
        const imageAreaWidth = width - 100;

        try {
            const imagePath = path.join(activity.activityPath, keyframe.imagePath);

            if (fs.existsSync(imagePath)) {
                await this._embedImage(pdfDoc, page, imagePath, 50, imageAreaTop - imageAreaHeight, imageAreaWidth, imageAreaHeight);
            } else {
                // 显示占位符
                page.drawRectangle({
                    x: 50,
                    y: imageAreaTop - imageAreaHeight,
                    width: imageAreaWidth,
                    height: imageAreaHeight,
                    borderColor: rgb(0.8, 0.8, 0.8),
                    borderWidth: 1
                });

                this._safeDrawText(page, '图像文件未找到', {
                    x: width / 2 - 50,
                    y: imageAreaTop - imageAreaHeight / 2,
                    size: 12,
                    font: font,
                    color: rgb(0.6, 0.6, 0.6)
                });
            }
        } catch (error) {
            logger.warn(`[SnapshotProcessor] Failed to embed image: ${error.message}`);
        }

        // OCR功能已禁用，不显示文本区域
    }

    /**
     * 在PDF页面中嵌入图像
     */
    async _embedImage(pdfDoc, page, imagePath, x, y, maxWidth, maxHeight) {
        // 使用异步读取，避免阻塞事件循环
        const imageBytes = await fsPromises.readFile(imagePath);

        // 检测图像格式并处理
        let image;
        const ext = path.extname(imagePath).toLowerCase();

        if (ext === '.png') {
            image = await pdfDoc.embedPng(imageBytes);
        } else if (ext === '.jpg' || ext === '.jpeg') {
            image = await pdfDoc.embedJpg(imageBytes);
        } else {
            // 对于WebP等格式，转换为PNG
            const pngBuffer = await sharp(imageBytes).png().toBuffer();
            image = await pdfDoc.embedPng(pngBuffer);
        }

        // 计算缩放比例以适应区域
        const imageDims = image.scale(1);
        const scaleX = maxWidth / imageDims.width;
        const scaleY = maxHeight / imageDims.height;
        const scale = Math.min(scaleX, scaleY, 1); // 不放大，只缩小

        const scaledWidth = imageDims.width * scale;
        const scaledHeight = imageDims.height * scale;

        // 居中显示
        const centeredX = x + (maxWidth - scaledWidth) / 2;
        const centeredY = y + (maxHeight - scaledHeight) / 2;

        // 绘制图像
        page.drawImage(image, {
            x: centeredX,
            y: centeredY,
            width: scaledWidth,
            height: scaledHeight
        });
    }

    /**
     * 文本自动换行处理
     */
    _wrapText(text, font, fontSize, maxWidth) {
        if (!text) return [];

        const lines = [];
        const paragraphs = text.split('\n');

        for (const paragraph of paragraphs) {
            if (paragraph.trim().length === 0) continue;

            let currentLine = '';
            // 对于中文，按字符分割；对于英文，保持单词完整性
            const chars = Array.from(paragraph);

            for (const char of chars) {
                const testLine = currentLine + char;
                let width;
                
                try {
                    width = font.widthOfTextAtSize(testLine, fontSize);
                } catch (error) {
                    // 如果字体不支持某个字符，使用默认宽度估算
                    width = testLine.length * fontSize * 0.6;
                }

                if (width > maxWidth && currentLine.length > 0) {
                    lines.push(currentLine);
                    currentLine = char;
                } else {
                    currentLine = testLine;
                }
            }

            if (currentLine.length > 0) {
                lines.push(currentLine);
            }
        }

        return lines;
    }

    /**
     * 重新生成活动PDF
     * @param {string} activityId 活动ID
     */
    async regenerateActivityPDF(activityId) {
        try {
            // 使用 Repository 查找活动
            const activityEntity = await this.repository.findActivityById(activityId);
            if (!activityEntity) {
                return { success: false, message: 'Activity not found' };
            }

            // 异步重新生成PDF
            this.processActivityResults(activityId).catch(error => {
                logger.error(`[SnapshotProcessor] Failed to regenerate PDF: ${error.message}`);
            });

            return { success: true, message: 'PDF regeneration started' };
        } catch (error) {
            logger.error(`[SnapshotProcessor] Failed to regenerate activity PDF: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 获取活动的关键帧
     * @param {string} activityId 活动ID
     */
    async getActivityKeyframes(activityId) {
        try {
            // 使用 Repository 查找活动
            const activityEntity = await this.repository.findActivityById(activityId);
            if (!activityEntity) {
                return { success: false, message: 'Activity not found' };
            }

            // 使用 Repository 查询关键帧
            const keyframeEntities = await this.repository.findKeyframesByActivity(activityId);
            const keyframes = keyframeEntities.map(s => RecallMapper.snapshotToDb(s));

            return { success: true, keyframes };
        } catch (error) {
            logger.error(`[SnapshotProcessor] Failed to get activity keyframes: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 获取活动的OCR提取内容
     * @param {string} activityId 活动ID
     */
    async getActivityExtractions(activityId) {
        try {
            // 使用 Repository 查询提取内容（通过 findSnapshotsByActivity 获取所有快照，再获取提取内容）
            const snapshotEntities = await this.repository.findSnapshotsByActivity(activityId);
            const allExtractions = [];

            for (const snapshot of snapshotEntities) {
                const snapshotExtractions = await this.repository.findExtractionsBySnapshot(snapshot.snapshotId);
                allExtractions.push(...snapshotExtractions);
            }

            // 转换为数据库格式并按时间排序
            const extractions = allExtractions
                .map(e => RecallMapper.extractionToDb(e))
                .sort((a, b) => a.createdAt - b.createdAt);

            return { success: true, extractions };
        } catch (error) {
            logger.error(`[SnapshotProcessor] Failed to get activity extractions: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 安全地绘制文本到PDF页面，处理字体不支持的字符
     */
    _safeDrawText(page, text, options) {
        try {
            page.drawText(text, options);
        } catch (error) {
            if (error.message.includes('cannot encode') || error.message.includes('WinAnsi')) {
                logger.error(`[SnapshotProcessor] Font encoding error: ${error.message}`);
                logger.error(`[SnapshotProcessor] Font name: ${options.font.name || 'Unknown'}`);
                logger.error(`[SnapshotProcessor] Problematic text sample: "${text.substring(0, 50)}..."`);
                logger.error(`[SnapshotProcessor] This may indicate that fontkit was not properly registered or the font does not support Unicode`);

                // 如果字体不支持某些字符，尝试过滤或替换
                let filteredText = '';
                for (const char of text) {
                    try {
                        // 测试字符是否可以被编码
                        options.font.widthOfTextAtSize(char, options.size || 12);
                        filteredText += char;
                    } catch (charError) {
                        logger.warn(`[SnapshotProcessor] Character '${char}' (U+${char.charCodeAt(0).toString(16)}) cannot be encoded by font`);
                        // 用问号替换不支持的字符
                        filteredText += '?';
                    }
                }

                if (filteredText !== text) {
                    logger.warn(`[SnapshotProcessor] ${text.length - filteredText.replace(/\?/g, '').length} characters were replaced with '?' due to font encoding issues`);
                }

                page.drawText(filteredText, options);
            } else {
                throw error;
            }
        }
    }

    /**
     * 嵌入支持中文的字体（使用项目内置字体）
     */
    async _embedChineseFont(pdfDoc) {
        const fontPaths = [
            path.join('resources', 'main', 'applications', 'recall', 'assets', 'fonts', 'AlibabaPuHuiTi-3-55-Regular.otf')
        ];

        let fontPath = null;
        for (const tryPath of fontPaths) {
            if (fs.existsSync(tryPath)) {
                fontPath = tryPath;
                break;
            } else {
                logger.debug(`[SnapshotProcessor] Font not found at: ${tryPath}`);
            }
        }

        if (!fontPath) {
            logger.error(`[SnapshotProcessor] Bundled font not found in any of the following paths:`);
            fontPaths.forEach(p => logger.error(`  - ${p}`));
            throw new Error('Bundled font file not found in any expected location');
        }

        try {
            // 使用异步读取，避免阻塞事件循环
            const fontBytes = await fsPromises.readFile(fontPath);
            // 使用subset选项以支持完整的Unicode字符集（包括中文）
            const font = await pdfDoc.embedFont(fontBytes, { subset: true });

            return font;
        } catch (error) {
            logger.error(`[SnapshotProcessor] Failed to embed bundled font: ${error.message}`);
            throw error;
        }
    }

    /**
     * 批量异步处理快照，生成记忆
     * @param {Array<{snapshotId: string, imagePath: string, activityId: string}>} snapshots
     * @param {number} batchSize - 每批处理数量（默认5张）
     */
    async processSnapshotsMemory(snapshots, batchSize = 5) {
        if (!snapshots || snapshots.length === 0) {
            logger.info('[SnapshotProcessor] No snapshots to process for memory generation');
            return;
        }

        logger.info(`[SnapshotProcessor] Starting memory generation for ${snapshots.length} snapshots`);

        // 分批处理
        for (let i = 0; i < snapshots.length; i += batchSize) {
            const batch = snapshots.slice(i, i + batchSize);

            // 添加到队列异步处理
            this.memoryQueue.add(async () => {
                await this._processBatchMemory(batch);
            }).catch(error => {
                logger.error(`[SnapshotProcessor] Failed to process batch ${i}-${i + batch.length}: ${error.message}`);
            });
        }

        logger.info(`[SnapshotProcessor] Memory generation tasks queued (${Math.ceil(snapshots.length / batchSize)} batches)`);
    }

    /**
     * 处理一批快照的记忆生成（内部方法）
     * @private
     */
    async _processBatchMemory(batch) {
        try {
            const startTime = Date.now();
            logger.debug(`[SnapshotProcessor] Processing batch of ${batch.length} snapshots`);

            // 准备图片数据
            const imageInputs = [];
            for (const snapshot of batch) {
                try {
                    const imageBuffer = await fsPromises.readFile(snapshot.imagePath);
                    const base64 = imageBuffer.toString('base64');
                    const ext = path.extname(snapshot.imagePath).toLowerCase();
                    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
                    const imageUrl = `data:${mimeType};base64,${base64}`;

                    imageInputs.push({
                        snapshotId: snapshot.snapshotId,
                        imageUrl
                    });
                } catch (error) {
                    logger.warn(`[SnapshotProcessor] Failed to read image ${snapshot.imagePath}: ${error.message}`);
                }
            }

            if (imageInputs.length === 0) {
                logger.warn('[SnapshotProcessor] No valid images in batch');
                return;
            }

            // 调用多模态模型生成记忆
            const memories = await ImageAnalyzeManager.batchGenerateMemories(imageInputs);

            // 批量保存记忆到数据库
            const validMemories = [];
            for (const memory of memories) {
                if (!memory.summary || memory.summary.trim() === '') {
                    logger.debug(`[SnapshotProcessor] Skipping empty memory for snapshot ${memory.snapshotId}`);
                    continue;
                }

                const snapshot = batch.find(s => s.snapshotId === memory.snapshotId);
                if (!snapshot) {
                    continue;
                }

                // 创建 Extraction 实体
                const extraction = new RecallExtraction(
                    uuidv4(),
                    snapshot.snapshotId,
                    snapshot.activityId,
                    {
                        contentType: 'llm',
                        content: memory.summary,
                        confidence: 100,
                        pageType: 'summary'
                    }
                );

                // 保存到数据库
                await this.repository.saveExtraction(extraction);

                // 更新快照的 hasExtraction 标记
                await this.repository.updateSnapshotFields(snapshot.snapshotId, {
                    hasExtraction: 1,
                    extractionStatus: 'completed'
                });

                validMemories.push({
                    snapshotId: snapshot.snapshotId,
                    summary: memory.summary
                });

                logger.debug(`[SnapshotProcessor] Saved memory for snapshot ${snapshot.snapshotId}: "${memory.summary}"`);
            }

            // 批量保存到向量库（使用 batchEmbed）
            if (this.vectorStorage && validMemories.length > 0) {
                try {
                    await this.vectorStorage.batchSaveMemories(validMemories);
                    logger.info(`[SnapshotProcessor] Saved ${validMemories.length} memories to vector storage`);
                } catch (error) {
                    logger.error(`[SnapshotProcessor] Failed to save to vector storage: ${error.message}`);
                }
            }

            const elapsedTime = Date.now() - startTime;
            logger.info(`[SnapshotProcessor] Batch processed in ${elapsedTime}ms (${memories.length} memories generated)`);

        } catch (error) {
            logger.error(`[SnapshotProcessor] Failed to process batch: ${error.message}`, error);
            throw error;
        }
    }

    /**
     * 等待所有记忆生成任务完成
     */
    async waitForMemoryProcessing() {
        await this.memoryQueue.onIdle();
        logger.info('[SnapshotProcessor] All memory generation tasks completed');
    }

    /**
     * 清理资源
     */
    async cleanup() {
        if (this.imageAnalyzer) {
            this.imageAnalyzer = null;
        }

        // 清空队列
        this.memoryQueue.clear();  // 新增
    }
}

export { SnapshotProcessor };
