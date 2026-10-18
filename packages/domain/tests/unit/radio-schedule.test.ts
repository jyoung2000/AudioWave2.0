import { beforeEach, describe, expect, it } from 'vitest';
import { iheartStationId, readIheartProgramme, resetIheartSiteCache } from '../../src/radio-schedule.js';

const WGCI = 'https://stream.revma.ihrhls.com/zc841';
const NOW = 1792302000000;
const STATION = { hits: [{ id: 841, name: '107.5 WGCI', website: 'wgci.iheart.com' }] };
const onAir = (name: string, startMs: number, stopMs: number) => ({ data: { sites: { find: { onAirSchedule: { current: { name, startMs, stopMs } } } } } });

function fake(answers: Record<string, unknown>) {
  const asked: string[] = [];
  const getJson = async (url: string) => {
    asked.push(url);
    const key = Object.keys(answers).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected ${url}`);
    const value = answers[key];
    if (value instanceof Error) throw value;
    return value;
  };
  return { asked, getJson };
}

beforeEach(() => resetIheartSiteCache());

describe('iheartStationId', () => {
  it('reads the station id from revma stream URLs only', () => {
    expect(iheartStationId(WGCI)).toBe('841');
    expect(iheartStationId('https://cloud.revma.ihrhls.com/zc841?rj-ttl=5')).toBe('841');
    expect(iheartStationId('https://stream.revma.ihrhls.com.evil.test/zc841')).toBeNull();
    expect(iheartStationId('https://user:pw@stream.revma.ihrhls.com/zc841')).toBeNull();
    expect(iheartStationId('https://example.com/zc841')).toBeNull();
    expect(iheartStationId('not a url')).toBeNull();
  });
});

describe('readIheartProgramme', () => {
  it('names the show on the air now, from the station website schedule', async () => {
    const f = fake({ 'liveStations/841': STATION, 'radioedit.iheart.com/graphql': onAir('Jamal Smallz', NOW - 60_000, NOW + 60_000) });
    expect(await readIheartProgramme(WGCI, f.getJson, NOW)).toBe('Jamal Smallz');
    expect(f.asked[0]).toBe('https://us.api.iheart.com/api/v2/content/liveStations/841');
    expect(decodeURIComponent(f.asked[1]!)).toContain('"host":"wgci.iheart.com"');
  });

  it('asks for the station website once, then only the schedule', async () => {
    const f = fake({ 'liveStations/841': STATION, 'radioedit.iheart.com/graphql': onAir('Jamal Smallz', NOW - 1, NOW + 1) });
    await readIheartProgramme(WGCI, f.getJson, NOW);
    await readIheartProgramme(WGCI, f.getJson, NOW);
    expect(f.asked.filter((u) => u.includes('liveStations'))).toHaveLength(1);
  });

  it('a show outside its window, a non-iHeart website or a failing schedule is no programme', async () => {
    expect(await readIheartProgramme(WGCI, fake({ 'liveStations/841': STATION, graphql: onAir('Old Show', NOW - 120_000, NOW - 60_000) }).getJson, NOW)).toBeNull();
    resetIheartSiteCache();
    expect(await readIheartProgramme(WGCI, fake({ 'liveStations/841': { hits: [{ id: 841, website: 'evil.example.com' }] } }).getJson, NOW)).toBeNull();
    resetIheartSiteCache();
    expect(await readIheartProgramme(WGCI, fake({ 'liveStations/841': { hits: [{ id: 999, website: 'wgci.iheart.com' }] } }).getJson, NOW)).toBeNull();
    resetIheartSiteCache();
    expect(await readIheartProgramme(WGCI, fake({ 'liveStations/841': STATION, graphql: new Error('down') }).getJson, NOW)).toBeNull();
  });

  it('never asks anything for a stream that is not iHeart', async () => {
    const f = fake({});
    expect(await readIheartProgramme('https://wfmt.streamguys1.com/main-mp3', f.getJson, NOW)).toBeNull();
    expect(f.asked).toEqual([]);
  });
});
