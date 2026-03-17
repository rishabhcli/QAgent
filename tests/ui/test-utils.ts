import React, { type PropsWithChildren } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toaster';

export function installMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches,
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

function Providers({ children }: PropsWithChildren) {
  return React.createElement(ToastProvider, null, children);
}

export function renderWithProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>
) {
  return render(ui, {
    wrapper: Providers,
    ...options,
  });
}
