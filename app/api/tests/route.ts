import { NextRequest, NextResponse } from 'next/server';
import type { TestSpec } from '@/lib/types';
import { getAllTestSpecs, addTestSpec } from '@/lib/dashboard/test-store';

export const dynamic = 'force-dynamic';

// GET /api/tests - List all test specs
export async function GET() {
  const specs = await getAllTestSpecs();
  return NextResponse.json({ testSpecs: specs });
}

// POST /api/tests - Create a new test spec
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, url, steps, timeout } = body;

    if (!name || !url || !steps || !Array.isArray(steps)) {
      return NextResponse.json(
        { error: 'Name, URL, and steps are required' },
        { status: 400 }
      );
    }

    const spec: TestSpec = {
      id: `test-${Date.now()}`,
      name,
      url,
      steps: steps.map((s: { action: string; expected?: string }) => ({
        action: s.action,
        expected: s.expected,
      })),
      timeout,
    };

    await addTestSpec(spec);

    return NextResponse.json({ testSpec: spec }, { status: 201 });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Error creating test spec:', error);
    return NextResponse.json(
      { error: 'Failed to create test spec' },
      { status: 500 }
    );
  }
}
