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

export function prefersReducedMotion(): boolean {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
}

type DesktopTransitionDirection = 'enter' | 'exit';

/**
 * 给桌面的空间展开/收拢补一层很轻的高光，让转场与主界面右上角入口保持视觉连续。
 * 桌面主体的 clip-path 承担主要运动，这里不创建会抢夺注意力的独立粒子。
 */
function playDesktopTransition(direction: DesktopTransitionDirection, zIndex = 60000): void {
    if (prefersReducedMotion()) return;

    const veil = document.createElement('div');
    veil.setAttribute('data-desktop-transition', direction);
    veil.style.cssText = [
        'position:fixed',
        'inset:0',
        `z-index:${zIndex}`,
        'pointer-events:none',
        'border:1px solid color-mix(in srgb,var(--od-accent,#3b82f6) 24%,transparent)',
        'background:color-mix(in srgb,var(--od-accent,#3b82f6) 5%,transparent)'
    ].join(';');

    const keyframes: Keyframe[] =
        direction === 'enter'
            ? [
                  {
                      opacity: 0.38,
                      clipPath: 'inset(36px 18px calc(100% - 76px) calc(100% - 250px) round 12px)'
                  },
                  { opacity: 0, clipPath: 'inset(0 round 0)' }
              ]
            : [
                  { opacity: 0, clipPath: 'inset(0 round 0)' },
                  {
                      opacity: 0.24,
                      clipPath: 'inset(36px 18px calc(100% - 76px) calc(100% - 250px) round 12px)'
                  }
              ];

    // 挂到主内容容器内，Linux 圆角模式下随 #app-root 的圆角裁切（body 直挂会逃逸裁切）
    const transitionHost = document.getElementById('app-root') ?? document.body;
    transitionHost.appendChild(veil);
    const animation = veil.animate(keyframes, {
        duration: direction === 'enter' ? 460 : 400,
        easing: direction === 'enter' ? 'cubic-bezier(0.22, 1, 0.36, 1)' : 'cubic-bezier(0.4, 0, 0.6, 1)',
        fill: 'both'
    });
    animation.finished.then(() => veil.remove()).catch(() => veil.remove());
}

export function playDesktopEnterTransition(zIndex?: number): void {
    playDesktopTransition('enter', zIndex);
}

export function playDesktopExitTransition(zIndex?: number): void {
    playDesktopTransition('exit', zIndex);
}
