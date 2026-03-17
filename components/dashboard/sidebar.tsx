'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Brain,
  ChevronLeft,
  ChevronRight,
  Github,
  LayoutDashboard,
  Loader2,
  Menu,
  Play,
  Radio,
  Settings,
  TestTube2,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils/cn';
import { useSession } from '@/lib/hooks/use-session';

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Runs', href: '/dashboard/runs', icon: Play },
  { name: 'Tests', href: '/dashboard/tests', icon: TestTube2 },
  { name: 'Patches', href: '/dashboard/patches', icon: Wrench },
  { name: 'Learning', href: '/dashboard/learning', icon: Brain },
  { name: 'Monitoring', href: '/dashboard/monitoring', icon: Radio },
  { name: 'Settings', href: '/dashboard/settings', icon: Settings },
];

const COLLAPSED_WIDTH = 88;
const EXPANDED_WIDTH = 284;

function getStoredCollapsedState(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return localStorage.getItem('sidebar_collapsed') === 'true';
  } catch {
    return false;
  }
}

function setSidebarWidth(width: number) {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.style.setProperty('--dashboard-sidebar-width', `${width}px`);
}

export function Sidebar() {
  const pathname = usePathname();
  const { isAuthenticated, user, isLoading, primaryRepo } = useSession();
  const [isOpen, setIsOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    const collapsed = getStoredCollapsedState();
    setIsCollapsed(collapsed);
    setSidebarWidth(collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH);
  }, []);

  useEffect(() => {
    setSidebarWidth(isCollapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH);
  }, [isCollapsed]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const toggleCollapsed = () => {
    const nextState = !isCollapsed;
    setIsCollapsed(nextState);

    try {
      localStorage.setItem('sidebar_collapsed', String(nextState));
    } catch {
      // Ignore storage failures.
    }
  };

  const connectionStatus = isLoading ? 'Syncing GitHub' : isAuthenticated ? 'Connected' : 'Not connected';
  const accountLabel = isLoading ? 'Loading account…' : isAuthenticated && user?.login ? `@${user.login}` : 'Connect GitHub';
  const repoLabel = isLoading ? 'Loading repository…' : primaryRepo?.fullName || primaryRepo?.name || 'No repo selected';
  const currentWidth = isCollapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH;

  const footerContent = useMemo(
    () => (
      <div className="rounded-2xl border border-border/80 bg-card/80 p-3 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              GitHub
            </p>
            <p className="mt-1 text-sm font-semibold text-foreground">{connectionStatus}</p>
            <p className="truncate text-sm text-muted-foreground">{accountLabel}</p>
            <p className="truncate text-xs text-muted-foreground">{repoLabel}</p>
          </div>
        </div>
      </div>
    ),
    [accountLabel, connectionStatus, isLoading, repoLabel]
  );

  return (
    <TooltipProvider delayDuration={120}>
      <>
        <button
          type="button"
          aria-label={isOpen ? 'Close navigation menu' : 'Open navigation menu'}
          onClick={() => setIsOpen((prev) => !prev)}
          className="fixed left-4 top-4 z-[60] inline-flex h-11 w-11 items-center justify-center rounded-xl border border-border/80 bg-background/95 shadow-lg backdrop-blur md:hidden"
        >
          {isOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>

        {isOpen && (
          <button
            type="button"
            aria-label="Close navigation overlay"
            className="fixed inset-0 z-40 bg-background/70 backdrop-blur-sm md:hidden"
            onClick={() => setIsOpen(false)}
          />
        )}

        <motion.aside
          className={cn(
            'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-border/80 bg-background/90 backdrop-blur-xl',
            'shadow-[0_24px_80px_-32px_rgba(15,23,42,0.45)]',
            isOpen ? 'translate-x-0' : '-translate-x-full',
            'md:translate-x-0'
          )}
          animate={{ width: currentWidth }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          <div
            className={cn(
              'flex h-16 items-center border-b border-border/70',
              isCollapsed ? 'justify-center px-3' : 'justify-between px-5'
            )}
          >
            <Link href="/dashboard" className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,hsl(var(--primary)),hsl(var(--primary)/0.7))] text-primary-foreground shadow-lg">
                <Zap className="h-5 w-5" />
              </div>
              <AnimatePresence initial={false}>
                {!isCollapsed && (
                  <motion.div
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: 'auto' }}
                    exit={{ opacity: 0, width: 0 }}
                    transition={{ duration: 0.15 }}
                    className="min-w-0 overflow-hidden"
                  >
                    <p className="truncate text-sm font-semibold text-foreground">PatchPilot</p>
                    <p className="truncate text-xs text-muted-foreground">Self-healing QA operations</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </Link>

            {!isCollapsed && (
              <button
                type="button"
                onClick={toggleCollapsed}
                className="hidden rounded-xl border border-transparent p-2 text-muted-foreground transition-colors hover:border-border hover:bg-muted/70 hover:text-foreground md:inline-flex"
                aria-label="Collapse sidebar"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            )}
          </div>

          <nav className={cn('flex-1 space-y-1 overflow-y-auto py-4', isCollapsed ? 'px-3' : 'px-4')}>
            {navigation.map((item) => {
              const isActive =
                pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href));

              const navItem = (
                <Link
                  key={item.name}
                  href={item.href}
                  onClick={() => setIsOpen(false)}
                  className={cn(
                    'group flex items-center gap-3 rounded-2xl border px-3 py-3 text-sm font-medium transition-all',
                    isCollapsed ? 'justify-center px-2' : '',
                    isActive
                      ? 'border-primary/25 bg-primary/10 text-foreground shadow-sm'
                      : 'border-transparent text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground'
                  )}
                >
                  <item.icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} />
                  <AnimatePresence initial={false}>
                    {!isCollapsed && (
                      <motion.span
                        initial={{ opacity: 0, width: 0 }}
                        animate={{ opacity: 1, width: 'auto' }}
                        exit={{ opacity: 0, width: 0 }}
                        transition={{ duration: 0.15 }}
                        className="overflow-hidden whitespace-nowrap"
                      >
                        {item.name}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </Link>
              );

              if (isCollapsed) {
                return (
                  <Tooltip key={item.name}>
                    <TooltipTrigger asChild>{navItem}</TooltipTrigger>
                    <TooltipContent side="right">{item.name}</TooltipContent>
                  </Tooltip>
                );
              }

              return navItem;
            })}
          </nav>

          <div className="border-t border-border/70 p-4">
            <AnimatePresence initial={false}>
              {!isCollapsed ? (
                <motion.div
                  key="expanded-footer"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.15 }}
                  className="overflow-hidden"
                >
                  {footerContent}
                </motion.div>
              ) : (
                <motion.div
                  key="collapsed-footer"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex flex-col items-center gap-3"
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-border/80 bg-card text-primary shadow-sm">
                        {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      <p className="font-medium">{connectionStatus}</p>
                      <p className="text-xs text-muted-foreground">{accountLabel}</p>
                      <p className="text-xs text-muted-foreground">{repoLabel}</p>
                    </TooltipContent>
                  </Tooltip>
                  <button
                    type="button"
                    onClick={toggleCollapsed}
                    className="hidden rounded-xl border border-transparent p-2 text-muted-foreground transition-colors hover:border-border hover:bg-muted/70 hover:text-foreground md:inline-flex"
                    aria-label="Expand sidebar"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.aside>
      </>
    </TooltipProvider>
  );
}
