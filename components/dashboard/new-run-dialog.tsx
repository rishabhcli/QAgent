'use client';

import { useEffect, useMemo, useState } from 'react';
import { Box, Globe, Loader2, Rocket, Sparkles, Wand2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSession } from '@/lib/hooks/use-session';
import { useToast } from '@/components/ui/toaster';

interface NewRunDialogProps {
  onRunCreated?: (runId: string) => void;
}

export function NewRunDialog({ onRunCreated }: NewRunDialogProps) {
  const router = useRouter();
  const { selectedRepos, primaryRepo, isAuthenticated } = useSession();
  const { error: showError, info, success } = useToast();
  const [open, setOpen] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [sandboxMode, setSandboxMode] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    if (selectedRepos.length === 0) {
      setSelectedRepo('');
      return;
    }

    if (!selectedRepos.some((repo) => repo.fullName === selectedRepo)) {
      setSelectedRepo(primaryRepo?.fullName || selectedRepos[0].fullName);
    }
  }, [open, primaryRepo, selectedRepo, selectedRepos]);

  const selectedRepository = useMemo(
    () => selectedRepos.find((repo) => repo.fullName === selectedRepo) ?? primaryRepo ?? null,
    [primaryRepo, selectedRepo, selectedRepos]
  );

  const handleQuickStart = async () => {
    if (!selectedRepository) {
      showError('Select a repository', 'Choose a connected repository before starting a run.');
      return;
    }

    if (!sandboxMode && targetUrl && !/^https?:\/\//i.test(targetUrl)) {
      showError('Invalid target URL', 'Enter a full URL including http:// or https://.');
      return;
    }

    setIsGenerating(true);

    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          repoId: String(selectedRepository.id),
          repoName: selectedRepository.fullName,
          targetUrl: sandboxMode ? undefined : (targetUrl || undefined),
          maxIterations: 5,
          cloudMode: true,
          sandboxMode,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to start run');
      }

      const data = await response.json();
      success('Run created', 'QAgent has started the analysis pipeline.');

      window.setTimeout(() => {
        setOpen(false);
        setIsGenerating(false);
        onRunCreated?.(data.run.id);
      }, 450);
    } catch (error) {
      setIsGenerating(false);
      showError(
        'Unable to start run',
        error instanceof Error ? error.message : 'QAgent could not create a run.'
      );
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setIsGenerating(false);
    }
  };

  const hasConnectedRepos = selectedRepos.length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          className="min-h-11 bg-[linear-gradient(135deg,hsl(var(--primary)),hsl(var(--primary)/0.75))] shadow-lg shadow-primary/20"
          data-new-run-trigger
        >
          <Rocket className="mr-2 h-4 w-4" />
          New Run
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Start a QAgent run
          </DialogTitle>
          <DialogDescription>
            QAgent will inspect your repository, run validations, generate fixes, and open GitHub pull requests for review or auto-merge.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="rounded-2xl border border-border/80 bg-muted/30 p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Wand2 className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">Automated code analysis and repair</p>
                <p className="text-sm text-muted-foreground">
                  The run checks repository health, diagnoses failures, generates targeted patches, and routes the result into GitHub pull requests.
                </p>
              </div>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="quick-repo">Repository</Label>
            {hasConnectedRepos ? (
              <Select value={selectedRepo} onValueChange={setSelectedRepo}>
                <SelectTrigger id="quick-repo" className="min-h-11">
                  <SelectValue placeholder="Select a repository" />
                </SelectTrigger>
                <SelectContent>
                  {selectedRepos.map((repo) => (
                    <SelectItem key={repo.id} value={repo.fullName}>
                      {repo.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="rounded-2xl border border-dashed border-border bg-muted/30 p-4">
                <p className="text-sm font-medium text-foreground">No repositories connected</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Connect GitHub and choose at least one repository in settings before starting a run.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    handleOpenChange(false);
                    info('Open settings', 'Connect GitHub to enable automated PR workflows.');
                    router.push('/dashboard/settings');
                  }}
                >
                  Open Settings
                </Button>
              </div>
            )}
          </div>

          <div className="grid gap-2">
            <button
              type="button"
              onClick={() => setSandboxMode(!sandboxMode)}
              className={`flex items-start gap-3 rounded-2xl border p-4 text-left transition-colors ${
                sandboxMode
                  ? 'border-primary/50 bg-primary/5'
                  : 'border-border/80 bg-muted/30 hover:border-border'
              }`}
            >
              <div className={`mt-0.5 flex h-5 w-5 items-center justify-center rounded-md border ${
                sandboxMode ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
              }`}>
                {sandboxMode && (
                  <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M2 6l3 3 5-5" />
                  </svg>
                )}
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Box className="h-4 w-4 text-primary" />
                  <span className="text-sm font-semibold text-foreground">Run from source</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Clone the repo into a cloud sandbox, start the dev server, and test the running UI automatically. No deployed URL needed.
                </p>
              </div>
            </button>
          </div>

          {!sandboxMode && (
            <div className="grid gap-2">
              <Label htmlFor="target-url" className="flex items-center gap-2">
                <Globe className="h-4 w-4" />
                Deployed URL
                <span className="text-xs font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="target-url"
                type="url"
                placeholder="https://your-app.vercel.app"
                value={targetUrl}
                onChange={(event) => setTargetUrl(event.target.value)}
                className="min-h-11 font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Provide a public deployment if you want Browserbase validation against a live environment. Leave this blank to run repository-first checks only.
              </p>
            </div>
          )}

          {isGenerating && (
            <div className="flex items-center gap-3 py-4">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">Creating run...</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isGenerating}>
            Cancel
          </Button>
          <Button onClick={handleQuickStart} disabled={isGenerating || !selectedRepository || !isAuthenticated} className="min-h-11">
            {isGenerating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Starting run…
              </>
            ) : (
              <>
                <Rocket className="mr-2 h-4 w-4" />
                Analyze & Fix
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default NewRunDialog;
