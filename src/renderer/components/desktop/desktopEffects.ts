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

const PARTICLE_COLORS = ['#3d6fff', '#7c5cff', '#10b981', '#f59e0b', '#93b7ff', '#c4adff'];

export function prefersReducedMotion(): boolean {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
}

function mountEffectHost(zIndex: number): { host: HTMLDivElement; style: HTMLStyleElement } {
    const host = document.createElement('div');
    host.setAttribute('data-desktop-effect', '');
    host.style.cssText = `position:fixed;inset:0;z-index:${zIndex};pointer-events:none;overflow:hidden;`;
    const style = document.createElement('style');
    host.appendChild(style);
    document.body.appendChild(host);
    return { host, style };
}

function spawnParticles(host: HTMLDivElement, count: number): HTMLSpanElement[] {
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const particles: HTMLSpanElement[] = [];
    for (let i = 0; i < count; i += 1) {
        const particle = document.createElement('span');
        const size = 4 + Math.random() * 7;
        const color = PARTICLE_COLORS[i % PARTICLE_COLORS.length];
        particle.style.cssText = [
            'position:absolute',
            `left:${centerX}px`,
            `top:${centerY}px`,
            `width:${size}px`,
            `height:${size}px`,
            'border-radius:50%',
            `background:${color}`,
            `box-shadow:0 0 ${size * 2}px ${color}`,
            '--od-px:-50%',
            '--od-py:-50%'
        ].join(';');
        host.appendChild(particle);
        particles.push(particle);
    }
    return particles;
}

/** 进入动效：粒子从屏幕中心向四周喷射。 */
export function playParticleBurst(zIndex = 60000): void {
    if (prefersReducedMotion()) return;
    const { host, style } = mountEffectHost(zIndex);
    style.textContent = `
        @keyframes od-particle-fly {
            0% { transform: translate(-50%, -50%) scale(0.4); opacity: 0.95; }
            70% { opacity: 0.75; }
            100% { transform: translate(calc(-50% + var(--od-dx)), calc(-50% + var(--od-dy))) scale(1.15); opacity: 0; }
        }
        [data-desktop-effect] span {
            animation: od-particle-fly 820ms cubic-bezier(0.16, 1, 0.3, 1) both;
            animation-delay: var(--od-delay);
        }
    `;
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const maxDistance = Math.max(window.innerWidth, window.innerHeight) * 0.55;
    for (const particle of spawnParticles(host, 42)) {
        const index = Array.prototype.indexOf.call(host.querySelectorAll('span'), particle);
        const angle = (Math.PI * 2 * index) / 42 + Math.random() * 0.5;
        const distance = 180 + Math.random() * maxDistance;
        particle.style.setProperty('--od-dx', `${Math.round(Math.cos(angle) * distance)}px`);
        particle.style.setProperty('--od-dy', `${Math.round(Math.sin(angle) * distance)}px`);
        particle.style.setProperty('--od-delay', `${Math.round(Math.random() * 90)}ms`);
    }
    window.setTimeout(() => host.remove(), 1200);
}

/** 退出动效：粒子从四周向屏幕中心收拢，与进入动效对称。 */
export function playParticleConverge(zIndex = 60000): void {
    if (prefersReducedMotion()) return;
    const { host, style } = mountEffectHost(zIndex);
    style.textContent = `
        @keyframes od-particle-gather {
            0% { transform: translate(var(--od-sx), var(--od-sy)) scale(1); opacity: 0; }
            30% { opacity: 0.9; }
            100% { transform: translate(0, 0) scale(0.3); opacity: 0; }
        }
        [data-desktop-effect] span {
            animation: od-particle-gather 520ms cubic-bezier(0.5, 0, 0.7, 0.4) both;
            animation-delay: var(--od-delay);
        }
    `;
    for (const particle of spawnParticles(host, 36)) {
        const angle = Math.random() * Math.PI * 2;
        const distance = 240 + Math.random() * Math.max(window.innerWidth, window.innerHeight) * 0.5;
        particle.style.setProperty('--od-sx', `${Math.round(Math.cos(angle) * distance)}px`);
        particle.style.setProperty('--od-sy', `${Math.round(Math.sin(angle) * distance)}px`);
        particle.style.setProperty('--od-delay', `${Math.round(Math.random() * 60)}ms`);
    }
    window.setTimeout(() => host.remove(), 900);
}
