# ADR-0002: One canonical schema package generates types, JSON Schema and OpenAPI

**Status:** accepted · **Date:** 2026-09-03

## Context
Three products exchange entities, events and files. Duplicated interfaces drift.

## Decision
`packages/contracts` holds every entity (`SyncedEntityBase` with `schemaVersion`, `createdAt/updatedAt`, tombstone `deletedAt`), the `/api/v1` route table (`defineRoute` with zod params/query/body/response, auth mode, scopes, rate-limit class, setup gate), WebSocket envelopes and event payload maps, and file formats (playlist JSON, EQ preset JSON, history CSV columns/row, release metadata, sync manifest/delta). `scripts/generate.ts` emits `generated/json-schema/*.json` and `generated/openapi.json`; `pnpm verify` fails when the committed output is stale.

The hub validates requests and (in dev/test) responses with the same schemas; the player and companion validate everything that crosses a trust boundary (IndexedDB rows, imported files, WS payloads, release feeds).

## Consequences
- A schema change is one edit; the OpenAPI document and the docs regenerate.
- Runtime protocol compatibility is explicit: `WS_PROTOCOL_VERSION`/`WS_MIN_SUPPORTED_PROTOCOL_VERSION` and `SCHEMA_VERSIONS` drive upgrade-required states instead of silent corruption.
