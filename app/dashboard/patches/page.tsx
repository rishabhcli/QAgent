'use client';

import { useState, useEffect, useCallback } from 'react';
import { GitBranch, CheckCircle, Clock, ExternalLink, Filter, Eye, Loader2, RefreshCw, Wrench } from 'lucide-react';
import { Header } from '@/components/dashboard/header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toaster';

interface PatchDiagnosis {
  type: string;
  confidence: number;
  rootCause: string;
}

interface Patch {
  id: string;
  file: string;
  description: string;
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  status: 'applied' | 'pending';
  runId: string;
  createdAt: string;
  prUrl?: string;
  prNumber?: number;
  merged?: boolean;
  mergeMethod?: string;
  mergeCommitSha?: string;
  mergeError?: string;
  diagnosis?: PatchDiagnosis;
}

const statusConfig = {
  applied: { label: 'Merged', variant: 'success' as const, icon: CheckCircle },
  pending: { label: 'Pending', variant: 'secondary' as const, icon: Clock },
};

function getPatchStatusLabel(patch: Patch): string {
  if (patch.merged) {
    return 'Merged';
  }
  if (patch.prUrl) {
    return patch.mergeError ? 'PR Open' : 'PR Created';
  }
  return statusConfig[patch.status].label;
}

export default function PatchesPage() {
  const { error: showError } = useToast();
  const [patches, setPatches] = useState<Patch[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [filter, setFilter] = useState<string>('all');
  const [selectedPatch, setSelectedPatch] = useState<Patch | null>(null);

  const fetchPatches = useCallback(async () => {
    try {
      const res = await fetch('/api/patches');
      if (res.ok) {
        const data = await res.json();
        setPatches(data.patches || []);
      } else {
        showError('Failed to load patches', 'PatchPilot could not fetch patch history.');
      }
    } catch {
      showError('Failed to load patches', 'Check your connection and try again.');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [showError]);

  useEffect(() => {
    fetchPatches();
  }, [fetchPatches]);

  const handleRefresh = () => {
    setIsRefreshing(true);
    fetchPatches();
  };

  const filteredPatches = filter === 'all' ? patches : patches.filter((p) => p.status === filter);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen">
        <Header title="Patches" />
        <div className="flex items-center justify-center h-96">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header title="Patches" />

      <div className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
        {/* Actions Bar */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">Patch delivery</p>
            <p className="text-sm text-muted-foreground">
              Review generated diffs, pull requests, merge outcomes, and any policy blocks that need attention.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Filter className="mr-2 h-4 w-4" />
                  {filter === 'all' ? 'All Status' : statusConfig[filter as keyof typeof statusConfig]?.label}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={() => setFilter('all')}>All Status</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setFilter('applied')}>Applied</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setFilter('pending')}>Pending</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Patches List */}
        <Card className="border-border/80 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">All Patches ({patches.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {filteredPatches.length === 0 ? (
                <EmptyState
                  variant={filter === 'all' ? 'no-data' : 'search'}
                  title={filter === 'all' ? 'No patches yet' : 'No patches match this filter'}
                  description={
                    filter === 'all'
                      ? 'Patches appear here after a run generates or merges a fix.'
                      : 'Try a different filter or refresh once more patch data is available.'
                  }
                  compact
                />
              ) : (
                filteredPatches.map((patch) => {
                  const config = statusConfig[patch.status] || statusConfig.pending;
                  const StatusIcon = config.icon;
                  return (
                    <div
                      key={patch.id}
                      className="flex items-center justify-between rounded-2xl border border-border/70 bg-card/80 p-4 transition-all hover:border-primary/20 hover:bg-accent/40"
                    >
                      <div className="flex items-center gap-4">
                        <div className="p-2.5 rounded-lg bg-primary/10">
                          <GitBranch className="h-5 w-5 text-primary" />
                        </div>
                        <div>
                          <p className="font-mono text-sm font-medium">{patch.file}</p>
                          <p className="text-sm text-muted-foreground mt-0.5">
                            {patch.description}
                          </p>
                          <div className="flex items-center gap-3 mt-2 text-xs">
                            <span className="text-success">+{patch.linesAdded}</span>
                            <span className="text-destructive">-{patch.linesRemoved}</span>
                            <span className="text-muted-foreground">
                              Run #{patch.runId?.slice(0, 8)} · {formatDate(patch.createdAt)}
                            </span>
                            {patch.prUrl && (
                              <span className="text-muted-foreground">
                                {patch.merged ? 'Merged to default branch' : 'PR awaiting merge'}
                              </span>
                            )}
                          </div>
                          {patch.mergeError && (
                            <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                              Auto-merge blocked: {patch.mergeError}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Badge variant={config.variant}>
                          <StatusIcon className="mr-1 h-3 w-3" />
                          {getPatchStatusLabel(patch)}
                        </Badge>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSelectedPatch(patch)}
                        >
                          <Eye className="mr-1 h-3 w-3" />
                          View
                        </Button>
                        {patch.prUrl && (
                          <Button variant="ghost" size="icon" asChild>
                            <a href={patch.prUrl} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Patch Detail Dialog */}
      <Dialog open={!!selectedPatch} onOpenChange={() => setSelectedPatch(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{selectedPatch?.file}</DialogTitle>
            <DialogDescription>{selectedPatch?.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* Diagnosis */}
            {selectedPatch?.diagnosis && (
              <div className="p-4 rounded-lg bg-secondary/50">
                <h4 className="text-sm font-medium mb-2">Diagnosis</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{selectedPatch.diagnosis.type}</Badge>
                    <span className="text-muted-foreground">
                      {(selectedPatch.diagnosis.confidence * 100).toFixed(0)}% confidence
                    </span>
                  </div>
                  <p className="text-muted-foreground">{selectedPatch.diagnosis.rootCause}</p>
                </div>
              </div>
            )}

            {(selectedPatch?.prUrl || selectedPatch?.mergeError) && (
              <div className="p-4 rounded-lg bg-secondary/50">
                <h4 className="text-sm font-medium mb-2">GitHub Status</h4>
                <div className="space-y-2 text-sm text-muted-foreground">
                  {selectedPatch?.prUrl && (
                    <p>
                      Pull request #{selectedPatch.prNumber ?? 'unknown'}{' '}
                      {selectedPatch.merged ? 'was merged' : 'has been created'}.
                    </p>
                  )}
                  {selectedPatch?.mergeMethod && (
                    <p>Merge method: {selectedPatch.mergeMethod}</p>
                  )}
                  {selectedPatch?.mergeCommitSha && (
                    <p>Merge commit: {selectedPatch.mergeCommitSha}</p>
                  )}
                  {selectedPatch?.mergeError && (
                    <p className="text-amber-600 dark:text-amber-400">Auto-merge blocked: {selectedPatch.mergeError}</p>
                  )}
                </div>
              </div>
            )}

            {/* Diff */}
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="bg-muted px-4 py-2 border-b border-border">
                <span className="text-xs font-medium text-muted-foreground">Diff</span>
              </div>
              <pre className="p-4 text-xs font-mono overflow-x-auto bg-background max-h-96">
                {selectedPatch?.diff ? (
                  selectedPatch.diff.split('\n').map((line, i) => (
                    <div
                      key={i}
                      className={
                        line.startsWith('+') && !line.startsWith('+++')
                          ? 'text-success bg-success/10'
                          : line.startsWith('-') && !line.startsWith('---')
                            ? 'text-destructive bg-destructive/10'
                            : line.startsWith('@@')
                              ? 'text-primary'
                              : 'text-muted-foreground'
                      }
                    >
                      {line}
                    </div>
                  ))
                ) : (
                  <span className="text-muted-foreground">No diff available</span>
                )}
              </pre>
            </div>
          </div>
          <DialogFooter>
            {selectedPatch?.prUrl && (
              <Button asChild>
                <a href={selectedPatch.prUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  View Pull Request
                </a>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
