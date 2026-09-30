'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

export interface Health {
  ok: boolean;
  githubConfigured: boolean;
  builderConfigured: boolean;
  repo: string;
}

let cached: Promise<Health | null> | null = null;

/** What this console is connected to (public, fetched once per page load). */
export function useHealth(): Health | null {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    cached ??= api<Health>('/health').catch(() => null);
    void cached.then(setHealth);
  }, []);
  return health;
}
