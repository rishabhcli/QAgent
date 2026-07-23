import type { Metadata } from 'next';
import { LandingExperience } from './landing-experience';

export const metadata: Metadata = {
  title: 'QAgent | Local-first autonomous QA',
  description:
    'Try the QAgent repair loop, inspect real evidence, and run the same local-first engine from desktop, CLI, or MCP.',
};

export default function HomePage() {
  return <LandingExperience />;
}
