/**
 * Test Specifications for QAgent
 *
 * Define your E2E test specs here.
 * Each spec represents a user flow to be tested by the Tester Agent.
 */

import type { TestSpec } from '@/lib/types';

const BASE_URL = process.env.TARGET_URL || 'http://localhost:3000';

export const landingSmokeSpec: TestSpec = {
  id: 'smoke-landing-001',
  name: 'Landing Page Smoke',
  url: `${BASE_URL}/`,
  steps: [
    {
      action: 'Verify the public landing page loads with the PatchPilot hero content',
      expected: 'PatchPilot',
    },
    {
      action: 'Verify the primary call to action is available',
      expected: 'Connect with GitHub',
    },
  ],
  timeout: 30000,
};

export const authenticatedShellSmokeSpec: TestSpec = {
  id: 'smoke-dashboard-001',
  name: 'Authenticated Shell Smoke',
  url: `${BASE_URL}/dashboard`,
  steps: [
    {
      action: 'Verify the authenticated dashboard shell loads',
      expected: 'Dashboard',
    },
    {
      action: 'Verify the primary navigation is available',
      expected: 'Runs',
    },
    {
      action: 'Verify the patches surface is reachable from the shell',
      expected: 'Patches',
    },
  ],
  timeout: 30000,
};

export const allTestSpecs: TestSpec[] = [
  landingSmokeSpec,
  authenticatedShellSmokeSpec,
];

export default allTestSpecs;
