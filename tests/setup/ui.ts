import React from 'react';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const ignoredMotionProps = new Set([
  'animate',
  'initial',
  'exit',
  'transition',
  'variants',
  'whileHover',
  'whileTap',
  'whileFocus',
  'whileInView',
  'viewport',
  'layout',
  'layoutId',
  'drag',
  'dragConstraints',
  'dragElastic',
  'dragMomentum',
  'dragPropagation',
  'onDragEnd',
  'onDragStart',
  'onDrag',
  'onUpdate',
]);

vi.mock('framer-motion', () => {
  const createMotionComponent = (tag: string) =>
    React.forwardRef<HTMLElement, Record<string, unknown>>(
      ({ children, ...props }, ref) =>
        React.createElement(
          tag,
          {
            ref,
            ...Object.fromEntries(
              Object.entries(props).filter(([key]) => !ignoredMotionProps.has(key))
            ),
          },
          children as React.ReactNode
        )
    );

  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => createMotionComponent(tag),
    }
  );

  return {
    motion,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useReducedMotion: () => false,
  };
});

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string | { pathname?: string };
    children?: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
    React.createElement(
      'a',
      {
        href:
          typeof href === 'string'
            ? href
            : (href as { pathname?: string } | undefined)?.pathname || '',
        ...props,
      },
      children
    ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();

  if (typeof document !== 'undefined') {
    document.documentElement.className = '';
    document.body.innerHTML = '';
  }

  if (typeof window !== 'undefined') {
    window.localStorage.clear();
    window.sessionStorage.clear();
  }
});

if (typeof window !== 'undefined') {
  const createStorage = () => {
    const store = new Map<string, string>();

    return {
      get length() {
        return store.size;
      },
      clear() {
        store.clear();
      },
      getItem(key: string) {
        return store.has(key) ? store.get(key)! : null;
      },
      key(index: number) {
        return Array.from(store.keys())[index] ?? null;
      },
      removeItem(key: string) {
        store.delete(key);
      },
      setItem(key: string, value: string) {
        store.set(key, String(value));
      },
    };
  };

  Object.defineProperty(window, 'localStorage', {
    writable: true,
    configurable: true,
    value: createStorage(),
  });

  Object.defineProperty(window, 'sessionStorage', {
    writable: true,
    configurable: true,
    value: createStorage(),
  });

  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      }),
    });
  }

  if (!window.ResizeObserver) {
    class ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }

    Object.defineProperty(window, 'ResizeObserver', {
      writable: true,
      configurable: true,
      value: ResizeObserver,
    });
  }

  if (!window.IntersectionObserver) {
    class IntersectionObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      root: Element | Document | null = null;
      rootMargin = '';
      thresholds: ReadonlyArray<number> = [];
    }

    Object.defineProperty(window, 'IntersectionObserver', {
      writable: true,
      configurable: true,
      value: IntersectionObserver,
    });
  }

  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  }
}
