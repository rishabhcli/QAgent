'use client';

import { useState, useEffect, useCallback } from 'react';
import type { RunEvent } from '@/lib/types';

interface UseRunStreamOptions {
  runId: string;
  enabled?: boolean;
  onEvent?: (event: RunEvent) => void;
  onComplete?: (success: boolean) => void;
  onError?: (error: string) => void;
}

interface RunStreamState {
  isConnected: boolean;
  events: RunEvent[];
  currentAgent: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error: string | null;
}

/**
 * React hook for subscribing to real-time run updates via SSE
 */
export function useRunStream({
  runId,
  enabled = true,
  onEvent,
  onComplete,
  onError,
}: UseRunStreamOptions) {
  const [state, setState] = useState<RunStreamState>({
    isConnected: false,
    events: [],
    currentAgent: null,
    status: 'pending',
    error: null,
  });

  useEffect(() => {
    if (!enabled || !runId) return;

    let eventSource: EventSource | null = null;

    const connect = () => {
      eventSource = new EventSource(`/api/runs/${runId}/stream`);

      eventSource.onopen = () => {
        setState((prev) => ({ ...prev, isConnected: true }));
      };

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as RunEvent;
          
          setState((prev) => {
            const newState = { ...prev, events: [...prev.events, data] };

            // Update state based on event type
            const eventData = data.data as Record<string, unknown>;
            switch (data.type) {
              case 'status':
                newState.status = eventData.status as RunStreamState['status'];
                break;
              case 'agent':
                if (eventData.status === 'started') {
                  newState.currentAgent = eventData.agent as string;
                }
                break;
              case 'complete':
                newState.status = eventData.success ? 'completed' : 'failed';
                newState.currentAgent = null;
                onComplete?.(eventData.success as boolean);
                break;
              case 'error':
                newState.error = eventData.error as string;
                newState.status = 'failed';
                onError?.(eventData.error as string);
                break;
            }

            return newState;
          });

          onEvent?.(data);
        } catch {
          // Ignore parse errors (like heartbeat messages)
        }
      };

      eventSource.onerror = () => {
        setState((prev) => ({ ...prev, isConnected: false }));
        eventSource?.close();
        
        // Reconnect after 3 seconds if not completed
        setTimeout(() => {
          if (state.status !== 'completed' && state.status !== 'failed') {
            connect();
          }
        }, 3000);
      };
    };

    connect();

    return () => {
      eventSource?.close();
    };
  }, [runId, enabled, onEvent, onComplete, onError, state.status]);

  const clearEvents = useCallback(() => {
    setState((prev) => ({ ...prev, events: [] }));
  }, []);

  return {
    ...state,
    clearEvents,
  };
}

export default useRunStream;
