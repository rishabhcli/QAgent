'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Monitor,
  Maximize2,
  ExternalLink,
  Loader2,
  WifiOff,
  Play,
  RefreshCw,
  Eye,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { motion, AnimatePresence } from 'framer-motion';

interface SessionDebugInfo {
  hasSession: boolean;
  sessionId?: string;
  debuggerUrl?: string;
  debuggerFullscreenUrl?: string;
  wsUrl?: string;
  isActive?: boolean;
  error?: string;
  message?: string;
}

interface LiveBrowserViewerProps {
  runId: string;
  isRunning?: boolean;
  className?: string;
}

export function LiveBrowserViewer({
  runId,
  isRunning = false,
  className,
}: LiveBrowserViewerProps) {
  const [sessionInfo, setSessionInfo] = useState<SessionDebugInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const buildIframeUrl = (url: string, extraParams?: Record<string, string>): string => {
    try {
      const parsed = new URL(url);
      parsed.searchParams.set('navbar', 'false');
      if (extraParams) {
        for (const [key, value] of Object.entries(extraParams)) {
          parsed.searchParams.set(key, value);
        }
      }
      return parsed.toString();
    } catch {
      const params = new URLSearchParams({ navbar: 'false', ...extraParams });
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}${params.toString()}`;
    }
  };

  const iframeSrc = sessionInfo?.debuggerUrl
    ? buildIframeUrl(sessionInfo.debuggerUrl)
    : undefined;

  useEffect(() => {
    let isMounted = true;

    const fetchSession = async () => {
      try {
        const res = await fetch(`/api/runs/${runId}/session`, {
          credentials: 'include',
        });
        if (!res.ok) {
          throw new Error('Failed to fetch session');
        }
        const data: SessionDebugInfo = await res.json();
        if (isMounted) {
          setSessionInfo(data);
          setError(null);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Unknown error');
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    fetchSession();

    // Poll for session updates while running
    const interval = setInterval(() => {
      if (isRunning) {
        fetchSession();
      }
    }, 3000);

    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [runId, isRunning, retryCount]);

  const handleFullscreen = () => {
    if (sessionInfo?.debuggerFullscreenUrl) {
      window.open(sessionInfo.debuggerFullscreenUrl, '_blank');
    }
  };

  const handleExternalLink = () => {
    if (sessionInfo?.debuggerUrl) {
      window.open(sessionInfo.debuggerUrl, '_blank');
    }
  };

  const handleRefresh = () => {
    setIframeLoaded(false);
    setRetryCount((prev) => prev + 1);
    if (iframeRef.current && sessionInfo?.debuggerUrl) {
      iframeRef.current.src = buildIframeUrl(sessionInfo.debuggerUrl, {
        t: String(Date.now()),
      });
    }
  };

  const handleIframeLoad = () => {
    setIframeLoaded(true);
  };

  return (
    <Card
      className={cn(
        'flex flex-col overflow-hidden border-2',
        isRunning && sessionInfo?.hasSession
          ? 'border-primary/20 shadow-[0_24px_80px_-40px_rgba(59,91,219,0.5)]'
          : 'border-border/80',
        className
      )}
    >
      <CardHeader className="border-b border-border/80 bg-card/80 pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-3">
            <div className="relative">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-sm">
                <Monitor className="h-5 w-5 text-primary" />
              </div>
              {isRunning && sessionInfo?.hasSession && (
                <span className="absolute -top-1 -right-1 flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500" />
                </span>
              )}
            </div>
            <div className="flex flex-col">
              <span className="flex items-center gap-2 font-semibold text-foreground">
                Live Browser
                <span className="rounded-full border border-border/80 bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  BROWSERBASE
                </span>
              </span>
              <span className="text-xs text-muted-foreground font-normal">
                {sessionInfo?.hasSession
                  ? sessionInfo.isActive
                    ? 'Streaming live browser session'
                    : 'Session available'
                  : 'Waiting for session...'}
              </span>
            </div>
          </CardTitle>
          {sessionInfo?.hasSession && sessionInfo.debuggerUrl && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={handleRefresh}
                title="Refresh"
                className="hover:bg-accent"
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleFullscreen}
                title="Fullscreen"
                className="hover:bg-accent"
              >
                <Maximize2 className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleExternalLink}
                title="Open in new tab"
                className="hover:bg-accent"
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex-1 p-0 min-h-0 relative">
        {/* Browser chrome mockup */}
        <div className="flex items-center gap-2 border-b border-border/70 bg-muted/40 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/80" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
            <div className="w-3 h-3 rounded-full bg-green-500/80" />
          </div>
          <div className="flex-1 mx-4">
            <div className="flex max-w-md items-center gap-2 rounded-xl border border-border/70 bg-background/90 px-3 py-1.5 text-xs text-muted-foreground">
              <Eye className="h-3 w-3" />
              <span className="truncate">
                {sessionInfo?.hasSession
                  ? 'browserbase.com/session/' +
                    (sessionInfo.sessionId?.slice(0, 8) || '...')
                  : 'No active session'}
              </span>
            </div>
          </div>
        </div>

        {/* Browser viewport */}
        <div className="relative aspect-video overflow-hidden bg-background">

          <AnimatePresence mode="wait">
            {isLoading ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 flex flex-col items-center justify-center"
              >
                <div className="relative">
                  <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground">
                  Connecting to browser session...
                </p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  Powered by Browserbase
                </p>
              </motion.div>
            ) : error ? (
              <motion.div
                key="error"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 flex flex-col items-center justify-center text-center p-6"
              >
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-destructive/20 bg-destructive/10">
                  <WifiOff className="h-8 w-8 text-destructive" />
                </div>
                <p className="mb-2 text-sm text-destructive">
                  Failed to connect to browser session
                </p>
                <p className="text-xs text-muted-foreground/70 max-w-xs">
                  {error}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRetryCount((prev) => prev + 1)}
                  className="mt-4"
                >
                  <RefreshCw className="h-3 w-3 mr-2" />
                  Retry
                </Button>
              </motion.div>
            ) : !sessionInfo?.hasSession ? (
              <motion.div
                key="no-session"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 flex flex-col items-center justify-center text-center p-6"
              >
                <div className="relative mb-6">
                  <div className="flex h-20 w-20 items-center justify-center rounded-3xl border border-primary/20 bg-primary/10">
                    <Monitor className="h-10 w-10 text-primary/70" />
                  </div>
                  <div className="absolute -bottom-2 -right-2 flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg">
                    <Zap className="h-4 w-4 text-primary-foreground" />
                  </div>
                </div>
                <p className="text-sm text-muted-foreground mb-1 font-medium">
                  No active browser session
                </p>
                <p className="text-xs text-muted-foreground/70 max-w-xs">
                  {sessionInfo?.message ||
                    'A live browser window will appear here when a test starts running'}
                </p>
              </motion.div>
            ) : sessionInfo.debuggerUrl ? (
              <motion.div
                key="iframe"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0"
              >
                {/* Loading overlay while iframe loads */}
                {!iframeLoaded && (
                  <div className="absolute inset-0 z-20 flex items-center justify-center bg-background">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  </div>
                )}

                <iframe
                  ref={iframeRef}
                  key={retryCount}
                  src={iframeSrc}
                  className="w-full h-full border-0"
                  allow="clipboard-read; clipboard-write"
                  sandbox="allow-same-origin allow-scripts allow-forms"
                  title="Live Browser Session - Browserbase"
                  onLoad={handleIframeLoad}
                />

                {/* Live indicator overlay */}
                {isRunning && (
                  <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-full border border-emerald-500/30 bg-background/90 px-3 py-1.5 text-xs font-medium text-emerald-600 shadow-sm backdrop-blur-md dark:text-emerald-400">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                    </span>
                    LIVE
                  </div>
                )}

                {/* Browserbase branding */}
                <div className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-1.5 rounded border border-border/70 bg-background/85 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur-md">
                  <div className="h-3 w-3 rounded bg-primary" />
                  Browserbase
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="no-debugger"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 flex flex-col items-center justify-center text-center p-6"
              >
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10">
                  <Play className="h-8 w-8 text-amber-600 dark:text-amber-400" />
                </div>
                <p className="text-sm text-muted-foreground">
                  Session started but debugger URL not available
                </p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  The session may still be initializing
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </CardContent>

      {/* Session info footer */}
      <div
        className={cn(
          'px-4 py-2.5 border-t text-xs flex items-center justify-between',
          sessionInfo?.hasSession ? 'bg-muted/20' : 'bg-muted/30'
        )}
      >
        <div className="flex items-center gap-3">
          {sessionInfo?.hasSession && sessionInfo.sessionId ? (
            <>
              <span className="font-mono text-muted-foreground">
                <span className="text-primary">session:</span>{' '}
                {sessionInfo.sessionId.slice(0, 12)}...
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">No active session</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {sessionInfo?.hasSession && (
            <span
              className={cn(
                'px-2 py-0.5 rounded-full text-[10px] font-medium',
                sessionInfo.isActive
                  ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              {sessionInfo.isActive ? '● Connected' : '○ Inactive'}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
