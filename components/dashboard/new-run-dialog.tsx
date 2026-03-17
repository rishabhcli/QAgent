'use client';

import { useEffect, useMemo, useState } from 'react';
import { Globe, Loader2, Rocket, Sparkles, Wand2 } from 'lucide-react';
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
import { Progress } from '@/components/ui/progress';
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

const GENERATION_STAGES = [
  { threshold: 18, label: 'Preparing repository workspace' },
  { threshold: 36, label: 'Inspecting project structure' },
  { threshold: 58, label: 'Running validation and analysis' },
  { threshold: 78, label: 'Generating candidate fixes' },
  { threshold: 92, label: 'Preparing pull request workflow' },
];

export function NewRunDialog({ onRunCreated }: NewRunDialogProps) {
  const router = useRouter();
  const { selectedRepos, primaryRepo, isAuthenticated } = useSession();
  const { error: showError, info, success } = useToast();
  const [open, setOpen] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState('');
  const [targetUrl, setTargetUrl] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateProgress, setGenerateProgress] = useState(0);
  const [generateStatus, setGenerateStatus] = useState('');

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

    if (targetUrl && !/^https?:\/\//i.test(targetUrl)) {
      showError('Invalid target URL', 'Enter a full URL including http:// or https://.');
      return;
    }

    setIsGenerating(true);
    setGenerateProgress(8);
    setGenerateStatus(GENERATION_STAGES[0].label);

    const progressInterval = window.setInterval(() => {
      setGenerateProgress((current) => {
        if (current >= 94) {
          return current;
        }

        const next = Math.min(current + 3, 94);
        const stage = GENERATION_STAGES.find(({ threshold }) => next <= threshold) || GENERATION_STAGES[GENERATION_STAGES.length - 1];
        setGenerateStatus(stage.label);
        return next;
      });
    }, 500);

    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          repoId: String(selectedRepository.id),
          repoName: selectedRepository.fullName,
          targetUrl: targetUrl || undefined,
          maxIterations: 5,
          cloudMode: true,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to start run');
      }

      const data = await response.json();
      window.clearInterval(progressInterval);
      setGenerateProgress(100);
      setGenerateStatus('Run created. Redirecting to live view…');
      success('Run created', 'PatchPilot has started the analysis pipeline.');

      window.setTimeout(() => {
        setOpen(false);
        setIsGenerating(false);
        setGenerateProgress(0);
        setGenerateStatus('');
        onRunCreated?.(data.run.id);
      }, 450);
    } catch (error) {
      window.clearInterval(progressInterval);
      setIsGenerating(false);
      setGenerateProgress(0);
      setGenerateStatus('');
      showError(
        'Unable to start run',
        error instanceof Error ? error.message : 'PatchPilot could not create a run.'
      );
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setIsGenerating(false);
      setGenerateProgress(0);
      setGenerateStatus('');
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
            Start a PatchPilot run
          </DialogTitle>
          <DialogDescription>
            PatchPilot will inspect your repository, run validations, generate fixes, and open GitHub pull requests for review or auto-merge.
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

          {isGenerating && (
            <div className="rounded-2xl border border-border/80 bg-card/80 p-4 shadow-sm">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <p className="text-sm font-medium text-foreground">{generateStatus}</p>
              </div>
              <Progress value={generateProgress} className="mt-4 h-2.5" />
              <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>Patch generation pipeline</span>
                <span>{Math.round(generateProgress)}%</span>
              </div>
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
