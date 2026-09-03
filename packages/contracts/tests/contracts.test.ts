import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as contracts from '../src/index.js';
import { routes, routePath } from '../src/api/routes.js';

describe('contracts', () => {
  it('exposes a stable contracts version', () => {
    expect(contracts.CONTRACTS_VERSION).toBe('1.0.0');
    expect(contracts.WS_PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('every route has a unique operationId and a valid path', () => {
    const ids = new Set<string>();
    for (const [name, r] of Object.entries(routes)) {
      expect(ids.has(r.operationId), `${name} duplicate operationId`).toBe(false);
      ids.add(r.operationId);
      expect(r.path.startsWith('/')).toBe(true);
      if (r.params) {
        const shape = (r.params as z.ZodObject<z.ZodRawShape>).shape;
        for (const key of Object.keys(shape)) expect(r.path).toContain(`:${key}`);
      }
    }
  });

  it('routePath substitutes params', () => {
    expect(routePath(routes.groupsGet, { groupId: '0192b1f0-0000-7000-8000-000000000001' })).toBe('/api/v1/groups/0192b1f0-0000-7000-8000-000000000001');
    expect(routePath(routes.healthz)).toBe('/healthz');
  });

  it('MediaLocator rejects filesystem paths', () => {
    const bad = contracts.MediaLocator.safeParse({ kind: 'windows-file', deviceId: 'x', fileId: 'C:\\Music\\a.mp3' });
    expect(bad.success).toBe(false);
    const good = contracts.MediaLocator.safeParse({ kind: 'windows-file', deviceId: '0192b1f0-0000-7000-8000-000000000001', fileId: 'f_01' });
    expect(good.success).toBe(true);
  });

  it('every schema converts to JSON schema without throwing', () => {
    let count = 0;
    for (const value of Object.values(contracts)) {
      if (value instanceof z.ZodType) {
        z.toJSONSchema(value, { unrepresentable: 'any' });
        count += 1;
      }
    }
    expect(count).toBeGreaterThan(80);
  });
});
