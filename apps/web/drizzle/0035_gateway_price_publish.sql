-- Price-book draft/publish (#352). Guide: apps/docs/guide/gateway-price-book.md.
-- Drizzle mirror: packages/shared-cloud-schema/src/gateway.ts. No foreign keys.
--
-- A price-book version is a draft until published_at is set, like
-- gateway_model.published_at for the catalog. The data plane charges only
-- published rows effective at request time; a published row never changes.
-- Rows written before this migration were already charged, so they are
-- backfilled as published when they were created.

ALTER TABLE gateway_price ADD COLUMN published_at integer;
UPDATE gateway_price SET published_at = created_at WHERE published_at IS NULL;
