'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Cpu, Zap } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils/cn';
import type { LLMCallDetails } from '@/lib/types';

interface LLMCallViewerProps {
  llmCall: LLMCallDetails;
  className?: string;
}

export function LLMCallViewer({ llmCall, className }: LLMCallViewerProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className={cn('rounded-lg border bg-card/50', className)}>
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors rounded-lg"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <Cpu className="h-4 w-4 text-primary" />
          </div>
          <div className="text-left">
            <p className="text-sm font-medium">LLM Call</p>
            <p className="text-xs text-muted-foreground">{llmCall.model}</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Zap className="h-3 w-3" />
            <span>{llmCall.tokens.toLocaleString()} tokens</span>
          </div>
          {llmCall.duration && (
            <span className="text-xs text-muted-foreground">
              {(llmCall.duration / 1000).toFixed(1)}s
            </span>
          )}
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 space-y-3">
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Prompt</p>
                <pre className="text-xs bg-muted/50 p-3 rounded-lg overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap font-mono">
                  {llmCall.prompt}
                </pre>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1">Response</p>
                <pre className="text-xs bg-muted/50 p-3 rounded-lg overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap font-mono">
                  {llmCall.response}
                </pre>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
