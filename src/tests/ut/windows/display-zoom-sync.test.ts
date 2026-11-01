import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

import { DisplayZoomSync } from '../../../main/windows/display-zoom-sync.ts';

const mainSource = readFileSync(new URL('../../../main/main.ts', import.meta.url), 'utf8');

class FakeWindow {
    readonly zoomFactors: number[] = [];
    destroyed = false;
    readonly webContents = {
        setZoomFactor: (factor: number) => {
            this.zoomFactors.push(factor);
        }
    };

    isDestroyed(): boolean {
        return this.destroyed;
    }
}

/** webContents 先于窗口销毁的替身：setZoomFactor 会像 Electron 一样抛错。 */
class BrokenWindow extends FakeWindow {
    override readonly webContents = {
        setZoomFactor: (_factor: number): void => {
            throw new Error('Object has been destroyed');
        }
    };
}

describe('DisplayZoomSync', () => {
    test('把同一缩放系数应用到主窗口与独立应用窗口', () => {
        const sync = new DisplayZoomSync<FakeWindow>();
        const main = new FakeWindow();
        const app = new FakeWindow();
        sync.add(main);
        sync.add(app);

        const applied = sync.apply(1.2);

        expect(applied).toEqual([main, app]);
        expect(main.zoomFactors).toEqual([1.2]);
        expect(app.zoomFactors).toEqual([1.2]);
    });

    test('已销毁的窗口不再应用缩放并被剔除', () => {
        const sync = new DisplayZoomSync<FakeWindow>();
        const main = new FakeWindow();
        const closed = new FakeWindow();
        sync.add(main);
        sync.add(closed);
        closed.destroyed = true;

        expect(sync.apply(0.8)).toEqual([main]);
        expect(closed.zoomFactors).toEqual([]);

        // 已剔除的窗口即使之后重新存活也不会被应用
        closed.destroyed = false;
        sync.apply(0.9);
        expect(closed.zoomFactors).toEqual([]);
        expect(main.zoomFactors).toEqual([0.8, 0.9]);
    });

    test('窗口关闭后 remove 不再参与同步', () => {
        const sync = new DisplayZoomSync<FakeWindow>();
        const app = new FakeWindow();
        sync.add(app);
        sync.remove(app);

        expect(sync.apply(1.5)).toEqual([]);
        expect(app.zoomFactors).toEqual([]);
    });

    test('单个窗口应用失败不阻断其余窗口', () => {
        const sync = new DisplayZoomSync<FakeWindow>();
        const main = new FakeWindow();
        const broken = new BrokenWindow();
        const app = new FakeWindow();
        sync.add(broken);
        sync.add(main);
        sync.add(app);

        // 抛错的窗口既不算应用成功，也不影响后面的主窗口 / 独立应用窗口
        expect(sync.apply(1.3)).toEqual([main, app]);
        expect(main.zoomFactors).toEqual([1.3]);
        expect(app.zoomFactors).toEqual([1.3]);
    });
});

describe('main.ts 的缩放接线', () => {
    test('缩放偏好应用到主窗口 + 独立应用窗口，而不是写死主窗口', () => {
        expect(mainSource).toContain('displayZoomSync.add(mainWindow)');
        expect(mainSource).toContain('displayZoomSync.add(appWindow)');
        expect(mainSource).toContain('for (const win of displayZoomSync.apply(effective))');
        // zoom 按 webContents 独立存储：新窗口必须显式按当前偏好初始化，否则从 100% 起步
        expect(mainSource).toContain('zoomFactor: computeEffectiveZoom()');
    });
});
