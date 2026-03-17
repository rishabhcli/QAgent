import { NextRequest, NextResponse } from 'next/server';
import { deleteTestSpec, getTestSpec, updateTestSpec } from '@/lib/dashboard/test-store';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ testId: string }> }
) {
  const { testId } = await params;
  const testSpec = await getTestSpec(testId);

  if (!testSpec) {
    return NextResponse.json({ error: 'Test spec not found' }, { status: 404 });
  }

  return NextResponse.json({ testSpec });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ testId: string }> }
) {
  const { testId } = await params;
  const updates = await request.json();
  const updated = await updateTestSpec(testId, updates);

  if (!updated) {
    return NextResponse.json({ error: 'Test spec not found' }, { status: 404 });
  }

  const testSpec = await getTestSpec(testId);
  return NextResponse.json({ testSpec });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ testId: string }> }
) {
  const { testId } = await params;
  const deleted = await deleteTestSpec(testId);

  if (!deleted) {
    return NextResponse.json({ error: 'Test spec not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
