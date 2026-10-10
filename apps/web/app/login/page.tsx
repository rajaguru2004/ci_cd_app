'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="h-svh bg-page" />}>
      <Login />
    </Suspense>
  );
}

function Login() {
  const params = useSearchParams();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login', { method: 'POST', json: { password } });
      const next = params.get('next');
      window.location.assign(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center gap-3">
          <svg width="40" height="40" viewBox="0 0 32 32" aria-hidden>
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
          <div>
            <h1 className="text-[20px] font-bold text-ink">Release Console</h1>
            <p className="text-[13px] text-muted">Build, test and release your apps to Google Play</p>
          </div>
        </div>
        <form onSubmit={submit} className="panel space-y-5 px-6 py-6">
          <div>
            <label className="label" htmlFor="password">
              Console password
            </label>
            <input
              id="password"
              type="password"
              className="field"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'login-error' : undefined}
              required
            />
          </div>
          {error && (
            <p id="login-error" role="alert" className="text-[13px] text-fail-ink">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-primary h-12 w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="mt-4 text-center text-[12px] text-muted">The password is CONSOLE_PASSWORD in the console&apos;s .env.</p>
      </div>
    </main>
  );
}
