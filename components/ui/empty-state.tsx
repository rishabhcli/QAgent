'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  AlertCircle,
  CheckCircle2,
  Construction,
  FileX,
  Lightbulb,
  Rocket,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';

type EmptyStateVariant = 'default' | 'search' | 'error' | 'success' | 'coming-soon' | 'no-data';

interface EmptyStateAction {
  label: string;
  onClick: () => void;
  variant?: 'default' | 'outline' | 'ghost';
}

interface EmptyStateProps {
  variant?: EmptyStateVariant;
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: EmptyStateAction | React.ReactNode;
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
  compact?: boolean;
  gradient?: string;
  suggestions?: Array<{
    icon: LucideIcon;
    title: string;
    description: string;
  }>;
  tip?: string;
  children?: React.ReactNode;
}

const variantConfig: Record<EmptyStateVariant, { icon: LucideIcon; accent: string; ring: string }> = {
  default: {
    icon: Rocket,
    accent: 'from-brand/20 via-brand-strong/10 to-transparent',
    ring: 'text-brand',
  },
  search: {
    icon: Search,
    accent: 'from-sky-500/20 via-brand/10 to-transparent',
    ring: 'text-sky-500',
  },
  error: {
    icon: AlertCircle,
    accent: 'from-red-500/20 via-red-500/10 to-transparent',
    ring: 'text-red-500',
  },
  success: {
    icon: CheckCircle2,
    accent: 'from-emerald-500/20 via-emerald-500/10 to-transparent',
    ring: 'text-emerald-500',
  },
  'coming-soon': {
    icon: Construction,
    accent: 'from-amber-500/20 via-amber-500/10 to-transparent',
    ring: 'text-amber-500',
  },
  'no-data': {
    icon: FileX,
    accent: 'from-slate-500/20 via-slate-500/10 to-transparent',
    ring: 'text-slate-500',
  },
};

function isActionObject(action: EmptyStateAction | React.ReactNode): action is EmptyStateAction {
  return action !== null && typeof action === 'object' && 'label' in action && 'onClick' in action;
}

function EmptyIllustration({
  Icon,
  accent,
  ring,
  reduceMotion,
}: {
  Icon: LucideIcon;
  accent: string;
  ring: string;
  reduceMotion: boolean;
}) {
  return (
    <div className="relative mx-auto mb-6 h-20 w-20">
      <div
        className={cn(
          'absolute inset-0 rounded-2xl bg-gradient-to-br blur-xl',
          accent
        )}
      />
      <motion.div
        initial={reduceMotion ? false : { scale: 0.96, opacity: 0 }}
        animate={reduceMotion ? undefined : { scale: 1, opacity: 1 }}
        transition={{ duration: 0.35 }}
        className="relative flex h-20 w-20 items-center justify-center rounded-2xl border border-border/70 bg-card/90 shadow-[0_20px_40px_hsl(224_30%_12%_/_0.1)] backdrop-blur-xl"
      >
        <Icon className={cn('h-9 w-9', ring)} />
      </motion.div>
    </div>
  );
}

export function EmptyState({
  variant = 'default',
  title,
  description,
  icon: CustomIcon,
  action,
  secondaryAction,
  className,
  compact = false,
  gradient: legacyGradient,
  suggestions,
  tip,
  children,
}: EmptyStateProps) {
  const config = variantConfig[variant];
  const Icon = CustomIcon || config.icon;
  const reduceMotion = useReducedMotion() ?? false;

  if (compact) {
    return (
      <div
        className={cn(
          'flex items-center gap-3 rounded-2xl border border-border/70 bg-card/80 p-4 shadow-sm',
          className
        )}
      >
        <div
          className={cn(
            'flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br',
            legacyGradient || config.accent
          )}
        >
          <Icon className={cn('h-5 w-5', config.ring)} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {description && <p className="truncate text-xs text-muted-foreground">{description}</p>}
        </div>
        {action && isActionObject(action) && (
          <Button size="sm" variant={action.variant || 'outline'} onClick={action.onClick}>
            {action.label}
          </Button>
        )}
        {action && !isActionObject(action) && action}
      </div>
    );
  }

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 16 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className={cn('flex flex-col items-center px-4 py-12 text-center', className)}
    >
      <EmptyIllustration Icon={Icon} accent={legacyGradient || config.accent} ring={config.ring} reduceMotion={reduceMotion} />

      <h3 className="text-xl font-semibold tracking-tight text-foreground">{title}</h3>
      {description && <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">{description}</p>}

      {(action || secondaryAction) && (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {action && isActionObject(action) && (
            <Button onClick={action.onClick} variant={action.variant || 'default'}>
              {action.label}
            </Button>
          )}
          {action && !isActionObject(action) && action}
          {secondaryAction && (
            <Button variant="outline" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}

      {suggestions && suggestions.length > 0 && (
        <div className="mt-8 grid w-full max-w-3xl gap-3 sm:grid-cols-2">
          {suggestions.map((suggestion) => {
            const SuggestionIcon = suggestion.icon;
            return (
              <div
                key={suggestion.title}
                className="rounded-2xl border border-border/70 bg-card/80 p-4 text-left shadow-sm"
              >
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                  <SuggestionIcon className="h-5 w-5 text-primary" />
                </div>
                <h4 className="text-sm font-semibold text-foreground">{suggestion.title}</h4>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{suggestion.description}</p>
              </div>
            );
          })}
        </div>
      )}

      {tip && (
        <div className="mt-6 inline-flex items-start gap-2 rounded-full border border-border/70 bg-muted/60 px-4 py-2 text-sm text-muted-foreground">
          <Lightbulb className="mt-0.5 h-4 w-4 text-primary" />
          <span>{tip}</span>
        </div>
      )}

      {children && <div className="mt-6 w-full max-w-3xl">{children}</div>}
    </motion.div>
  );
}
