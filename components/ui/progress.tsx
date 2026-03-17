'use client';

import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils/cn';

const progressVariants = cva(
  'relative h-2 w-full overflow-hidden rounded-full bg-muted',
  {
    variants: {
      variant: {
        default: 'bg-primary/20',
        brand: 'bg-brand/20',
        success: 'bg-emerald-500/20',
        warning: 'bg-amber-500/20',
        info: 'bg-sky-500/20',
        neon: 'bg-brand/20',
        'neon-magenta': 'bg-brand-strong/20',
        'neon-green': 'bg-emerald-500/20',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

const indicatorVariants = cva(
  'h-full w-full flex-1 transition-all duration-300',
  {
    variants: {
      variant: {
        default: 'bg-primary',
        brand: 'bg-brand shadow-[0_0_18px_hsl(var(--brand-glow)/0.18)]',
        success: 'bg-emerald-500',
        warning: 'bg-amber-500',
        info: 'bg-sky-500',
        neon: 'bg-brand shadow-[0_0_18px_hsl(var(--brand-glow)/0.18)]',
        'neon-magenta': 'bg-brand-strong shadow-[0_0_18px_hsl(var(--brand-strong)/0.18)]',
        'neon-green': 'bg-emerald-500',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface ProgressProps
  extends React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>,
    VariantProps<typeof progressVariants> {}

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  ProgressProps
>(({ className, value, variant, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn(progressVariants({ variant, className }))}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className={cn(indicatorVariants({ variant }))}
      style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
