/**
 * Human copy for Better Auth / OAuth `?error=` codes on /login.
 * Raw codes stay available for support; UI never dumps only the code.
 */
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  state_mismatch:
    "Google sign-in expired or the browser lost the sign-in session (often after a long 2FA, a second Google prompt, or returning on a different host). Please try Continue with Google again.",
  state_security_mismatch:
    "Google sign-in could not be verified in this browser. Please try Continue with Google again.",
  state_not_found:
    "Google sign-in was incomplete. Please try Continue with Google again.",
  state_invalid:
    "Google sign-in data was invalid. Please try Continue with Google again.",
  state_generation_error:
    "Could not start Google sign-in. Please retry in a moment.",
  access_denied:
    "Google sign-in was cancelled. You can try again when ready.",
  invalid_code:
    "Google sign-in code was invalid or already used. Please try Continue with Google again.",
  no_code:
    "Google did not return a sign-in code. Please try Continue with Google again.",
  oauth_provider_not_found:
    "Google sign-in is not configured on this service.",
  unable_to_get_user_info:
    "Google signed you in but we could not read your profile. Please retry.",
  user_creation_failed:
    "Could not create your Clash account from Google. Please retry or use email.",
  email_not_verified:
    "Your Google account email is not verified. Verify it with Google, then retry.",
  account_already_linked_to_different_user:
    "That Google account is already linked to a different Clash user.",
  unable_to_link_account:
    "Could not link your Google account. Please retry.",
  signup_disabled:
    "New account sign-up is disabled on this service.",
  payload_expired:
    "Sign-in expired. Please try Continue with Google again.",
  please_restart_the_process:
    "Please restart Google sign-in from Clash.",
  unknown:
    "Something went wrong during sign-in. Please try again.",
};

export function oauthErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  const key = code.trim();
  if (!key) return null;
  const known = OAUTH_ERROR_MESSAGES[key];
  if (known) return known;
  return `Sign-in failed (${key}). Please try Continue with Google again, or use email.`;
}
