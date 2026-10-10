'use client';

import { api } from './api';
import type { BuilderStatus } from './types';
import { usePoll } from './usePoll';

/** What the one builder is doing for all apps: polled faster while it builds. */
export function useBuilder(): BuilderStatus | null {
  const status = usePoll<BuilderStatus>(() => api<BuilderStatus>('/builder'), 8000, []);
  return status.data;
}
