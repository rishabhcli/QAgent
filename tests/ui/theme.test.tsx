import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ThemeProvider, useTheme } from '@/lib/providers/theme-provider';
import { installMatchMedia } from './test-utils';

function ThemeHarness() {
  const { theme, resolvedTheme, setTheme } = useTheme();

  return (
    <div>
      <p data-testid="theme">{theme}</p>
      <p data-testid="resolved-theme">{resolvedTheme}</p>
      <button type="button" onClick={() => setTheme('light')}>
        Set light theme
      </button>
    </div>
  );
}

describe('ThemeProvider', () => {
  it('resolves system theme and updates the DOM when toggled', async () => {
    installMatchMedia(true);
    window.localStorage.setItem('theme', 'system');

    const user = userEvent.setup();

    render(
      <ThemeProvider>
        <ThemeHarness />
      </ThemeProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('theme')).toHaveTextContent('system');
      expect(screen.getByTestId('resolved-theme')).toHaveTextContent('dark');
      expect(document.documentElement).toHaveClass('dark');
    });

    await user.click(screen.getByRole('button', { name: /set light theme/i }));

    await waitFor(() => {
      expect(screen.getByTestId('theme')).toHaveTextContent('light');
      expect(screen.getByTestId('resolved-theme')).toHaveTextContent('light');
      expect(document.documentElement).toHaveClass('light');
    });

    expect(window.localStorage.getItem('theme')).toBe('light');
  });
});
