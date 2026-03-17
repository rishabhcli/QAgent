'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowRight,
  BookOpen,
  Brain,
  ExternalLink,
  GitBranch,
  Github,
  HelpCircle,
  Keyboard,
  LayoutDashboard,
  Monitor,
  Moon,
  Play,
  Radio,
  Search,
  Settings,
  Sparkles,
  Sun,
  TestTube2,
  Wrench,
  X,
} from 'lucide-react';
import { useTheme } from '@/lib/providers/theme-provider';
import { cn } from '@/lib/utils/cn';

interface CommandItem {
  id: string;
  label: string;
  description?: string;
  icon: React.ElementType;
  action: () => void;
  category: 'navigation' | 'action' | 'recent' | 'help';
  shortcut?: string;
  keywords?: string[];
}

interface RecentCommand {
  id: string;
  timestamp: number;
}

const GITHUB_REPO_URL = 'https://github.com/rishabhcli/weavehacks';
const README_URL = `${GITHUB_REPO_URL}#readme`;
const DEMO_URL = `${GITHUB_REPO_URL}/blob/main/docs/DEMO_SCRIPT.md`;
const RECENT_COMMANDS_KEY = 'patchpilot_recent_commands';
const MAX_RECENT_COMMANDS = 5;

function useRecentCommands() {
  const [recentCommands, setRecentCommands] = useState<RecentCommand[]>([]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(RECENT_COMMANDS_KEY);
      if (stored) {
        setRecentCommands(JSON.parse(stored));
      }
    } catch {
      // Ignore storage failures.
    }
  }, []);

  const addRecentCommand = useCallback((id: string) => {
    setRecentCommands((prev) => {
      const filtered = prev.filter((command) => command.id !== id);
      const updated = [{ id, timestamp: Date.now() }, ...filtered].slice(0, MAX_RECENT_COMMANDS);

      try {
        localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(updated));
      } catch {
        // Ignore storage failures.
      }

      return updated;
    });
  }, []);

  return { recentCommands, addRecentCommand };
}

function fuzzyMatch(value: string, pattern: string): number {
  const source = value.toLowerCase();
  const query = pattern.toLowerCase();

  if (source === query) return 1000;
  if (source.startsWith(query)) return 100;
  if (source.includes(query)) return 10;

  let queryIndex = 0;
  let score = 0;

  for (let index = 0; index < source.length && queryIndex < query.length; index += 1) {
    if (source[index] === query[queryIndex]) {
      score += 1;
      queryIndex += 1;
    }
  }

  return queryIndex === query.length ? score : 0;
}

