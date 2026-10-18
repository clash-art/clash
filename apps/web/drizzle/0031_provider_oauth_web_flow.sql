-- Web redirect Provider OAuth on the Cloudflare adapter.
--
-- callback_type: 'web' for a flow finished by GET /api/v1/provider-oauth/callback.
-- encrypted_flow_secret: ACTION_SECRET_KEY envelope over the PKCE verifier, the
--   state and the redirect_uri of a pending flow. Never stored in clear; cleared
--   once the callback consumes it, which is what makes a state single-use.
-- error_code: stable PROVIDER_OAUTH_* code beside the human message in `error`.
-- No foreign keys.
ALTER TABLE `provider_oauth` ADD COLUMN `callback_type` TEXT;
ALTER TABLE `provider_oauth` ADD COLUMN `encrypted_flow_secret` TEXT;
ALTER TABLE `provider_oauth` ADD COLUMN `error_code` TEXT;
