/** Only same-origin paths can continue a browser sign-in. */
export function loginReturnPath(value: string | null): string {
  if (
    !value?.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020]/u.test(value)
  )
    return "/";
  const url = new URL(value, "https://clash.invalid");
  if (url.origin !== "https://clash.invalid" || url.pathname === "/login")
    return "/";
  return url.pathname + url.search + url.hash;
}
