/**
 * GitHub Webhook Handler
 *
 * Processes push and pull request events to trigger automated runs.
 */

import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
import {
  verifyWebhookSignature,
  getWebhookEventType,
  getWebhookDeliveryId,
  isTriggeringEvent,
  isTriggeringPRAction,
} from '@/lib/github/webhook-validator';
import { enqueueRun } from '@/lib/redis/queue';
import { getMonitoringConfig } from '@/lib/redis/monitoring-config';
import type { GitHubPushEvent, GitHubPullRequestEvent } from '@/lib/types';

function getRepoIdFromPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const repository = (payload as { repository?: { id?: unknown } }).repository;
  if (!repository?.id) {
    return null;
  }

  return repository.id.toString();
}

async function resolveWebhookSecret(repoId: string | null): Promise<string | null> {
  const legacySecret = process.env.GITHUB_WEBHOOK_SECRET || null;

  if (!repoId) {
    return legacySecret;
  }

  const config = await getMonitoringConfig(repoId);
  return config?.webhookSecret || legacySecret;
}

/**
 * POST /api/webhooks/github
 * Handle incoming GitHub webhooks
 */
export async function POST(request: NextRequest) {
  const deliveryId = getWebhookDeliveryId(request.headers);
  const eventType = getWebhookEventType(request.headers);

  // Get raw body for signature verification
  const rawBody = await request.text();

  // Parse the payload
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const repoId = getRepoIdFromPayload(payload);
  const webhookSecret = await resolveWebhookSecret(repoId);
  if (!webhookSecret) {
    console.error('[Webhook] No webhook secret configured for delivery', deliveryId);
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  // Verify signature
  const signature = request.headers.get('x-hub-signature-256');
  if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
    console.warn(`[Webhook] Invalid signature for delivery ${deliveryId}`);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Check if this event type triggers runs
  if (!isTriggeringEvent(eventType)) {
    return NextResponse.json({ message: 'Event ignored', eventType });
  }

  // Process the event
  try {
    let result: { queued: boolean; runId?: string; message: string };

    if (eventType === 'push') {
      result = await handlePushEvent(payload as GitHubPushEvent);
    } else if (eventType === 'pull_request') {
      result = await handlePullRequestEvent(payload as GitHubPullRequestEvent);
    } else {
      result = { queued: false, message: 'Unknown event type' };
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Webhook] Error processing event:', error);
    return NextResponse.json({ error: 'Failed to process webhook' }, { status: 500 });
  }
}

/**
 * Handle push events
 */
async function handlePushEvent(event: GitHubPushEvent): Promise<{
  queued: boolean;
  runId?: string;
  message: string;
}> {
  const repoId = event.repository.id.toString();
  const repoFullName = event.repository.full_name;
  const branch = event.ref.replace('refs/heads/', '');
  const defaultBranch = event.repository.default_branch;

  // Only trigger on pushes to the default branch
  if (branch !== defaultBranch) {
    return {
      queued: false,
      message: `Push to non-default branch (${branch}) ignored`,
    };
  }

  // Check if monitoring is enabled for this repo
  const config = await getMonitoringConfig(repoId);
  if (!config || !config.enabled) {
    return {
      queued: false,
      message: `Monitoring not enabled for ${repoFullName}`,
    };
  }

  // Check if configured for on_push triggers
  if (config.schedule !== 'on_push') {
    return {
      queued: false,
      message: `Repo not configured for push triggers (schedule: ${config.schedule})`,
    };
  }

  // Enqueue the run
  const queuedRun = await enqueueRun({
    repoId,
    repoFullName,
    trigger: 'webhook',
    metadata: {
      commitSha: event.after,
      branch,
      pusher: event.pusher.name,
    },
  });

  if (!queuedRun) {
    return {
      queued: false,
      message: `Run already queued for ${repoFullName}:${branch}`,
    };
  }

  return {
    queued: true,
    runId: queuedRun.id,
    message: `Enqueued run for push to ${repoFullName}:${branch}`,
  };
}

/**
 * Handle pull request events
 */
async function handlePullRequestEvent(event: GitHubPullRequestEvent): Promise<{
  queued: boolean;
  runId?: string;
  message: string;
}> {
  const { action, pull_request: pr, repository } = event;
  const repoId = repository.id.toString();
  const repoFullName = repository.full_name;

  // Only process certain PR actions
  if (!isTriggeringPRAction(action)) {
    return {
      queued: false,
      message: `PR action ${action} ignored`,
    };
  }

  // Check if monitoring is enabled for this repo
  const config = await getMonitoringConfig(repoId);
  if (!config || !config.enabled) {
    return {
      queued: false,
      message: `Monitoring not enabled for ${repoFullName}`,
    };
  }

  // Enqueue the run
  const queuedRun = await enqueueRun({
    repoId,
    repoFullName,
    trigger: 'webhook',
    metadata: {
      commitSha: pr.head.sha,
      branch: pr.head.ref,
      prNumber: pr.number,
    },
  });

  if (!queuedRun) {
    return {
      queued: false,
      message: `Run already queued for ${repoFullName} PR #${pr.number}`,
    };
  }

  return {
    queued: true,
    runId: queuedRun.id,
    message: `Enqueued run for PR #${pr.number} on ${repoFullName}`,
  };
}

/**
 * GET /api/webhooks/github
 * Health check endpoint
 */
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'GitHub webhook endpoint is ready',
    configured: !!process.env.GITHUB_WEBHOOK_SECRET,
  });
}
