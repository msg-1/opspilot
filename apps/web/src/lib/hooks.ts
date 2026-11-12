'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

/**
 * Runs a mutation with busy/error state and then refreshes every cached API query, so lists,
 * counters and detail views all reflect the change without each page wiring its own invalidation.
 */
export function useAction() {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, key = 'default'): Promise<T | undefined> => {
      setBusy(key);
      setError(null);
      try {
        const result = await fn();
        await client.invalidateQueries({ queryKey: ['api'] });
        return result;
      } catch (err) {
        setError(err);
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [client],
  );
  return { run, busy, error, clearError: () => setError(null) };
}

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
