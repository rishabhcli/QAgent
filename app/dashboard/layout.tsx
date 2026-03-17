'use client';

import { Sidebar } from '@/components/dashboard/sidebar';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Sidebar />
      <main
        className="pt-16 transition-[padding] duration-200 md:pt-0"
        style={{ paddingLeft: 'var(--dashboard-sidebar-width, 0px)' }}
      >
        {children}
      </main>
      <OnboardingWizard />
    </div>
  );
}
