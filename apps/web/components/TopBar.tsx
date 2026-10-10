'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, ChevronDown, ChevronRight, CircleDot, CircleX, KeyRound, LayoutGrid, LogOut, Plus, Settings2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { AppView } from '@/lib/types';
import { useBuilder } from '@/lib/useBuilder';

export function Mark({ size = 32 }: { size?: number }) {
  // The favicon's ring: six stages, the last one shipped.
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <rect width="32" height="32" rx="8" fill="var(--color-brand)" />
      <g fill="none" strokeWidth="3.2" strokeLinecap="round">
        <path d="M16 6.5a9.5 9.5 0 0 1 8.2 4.75" stroke="#10B981" />
        <path d="M25.3 13.6a9.5 9.5 0 0 1-1.1 7.15" stroke="#10B981" />
        <path d="M22.7 22.9a9.5 9.5 0 0 1-6.7 2.6" stroke="#10B981" />
        <path d="M13.6 25.2a9.5 9.5 0 0 1-6.3-4.45" stroke="#AECCFF" />
        <path d="M6.6 18.4a9.5 9.5 0 0 1 1.2-7.2" stroke="#AECCFF" />
        <path d="M9.3 9.1a9.5 9.5 0 0 1 4.3-2.3" stroke="#F66600" />
      </g>
    </svg>
  );
}

const NAV = [
  { href: '/', label: 'Apps', icon: LayoutGrid },
  { href: '/keys', label: 'Git keys', icon: KeyRound },
  { href: '/setup', label: 'Setup', icon: Settings2 },
];

/** The app you are in, and every other app one press away. */
function AppSwitcher({ app }: { app: { id: string; name: string } }) {
  const [apps, setApps] = useState<AppView[] | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  function place() {
    const b = button.current?.getBoundingClientRect();
    const m = menu.current;
    if (!b || !m) return;
    m.style.top = `${b.bottom + 8}px`;
    m.style.left = `${Math.max(8, Math.min(b.left, window.innerWidth - 328))}px`;
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        popoverTarget="app-switcher"
        onClick={() => {
          place();
          if (!apps) void api<AppView[]>('/apps').then(setApps, () => setApps([]));
        }}
        className="flex h-10 min-w-0 items-center gap-1.5 rounded-[var(--radius-control)] px-2 text-[15px] font-bold text-ink transition-colors hover:bg-line-soft"
        aria-label={`${app.name}: switch app`}
      >
        <span className="truncate">{app.name}</span>
        <ChevronDown size={16} aria-hidden className="shrink-0 text-muted" />
      </button>
      <div
        ref={menu}
        id="app-switcher"
        popover="auto"
        className="m-0 w-80 rounded-[var(--radius-card)] border border-line bg-card p-1.5 shadow-overlay"
        style={{ position: 'fixed', inset: 'auto' }}
      >
        <p className="px-2.5 pb-1 pt-1.5 text-[12px] font-medium text-muted">Apps</p>
        <ul>
          {(apps ?? []).map((a) => (
            <li key={a.id}>
              <Link
                href={`/apps/${a.id}`}
                onClick={() => menu.current?.hidePopover()}
                className="flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] px-2.5 py-1.5 hover:bg-line-soft"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{a.name}</span>
                  <span className="block truncate font-mono text-[12px] text-muted">{a.packageName}</span>
                </span>
                {a.id === app.id && <Check size={16} aria-label="current" className="shrink-0 text-brand" />}
              </Link>
            </li>
          ))}
          {!apps && <li className="px-2.5 py-2 text-[13px] text-muted">Loading…</li>}
        </ul>
        <div className="mt-1 border-t border-line pt-1">
          <Link href="/apps/new" onClick={() => menu.current?.hidePopover()} className="flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] px-2.5 text-[14px] font-medium text-brand hover:bg-brand-wash">
            <Plus size={16} aria-hidden />
            Add an app
          </Link>
        </div>
      </div>
    </>
  );
}

/** One builder serves every app: what it is doing now, and the way to that run. */
function BuilderChip() {
  const status = useBuilder();
  if (!status) return null;
  if (!status.ok) {
    return (
      <Link href="/setup" className="flex h-9 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium text-fail-ink hover:bg-fail-wash">
        <CircleX size={15} strokeWidth={2.2} aria-hidden color="var(--color-fail)" />
        <span className="hidden md:inline">Builder not answering</span>
      </Link>
    );
  }
  const c = status.current;
  if (status.busy && c) {
    return (
      <Link
        href={c.appId ? `/apps/${c.appId}?run=${c.id}` : '/'}
        className="flex h-9 min-w-0 items-center gap-1.5 rounded-full border border-line bg-card px-2.5 text-[13px] text-run-ink transition-colors hover:border-brand/30 hover:bg-brand-wash"
        title={`Building ${c.appName ?? ''} #${c.number}${c.job ? ` · ${c.job}` : ''}${status.queued ? ` · ${status.queued} queued` : ''}`}
      >
        <CircleDot size={15} strokeWidth={2.2} aria-hidden color="var(--color-run)" />
        <span className="hidden truncate font-medium md:inline">
          Building {c.appName} #{c.number}
        </span>
        {c.job && <span className="hidden text-muted xl:inline">· {c.job}</span>}
        {status.queued > 0 && <span className="text-muted">+{status.queued}</span>}
      </Link>
    );
  }
  return <span className="hidden text-[13px] text-muted lg:inline">Builder idle</span>;
}

export function TopBar({ app }: { app?: { id: string; name: string } | null }) {
  const path = usePathname();

  async function signOut() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign('/login');
  }

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 border-b border-line bg-card/95 px-4 backdrop-blur md:gap-4 md:px-6">
      <div className="flex min-w-0 items-center gap-2.5">
        <Link href="/" className="shrink-0 rounded-lg" aria-label="Release Console: all apps">
          <Mark />
        </Link>
        <Link href="/" className={clsx('truncate text-[15px] font-bold text-ink', app ? 'hidden lg:block' : 'block')}>
          Release Console
        </Link>
        {app && (
          <>
            <ChevronRight size={16} aria-hidden className="hidden shrink-0 text-faint lg:block" />
            <AppSwitcher app={app} />
          </>
        )}
      </div>

      <div className="ms-auto flex items-center gap-1 md:gap-2">
        <BuilderChip />
        <nav aria-label="Console" className="flex items-center gap-0.5 md:gap-1">
          {NAV.map((item) => {
            const active = item.href === '/' ? path === '/' || path.startsWith('/apps') : path.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                aria-label={item.label}
                className={clsx(
                  'flex h-10 min-w-10 items-center justify-center gap-2 rounded-lg px-2.5 font-medium transition-colors md:px-3',
                  active ? 'bg-line-soft text-ink' : 'text-muted hover:bg-line-soft hover:text-ink',
                )}
              >
                <Icon size={17} aria-hidden className="md:hidden" />
                <span className="hidden md:inline">{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <button type="button" className="btn btn-quiet h-10 w-10 p-0" onClick={signOut} aria-label="Sign out" title="Sign out">
          <LogOut size={17} aria-hidden />
        </button>
      </div>
    </header>
  );
}
