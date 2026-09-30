'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { LogOut, Play } from 'lucide-react';
import { api } from '@/lib/api';
import { useHealth } from '@/lib/useHealth';

function Mark() {
  // The favicon's ring: six stages, the last one shipped.
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden className="shrink-0">
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


export function TopBar({ onStart, setupAttention }: { onStart?: () => void; setupAttention?: boolean }) {
  const path = usePathname();
  const repo = useHealth()?.repo ?? null;
  const nav = [
    { href: '/', label: 'Pipeline' },
    { href: '/setup', label: 'Setup' },
  ];

  async function signOut() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign('/login');
  }

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-line bg-card/95 px-4 backdrop-blur md:gap-6 md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <Link href="/" className="shrink-0 rounded-lg" aria-label="FusionHRM Android pipeline">
          <Mark />
        </Link>
        <div className="hidden min-w-0 leading-tight sm:block">
          <Link href="/" className="block truncate text-[15px] font-bold text-ink">
            FusionHRM Android
          </Link>
          <p className="flex min-w-0 items-center gap-1.5 font-mono text-[12px] text-muted">
            <span className="truncate">com.fusionapps.fusionhrm</span>
            {repo && (
              <>
                <span aria-hidden>·</span>
                <a
                  href={`https://github.com/${repo}`}
                  target="_blank"
                  rel="noreferrer"
                  className="hidden truncate underline-offset-2 hover:text-brand hover:underline lg:inline"
                  title={repo}
                >
                  {repo.split('/')[1]}
                </a>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="ms-auto flex items-center gap-1 md:gap-2">
        <nav aria-label="Console" className="flex items-center gap-1">
          {nav.map((item) => {
            const active = item.href === '/' ? path === '/' : path.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'relative flex h-10 items-center rounded-lg px-3 font-medium transition-colors duration-200',
                  active ? 'bg-line-soft text-ink' : 'text-muted hover:bg-line-soft hover:text-ink',
                )}
              >
                {item.label}
                {item.href === '/setup' && setupAttention && (
                  <span className="ms-2 h-2 w-2 rounded-full bg-warn" role="img" aria-label="needs attention" />
                )}
              </Link>
            );
          })}
        </nav>
        {onStart && (
          <button type="button" className="btn btn-primary ms-1 md:ms-2" onClick={onStart}>
            <Play size={15} aria-hidden fill="currentColor" />
            <span className="hidden sm:inline">Start build</span>
            <span className="sm:hidden">Start</span>
          </button>
        )}
        <button type="button" className="btn btn-quiet h-10 w-10 p-0" onClick={signOut} aria-label="Sign out" title="Sign out">
          <LogOut size={17} aria-hidden />
        </button>
      </div>
    </header>
  );
}
