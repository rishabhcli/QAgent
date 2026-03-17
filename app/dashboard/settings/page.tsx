'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { Github, Check, AlertCircle, Link2, Unlink, RefreshCw, Loader2, ShieldCheck, Wand2 } from 'lucide-react';
import { Header } from '@/components/dashboard/header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toaster';

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
}

interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  url: string;
  defaultBranch: string;
}

interface SessionData {
  authenticated: boolean;
  user?: GitHubUser;
  repos?: GitHubRepo[];
  selectedRepoIds?: number[];
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsPageSkeleton />}>
      <SettingsPageContent />
    </Suspense>
  );
}

function SettingsPageSkeleton() {
  return (
    <div className="min-h-screen">
      <Header title="Settings" />
      <div className="p-6 space-y-6 max-w-3xl">
        <div className="h-64 bg-muted/30 rounded-lg animate-pulse" />
      </div>
    </div>
  );
}

function SettingsPageContent() {
  const searchParams = useSearchParams();
  const { success, error: showError, info } = useToast();
  const [session, setSession] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedRepos, setSelectedRepos] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    // Check URL params for OAuth result
    const connected = searchParams.get('connected');
    const error = searchParams.get('error');

    if (connected === 'true') {
      setMessage({ type: 'success', text: 'GitHub account connected successfully!' });
    } else if (error) {
      const errorMessages: Record<string, string> = {
        invalid_state: 'Invalid OAuth state. Please try again.',
        no_code: 'No authorization code received.',
        oauth_failed: 'OAuth authentication failed. Please try again.',
      };
      setMessage({ type: 'error', text: errorMessages[error] || 'An error occurred.' });
    }

    // Fetch current session
    fetchSession();
  }, [searchParams]);

  const fetchSession = async () => {
    try {
      const res = await fetch('/api/auth/session');
      const data = await res.json();
      setSession(data);
      if (data.repos?.length > 0) {
        const selection = Array.isArray(data.selectedRepoIds) && data.selectedRepoIds.length > 0
          ? data.selectedRepoIds
          : [data.repos[0].id];

        setSelectedRepos(new Set(selection));

        if (!data.selectedRepoIds || data.selectedRepoIds.length === 0) {
          await fetch('/api/auth/session', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selectedRepoIds: selection }),
          });
        }
      }
    } catch {
      setSession({ authenticated: false });
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = () => {
    window.location.href = '/api/auth/github';
  };

  const handleDisconnect = async () => {
    try {
      await fetch('/api/auth/session', { method: 'DELETE' });
      setSession({ authenticated: false });
      setMessage({ type: 'success', text: 'GitHub account disconnected.' });
    } catch {
      setMessage({ type: 'error', text: 'Failed to disconnect.' });
      showError('Failed to disconnect', 'PatchPilot could not clear the GitHub session.');
    }
  };

  const toggleRepo = async (repoId: number) => {
    const newSelected = new Set(selectedRepos);
    if (newSelected.has(repoId)) {
      newSelected.delete(repoId);
    } else {
      newSelected.add(repoId);
    }
    setSelectedRepos(newSelected);

    try {
      await fetch('/api/auth/session', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedRepoIds: Array.from(newSelected) }),
      });
      setSession((current) =>
        current
          ? {
              ...current,
              selectedRepoIds: Array.from(newSelected),
            }
          : current
      );
      success('Repository selection updated');
    } catch {
      setMessage({ type: 'error', text: 'Failed to save repository selection.' });
      showError('Failed to save selection', 'PatchPilot could not update the selected repositories.');
    }
  };

  const isConnected = session?.authenticated && session?.user;

  return (
    <div className="min-h-screen bg-background">
      <Header title="Settings" />

      <div className="mx-auto max-w-4xl space-y-6 p-6 lg:p-8">
        {/* Status Message */}
        {message && (
          <div
            className={`p-4 rounded-lg border ${
              message.type === 'success'
                ? 'bg-success/10 border-success/20 text-success'
                : 'bg-destructive/10 border-destructive/20 text-destructive'
            }`}
          >
            <div className="flex items-center gap-2">
              {message.type === 'success' ? (
                <Check className="h-4 w-4" />
              ) : (
                <AlertCircle className="h-4 w-4" />
              )}
              <span className="text-sm font-medium">{message.text}</span>
            </div>
          </div>
        )}

        {/* GitHub Connection */}
        <Card className="border-border/80 shadow-sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Github className="h-5 w-5" />
                  GitHub Connection
                </CardTitle>
                <CardDescription className="mt-1">
                  Connect your GitHub account to create PRs for patches
                </CardDescription>
              </div>
              {isConnected && (
                <Badge variant="success">
                  <Check className="mr-1 h-3 w-3" />
                  Connected
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : !isConnected ? (
              <div className="space-y-4">
                <div className="p-4 rounded-lg bg-muted/50 border border-border">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="h-5 w-5 text-warning mt-0.5" />
                    <div>
                      <p className="text-sm font-medium">Not connected</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        Connect your GitHub account to enable automatic PR creation for patches.
                      </p>
                    </div>
                  </div>
                </div>
                <Button onClick={handleConnect} className="w-full sm:w-auto">
                  <Github className="mr-2 h-4 w-4" />
                  Connect GitHub Account
                </Button>
                <p className="text-xs text-muted-foreground">
                  We&apos;ll request access to your repositories to create branches and pull requests.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 rounded-lg bg-success/10 border border-success/20">
                  <div className="flex items-center gap-3">
                    {session.user?.avatarUrl ? (
                      <Image
                        src={session.user.avatarUrl}
                        alt={session.user.login}
                        width={40}
                        height={40}
                        className="rounded-full"
                      />
                    ) : (
                      <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                        <Github className="h-5 w-5" />
                      </div>
                    )}
                    <div>
                      <p className="font-medium">@{session.user?.login}</p>
                      {session.user?.name && (
                        <p className="text-sm text-muted-foreground">{session.user.name}</p>
                      )}
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={handleDisconnect}>
                    <Unlink className="mr-2 h-4 w-4" />
                    Disconnect
                  </Button>
                </div>

                {/* Repository Selection */}
                {session.repos && session.repos.length > 0 && (
                  <div className="pt-4">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="text-sm font-medium">Select Repositories</h4>
                      <Button variant="ghost" size="sm" onClick={fetchSession}>
                        <RefreshCw className="mr-2 h-3 w-3" />
                        Refresh
                      </Button>
                    </div>
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {session.repos.map((repo) => (
                        <div
                          key={repo.id}
                          className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors ${
                            selectedRepos.has(repo.id)
                              ? 'border-primary bg-primary/5'
                              : 'border-border hover:bg-muted/50'
                          }`}
                          onClick={() => toggleRepo(repo.id)}
                        >
                          <div className="flex items-center gap-3">
                            <div
                              className={`h-4 w-4 rounded border flex items-center justify-center ${
                                selectedRepos.has(repo.id)
                                  ? 'bg-primary border-primary'
                                  : 'border-muted-foreground'
                              }`}
                            >
                              {selectedRepos.has(repo.id) && (
                                <Check className="h-3 w-3 text-primary-foreground" />
                              )}
                            </div>
                            <span className="font-mono text-sm">{repo.fullName}</span>
                          </div>
                          {selectedRepos.has(repo.id) && (
                            <Badge variant="secondary" className="text-xs">
                              Active
                            </Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Target URL Configuration */}
        <Card className="border-border/80 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Link2 className="h-5 w-5" />
              Validation target
            </CardTitle>
            <CardDescription>
              Choose live environment validation on a per-run basis.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-2xl border border-border/80 bg-muted/30 p-4">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Wand2 className="h-4 w-4" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">Set the deployed URL when launching a run</p>
                  <p className="text-sm text-muted-foreground">
                    PatchPilot validates code first. If you provide a public deployment URL in the new-run dialog, it will also run Browserbase validation against that environment.
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/80 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" />
              Environment prerequisites
            </CardTitle>
            <CardDescription>
              These integrations are configured through environment variables, not this UI.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {[
                'GitHub OAuth for repository selection and pull request creation',
                'OpenAI for diagnosis and patch generation',
                'Browserbase when live browser validation is required',
                'Redis, Vercel, and Weave for persistence, deployment, and observability',
              ].map((item) => (
                <div key={item} className="flex items-start gap-3 rounded-xl border border-border/70 bg-muted/20 px-4 py-3">
                  <Check className="mt-0.5 h-4 w-4 text-primary" />
                  <span className="text-sm text-muted-foreground">{item}</span>
                </div>
              ))}
              <Button
                variant="outline"
                onClick={() => info('Environment setup', 'Review .env.example and deployment settings to update integrations.')}
              >
                View setup guidance
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
