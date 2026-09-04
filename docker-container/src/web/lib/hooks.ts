/**
 * Data-fetching hooks for the admin GUI.
 *
 * Deliberately small: no query library, because the whole GUI is a handful of screens polling a
 * local server. What it does provide is the thing a hand-rolled `useEffect` usually gets wrong —
 * cancelling in-flight requests, not setting state after unmount, and keeping the previous value
 * visible while a refresh is in flight so panels do not flash empty every few seconds.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RouteName, Routes } from '@now-playing/contracts';
import { api, ApiError, type RequestOptions } from './api.js';

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** True only for the first load; a background refresh keeps the previous data on screen. */
  initial: boolean;
  reload: () => void;
}

export function useResource<N extends RouteName>(name: N, options: RequestOptions = {}, config: { pollMs?: number; enabled?: boolean } = {}): Resource<ReturnType<Routes[N]['response']['parse']>> {
  type T = ReturnType<Routes[N]['response']['parse']>;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(config.enabled !== false);
  const [initial, setInitial] = useState(true);
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify({ params: options.params, query: options.query, body: options.body });
  const enabled = config.enabled !== false;
  const pollMs = config.pollMs;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let cancelled = false;
    const load = async (): Promise<void> => {
      setLoading(true);
      try {
        const parsed = JSON.parse(key) as RequestOptions;
        const result = await api(name, { ...parsed, signal: controller.signal });
        if (cancelled) return;
        setData(result as T);
        setError(null);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(err instanceof ApiError ? err : new ApiError(0, err instanceof Error ? err.message : String(err), null, null, null, null));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setInitial(false);
        }
      }
    };
    void load();
    const timer = pollMs ? setInterval(() => void load(), pollMs) : null;
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [name, key, nonce, pollMs, enabled]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, initial, reload };
}

export interface Action<A extends unknown[], R> {
  run: (...args: A) => Promise<R | null>;
  busy: boolean;
  error: ApiError | null;
  clearError: () => void;
}

/** A mutating call with its own busy and error state, safe to fire from a click handler. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): Action<A, R> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (...args: A): Promise<R | null> => {
      setBusy(true);
      setError(null);
      try {
        const result = await fn(...args);
        return result;
      } catch (err) {
        if (mounted.current) setError(err instanceof ApiError ? err : new ApiError(0, err instanceof Error ? err.message : String(err), null, null, null, null));
        return null;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [fn],
  );

  return { run, busy, error, clearError: useCallback(() => setError(null), []) };
}

/** Remember a value across reloads, tolerating a browser that refuses storage entirely. */
export function useStoredState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Private mode, or site data blocked: the preference simply does not persist.
      }
    },
    [key],
  );
  return [value, set];
}
