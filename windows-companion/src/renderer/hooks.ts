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

/**
 * `pollMs` may be a function of the latest answer, so a view can watch closely while something is
 * moving (a downloader being set up) and relax when it is not, without restarting the poll.
 */
export function useChannel<C extends IpcChannel>(channel: C, request: IpcRequest<C>, options: { pollMs?: number | ((data: IpcResponse<C> | null) => number) } = {}): Resource<IpcResponse<C>> {
  const [data, setData] = useState<IpcResponse<C> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify(request ?? null);
  const pollRef = useRef(options.pollMs);
  pollRef.current = options.pollMs;
  const polling = options.pollMs !== undefined;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let latest: IpcResponse<C> | null = null;
    const load = async (): Promise<void> => {
      try {
        const result = await invoke(channel, JSON.parse(key) as IpcRequest<C>);
        latest = result;
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
    const schedule = (): void => {
      const poll = pollRef.current;
      if (cancelled || poll === undefined) return;
      const ms = typeof poll === 'function' ? poll(latest) : poll;
      if (ms > 0) timer = setTimeout(() => void load().then(schedule), ms);
    };
    void load().then(schedule);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [channel, key, nonce, polling]);

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
