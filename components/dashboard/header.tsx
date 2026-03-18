'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import {
  BookOpen,
  Command,
  Github,
  HelpCircle,
  LogOut,
  Search,
  Settings,
  User,
  UserCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { useSession } from '@/lib/hooks/use-session';
import { useToast } from '@/components/ui/toaster';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const GITHUB_REPO_URL = 'https://github.com/rishabhcli/QAgent';
const README_URL = `${GITHUB_REPO_URL}#readme`;

interface HeaderProps {
  title?: string;
}

function dispatchPaletteEvent(mode: 'search' | 'shortcuts' = 'search') {
  document.dispatchEvent(new CustomEvent('qagent:open-command-palette', { detail: { mode } }));
}

export function Header({ title }: HeaderProps) {
  const router = useRouter();
  const { user, isAuthenticated, primaryRepo, disconnect } = useSession();
  const { info } = useToast();

  const handleSignOut = async () => {
    await disconnect();
    info('Signed out', 'Your GitHub session has been disconnected.');
    router.push('/');
  };

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-xl" role="banner">
      <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between gap-4 px-6 lg:px-8">
        <div className="min-w-0">
          {title ? (
            <>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                QAgent
              </p>
              <h1 className="truncate text-xl font-semibold text-foreground">{title}</h1>
            </>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,hsl(var(--primary)),hsl(var(--primary)/0.7))] text-primary-foreground shadow-lg">
                <Github className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">QAgent</p>
                <p className="truncate text-xs text-muted-foreground">
                  {primaryRepo?.fullName || 'Self-healing QA operations'}
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => dispatchPaletteEvent('search')}
            className="hidden h-10 min-w-[14rem] items-center gap-3 rounded-2xl border border-border/80 bg-card/70 px-3 text-left text-sm text-muted-foreground transition-colors hover:border-border hover:bg-accent/50 md:flex"
            aria-label="Open command palette"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            <span>Search commands, runs, and flows</span>
            <kbd className="ml-auto flex items-center gap-1 rounded-lg border border-border/70 bg-background/80 px-2 py-1 text-[11px]">
              <Command className="h-3 w-3" />
              <span>K</span>
            </kbd>
          </button>

          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => dispatchPaletteEvent('search')}
            aria-label="Open command palette"
          >
            <Search className="h-4 w-4" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="hidden sm:inline-flex"
            onClick={() => dispatchPaletteEvent('shortcuts')}
            aria-label="Keyboard shortcuts"
          >
            <HelpCircle className="h-4 w-4" />
          </Button>

          <ThemeToggle />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full border border-transparent hover:border-border"
                aria-label="User menu"
              >
                {isAuthenticated && user?.avatarUrl ? (
                  <Image
                    src={user.avatarUrl}
                    alt={`${user.login}'s avatar`}
                    width={34}
                    height={34}
                    className="rounded-full"
                  />
                ) : (
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <User className="h-4 w-4" aria-hidden="true" />
                  </div>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>
                {isAuthenticated && user ? (
                  <div className="flex flex-col space-y-1">
                    <span className="font-medium">@{user.login}</span>
                    {user.name && <span className="text-xs font-normal text-muted-foreground">{user.name}</span>}
                    <span className="truncate text-xs font-normal text-muted-foreground">
                      {primaryRepo?.fullName || 'No repository selected'}
                    </span>
                  </div>
                ) : (
                  'Workspace'
                )}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => router.push('/dashboard/settings')}>
                <UserCircle className="mr-2 h-4 w-4" aria-hidden="true" />
                Profile
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push('/dashboard/settings')}>
                <Settings className="mr-2 h-4 w-4" aria-hidden="true" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => window.open(README_URL, '_blank', 'noopener,noreferrer')}>
                <BookOpen className="mr-2 h-4 w-4" aria-hidden="true" />
                Documentation
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => window.open(GITHUB_REPO_URL, '_blank', 'noopener,noreferrer')}>
                <Github className="mr-2 h-4 w-4" aria-hidden="true" />
                Source Code
              </DropdownMenuItem>
              {isAuthenticated && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleSignOut} className="text-destructive">
                    <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
                    Sign out
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
