'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Trash2, GripVertical, Save } from 'lucide-react';
import { Header } from '@/components/dashboard/header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils/cn';
import { useToast } from '@/components/ui/toaster';

interface TestStep {
  id: string;
  action: string;
  expected: string;
}

export default function NewTestPage() {
  const router = useRouter();
  const { error: showError, success } = useToast();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [steps, setSteps] = useState<TestStep[]>([
    { id: '1', action: '', expected: '' },
  ]);

  const addStep = () => {
    setSteps([
      ...steps,
      { id: Date.now().toString(), action: '', expected: '' },
    ]);
  };

  const removeStep = (id: string) => {
    if (steps.length > 1) {
      setSteps(steps.filter((step) => step.id !== id));
    }
  };

  const updateStep = (id: string, field: 'action' | 'expected', value: string) => {
    setSteps(
      steps.map((step) =>
        step.id === id ? { ...step, [field]: value } : step
      )
    );
  };

  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    if (!name || !url) return;

    setIsSaving(true);
    try {
      const testSpec = {
        name,
        url,
        steps: steps.map((s) => ({ action: s.action, expected: s.expected })),
      };

      const response = await fetch('/api/tests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testSpec),
      });

      if (response.ok) {
        success('Test spec saved');
        router.push('/dashboard/tests');
      } else {
        showError('Failed to save test spec');
      }
    } catch {
      showError('Failed to save test spec');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <div className="mx-auto max-w-4xl space-y-6 p-6 lg:p-8">
        {/* Back button and title */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/dashboard/tests">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold">Create Test Spec</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Define test steps using natural language
              </p>
            </div>
          </div>
          <Button onClick={handleSave} disabled={isSaving || !name || !url}>
            {isSaving ? (
              <div className="h-4 w-4 mr-2 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {isSaving ? 'Saving...' : 'Save Test'}
          </Button>
        </div>

        {/* Basic Info */}
        <Card className="border-border/80 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Basic Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="name" className="text-sm font-medium">
                Test Name
              </label>
              <Input
                id="name"
                placeholder="e.g., Add to Cart Flow"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="url" className="text-sm font-medium">
                Starting URL
              </label>
              <Input
                id="url"
                placeholder="e.g., http://localhost:3000"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
          </CardContent>
        </Card>

        {/* Test Steps */}
        <Card className="border-border/80 shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Test Steps</CardTitle>
            <CardDescription>
              Write steps in natural language. Stagehand will interpret and execute them.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {steps.map((step, index) => (
              <div
                key={step.id}
                className={cn(
                  'p-4 rounded-lg border border-border/50 bg-secondary/20',
                  'hover:border-border transition-colors'
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="flex items-center gap-2 pt-2">
                    <GripVertical className="h-4 w-4 text-muted-foreground cursor-grab" />
                    <span className="text-sm font-medium text-muted-foreground w-6">
                      {index + 1}.
                    </span>
                  </div>
                  <div className="flex-1 space-y-3">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Action</label>
                      <Textarea
                        placeholder='e.g., Click the "Add to Cart" button for the first product'
                        value={step.action}
                        onChange={(e) => updateStep(step.id, 'action', e.target.value)}
                        className="min-h-[60px]"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        Expected Result (optional)
                      </label>
                      <Textarea
                        placeholder='e.g., A success message appears saying "Added to cart"'
                        value={step.expected}
                        onChange={(e) => updateStep(step.id, 'expected', e.target.value)}
                        className="min-h-[60px]"
                      />
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => removeStep(step.id)}
                    disabled={steps.length === 1}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}

            <Button variant="outline" onClick={addStep} className="w-full">
              <Plus className="mr-2 h-4 w-4" />
              Add Step
            </Button>
          </CardContent>
        </Card>

        {/* Tips */}
        <Card className="border-primary/20 bg-primary/5 shadow-sm">
          <CardContent className="pt-6">
            <h4 className="font-medium mb-2">Tips for writing test steps</h4>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>• Be specific about which element to interact with</li>
              <li>• Use quotes for exact text content to match</li>
              <li>• Include expected outcomes to verify test success</li>
              <li>• Keep steps atomic and focused on one action</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
