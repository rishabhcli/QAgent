import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

describe('Dialog', () => {
  it('exposes an accessible dialog surface with a labelled title and close control', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start new run</DialogTitle>
            <DialogDescription>Choose a repository and target URL.</DialogDescription>
          </DialogHeader>
          <button type="button">Continue</button>
        </DialogContent>
      </Dialog>
    );

    expect(screen.getByRole('dialog', { name: /start new run/i })).toBeInTheDocument();
    expect(screen.getByText('Choose a repository and target URL.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeVisible();
  });
});
