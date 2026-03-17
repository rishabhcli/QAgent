'use client';

import { useState } from 'react';
import {
  Wand2,
  Loader2,
  Globe,
  CheckCircle,
  XCircle,
  ChevronRight,
  Sparkles,
  Navigation,
  FormInput,
  MousePointerClick,
  Lock,
  AlertTriangle,
} from 'lucide-react';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils/cn';
import type { TestSpec } from '@/lib/types';
import { motion, AnimatePresence } from 'framer-motion';

interface DiscoveredFlow {
  name: string;
  url: string;
  type: 'navigation' | 'form' | 'action' | 'auth';
  steps: Array<{ action: string; expected?: string }>;
  confidence: number;
}

interface GenerateResponse {
  success: boolean;
  flows: DiscoveredFlow[];
  testSpecs: TestSpec[];
  summary: {
    totalFlows: number;
    navigationFlows: number;
    formFlows: number;
    actionFlows: number;
    authFlows: number;
    avgConfidence: number;
  };
}

interface TestGeneratorDialogProps {
  onTestsGenerated?: (testSpecs: TestSpec[]) => void;
  triggerButton?: React.ReactNode;
}

const flowTypeIcons = {
  navigation: Navigation,
  form: FormInput,
  action: MousePointerClick,
  auth: Lock,
};

const flowTypeLabels = {
  navigation: 'Navigation',
  form: 'Form',
  action: 'Action',
  auth: 'Auth',
};

const flowTypeColors = {
  navigation: 'text-blue-400 bg-blue-500/10 border-blue-500/30',
  form: 'text-purple-400 bg-purple-500/10 border-purple-500/30',
  action: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  auth: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
};

type GeneratorStep = 'input' | 'generating' | 'review' | 'saving';

