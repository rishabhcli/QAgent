import '@fontsource-variable/fraunces';
import '@fontsource-variable/source-sans-3';
import './styles.css';
import type { Metadata } from 'next';
import Link from 'next/link';
import { GitFork, SquareTerminal } from 'lucide-react';

export const metadata: Metadata = {
  title: { default: 'QAgent', template: '%s | QAgent' },
  description:
    'Local-first autonomous QA for developers, available as a desktop app, CLI, and MCP server.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <header className="topbar">
          <Link className="wordmark" href="/" aria-label="QAgent documentation home">
            <span className="wordmark-mark">Q</span>
            <span>QAgent</span>
            <span className="beta">v0.2 beta</span>
          </Link>
          <nav className="top-actions" aria-label="External links">
            <a href="https://github.com/rishabhcli/QAgent" aria-label="QAgent on GitHub">
              <GitFork size={18} aria-hidden="true" />
              <span>GitHub</span>
            </a>
            <Link href="/quickstart/" aria-label="Five-minute quickstart">
              <SquareTerminal size={18} aria-hidden="true" />
              <span>Quickstart</span>
            </Link>
          </nav>
        </header>
        {children}
        <footer>
          <span>QAgent is licensed under AGPL-3.0.</span>
          <span>Local by default. Provenance on every result.</span>
        </footer>
      </body>
    </html>
  );
}
