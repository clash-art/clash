import type { LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData } from "react-router";
import HomePageClient from "@clash/web-ui/components/HomePageClient";
import {
  getRuntimeCapabilities,
  runtimeFetch,
} from "@clash/web-ui/lib/runtimeConfig";
import {
  getSession,
  sessionFailureStatus,
} from "@clash/web-ui/lib/sessionStore";
import {
  emptyMarketplaceFeedData,
  loadMarketplaceFeedData,
} from "../lib/marketplaceData";

export async function loader(_: LoaderFunctionArgs) {
  if (getRuntimeCapabilities().auth.mode === "better-auth") {
    const session = await getSession();
    const failure = sessionFailureStatus(session);
    if (failure !== null) {
      throw new Response("Unable to verify session", { status: failure });
    }
    if (!session.data?.user?.id) throw redirect("/login");
  }

  const projects = runtimeFetch("/api/v1/projects", { credentials: "include" })
    .then(async (response) => {
      if (response.status === 401) throw redirect("/login");
      if (!response.ok) return [];
      const data = (await response.json()) as { projects?: unknown[] };
      return Array.isArray(data.projects) ? data.projects : [];
    })
    .catch((error: unknown) => {
      if (error instanceof Response) throw error;
      return [];
    });
  const marketplaceFeed = await loadMarketplaceFeedData().catch(
    (error: unknown) => {
      if (error instanceof Response) throw error;
      return emptyMarketplaceFeedData;
    },
  );

  // Hosted sessions keep the blocking list so a 401 still redirects to /login
  // before anything renders. The local Host streams it: listing reads every
  // Project's replica and assets, and the Dashboard must not sit behind it.
  if (getRuntimeCapabilities().auth.mode === "better-auth") {
    return { authed: true as const, projects: await projects, marketplaceFeed };
  }
  return { authed: true as const, projects, marketplaceFeed };
}

export default function Home() {
  const data = useLoaderData<typeof loader>();
  return (
    <HomePageClient
      initialProjects={data.projects as any}
      marketplaceFeed={data.marketplaceFeed}
    />
  );
}
