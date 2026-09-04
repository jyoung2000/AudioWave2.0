/**
 * Small data hooks over the IPC bridge — the same shape as the hub's admin GUI, for the same
 * reason: cancel in flight, never set state after unmount, and keep the previous value on screen
 * while a refresh runs.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { IpcChannel, IpcEvent, IpcEventPayload, IpcRequest, IpcResponse } from '../shared/ipc.js';
import { invoke, subscribe } from './bridge.js';

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useChannel<C extends IpcChannel>(channel: C, request: IpcRequest<C>, options: { pollMs?: number } = {}): Resource<IpcResponse<C>> {
  const [data, setData] = useState<IpcResponse<C> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify(request ?? null);
  const pollMs = options.pollMs;

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const result = await invoke(channel, JSON.parse(key) as IpcRequest<C>);
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = pollMs ? setInterval(() => void load(), pollMs) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [channel, key, nonce, pollMs]);

  return { data, error, loading, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): { run: (...args: A) => Promise<R | null>; busy: boolean; error: string | null } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        return await fn(...args);
      } catch (err) {
        if (mounted.current) setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [fn],
  );
  return { run, busy, error };
}

export function useEvent<E extends IpcEvent>(event: E, listener: (payload: IpcEventPayload<E>) => void): void {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => subscribe(event, (payload) => ref.current(payload)), [event]);
}
