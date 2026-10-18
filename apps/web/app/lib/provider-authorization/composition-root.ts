/**
 * apps/web composition root (also the desktop renderer's): binds how the
 * settings screen sends a user to a provider. No package below this root may
 * call the binder or read the desktop bridge for it.
 */
import {
  bindProviderAuthorization,
  createDesktopProviderAuthorization,
  createWebProviderAuthorization,
} from "@clash/web-ui/lib/provider-authorization";

export function installProviderAuthorizationCompositionRoot(): void {
  const authorizeProvider = globalThis.__CLASH_DESKTOP__?.authorizeProvider;
  bindProviderAuthorization(
    authorizeProvider
      ? createDesktopProviderAuthorization(authorizeProvider)
      : createWebProviderAuthorization(window.location),
  );
}
