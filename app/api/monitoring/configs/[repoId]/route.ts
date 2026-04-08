/**
 * Single Monitoring Config API
 *
 * Get, update, and delete a monitoring configuration.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isRepoAllowed } from '@/lib/auth/repo-access';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
import {
  getMonitoringConfig,
  updateMonitoringConfig,
  deleteMonitoringConfig,
} from '@/lib/redis/monitoring-config';

interface RouteParams {
  params: Promise<{ repoId: string }>;
}

/**
 * GET /api/monitoring/configs/[repoId]
 * Get a specific monitoring configuration
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userId = session.user.id;

    const { repoId } = await params;
    const config = await getMonitoringConfig(repoId);

    if (!config || config.ownerId !== userId) {
      return NextResponse.json({ error: 'Config not found' }, { status: 404 });
    }

    const repoAllowed = await isRepoAllowed(session, {
      repoId,
      repoFullName: config.repoFullName,
    });

    if (!repoAllowed) {
      return NextResponse.json({ error: 'Repository access is not authorized' }, { status: 403 });
    }

    return NextResponse.json({ config });
  } catch (error) {
    console.error('Error fetching monitoring config:', error);
    return NextResponse.json({ error: 'Failed to fetch config' }, { status: 500 });
  }
}

/**
 * PATCH /api/monitoring/configs/[repoId]
 * Update a monitoring configuration
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userId = session.user.id;

    const { repoId } = await params;
    const body = await request.json();
    const existingConfig = await getMonitoringConfig(repoId);

    if (!existingConfig || existingConfig.ownerId !== userId) {
      return NextResponse.json({ error: 'Config not found' }, { status: 404 });
    }

    const repoAllowed = await isRepoAllowed(session, {
      repoId,
      repoFullName: existingConfig.repoFullName,
    });

    if (!repoAllowed) {
      return NextResponse.json({ error: 'Repository access is not authorized' }, { status: 403 });
    }

    const config = await updateMonitoringConfig(repoId, body);

    if (!config) {
      return NextResponse.json({ error: 'Config not found' }, { status: 404 });
    }

    return NextResponse.json({ config });
  } catch (error) {
    console.error('Error updating monitoring config:', error);
    return NextResponse.json({ error: 'Failed to update config' }, { status: 500 });
  }
}

/**
 * DELETE /api/monitoring/configs/[repoId]
 * Delete a monitoring configuration
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userId = session.user.id;

    const { repoId } = await params;
    const existingConfig = await getMonitoringConfig(repoId);

    if (!existingConfig || existingConfig.ownerId !== userId) {
      return NextResponse.json({ error: 'Config not found or already deleted' }, { status: 404 });
    }

    const repoAllowed = await isRepoAllowed(session, {
      repoId,
      repoFullName: existingConfig.repoFullName,
    });

    if (!repoAllowed) {
      return NextResponse.json({ error: 'Repository access is not authorized' }, { status: 403 });
    }

    const deleted = await deleteMonitoringConfig(repoId);

    if (!deleted) {
      return NextResponse.json({ error: 'Config not found or already deleted' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting monitoring config:', error);
    return NextResponse.json({ error: 'Failed to delete config' }, { status: 500 });
  }
}
