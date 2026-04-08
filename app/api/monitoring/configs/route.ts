/**
 * Monitoring Configs API
 *
 * List and create monitoring configurations.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isRepoAllowed } from '@/lib/auth/repo-access';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
import {
  getAllMonitoringConfigs,
  createMonitoringConfig,
  getMonitoringConfig,
} from '@/lib/redis/monitoring-config';
import { generateWebhookSecret } from '@/lib/github/webhook-validator';
import type { MonitoringSchedule } from '@/lib/types';

/**
 * GET /api/monitoring/configs
 * List all monitoring configurations
 */
export async function GET() {
  try {
    const session = await getSession();
    const userId = session?.user?.id;

    if (userId === undefined) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const configs = await getAllMonitoringConfigs();
    return NextResponse.json({
      configs: configs.filter((config) => config.ownerId === userId),
    });
  } catch (error) {
    console.error('Error fetching monitoring configs:', error);
    return NextResponse.json({ error: 'Failed to fetch configs' }, { status: 500 });
  }
}

/**
 * POST /api/monitoring/configs
 * Create a new monitoring configuration
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userId = session.user.id;

    const body = await request.json();
    const { repoId, repoFullName, schedule, testSpecs } = body;

    if (!repoId || !repoFullName) {
      return NextResponse.json({ error: 'repoId and repoFullName are required' }, { status: 400 });
    }

    const existingConfig = await getMonitoringConfig(repoId);
    if (existingConfig && existingConfig.ownerId !== userId) {
      return NextResponse.json(
        { error: 'Monitoring is already configured for this repository' },
        { status: 409 }
      );
    }

    const repoAllowed = await isRepoAllowed(session, {
      repoId,
      repoFullName,
    });

    if (!repoAllowed) {
      return NextResponse.json({ error: 'Repository access is not authorized' }, { status: 403 });
    }

    // Generate a webhook secret for this repo
    const webhookSecret = generateWebhookSecret();

    const config = await createMonitoringConfig({
      ownerId: userId,
      repoId,
      repoFullName,
      schedule: (schedule as MonitoringSchedule) || 'on_push',
      testSpecs: testSpecs || [],
      webhookSecret,
    });

    return NextResponse.json({ config }, { status: 201 });
  } catch (error) {
    console.error('Error creating monitoring config:', error);
    return NextResponse.json({ error: 'Failed to create config' }, { status: 500 });
  }
}
