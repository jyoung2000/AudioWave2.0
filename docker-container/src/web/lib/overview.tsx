/**
 * One reading of the hub's overview for the whole window.
 *
 * The Overview tab's badge, the status lamp and the "Needs attention" list all say how many things
 * need attention. When each polled on its own they could disagree for a few seconds; now the window
 * reads `/metrics/overview` once and every part of it is drawn from that one answer.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { OverviewMetrics } from '@now-playing/contracts';
import { useResource, type Resource } from './hooks.js';

const OverviewContext = createContext<Resource<OverviewMetrics> | null>(null);

export const OVERVIEW_POLL_MS = 5_000;

export function OverviewProvider({ value, children }: { value: Resource<OverviewMetrics>; children: ReactNode }) {
  return <OverviewContext.Provider value={value}>{children}</OverviewContext.Provider>;
}

/** The window's shared overview; a view rendered on its own (in a test, say) reads it for itself. */
export function useOverview(): Resource<OverviewMetrics> {
  const shared = useContext(OverviewContext);
  const own = useResource('metricsOverview', {}, { pollMs: OVERVIEW_POLL_MS, enabled: shared === null }) as Resource<OverviewMetrics>;
  return shared ?? own;
}
