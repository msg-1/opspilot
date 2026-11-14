'use client';

import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Activity, BarChart3, Bell, BookOpen, Boxes, ChevronsUpDown, GitBranch, LayoutDashboard, LogOut, Menu, PlugZap, Rocket, ScrollText, Settings, ShieldCheck, Siren, Sparkles, Users, X } from 'lucide-react';
import { BRAND } from '@/lib/brand';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, useApi } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Avatar } from './ui';

const NAV = [
  {
    label: 'Respond',
    items: [
      { href: '/', label: 'Overview', icon: LayoutDashboard },
      { href: '/incidents', label: 'Incidents', icon: Siren },
      { href: '/investigations', label: 'Investigations', icon: Sparkles },
      { href: '/remediation', label: 'Approvals', icon: ShieldCheck },
    ],
  },
  {
    label: 'Observe',
    items: [
      { href: '/services', label: 'Services', icon: Boxes },
      { href: '/monitoring', label: 'Monitoring', icon: Activity },
      { href: '/logs', label: 'Logs', icon: ScrollText },
      { href: '/deployments', label: 'Deployments', icon: Rocket },
      { href: '/changes', label: 'Code changes', icon: GitBranch },
    ],
  },
  {
    label: 'Learn',
    items: [
      { href: '/knowledge', label: 'Knowledge base', icon: BookOpen },
      { href: '/analytics', label: 'Analytics', icon: BarChart3 },
    ],
  },
  {
    label: 'Organisation',
    items: [
      { href: '/integrations', label: 'Integrations', icon: PlugZap },
      { href: '/team', label: 'Team', icon: Users },
      { href: '/settings', label: 'Settings', icon: Settings },
    ],
  },
];

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

interface NotificationItem {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const client = useQueryClient();
  const { data } = useApi<{ data: NotificationItem[]; unread: number }>('/notifications', { refetchInterval: 30_000 });
  const markRead = async () => {
    if (!data?.unread) return;
    await api.post('/notifications/read');
    await client.invalidateQueries({ queryKey: ['api', '/notifications'] });
  };
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={data?.unread ? `Notifications, ${data.unread} unread` : 'Notifications'}
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) void markRead();
        }}
        className="relative rounded-md p-2 text-ink-2 hover:bg-sunken hover:text-ink"
      >
        <Bell className="size-[18px]" aria-hidden />
        {!!data?.unread && <span className="tabular absolute top-0.5 right-0.5 min-w-4 rounded-full bg-critical px-1 text-center text-[10px] leading-4 font-semibold text-white">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
          <div className="border-b border-line px-4 py-2.5 text-sm font-semibold">Notifications</div>
          <ul className="max-h-96 overflow-y-auto">
            {!data?.data.length && <li className="px-4 py-8 text-center text-[13px] text-ink-2">Nothing yet. Assignments, mentions and approval requests appear here.</li>}
            {data?.data.map((n) => (
              <li key={n.id} className="border-b border-line last:border-0">
                <Link href={n.link ?? '#'} onClick={() => setOpen(false)} className="block px-4 py-2.5 hover:bg-sunken">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink">{n.title}</span>
                    <span className="shrink-0 text-[11px] text-ink-3">{timeAgo(n.createdAt)}</span>
                  </div>
                  {n.body && <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-2">{n.body}</p>}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function AccountMenu() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-rail-2">
        <Avatar name={session.user.name} size={28} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-white">{session.user.name}</span>
          <span className="block truncate text-[11px] text-rail-ink">{session.organization.name}</span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-rail-ink" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full left-0 z-30 mb-1 w-64 overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-pop">
          <div className="border-b border-line px-3 py-2.5">
            <div className="truncate text-[13px] font-medium">{session.user.email}</div>
            <div className="text-[12px] text-ink-2">{session.role.charAt(0) + session.role.slice(1).toLowerCase()} in {session.organization.name}</div>
          </div>
          {session.organizations.length > 1 && (
            <div className="border-b border-line py-1">
              <div className="px-3 py-1 text-[11px] font-medium text-ink-3 uppercase">Switch organisation</div>
              {session.organizations
                .filter((o) => o.id !== session.organization.id)
                .map((o) => (
                  <button key={o.id} role="menuitem" type="button" onClick={() => void session.switchOrganization(o.id)} className="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-sunken">
                    {o.name}
                  </button>
                ))}
            </div>
          )}
          <button role="menuitem" type="button" onClick={() => void session.signOut()} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-sunken">
            <LogOut className="size-3.5" aria-hidden />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { data } = useApi<{ counts: { activeIncidents: number; pendingApprovals: number } }>('/dashboard', { refetchInterval: 30_000 });
  const counts: Record<string, number | undefined> = { '/incidents': data?.counts.activeIncidents, '/remediation': data?.counts.pendingApprovals };
  return (
    <div className="flex h-full flex-col bg-rail text-rail-ink">
      <Link href="/" onClick={onNavigate} className="flex items-center gap-2.5 px-5 pt-5 pb-4">
        <span aria-hidden className="flex size-7 items-center justify-center rounded-lg bg-white text-rail">
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 13h4l2.5-7 4 13 2.5-6H21" />
          </svg>
        </span>
        <span className="text-[15px] font-semibold tracking-[0.08em] text-white" title={`${BRAND.name} · ${BRAND.category}`}>{BRAND.name}</span>
      </Link>
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pb-4">
        {NAV.map((group) => (
          <div key={group.label} className="mt-4 first:mt-1">
            <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-rail-ink/60 uppercase">{group.label}</div>
            {group.items.map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname === item.href || pathname.startsWith(`${item.href}/`);
              const count = counts[item.href];
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={clsx('flex items-center gap-2.5 rounded-lg px-2 py-[7px] text-[13.5px] font-medium transition-colors', active ? 'bg-rail-2 text-white' : 'hover:bg-rail-2/60 hover:text-white')}
                >
                  <item.icon className="size-4 shrink-0" aria-hidden />
                  <span className="flex-1">{item.label}</span>
                  {!!count && <span className={clsx('tabular rounded-full px-1.5 text-[11px] leading-[18px] font-semibold', item.href === '/incidents' ? 'bg-critical text-white' : 'bg-warn text-ink')}>{count}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="border-t border-white/10 p-2">
        <AccountMenu />
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const pathname = usePathname();
  useEffect(() => setDrawer(false), [pathname]);
  return (
    <div className="min-h-dvh lg:pl-60">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-ink focus:px-3 focus:py-2 focus:text-white">
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 lg:block">
        <Sidebar />
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label="Close navigation" className="absolute inset-0 bg-ink/50" onClick={() => setDrawer(false)} />
          <aside className="relative h-full w-64 shadow-pop">
            <Sidebar onNavigate={() => setDrawer(false)} />
            <button type="button" aria-label="Close navigation" onClick={() => setDrawer(false)} className="absolute top-4 right-3 rounded p-1 text-rail-ink hover:bg-rail-2">
              <X className="size-4" aria-hidden />
            </button>
          </aside>
        </div>
      )}
      <div className="sticky top-0 z-10 flex h-12 items-center justify-between border-b border-line bg-page/90 px-4 backdrop-blur lg:px-8">
        <button type="button" aria-label="Open navigation" onClick={() => setDrawer(true)} className="rounded-md p-2 text-ink-2 hover:bg-sunken lg:hidden">
          <Menu className="size-[18px]" aria-hidden />
        </button>
        <div className="hidden lg:block" />
        <Notifications />
      </div>
      <main id="main" className="mx-auto max-w-[1280px] px-4 py-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
