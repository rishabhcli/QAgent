import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from '@/components/dashboard/sidebar';

const navigationState = vi.hoisted(() => ({
  pathname: '/dashboard/runs',
}));

const sessionState = vi.hoisted(() => ({
  value: {
    isAuthenticated: true,
    user: {
      login: 'rishabh',
      avatarUrl: '',
    },
    repos: [
      {
        id: 1,
        name: 'weavehacks',
        fullName: 'rishabh/weavehacks',
      },
    ],
    primaryRepo: {
      id: 1,
      name: 'weavehacks',
      fullName: 'rishabh/weavehacks',
    },
    isLoading: false,
    selectedRepoIds: [1],
    disconnect: vi.fn(),
    mutate: vi.fn(),
  },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigationState.pathname,
}));

vi.mock('@/lib/hooks/use-session', () => ({
  useSession: () => sessionState.value,
}));

describe('Sidebar', () => {
  it('renders the authenticated shell navigation and repo context', () => {
    render(<Sidebar />);

    expect(screen.getByText('PatchPilot')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'href',
      '/dashboard'
    );
    expect(screen.getByRole('link', { name: 'Runs' })).toHaveAttribute('href', '/dashboard/runs');
    expect(screen.getByRole('link', { name: 'Patches' })).toHaveAttribute(
      'href',
      '/dashboard/patches'
    );
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('@rishabh')).toBeInTheDocument();
    expect(screen.getByText('rishabh/weavehacks')).toBeInTheDocument();
  });
});
