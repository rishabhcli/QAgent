import { NextRequest } from 'next/server';
import { getRunAsync } from '@/lib/dashboard/run-store';
import { sseEmitter } from '@/lib/dashboard/sse-emitter';
import type { RunEvent } from '@/lib/types';

// GET /api/runs/[runId]/stream - SSE endpoint for real-time updates
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const run = await getRunAsync(runId);

  if (!run) {
    return new Response('Run not found', { status: 404 });
  }

  // Create a readable stream for SSE
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      // Send initial state
      const initialEvent: RunEvent = {
        type: 'status',
        timestamp: new Date(),
        runId,
        data: {
          status: run.status,
          currentAgent: run.currentAgent,
          iteration: run.iteration,
        },
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialEvent)}\n\n`));

      for (const bufferedEvent of sseEmitter.getBufferedEvents(runId)) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(bufferedEvent)}\n\n`));
      }

      // Subscribe to updates
      const unsubscribe = sseEmitter.subscribe(runId, (event) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

          // Close stream if run is complete
          if (event.type === 'complete' || event.type === 'error') {
            setTimeout(() => {
              unsubscribe();
              controller.close();
            }, 1000);
          }
        } catch {
          // Client disconnected
          unsubscribe();
        }
      });

      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        unsubscribe();
        controller.close();
      });

      // Keep-alive ping every 30 seconds
      const pingInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          clearInterval(pingInterval);
          unsubscribe();
        }
      }, 30000);

      // Clean up interval when stream closes
      request.signal.addEventListener('abort', () => {
        clearInterval(pingInterval);
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
