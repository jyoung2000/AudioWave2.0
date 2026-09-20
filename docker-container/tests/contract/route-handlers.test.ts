/**
 * Every declared route has a handler.
 *
 * `docs/IMPLEMENTATION_STATUS.md` claimed "a contract test asserts every declared route has a
 * handler". There was no such test. This is it — the claim is now true rather than merely written
 * down, and adding a route to the contract without registering it becomes a failing test rather
 * than a 404 someone finds later.
 *
 * `hasRoute` asks Fastify's own router, so this checks what was actually registered, not what a
 * source file appears to register.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_PREFIX, routes, type RouteContract } from '@now-playing/contracts';
import { createTestHub, type TestHub } from '../helpers/hub.js';

let hub: TestHub;

beforeAll(async () => {
  hub = await createTestHub();
});

afterAll(async () => {
  await hub.dispose();
});

/** Where the route is mounted: absolute paths stand alone, the rest hang off the API prefix. */
function urlOf(route: RouteContract): string {
  return route.absolute ? route.path : `${API_PREFIX}${route.path}`;
}

const declared = Object.entries(routes) as Array<[string, RouteContract]>;

describe('declared routes', () => {
  it('declares at least the operations the documentation counts', () => {
    // A guard on the guard: if `routes` were ever empty or filtered, the loop below would pass
    // vacuously and prove nothing.
    expect(declared.length).toBeGreaterThan(100);
  });

  it.each(declared.map(([name, route]) => [`${route.method} ${urlOf(route)} (${name})`, route] as const))('%s has a handler', (_label, route) => {
    expect(hub.app.hasRoute({ method: route.method as 'GET', url: urlOf(route) })).toBe(true);
  });

  it('gives every route a unique operationId', () => {
    // The OpenAPI document and every generated client key on this, so a duplicate silently drops one.
    const ids = declared.map(([, route]) => route.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never mounts two routes at the same method and path', () => {
    const seen = declared.map(([, route]) => `${route.method} ${urlOf(route)}`);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
