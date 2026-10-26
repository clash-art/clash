-- #419: a payments plugin maps a provider price/product id to one package or
-- top-up pack. The columns exist since 0032 (nullable, configuration only:
-- no price or product id is hardcoded); one id names at most one row.
-- SQLite unique indexes admit any number of NULLs (self-host leaves them unset).
CREATE UNIQUE INDEX IF NOT EXISTS gateway_package_external_price_idx
  ON gateway_package(external_price_id);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_topup_pack_external_price_idx
  ON gateway_topup_pack(external_price_id);