export function TestGeneratorDialog({
  onTestsGenerated,
  triggerButton,
}: TestGeneratorDialogProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<GeneratorStep>('input');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState('');
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [selectedFlows, setSelectedFlows] = useState<Set<number>>(new Set());
  const [isSaving, setIsSaving] = useState(false);

  const resetDialog = () => {
    setStep('input');
    setUrl('');
    setError(null);
    setProgress(0);
    setProgressText('');
    setResult(null);
    setSelectedFlows(new Set());
    setIsSaving(false);
  };

  const handleGenerate = async () => {
    if (!url) return;

    setStep('generating');
    setError(null);
    setProgress(10);
    setProgressText('Connecting to browser...');

    try {
      // Simulate progress updates
      const progressInterval = setInterval(() => {
        setProgress((p) => {
          if (p < 30) {
            setProgressText('Navigating to website...');
            return p + 2;
          } else if (p < 50) {
            setProgressText('Discovering interactive elements...');
            return p + 1;
          } else if (p < 70) {
            setProgressText('Analyzing user flows...');
            return p + 0.5;
          } else if (p < 85) {
            setProgressText('Generating test specifications...');
            return p + 0.3;
          }
          return p;
        });
      }, 500);

      const response = await fetch('/api/tests/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          url,
          options: {
            maxPages: 5,
            maxDepth: 2,
            includeAuth: true,
          },
        }),
      });

      clearInterval(progressInterval);

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to generate tests');
      }

      const data: GenerateResponse = await response.json();
      setResult(data);
      setProgress(100);
      setProgressText('Complete!');

      // Auto-select high confidence flows
      const autoSelected = new Set<number>();
      data.flows.forEach((flow, index) => {
        if (flow.confidence >= 0.7) {
          autoSelected.add(index);
        }
      });
      setSelectedFlows(autoSelected);

      // Move to review step
      setTimeout(() => setStep('review'), 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStep('input');
    }
  };

  const toggleFlow = (index: number) => {
    setSelectedFlows((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const handleSave = async () => {
    if (!result) return;

    setIsSaving(true);

    try {
      const selectedSpecs = result.testSpecs.filter((_, index) =>
        selectedFlows.has(index)
      );

      // Save each test spec
      for (const spec of selectedSpecs) {
        await fetch('/api/tests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(spec),
        });
      }

      onTestsGenerated?.(selectedSpecs);
      setOpen(false);
      resetDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save tests');
    } finally {
      setIsSaving(false);
    }
  };

  const renderContent = () => {
    switch (step) {
      case 'input':
        return (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Wand2 className="h-5 w-5 text-primary" />
                Auto-Generate Tests
              </DialogTitle>
              <DialogDescription>
                Enter a URL and PatchPilot will crawl your app to discover user flows
                and automatically generate test specifications.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="url" className="flex items-center gap-2">
                  <Globe className="h-4 w-4" />
                  Website URL
                </Label>
                <Input
                  id="url"
                  type="url"
                  placeholder="https://example.com"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  PatchPilot will navigate your app and discover testable user flows
                </p>
              </div>

              {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {error}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleGenerate}
                disabled={!url}
                className="shadow-lg shadow-primary/20"
              >
                <Sparkles className="mr-2 h-4 w-4" />
                Generate Tests
              </Button>
            </DialogFooter>
          </>
        );

      case 'generating':
        return (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
                Discovering Flows
              </DialogTitle>
              <DialogDescription>
                PatchPilot is crawling your application to discover user flows...
              </DialogDescription>
            </DialogHeader>

            <div className="py-8 space-y-6">
              <div className="space-y-3">
                <Progress value={progress} className="h-2" />
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{progressText}</span>
                  <span className="font-medium">{Math.round(progress)}%</span>
                </div>
              </div>

              <div className="flex items-center justify-center">
                <div className="relative">
                  <div className="flex h-20 w-20 items-center justify-center rounded-3xl border border-primary/20 bg-primary/10">
                    <Wand2 className="h-8 w-8 animate-pulse text-primary" />
                  </div>
                  <motion.div
                    className="absolute -inset-4 rounded-[2rem] border border-primary/15"
                    animate={{
                      scale: [1, 1.1, 1],
                      opacity: [0.5, 0.2, 0.5],
                    }}
                    transition={{ duration: 2, repeat: Infinity }}
                  />
                </div>
              </div>
            </div>
          </>
        );

      case 'review':
        if (!result) return null;

        return (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-success" />
                Review Discovered Flows
              </DialogTitle>
              <DialogDescription>
                Found {result.flows.length} testable flows. Select which ones to save as tests.
              </DialogDescription>
            </DialogHeader>

            <div className="py-4 space-y-4">
              {/* Summary stats */}
              <div className="grid grid-cols-4 gap-2">
                <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-center">
                  <div className="text-lg font-bold text-blue-400">{result.summary.navigationFlows}</div>
                  <div className="text-xs text-muted-foreground">Navigation</div>
                </div>
                <div className="p-2 rounded-lg bg-purple-500/10 border border-purple-500/30 text-center">
                  <div className="text-lg font-bold text-purple-400">{result.summary.formFlows}</div>
                  <div className="text-xs text-muted-foreground">Forms</div>
                </div>
                <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-center">
                  <div className="text-lg font-bold text-amber-400">{result.summary.actionFlows}</div>
                  <div className="text-xs text-muted-foreground">Actions</div>
                </div>
                <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-center">
                  <div className="text-lg font-bold text-emerald-400">{result.summary.authFlows}</div>
                  <div className="text-xs text-muted-foreground">Auth</div>
                </div>
              </div>

              {/* Flow list */}
              <ScrollArea className="h-[300px] border rounded-lg">
                <div className="p-2 space-y-2">
                  <AnimatePresence>
                    {result.flows.map((flow, index) => {
                      const Icon = flowTypeIcons[flow.type];
                      const isSelected = selectedFlows.has(index);

                      return (
                        <motion.div
                          key={index}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: index * 0.05 }}
                          className={cn(
                            'p-3 rounded-lg border cursor-pointer transition-all',
                            isSelected
                              ? 'bg-primary/10 border-primary/30'
                              : 'bg-muted/30 border-border/50 hover:bg-muted/50'
                          )}
                          onClick={() => toggleFlow(index)}
                        >
                          <div className="flex items-start gap-3">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleFlow(index)}
                              className="mt-1 h-4 w-4 rounded"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className={cn(
                                  'p-1 rounded border',
                                  flowTypeColors[flow.type]
                                )}>
                                  <Icon className="h-3 w-3" />
                                </span>
                                <span className="font-medium text-sm">{flow.name}</span>
                                <span className={cn(
                                  'ml-auto text-xs px-1.5 py-0.5 rounded',
                                  flow.confidence >= 0.8 ? 'bg-emerald-500/20 text-emerald-400' :
                                  flow.confidence >= 0.6 ? 'bg-amber-500/20 text-amber-400' :
                                  'bg-gray-500/20 text-gray-400'
                                )}>
                                  {Math.round(flow.confidence * 100)}%
                                </span>
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {flow.steps.length} step(s)
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground/70 truncate">
                                {flow.url}
                              </div>
                            </div>
                          </div>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              </ScrollArea>

              {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {error}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep('input')}>
                Back
              </Button>
              <Button
                onClick={handleSave}
                disabled={selectedFlows.size === 0 || isSaving}
                className="shadow-lg shadow-primary/20"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <CheckCircle className="mr-2 h-4 w-4" />
                    Save {selectedFlows.size} Test(s)
                  </>
                )}
              </Button>
            </DialogFooter>
          </>
        );

      default:
        return null;
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        if (!isOpen) resetDialog();
      }}
    >
      <DialogTrigger asChild>
        {triggerButton || (
          <Button variant="outline">
            <Wand2 className="mr-2 h-4 w-4" />
            Auto-Generate Tests
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[550px]">{renderContent()}</DialogContent>
    </Dialog>
  );
}

export default TestGeneratorDialog;
