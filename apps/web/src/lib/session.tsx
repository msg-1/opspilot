'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo } from 'react';
import { api, useApi } from './api';

export interface Session {
  user: { id: string; email: string; name: string; title: string | null };
  organization: { id: string; name: string; slug: string };
  role: 'OWNER' | 'ADMIN' | 'ENGINEER' | 'VIEWER';
  permissions: string[];
  organizations: { id: string; name: string; slug: string; role: string }[];
}

interface SessionContext extends Session {
  can: (permission: string) => boolean;
  signOut: () => Promise<void>;
  switchOrganization: (id: string) => Promise<void>;
}

const Ctx = createContext<SessionContext | null>(null);

export function useSessionQuery() {
  return useApi<Session>('/auth/me', { retry: false, staleTime: 60_000 });
}

export function SessionProvider({ session, children }: { session: Session; children: React.ReactNode }) {
  const client = useQueryClient();
  const signOut = useCallback(async () => {
    await api.post('/auth/logout').catch(() => undefined);
    client.clear();
    window.location.assign('/login');
  }, [client]);
  const switchOrganization = useCallback(
    async (organizationId: string) => {
      await api.post('/auth/switch-organization', { organizationId });
      client.clear();
      window.location.assign('/');
    },
    [client],
  );
  const value = useMemo<SessionContext>(
    () => ({ ...session, can: (p) => session.permissions.includes(p), signOut, switchOrganization }),
    [session, signOut, switchOrganization],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession must be used inside the signed-in application shell');
  return ctx;
}
