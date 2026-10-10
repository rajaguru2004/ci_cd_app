'use client';

import { useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import type { KeyRecord } from '@/lib/types';

const HOSTS = [
  { label: 'GitHub', where: 'Settings → SSH and GPG keys → New SSH key', url: 'https://github.com/settings/ssh/new' },
  { label: 'GitLab', where: 'Preferences → SSH Keys → Add new key', url: 'https://gitlab.com/-/user_settings/ssh_keys' },
  { label: 'Bitbucket', where: 'Personal settings → SSH keys → Add key', url: 'https://bitbucket.org/account/settings/ssh-keys/' },
];

export function CopyButton({ text, label, primary = false }: { text: string; label: string; primary?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={primary ? 'btn btn-primary' : 'btn btn-secondary'}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1600);
        });
      }}
    >
      {done ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
      <span aria-live="polite">{done ? 'Copied' : label}</span>
    </button>
  );
}

/**
 * A key's public line, ready to paste, and where each git host takes it. The private half
 * never leaves the console's vault; this is the only part anyone sees.
 */
export function KeyBlock({ sshKey, compact = false }: { sshKey: KeyRecord; compact?: boolean }) {
  return (
    <div className="space-y-4">
      <div>
        <p className="label">Public key for {sshKey.email}</p>
        <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded-[var(--radius-control)] border border-line bg-page px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink">
          {sshKey.publicKey}
        </pre>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <CopyButton text={sshKey.publicKey} label="Copy key" />
          <span className="font-mono text-[12px] text-muted">{sshKey.fingerprint}</span>
        </div>
      </div>
      {!compact && (
        <div>
          <p className="label">Add it to your git account</p>
          <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line">
            {HOSTS.map((h) => (
              <li key={h.label} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5 text-[13px]">
                <span>
                  <span className="font-semibold text-ink">{h.label}</span> <span className="text-body">{h.where}</span>
                </span>
                <a href={h.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-brand underline">
                  Open <ExternalLink size={12} aria-hidden />
                </a>
              </li>
            ))}
          </ul>
          <p className="hint max-w-[70ch]">
            On your account, the key reaches every repository you can open. To give it one repository only, add it there as a deploy key instead (repository →
            Settings → Deploy keys, read access).
          </p>
        </div>
      )}
    </div>
  );
}
