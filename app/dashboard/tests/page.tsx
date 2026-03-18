'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Plus, TestTube2, Edit, Trash2, Play, Loader2, RefreshCw, Sparkles, FileCode2, BookOpen, HelpCircle, Wand2 } from 'lucide-react';
import { Header } from '@/components/dashboard/header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TestGeneratorDialog } from '@/components/dashboard/test-generator-dialog';
import { useToast } from '@/components/ui/toaster';

interface TestSpec {
  id: string;
  name: string;
  url: string;
  steps: Array<{ action: string; expected?: string }>;
  timeout?: number;
}

export default function TestsPage() {
  const { error: showError, success } = useToast();
  const [testSpecs, setTestSpecs] = useState<TestSpec[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchTestSpecs = useCallback(async () => {
    try {
      const res = await fetch('/api/tests', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setTestSpecs(data.testSpecs || []);
      } else {
        showError('Failed to load test specs', 'QAgent could not fetch your saved test definitions.');
      }
    } catch {
      showError('Failed to load test specs', 'Check your connection and try again.');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [showError]);

  useEffect(() => {
    fetchTestSpecs();
  }, [fetchTestSpecs]);

  const handleRefresh = () => {
    setIsRefreshing(true);
    fetchTestSpecs();
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/tests/${id}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) {
        fetchTestSpecs();
        success('Test spec deleted');
      } else {
        showError('Failed to delete test spec');
      }
    } catch {
      showError('Failed to delete test spec');
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen">
        <Header title="Test Specs" />
        <div className="flex items-center justify-center h-96">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header title="Test Specs" />

      <div className="mx-auto max-w-7xl space-y-6 p-6 lg:p-8">
        {/* Actions Bar */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">Test specifications</p>
            <p className="text-sm text-muted-foreground">
              Define manual flows or auto-generate them so QAgent has reliable coverage targets.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <TestGeneratorDialog
              onTestsGenerated={() => fetchTestSpecs()}
              triggerButton={
                <Button variant="outline">
                  <Wand2 className="mr-2 h-4 w-4" />
                  Auto-Generate
                </Button>
              }
            />
            <Link href="/dashboard/tests/new">
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                New Test Spec
              </Button>
            </Link>
          </div>
        </div>

        {/* Tests Grid */}
        {testSpecs.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {testSpecs.map((spec) => (
              <Card key={spec.id} className="hover:border-primary/50 transition-colors">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="p-2 rounded-lg bg-primary/10">
                        <TestTube2 className="h-4 w-4 text-primary" />
                      </div>
                      <CardTitle className="text-base">{spec.name}</CardTitle>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="text-sm">
                      <p className="text-muted-foreground truncate">{spec.url}</p>
                    </div>
                    <div className="flex items-center justify-between text-sm text-muted-foreground">
                      <span>{spec.steps.length} step(s)</span>
                      {spec.timeout && <span>Timeout: {spec.timeout / 1000}s</span>}
                    </div>
                    <div className="flex items-center gap-2 pt-2">
                      <Link href={`/dashboard/tests/new?edit=${spec.id}`} className="flex-1">
                        <Button variant="outline" size="sm" className="w-full">
                          <Edit className="mr-1 h-3 w-3" />
                          Edit
                        </Button>
                      </Link>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => handleDelete(spec.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          /* Empty State */
          <EmptyState
            icon={TestTube2}
            title="No test specs yet"
            description="Create test specifications that QAgent will use to automatically test your application and find bugs."
            action={
              <Link href="/dashboard/tests/new">
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Test Spec
                </Button>
              </Link>
            }
            gradient="from-emerald-500/20 to-teal-600/20"
            suggestions={[
              {
                icon: Sparkles,
                title: 'Use AI to Generate Tests',
                description: 'Describe what to test in natural language',
              },
              {
                icon: FileCode2,
                title: 'Import from Playwright',
                description: 'Convert existing Playwright tests',
              },
              {
                icon: BookOpen,
                title: 'Browse Templates',
                description: 'Start with common test patterns',
              },
              {
                icon: HelpCircle,
                title: 'Read the Docs',
                description: 'Learn how to write effective tests',
              },
            ]}
            tip="Start with simple user flows like login or checkout for best results."
          />
        )}
      </div>
    </div>
  );
}
