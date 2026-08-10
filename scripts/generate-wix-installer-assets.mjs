/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const outputDir = path.join(projectRoot, 'resources', 'package', 'installer');
const bootstrapperOutputDir = path.join(projectRoot, 'resources', 'package', 'bootstrapper');
const iconPath = path.join(outputDir, 'opendesk-icon.png');

const colors = {
    surface: [248, 250, 250],
    sidebar: [32, 42, 45],
    sidebarRing: [39, 74, 71],
    teal: [8, 127, 114],
    coral: [223, 108, 82],
    line: [221, 230, 231]
};

function createCanvas(width, height, color) {
    const pixels = Buffer.alloc(width * height * 3);
    for (let offset = 0; offset < pixels.length; offset += 3) {
        pixels[offset] = color[0];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[2];
    }
    return pixels;
}

function setPixel(pixels, width, height, x, y, color) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = (y * width + x) * 3;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
}

function fillRect(pixels, width, height, left, top, rectWidth, rectHeight, color) {
    for (let y = top; y < top + rectHeight; y += 1) {
        for (let x = left; x < left + rectWidth; x += 1) {
            setPixel(pixels, width, height, x, y, color);
        }
    }
}

function fillRoundedRect(pixels, width, height, left, top, rectWidth, rectHeight, radius, color) {
    for (let y = top; y < top + rectHeight; y += 1) {
        for (let x = left; x < left + rectWidth; x += 1) {
            const nearestX = Math.max(left + radius, Math.min(x, left + rectWidth - radius - 1));
            const nearestY = Math.max(top + radius, Math.min(y, top + rectHeight - radius - 1));
            if ((x - nearestX) ** 2 + (y - nearestY) ** 2 <= radius ** 2) {
                setPixel(pixels, width, height, x, y, color);
            }
        }
    }
}

function drawRing(pixels, width, height, centerX, centerY, radius, thickness, color) {
    const innerSquared = (radius - thickness) ** 2;
    const outerSquared = radius ** 2;
    for (let y = centerY - radius; y <= centerY + radius; y += 1) {
        for (let x = centerX - radius; x <= centerX + radius; x += 1) {
            const distanceSquared = (x - centerX) ** 2 + (y - centerY) ** 2;
            if (distanceSquared >= innerSquared && distanceSquared <= outerSquared) {
                setPixel(pixels, width, height, x, y, color);
            }
        }
    }
}

async function createDialogBackground() {
    const width = 493;
    const height = 312;
    const pixels = createCanvas(width, height, colors.surface);

    fillRect(pixels, width, height, 0, 0, 124, height, colors.sidebar);
    fillRect(pixels, width, height, 124, 0, 4, height, colors.teal);
    drawRing(pixels, width, height, 105, 252, 76, 18, colors.sidebarRing);
    fillRect(pixels, width, height, 58, 282, 48, 5, colors.coral);

    await sharp(pixels, { raw: { width, height, channels: 3 } })
        .composite([{ input: await sharp(iconPath).resize(52, 52).png().toBuffer(), left: 35, top: 38 }])
        .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
        .toFile(path.join(outputDir, 'dialog.jpg'));
}

async function createBanner() {
    const width = 493;
    const height = 58;
    const pixels = createCanvas(width, height, colors.surface);

    fillRect(pixels, width, height, 0, height - 2, width, 2, colors.line);
    fillRect(pixels, width, height, 0, 0, 5, height - 2, colors.teal);
    fillRect(pixels, width, height, 435, 0, 58, height - 2, colors.sidebar);
    fillRect(pixels, width, height, 435, height - 6, 58, 4, colors.coral);

    await sharp(pixels, { raw: { width, height, channels: 3 } })
        .composite([{ input: await sharp(iconPath).resize(34, 34).png().toBuffer(), left: 447, top: 10 }])
        .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
        .toFile(path.join(outputDir, 'banner.jpg'));
}

async function createBootstrapperBackground() {
    const width = 920;
    const height = 600;
    const pixels = createCanvas(width, height, colors.surface);

    fillRect(pixels, width, height, 0, 0, 280, height, colors.sidebar);
    drawRing(pixels, width, height, 252, 474, 105, 24, colors.sidebarRing);
    fillRect(pixels, width, height, 170, 552, 64, 7, colors.coral);
    fillRect(pixels, width, height, 280, 0, width - 280, height, colors.surface);
    fillRect(pixels, width, height, 280, 0, 4, height, colors.teal);
    fillRect(pixels, width, height, 284, 516, width - 284, 84, [252, 253, 253]);
    fillRect(pixels, width, height, 284, 515, width - 284, 1, colors.line);

    await sharp(pixels, { raw: { width, height, channels: 3 } })
        .composite([{ input: await sharp(iconPath).resize(50, 50).png().toBuffer(), left: 198, top: 28 }])
        .png()
        .toFile(path.join(bootstrapperOutputDir, 'background.png'));
}

async function createFeatureRows() {
    const width = 530;
    const height = 238;
    const pixels = createCanvas(width, height, colors.surface);

    for (const top of [0, 74, 148]) {
        fillRoundedRect(pixels, width, height, 0, top, 36, 36, 5, [229, 243, 240]);
        fillRect(pixels, width, height, 0, top + 57, width, 1, colors.line);
    }

    await sharp(pixels, { raw: { width, height, channels: 3 } })
        .png()
        .toFile(path.join(bootstrapperOutputDir, 'feature-rows.png'));
}

async function createProgressImage() {
    const width = 4;
    const height = 18;
    const pixels = createCanvas(width, height, colors.line);

    fillRect(pixels, width, height, 0, 0, 2, height, colors.teal);

    await sharp(pixels, { raw: { width, height, channels: 3 } })
        .png()
        .toFile(path.join(bootstrapperOutputDir, 'progress.png'));
}

await Promise.all([
    createDialogBackground(),
    createBanner(),
    createBootstrapperBackground(),
    createFeatureRows(),
    createProgressImage()
]);
console.log(`Generated WiX installer assets in ${outputDir}`);
