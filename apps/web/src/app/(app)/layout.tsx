'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { AppShell } from '@/components/shell';
import { ErrorState, Spinner } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { SessionProvider, useSessionQuery } from '@/lib/session';

/** Everything under (app) requires a session. The API enforces access; this only routes the browser. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data, error, isLoading, refetch } = useSessionQuery();
  const unauthenticated = error instanceof ApiError && error.status === 401;
  useEffect(() => {
    if (unauthenticated) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [unauthenticated, router]);

  if (isLoading || unauthenticated) return <div className="flex min-h-dvh items-center justify-center"><Spinner label="Loading OpsPilot" /></div>;
  if (error || !data) return <div className="mx-auto max-w-md p-8"><ErrorState error={error} retry={() => void refetch()} /></div>;
  return (
    <SessionProvider session={data}>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
