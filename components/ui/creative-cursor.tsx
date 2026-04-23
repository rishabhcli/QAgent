'use client';

import { useEffect, useRef } from 'react';

type CursorMode = 'default' | 'interactive' | 'text';
type Point = {
  x: number;
  y: number;
};

const INTERACTIVE_SELECTOR =
  'a, button, [role="button"], [role="link"], input, textarea, select, [contenteditable="true"], [role="textbox"], .cursor-pointer, label, summary, [type="submit"], [type="button"]';
const TEXT_SELECTOR =
  'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"], [role="textbox"]';
const TRAIL_COUNT = 8;
const ORBIT_EASING = 0.18;
const TRAIL_EASING = 0.28;
const PRESS_SCALE_DAMPER = 0.82;

export function CreativeCursor() {
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const dotRef = useRef<HTMLSpanElement | null>(null);
  const orbitRef = useRef<HTMLSpanElement | null>(null);
  const trailRefs = useRef<Array<HTMLSpanElement | null>>([]);

  const cursorScaleRef = useRef({
    dot: 1,
    orbit: 1,
  });
  const isPressing = useRef(false);

  const trailPoints = useRef<Point[]>([]);
  const mousePoint = useRef<Point>({ x: 0, y: 0 });
  const orbitPoint = useRef<Point>({ x: 0, y: 0 });

  useEffect(() => {
    const supportsFinePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    if (!supportsFinePointer.matches || prefersReducedMotion.matches) {
      return;
    }

    const body = document.body;
    body.classList.add('has-creative-cursor');

    mousePoint.current = {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    };
    orbitPoint.current = {
      x: mousePoint.current.x,
      y: mousePoint.current.y,
    };
    trailPoints.current = Array.from({ length: TRAIL_COUNT }, () => ({
      x: mousePoint.current.x,
      y: mousePoint.current.y,
    }));

    let currentMode: CursorMode = 'default';
    let frameId = 0;

    const setMode = (target: EventTarget | null) => {
      if (!(target instanceof Element)) {
        return;
      }

      const nextMode: CursorMode = target.closest(TEXT_SELECTOR)
        ? 'text'
        : target.closest(INTERACTIVE_SELECTOR)
          ? 'interactive'
          : 'default';

      if (nextMode === currentMode) {
        return;
      }

      const cursor = cursorRef.current;
      if (!cursor) {
        return;
      }

      cursor.classList.remove('creative-cursor-shell--interactive', 'creative-cursor-shell--text');

      if (nextMode === 'interactive') {
        cursor.classList.add('creative-cursor-shell--interactive');
        cursorScaleRef.current = {
          dot: 1.15,
          orbit: 1.35,
        };
      }

      if (nextMode === 'text') {
        cursor.classList.add('creative-cursor-shell--text');
        cursorScaleRef.current = {
          dot: 0.78,
          orbit: 0.9,
        };
      }

      if (nextMode === 'default') {
        cursorScaleRef.current = {
          dot: 1,
          orbit: 1,
        };
      }

      currentMode = nextMode;
    };

    const onMouseMove = (event: MouseEvent) => {
      mousePoint.current = {
        x: event.clientX,
        y: event.clientY,
      };
      setMode(event.target);
    };

    const onMouseLeave = (event: MouseEvent) => {
      if (event.relatedTarget === null) {
        cursorRef.current?.classList.add('creative-cursor-shell--hidden');
      }
    };

    const onMouseEnter = () => {
      cursorRef.current?.classList.remove('creative-cursor-shell--hidden');
    };

    const onMouseDown = (event: MouseEvent) => {
      const cursor = cursorRef.current;
      if (!cursor) {
        return;
      }

      isPressing.current = true;

      const burst = document.createElement('span');
      burst.className = 'creative-cursor-burst';
      burst.style.left = `${event.clientX}px`;
      burst.style.top = `${event.clientY}px`;
      cursor.appendChild(burst);
      burst.addEventListener(
        'animationend',
        () => {
          burst.remove();
        },
        { once: true },
      );
    };

    const onMouseUp = () => {
      isPressing.current = false;
    };

    const onResize = () => {
      mousePoint.current = {
        x: Math.min(mousePoint.current.x, window.innerWidth),
        y: Math.min(mousePoint.current.y, window.innerHeight),
      };
    };

    const raf = () => {
      const cursor = cursorRef.current;
      const dot = dotRef.current;
      const orbit = orbitRef.current;
      if (!cursor || !dot || !orbit) {
        return;
      }

      const { dot: dotScale, orbit: orbitScale } = cursorScaleRef.current;
      const effectiveDotScale = dotScale * (isPressing.current ? PRESS_SCALE_DAMPER : 1);
      const effectiveOrbitScale = orbitScale * (isPressing.current ? PRESS_SCALE_DAMPER : 1);

      orbitPoint.current.x += (mousePoint.current.x - orbitPoint.current.x) * ORBIT_EASING;
      orbitPoint.current.y += (mousePoint.current.y - orbitPoint.current.y) * ORBIT_EASING;

      dot.style.opacity = '1';
      dot.style.transform = `translate3d(${mousePoint.current.x - 5}px, ${mousePoint.current.y - 5}px, 0) scale(${effectiveDotScale})`;
      orbit.style.opacity = '1';
      orbit.style.transform = `translate3d(${orbitPoint.current.x - 18}px, ${orbitPoint.current.y - 18}px, 0) scale(${effectiveOrbitScale})`;

      const points = trailPoints.current;
      points[0].x += (orbitPoint.current.x - points[0].x) * TRAIL_EASING;
      points[0].y += (orbitPoint.current.y - points[0].y) * TRAIL_EASING;

      for (let index = 1; index < points.length; index += 1) {
        points[index].x += (points[index - 1].x - points[index].x) * TRAIL_EASING;
        points[index].y += (points[index - 1].y - points[index].y) * TRAIL_EASING;
      }

      for (let index = 0; index < points.length; index += 1) {
        const trail = trailRefs.current[index];
        if (!trail) {
          continue;
        }

        const point = points[index];
        const scale = 1 - index / (points.length + 1);
        const offset = (index + 1) * 2;
        const opacity = Math.max(0.08, 0.45 - index * 0.05);

        trail.style.transform = `translate3d(${point.x - offset}px, ${point.y - offset}px, 0) scale(${scale})`;
        trail.style.opacity = `${opacity}`;
      }

      frameId = requestAnimationFrame(raf);
    };

    frameId = requestAnimationFrame(raf);

    const doc = document;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    doc.addEventListener('mouseout', onMouseLeave);
    doc.addEventListener('mouseover', onMouseEnter);
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(frameId);
      body.classList.remove('has-creative-cursor');
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      doc.removeEventListener('mouseout', onMouseLeave);
      doc.removeEventListener('mouseover', onMouseEnter);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <div ref={cursorRef} className="creative-cursor-shell" aria-hidden="true">
      <span ref={dotRef} className="creative-cursor-dot" />
      <span ref={orbitRef} className="creative-cursor-orbit" />
      {Array.from({ length: TRAIL_COUNT }, (_, index) => (
        <span
          key={index}
          ref={(el) => {
            trailRefs.current[index] = el;
          }}
          className="creative-cursor-trail"
        />
      ))}
    </div>
  );
}
