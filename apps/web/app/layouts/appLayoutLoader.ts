import type { LoaderFunctionArgs } from "react-router";
import { getRuntimeCapabilities } from "@clash/web-ui/lib/runtimeConfig";
import { getSession } from "@clash/web-ui/lib/sessionStore";

export async function loader(_: LoaderFunctionArgs) {
  if (getRuntimeCapabilities().auth.mode === "local-user") {
    return { isAuthenticated: true };
  }
  // The shared session source: fetched once per page load, then cached (#160).
  const { data } = await getSession();
  return { isAuthenticated: !!data?.user?.id };
}
