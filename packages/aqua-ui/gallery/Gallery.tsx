import { useMemo, type ReactNode } from 'react';
import { AquaProvider, ToastProvider, type AquaProfile } from '../src/index.js';
import { ControlsDemo, IconsDemo, OverlaysDemo, PageDemo, ResultsDemo, ShellDemo, StatesDemo, makeRows } from './specimens.js';

const params = new URLSearchParams(location.search);
const only = params.get('component');
const widthParam = params.get('width');
const reduced = params.get('reduced') === '1';
const inactive = params.get('inactive') === '1';
const profile = (params.get('profile') as AquaProfile | null) ?? 'snow-leopard-itunes-9';
const rows = makeRows(Number(params.get('rows') ?? 40));

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  if (only && only !== id && only !== 'all') return null;
  return (
    <section data-gallery={id} style={{ marginBottom: 24 }}>
      <h2 style={{ color: '#fff', font: '700 13px/1.2 "Lucida Grande", sans-serif', margin: '0 0 8px', textShadow: '0 1px 0 rgba(0,0,0,.5)' }}>{title}</h2>
      <div style={{ display: 'grid', gap: 12 }}>{children}</div>
    </section>
  );
}

export function Gallery() {
  const width = useMemo(() => (widthParam ? Number(widthParam) : undefined), []);
  return (
    <AquaProvider profile={profile} active={!inactive} reducedMotion={reduced || undefined}>
      <ToastProvider>
        <div style={{ maxWidth: width ?? 1180, margin: '0 auto' }}>
          <Section id="page" title="Page shell (status bar, section strip, hero, iTunes 10 list)"><PageDemo /></Section>
          <Section id="shell" title="Application shell (window, toolbar, source list, table, bottom bar)"><ShellDemo rows={rows} width={width} inactive={inactive} /></Section>
          <Section id="controls" title="Controls"><ControlsDemo /></Section>
          <Section id="overlays" title="Overlays"><OverlaysDemo initiallyOpen={params.get('state') === 'open'} /></Section>
          <Section id="states" title="States"><StatesDemo /></Section>
          <Section id="results" title="Results & grid"><ResultsDemo /></Section>
          <Section id="icons" title="Icons"><IconsDemo /></Section>
        </div>
      </ToastProvider>
    </AquaProvider>
  );
}
