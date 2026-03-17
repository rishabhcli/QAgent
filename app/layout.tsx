import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ToastProvider } from '@/components/ui/toaster';
import { ThemeProvider } from '@/lib/providers/theme-provider';
import { CommandPalette } from '@/components/ui/command-palette';

export const metadata: Metadata = {
  title: {
    default: 'PatchPilot',
    template: '%s | PatchPilot',
  },
  description: 'Self-healing QA agent for testing, patching, and verifying web apps.',
  applicationName: 'PatchPilot',
  keywords: ['PatchPilot', 'QA automation', 'bug fixing', 'browser testing', 'GitHub PRs'],
  creator: 'PatchPilot',
  publisher: 'PatchPilot',
  openGraph: {
    title: 'PatchPilot',
    description: 'Self-healing QA agent for testing, patching, and verifying web apps.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PatchPilot',
    description: 'Self-healing QA agent for testing, patching, and verifying web apps.',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
    { media: '(prefers-color-scheme: dark)', color: '#020617' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="app-shell font-sans antialiased">
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var theme=localStorage.getItem('theme')||'system';var system=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';var resolved=theme==='system'?system:theme;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);root.style.colorScheme=resolved;}catch(e){}})();`,
          }}
        />
        <ThemeProvider>
          <ToastProvider>
            {children}
            <CommandPalette />
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
