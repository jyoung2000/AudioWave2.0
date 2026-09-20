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
  const key = JSON.stringify({ params: options.params, query: options.query, body: options.body });
  const fullKey = `${name}:${key}`;
  // Results are tagged with the request they answer, so switching params never shows the previous
  // params' data (or error) as if it belonged to the new ones.
  const [result, setResult] = useState<{ key: string; data: T | null; error: ApiError | null } | null>(null);
  const [loading, setLoading] = useState(config.enabled !== false);
  const [nonce, setNonce] = useState(0);
  const enabled = config.enabled !== false;
  const pollMs = config.pollMs;
  const current = result?.key === fullKey ? result : null;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let cancelled = false;
    const load = async (): Promise<void> => {
      setLoading(true);
      try {
        const parsed = JSON.parse(key) as RequestOptions;
        const value = await api(name, { ...parsed, signal: controller.signal });
        if (cancelled) return;
        setResult({ key: fullKey, data: value as T, error: null });
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        const apiError = err instanceof ApiError ? err : new ApiError(0, err instanceof Error ? err.message : String(err), null, null, null, null);
        setResult((prev) => ({ key: fullKey, data: prev?.key === fullKey ? prev.data : null, error: apiError }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = pollMs ? setInterval(() => void load(), pollMs) : null;
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [name, key, fullKey, nonce, pollMs, enabled]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data: current?.data ?? null, error: current?.error ?? null, loading: enabled && (loading || current === null), initial: current === null, reload };
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

/**
 * Remember a value across reloads, tolerating a browser that refuses storage entirely. Stored
 * values are untrusted (an older build, a hand edit): `isValid` rejects anything unusable and the
 * initial value is used instead.
 */
export function useStoredState<T>(key: string, initial: T, isValid?: (value: unknown) => value is T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return initial;
      const parsed: unknown = JSON.parse(raw);
      if (isValid && !isValid(parsed)) return initial;
      return parsed as T;
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
