/**
 * Knowing a content hash is not a claim on the file: a transfer only grants its receiver read
 * access once the sender has proved it holds the bytes, and creating a transfer grants the creator
 * nothing.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHub, pairDevice, type TestHub } from '../helpers/hub.js';

const CONTENT = Buffer.from('private audio bytes that only the owner holds');
const HASH = createHash('sha256').update(CONTENT).digest('hex');

type Device = { deviceId: string; authorization: string };

let hub: TestHub;
let admin: { cookie: string; csrfToken: string };
let owner: Device;
let friend: Device;
let attacker: Device;
let accomplice: Device;

async function transfer(from: Device, to: Device): Promise<{ id: string; checksumVerified: boolean }> {
  const response = await hub.app.inject({ method: 'POST', url: '/api/v1/transfers', headers: { authorization: from.authorization }, payload: { toDeviceId: to.deviceId, contentHash: HASH, sizeBytes: CONTENT.byteLength, policy: 'both' } });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; checksumVerified: boolean };
}

async function put(from: Device, body: Buffer) {
  return hub.app.inject({ method: 'PUT', url: `/api/v1/files/${HASH}?offset=0&total=${body.byteLength}`, headers: { authorization: from.authorization, 'content-type': 'application/octet-stream' }, payload: body });
}

async function get(as: Device) {
  return hub.app.inject({ method: 'GET', url: `/api/v1/files/${HASH}`, headers: { authorization: as.authorization } });
}

beforeEach(async () => {
  hub = await createTestHub();
  admin = await hub.completeSetup();
  owner = await pairDevice(hub, admin, { name: 'Owner' });
  friend = await pairDevice(hub, admin, { name: 'Friend' });
  attacker = await pairDevice(hub, admin, { name: 'Attacker' });
  accomplice = await pairDevice(hub, admin, { name: 'Accomplice' });
  await transfer(owner, friend);
  expect((await put(owner, CONTENT)).statusCode).toBe(200);
  expect((await get(friend)).statusCode).toBe(200);
});

afterEach(async () => {
  await hub.dispose();
});

describe('transfer ownership', () => {
  it('lets the uploader read its own file', async () => {
    const response = await get(owner);
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(CONTENT)).toBe(true);
  });

  it('does not let a device claim a file by naming its hash in a transfer', async () => {
    const job = await transfer(attacker, accomplice);
    expect(job.checksumVerified).toBe(false);
    expect((await get(attacker)).statusCode).toBe(404);
    expect((await get(accomplice)).statusCode).toBe(404);
    const head = await hub.app.inject({ method: 'HEAD', url: `/api/v1/files/${HASH}`, headers: { authorization: attacker.authorization } });
    expect(head.statusCode).toBe(404);
    expect(head.headers['x-received-bytes']).toBe('0');
  });

  it('does not treat a deduplicated PUT as proof of possession', async () => {
    await transfer(attacker, accomplice);
    // A single short chunk used to be answered "complete" because the hub already held the hash.
    const partial = await hub.app.inject({ method: 'PUT', url: `/api/v1/files/${HASH}?offset=0&total=${CONTENT.byteLength}`, headers: { authorization: attacker.authorization, 'content-type': 'application/octet-stream' }, payload: CONTENT.subarray(0, 4) });
    expect(partial.statusCode).toBe(200);
    expect(partial.json()).toMatchObject({ complete: false });
    expect((await get(accomplice)).statusCode).toBe(404);
    // Wrong bytes are discarded and grant nothing.
    const wrong = Buffer.alloc(CONTENT.byteLength - 4, 1);
    const rest = await hub.app.inject({ method: 'PUT', url: `/api/v1/files/${HASH}?offset=4&total=${CONTENT.byteLength}`, headers: { authorization: attacker.authorization, 'content-type': 'application/octet-stream' }, payload: wrong });
    expect(rest.statusCode).toBe(400);
    expect((await get(accomplice)).statusCode).toBe(404);
    // The owner's copy is untouched.
    expect((await get(friend)).rawPayload.equals(CONTENT)).toBe(true);
  });

  it('grants the receiver access once a sender uploads the real bytes itself', async () => {
    await transfer(attacker, accomplice);
    expect((await put(attacker, CONTENT)).json()).toMatchObject({ complete: true, verified: true });
    expect((await get(accomplice)).statusCode).toBe(200);
  });

  it('scopes the duplicate-transfer lookup to the caller', async () => {
    const mine = (await hub.app.inject({ method: 'GET', url: '/api/v1/transfers', headers: { authorization: owner.authorization } })).json() as { items: Array<{ id: string }> };
    expect(mine.items.length).toBeGreaterThan(0);
    // Same hash, same receiver, different sender: a new job, never the owner's record.
    const job = await transfer(attacker, friend);
    expect(mine.items.map((t) => t.id)).not.toContain(job.id);
    const attackersView = (await hub.app.inject({ method: 'GET', url: '/api/v1/transfers', headers: { authorization: attacker.authorization } })).json() as { items: Array<{ id: string }> };
    expect(attackersView.items.some((t) => mine.items.some((m) => m.id === t.id))).toBe(false);
  });

  it('gives the receiver of an already-verified sender immediate access', async () => {
    // The friend received the file, so it may pass it on without re-uploading.
    const job = await transfer(friend, accomplice);
    expect(job.checksumVerified).toBe(true);
    expect((await get(accomplice)).statusCode).toBe(200);
  });
});
