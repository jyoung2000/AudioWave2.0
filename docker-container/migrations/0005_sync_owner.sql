-- Sync isolation: every synced record belongs to an owner — 'user:<hub user id>', 'device:<device id>'
-- for a device not linked to a hub user, or 'hub' for records the hub itself publishes or imports.
-- Devices only pull their owner's records plus hub records, and may only write their owner's records.
ALTER TABLE synced_records ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'hub';

UPDATE synced_records
SET owner_id = COALESCE(
  (SELECT 'user:' || d.hub_user_id FROM devices d WHERE d.id = synced_records.origin_device_id AND d.hub_user_id IS NOT NULL),
  (SELECT 'device:' || d.id FROM devices d WHERE d.id = synced_records.origin_device_id),
  'hub'
);

CREATE INDEX idx_synced_records_owner ON synced_records(owner_id, collection, updated_at);
