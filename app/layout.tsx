import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import { ToastProvider } from '@/components/ui/toaster';
import { ThemeProvider } from '@/lib/providers/theme-provider';
import { CommandPalette } from '@/components/ui/command-palette';

const DEFAULT_DEV_APP_ORIGIN = 'http://localhost:3000';
const CANONICAL_DEV_APP_ORIGIN = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_APP_URL?.trim() || DEFAULT_DEV_APP_ORIGIN).origin;
  } catch {
    return DEFAULT_DEV_APP_ORIGIN;
  }
})();

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://qagent.dev'),
  title: {
    default: 'QAgent',
    template: '%s | QAgent',
  },
  description: 'Automated QA that tests your web app, fixes bugs, and verifies patches — end to end.',
  applicationName: 'QAgent',
  keywords: ['QAgent', 'QA automation', 'self-healing', 'browser testing', 'GitHub PRs', 'automated testing'],
  creator: 'QAgent',
  publisher: 'QAgent',
  icons: {
    icon: '/favicon.svg',
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    title: 'QAgent — Self-Healing QA for Engineering Teams',
    description: 'Automated QA that tests your web app, fixes bugs, and verifies patches — end to end.',
    siteName: 'QAgent',
    type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'QAgent — Self-Healing QA' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'QAgent — Self-Healing QA for Engineering Teams',
    description: 'Automated QA that tests your web app, fixes bugs, and verifies patches — end to end.',
    images: ['/og.png'],
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
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body className={`${GeistSans.className} app-shell font-sans antialiased`}>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var canonicalOrigin=${JSON.stringify(CANONICAL_DEV_APP_ORIGIN)};var url=new URL(window.location.href);var isLoopbackAlias=url.hostname==='127.0.0.1'||url.hostname==='::1'||url.hostname==='[::1]';if(isLoopbackAlias&&canonicalOrigin&&url.origin!==canonicalOrigin){var target=new URL(canonicalOrigin);target.pathname=url.pathname;target.search=url.search;target.hash=url.hash;window.location.replace(target.toString());return;}}catch(e){}})();`,
          }}
        />
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