export function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const router = useRouter();
  const pathname = usePathname();
  const { recentCommands, addRecentCommand } = useRecentCommands();
  const { theme, resolvedTheme, setTheme } = useTheme();

  const commands: CommandItem[] = useMemo(
    () => [
      {
        id: 'nav-dashboard',
        label: 'Go to Dashboard',
        description: 'View your operational overview',
        icon: LayoutDashboard,
        action: () => router.push('/dashboard'),
        category: 'navigation',
        shortcut: 'G then D',
        keywords: ['home', 'overview', 'dashboard'],
      },
      {
        id: 'nav-runs',
        label: 'Go to Runs',
        description: 'Inspect runs and live status',
        icon: Play,
        action: () => router.push('/dashboard/runs'),
        category: 'navigation',
        shortcut: 'G then R',
        keywords: ['runs', 'executions', 'activity'],
      },
      {
        id: 'nav-tests',
        label: 'Go to Tests',
        description: 'Manage test specifications',
        icon: TestTube2,
        action: () => router.push('/dashboard/tests'),
        category: 'navigation',
        shortcut: 'G then T',
        keywords: ['tests', 'specs', 'flows'],
      },
      {
        id: 'nav-patches',
        label: 'Go to Patches',
        description: 'Review generated patches and PRs',
        icon: GitBranch,
        action: () => router.push('/dashboard/patches'),
        category: 'navigation',
        shortcut: 'G then P',
        keywords: ['patches', 'pull requests', 'merge'],
      },
      {
        id: 'nav-learning',
        label: 'Go to Learning',
        description: 'Review self-improvement metrics',
        icon: Brain,
        action: () => router.push('/dashboard/learning'),
        category: 'navigation',
        shortcut: 'G then L',
        keywords: ['learning', 'knowledge', 'patterns'],
      },
      {
        id: 'nav-monitoring',
        label: 'Go to Monitoring',
        description: 'Check continuous monitoring health',
        icon: Radio,
        action: () => router.push('/dashboard/monitoring'),
        category: 'navigation',
        shortcut: 'G then M',
        keywords: ['monitoring', 'status', 'webhooks'],
      },
      {
        id: 'nav-settings',
        label: 'Go to Settings',
        description: 'Manage integrations and repositories',
        icon: Settings,
        action: () => router.push('/dashboard/settings'),
        category: 'navigation',
        shortcut: 'G then S',
        keywords: ['settings', 'account', 'integrations'],
      },
      {
        id: 'action-new-run',
        label: 'Start New Run',
        description: 'Open the new run flow from the dashboard',
        icon: Sparkles,
        action: () => router.push('/dashboard'),
        category: 'action',
        shortcut: 'N then R',
        keywords: ['create', 'run', 'analyze'],
      },
      {
        id: 'action-new-test',
        label: 'Create Test Spec',
        description: 'Add a new manual test specification',
        icon: TestTube2,
        action: () => router.push('/dashboard/tests/new'),
        category: 'action',
        shortcut: 'N then T',
        keywords: ['create test', 'new test', 'spec'],
      },
      {
        id: 'action-theme-light',
        label: 'Use Light Theme',
        description: 'Switch the workspace to light mode',
        icon: Sun,
        action: () => setTheme('light'),
        category: 'action',
        keywords: ['light', 'theme', 'appearance'],
      },
      {
        id: 'action-theme-dark',
        label: 'Use Dark Theme',
        description: 'Switch the workspace to dark mode',
        icon: Moon,
        action: () => setTheme('dark'),
        category: 'action',
        keywords: ['dark', 'theme', 'appearance'],
      },
      {
        id: 'action-theme-system',
        label: 'Use System Theme',
        description: 'Follow your operating system theme',
        icon: Monitor,
        action: () => setTheme('system'),
        category: 'action',
        keywords: ['system', 'theme', 'appearance'],
      },
      {
        id: 'help-shortcuts',
        label: 'Keyboard Shortcuts',
        description: 'Open the shortcut cheat sheet',
        icon: Keyboard,
        action: () => setShowShortcuts(true),
        category: 'help',
        keywords: ['keyboard', 'shortcuts', 'help'],
      },
      {
        id: 'help-docs',
        label: 'Open Documentation',
        description: 'View the PatchPilot README',
        icon: BookOpen,
        action: () => window.open(README_URL, '_blank', 'noopener,noreferrer'),
        category: 'help',
        keywords: ['docs', 'readme', 'documentation'],
      },
      {
        id: 'help-demo',
        label: 'Open Demo Script',
        description: 'Review the demo flow and talk track',
        icon: ExternalLink,
        action: () => window.open(DEMO_URL, '_blank', 'noopener,noreferrer'),
        category: 'help',
        keywords: ['demo', 'script', 'presentation'],
      },
      {
        id: 'help-github',
        label: 'Open GitHub Repository',
        description: 'View the source code and open issues',
        icon: Github,
        action: () => window.open(GITHUB_REPO_URL, '_blank', 'noopener,noreferrer'),
        category: 'help',
        keywords: ['github', 'repository', 'source'],
      },
    ],
    [router, setTheme]
  );

  const filteredCommands = useMemo(() => {
    if (!search.trim()) {
      const recentIds = new Set(recentCommands.map((command) => command.id));
      const recent = recentCommands
        .map((command) => commands.find((item) => item.id === command.id))
        .filter(Boolean) as CommandItem[];
      const others = commands.filter((command) => !recentIds.has(command.id));
      return [...recent.map((command) => ({ ...command, category: 'recent' as const })), ...others];
    }

    return commands
      .map((command) => ({
        ...command,
        score: Math.max(
          fuzzyMatch(command.label, search),
          fuzzyMatch(command.description || '', search),
          ...(command.keywords?.map((keyword) => fuzzyMatch(keyword, search)) || [0])
        ),
      }))
      .filter((command) => command.score > 0)
      .sort((a, b) => b.score - a.score);
  }, [commands, recentCommands, search]);

  const groupedCommands = useMemo(() => {
    if (search.trim()) {
      return { 'Search Results': filteredCommands };
    }

    const groups: Record<string, CommandItem[]> = {
      Recent: [],
      Navigation: [],
      Actions: [],
      Help: [],
    };

    filteredCommands.forEach((command) => {
      const group =
        command.category === 'recent'
          ? 'Recent'
          : command.category === 'navigation'
            ? 'Navigation'
            : command.category === 'action'
              ? 'Actions'
              : 'Help';
      groups[group].push(command);
    });

    return Object.fromEntries(Object.entries(groups).filter(([, items]) => items.length > 0));
  }, [filteredCommands, search]);

  const runCommand = useCallback(
    (command: CommandItem) => {
      command.action();
      addRecentCommand(command.id);
      setIsOpen(false);
      setSearch('');
      setShowShortcuts(false);
    },
    [addRecentCommand]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setIsOpen((previous) => !previous);
        setSearch('');
        setSelectedIndex(0);
        setShowShortcuts(false);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        const nextTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
        setTheme(nextTheme);
        return;
      }

      if (!isOpen) {
        return;
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setSelectedIndex((previous) => (previous + 1) % filteredCommands.length);
          break;
        case 'ArrowUp':
          event.preventDefault();
          setSelectedIndex((previous) => (previous - 1 + filteredCommands.length) % filteredCommands.length);
          break;
        case 'Enter':
          event.preventDefault();
          if (filteredCommands[selectedIndex]) {
            runCommand(filteredCommands[selectedIndex]);
          }
          break;
        case 'Escape':
          event.preventDefault();
          if (showShortcuts) {
            setShowShortcuts(false);
          } else {
            setIsOpen(false);
            setSearch('');
          }
          break;
      }
    },
    [filteredCommands, isOpen, resolvedTheme, runCommand, selectedIndex, setTheme, showShortcuts]
  );

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = 'detail' in event ? (event as CustomEvent<{ mode?: 'search' | 'shortcuts' }>).detail : undefined;
      setIsOpen(true);
      setSearch('');
      setSelectedIndex(0);
      setShowShortcuts(detail?.mode === 'shortcuts');
    };

    document.addEventListener('patchpilot:open-command-palette', handleOpen);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('patchpilot:open-command-palette', handleOpen);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  useEffect(() => {
    setIsOpen(false);
    setShowShortcuts(false);
  }, [pathname]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.button
            type="button"
            aria-label="Close command palette"
            className="fixed inset-0 z-[100] bg-background/70 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsOpen(false)}
          />

          <motion.div
            className="fixed inset-x-4 top-[10vh] z-[101] mx-auto max-w-2xl"
            initial={{ opacity: 0, scale: 0.96, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -10 }}
            transition={{ duration: 0.16 }}
          >
            <div className="overflow-hidden rounded-[1.5rem] border border-border/80 bg-card/95 shadow-[0_30px_120px_-40px_rgba(15,23,42,0.55)] backdrop-blur-xl">
              <div className="flex items-center gap-3 border-b border-border/80 px-5 py-4">
                {showShortcuts ? <Keyboard className="h-5 w-5 text-primary" /> : <Search className="h-5 w-5 text-primary" />}
                <input
                  type="text"
                  placeholder={showShortcuts ? 'Keyboard shortcuts' : 'Search commands, routes, and actions'}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
                  autoFocus
                  readOnly={showShortcuts}
                />
                <button
                  type="button"
                  onClick={() => {
                    if (showShortcuts) {
                      setShowShortcuts(false);
                    } else {
                      setIsOpen(false);
                    }
                  }}
                  className="rounded-xl border border-border/70 bg-background/80 p-2 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label="Close command palette"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="max-h-[55vh] overflow-y-auto p-3">
                {showShortcuts ? (
                  <ShortcutsView theme={theme} resolvedTheme={resolvedTheme} />
                ) : filteredCommands.length === 0 ? (
                  <div className="py-14 text-center">
                    <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl bg-primary/10 text-primary">
                      <Search className="h-7 w-7" />
                    </div>
                    <p className="font-medium text-foreground">No results found</p>
                    <p className="mt-1 text-sm text-muted-foreground">Try a different search term.</p>
                  </div>
                ) : (
                  Object.entries(groupedCommands).map(([group, items]) => (
                    <div key={group} className="mb-4 last:mb-0">
                      <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        {group}
                      </p>
                      <div className="space-y-1">
                        {items.map((command) => {
                          const globalIndex = filteredCommands.indexOf(command);

                          return (
                            <CommandRow
                              key={command.id}
                              command={command}
                              isSelected={globalIndex === selectedIndex}
                              onClick={() => runCommand(command)}
                            />
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {!showShortcuts && (
                <div className="flex items-center justify-between border-t border-border/80 bg-muted/20 px-5 py-3 text-xs text-muted-foreground">
                  <div className="flex items-center gap-4">
                    <span className="flex items-center gap-1">
                      <kbd className="rounded-lg border border-border/70 bg-background/80 px-2 py-1">↑</kbd>
                      <kbd className="rounded-lg border border-border/70 bg-background/80 px-2 py-1">↓</kbd>
                      <span className="ml-1">navigate</span>
                    </span>
                    <span className="flex items-center gap-1">
                      <kbd className="rounded-lg border border-border/70 bg-background/80 px-2 py-1">↵</kbd>
                      <span>select</span>
                    </span>
                  </div>
                  <button
                    type="button"
                    className="flex items-center gap-1 transition-colors hover:text-foreground"
                    onClick={() => setShowShortcuts(true)}
                    data-help-trigger
                  >
                    <HelpCircle className="h-3.5 w-3.5" />
                    <span>Shortcuts</span>
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function CommandRow({
  command,
  isSelected,
  onClick,
}: {
  command: CommandItem;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left transition-colors',
        isSelected
          ? 'border-primary/20 bg-primary/10 text-foreground'
          : 'border-transparent text-foreground/90 hover:border-border hover:bg-accent/50'
      )}
    >
      <div
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
          isSelected ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
        )}
      >
        <command.icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{command.label}</p>
        {command.description && <p className="truncate text-xs text-muted-foreground">{command.description}</p>}
      </div>
      <div className="flex items-center gap-3">
        {command.shortcut && (
          <span className="hidden rounded-lg border border-border/70 bg-background/80 px-2 py-1 text-[11px] text-muted-foreground sm:inline-flex">
            {command.shortcut}
          </span>
        )}
        <ArrowRight className={cn('h-4 w-4', isSelected ? 'text-primary' : 'text-muted-foreground')} />
      </div>
    </button>
  );
}

function ShortcutsView({
  theme,
  resolvedTheme,
}: {
  theme: 'light' | 'dark' | 'system';
  resolvedTheme: 'light' | 'dark';
}) {
  const groups = [
    {
      title: 'Navigation',
      items: [
        ['⌘/Ctrl + K', 'Open command palette'],
        ['↑ / ↓', 'Move through results'],
        ['Enter', 'Run selected command'],
        ['Esc', 'Close palette or shortcuts'],
      ],
    },
    {
      title: 'Appearance',
      items: [
        ['⌘/Ctrl + Shift + L', `Toggle light/dark (current: ${resolvedTheme})`],
        ['Theme menu', `Theme preference is ${theme}`],
      ],
    },
  ];

  return (
    <div className="space-y-4 p-2">
      {groups.map((group) => (
        <div key={group.title} className="rounded-2xl border border-border/80 bg-muted/20 p-4">
          <p className="text-sm font-semibold text-foreground">{group.title}</p>
          <div className="mt-3 space-y-2">
            {group.items.map(([shortcut, description]) => (
              <div key={shortcut} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-muted-foreground">{description}</span>
                <kbd className="rounded-lg border border-border/70 bg-background/80 px-2 py-1 text-[11px] text-foreground">
                  {shortcut}
                </kbd>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
