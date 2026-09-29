import GlobalAssetsClient from "@clash/web-ui/components/GlobalAssetsClient";
import { listPersonalGlobalAssets } from "@clash/web-ui/lib/hooks/useAsset";
import { AppPage, AppPageHeader } from "@clash/web-ui/components/AppPage";
import { InlineAlert } from "@clash/gui/components/ui/feedback";
import { Button } from "@clash/gui/components/ui/button";
import {
  isRouteErrorResponse,
  useRouteError,
  useRevalidator,
  redirect,
  useLoaderData,
} from "react-router";

export async function loader() {
  try {
    return { assets: await listPersonalGlobalAssets() };
  } catch (error) {
    const status =
      error &&
      typeof error === "object" &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : undefined;
    if (status === 401) throw redirect("/login");
    if (status === undefined) throw error;
    throw new Response("Failed to load Global Assets", {
      status,
    });
  }
}

export default function AssetsRoute() {
  const { assets } = useLoaderData<typeof loader>();
  return <GlobalAssetsClient initialAssets={assets} />;
}

/** Keep the application shell and navigation available when this service lacks
 * the personal library endpoint or the library cannot be loaded. */
export function ErrorBoundary() {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const unavailable =
    isRouteErrorResponse(error) &&
    (error.status === 404 || error.status === 501);
  return (
    <AppPage>
      <AppPageHeader
        title="Assets"
        description="Your personal media library."
      />
      <InlineAlert
        tone="error"
        title={
          unavailable ? "Asset library unavailable" : "Could not load assets"
        }
        message={
          unavailable
            ? "This service does not provide a personal asset library yet."
            : "Check your connection and try again."
        }
      />
      <Button
        className="mt-4"
        disabled={revalidator.state !== "idle"}
        onClick={() => void revalidator.revalidate()}
      >
        Try again
      </Button>
    </AppPage>
  );
}
