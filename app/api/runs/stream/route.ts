import { NextRequest } from 'next/server';
import { sseEmitter } from '@/lib/dashboard/sse-emitter';
import type { RunEvent } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * SSE endpoint for real-time run updates
 * Clients can subscribe to updates for a specific run
 */
export async function GET(request: NextRequest) {
  const runId = request.nextUrl.searchParams.get('runId');
  
  if (!runId) {
    return new Response('runId parameter is required', { status: 400 });
  }

  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection message
      const connectMessage = `data: ${JSON.stringify({ type: 'connected', runId })}\n\n`;
      controller.enqueue(encoder.encode(connectMessage));

      // Replay buffered events for late joiners
      const buffered = sseEmitter.getBufferedEvents(runId);
      for (const event of buffered) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          break;
        }
      }

      // Subscribe to run events
      const unsubscribe = sseEmitter.subscribe(runId, (event: RunEvent) => {
        try {
          const message = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(message));
          
          // Close stream when run completes
          if (event.type === 'complete' || event.type === 'error') {
            setTimeout(() => {
              unsubscribe();
              controller.close();
            }, 1000); // Give client time to receive final message
          }
        } catch {
          // Stream may have been closed
          unsubscribe();
        }
      });

      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        unsubscribe();
        controller.close();
      });

      // Keep connection alive with periodic heartbeat
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          clearInterval(heartbeat);
          unsubscribe();
        }
      }, 30000); // Every 30 seconds

      // Cleanup on close
      request.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    },
  });
}
