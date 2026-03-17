import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils/cn';

const inputVariants = cva(
  'flex min-h-11 w-full rounded-xl border bg-background/90 px-3 py-2.5 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground shadow-sm transition-all duration-200 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border-input focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        brand:
          'border-brand/30 bg-brand-soft/20 focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2',
        accent:
          'border-brand-strong/30 bg-background/90 focus-visible:border-brand-strong focus-visible:ring-2 focus-visible:ring-brand-strong/30 focus-visible:ring-offset-2',
        neon:
          'border-brand/30 bg-brand-soft/20 focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2',
        'neon-magenta':
          'border-brand-strong/30 bg-background/90 focus-visible:border-brand-strong focus-visible:ring-2 focus-visible:ring-brand-strong/30 focus-visible:ring-offset-2',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement>,
    VariantProps<typeof inputVariants> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, variant, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(inputVariants({ variant, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input, inputVariants };
