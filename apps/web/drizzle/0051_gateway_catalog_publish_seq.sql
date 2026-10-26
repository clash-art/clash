-- Official catalog publish order (#351). Guide: apps/docs/guide/gateway-admin.md.
-- Drizzle mirror: packages/shared-cloud-schema/src/gateway.ts. No foreign keys.
--
-- published_at is unix seconds, so two versions published within one second
-- tied and the live version fell back to the larger version *name*: the
-- version published last could stay unrouted. publish_seq records the publish
-- order (every row of a version gets the same value, MAX + 1 at publish), and
-- the live version is the newest started published_at, then the highest
-- publish_seq. Drafts keep NULL.
--
-- Backfill: versions already published are numbered in the order the live
-- query chose before (published_at, then catalog_version), so the version
-- that routes today keeps routing.

ALTER TABLE gateway_model ADD COLUMN publish_seq integer;

UPDATE gateway_model
   SET publish_seq = (
     SELECT COUNT(DISTINCT earlier.catalog_version)
       FROM gateway_model AS earlier
      WHERE earlier.published_at IS NOT NULL
        AND (earlier.published_at < gateway_model.published_at
             OR (earlier.published_at = gateway_model.published_at
                 AND earlier.catalog_version <= gateway_model.catalog_version))
   )
 WHERE published_at IS NOT NULL AND publish_seq IS NULL;

CREATE INDEX IF NOT EXISTS gateway_model_published_idx
  ON gateway_model(published_at, publish_seq);
