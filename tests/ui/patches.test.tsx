import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockFetchResponse } from '@/tests/unit/test-utils';
import { renderWithProviders } from './test-utils';

vi.mock('@/components/dashboard/header', () => ({
  Header: ({ title }: { title?: string }) => React.createElement('header', null, title),
}));

import PatchesPage from '@/app/dashboard/patches/page';

describe('Patches page', () => {
  it('renders merged, created, and blocked PR states', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        createMockFetchResponse({
          patches: [
            {
              id: 'patch-1',
              file: 'app/page.tsx',
              description: 'Landing page polish',
              diff: '--- a/app/page.tsx\n+++ b/app/page.tsx\n@@ -1,1 +1,1 @@\n-old\n+new',
              linesAdded: 1,
              linesRemoved: 1,
              status: 'applied',
              runId: 'run-1',
              createdAt: '2026-03-17T10:00:00.000Z',
              prUrl: 'https://github.com/example/repo/pull/1',
              prNumber: 1,
              merged: true,
              mergeMethod: 'squash',
              mergeCommitSha: 'abc123',
              diagnosis: {
                type: 'UI_BUG',
                confidence: 0.92,
                rootCause: 'Landing CTA was visually weak',
              },
            },
            {
              id: 'patch-2',
              file: 'components/dashboard/sidebar.tsx',
              description: 'Sidebar branding',
              diff: '--- a/components/dashboard/sidebar.tsx\n+++ b/components/dashboard/sidebar.tsx',
              linesAdded: 3,
              linesRemoved: 1,
              status: 'pending',
              runId: 'run-2',
              createdAt: '2026-03-17T11:00:00.000Z',
              prUrl: 'https://github.com/example/repo/pull/2',
              prNumber: 2,
              merged: false,
              mergeMethod: 'merge',
              diagnosis: {
                type: 'UI_BUG',
                confidence: 0.88,
                rootCause: 'Sidebar still used outdated neon styling',
              },
            },
            {
              id: 'patch-3',
              file: 'components/dashboard/new-run-dialog.tsx',
              description: 'Dialog validation',
              diff: '--- a/components/dashboard/new-run-dialog.tsx\n+++ b/components/dashboard/new-run-dialog.tsx',
              linesAdded: 2,
              linesRemoved: 0,
              status: 'pending',
              runId: 'run-3',
              createdAt: '2026-03-17T12:00:00.000Z',
              prUrl: 'https://github.com/example/repo/pull/3',
              prNumber: 3,
              merged: false,
              mergeMethod: 'squash',
              mergeError: 'Branch protection blocked merge',
            },
          ],
        })
      )
    );

    renderWithProviders(<PatchesPage />);

    await waitFor(() => {
    expect(screen.getByText('Merged')).toBeInTheDocument();
    expect(screen.getByText('PR Created')).toBeInTheDocument();
    expect(screen.getByText('PR Open')).toBeInTheDocument();
  });

  expect(screen.getByText(/Auto-merge blocked: Branch protection blocked merge/i)).toBeInTheDocument();
  expect(screen.getByText(/Merged to default branch/i)).toBeInTheDocument();
  expect(screen.getAllByText(/PR awaiting merge/i)).toHaveLength(2);
  });
});
