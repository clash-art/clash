import { useCallback, useEffect, useRef, useState } from "react";
import { Cloud } from "@phosphor-icons/react";
import {
  OFFICIAL_CLOUD_URL,
  type CloudConnectionStatus,
  type ProjectCloudJourney,
} from "@clash/shared-types";
import { runtimeApiUrl, isDesktopRuntime } from "../lib/runtimeConfig";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Dialog } from "./ui/dialog";
import { IconButton } from "./ui/icon-button";
import { Tooltip } from "./ui/tooltip";

async function cloudApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(runtimeApiUrl(path), {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw Error(
      value &&
        typeof value === "object" &&
        "error" in value &&
        typeof value.error === "string"
        ? value.error
        : `Request failed (HTTP ${response.status})`,
    );
  return value as T;
}
async function openCloudUrl(url: string) {
  if (globalThis.__CLASH_DESKTOP__?.openExternal)
    await globalThis.__CLASH_DESKTOP__.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Could not connect. Please try again.";
interface Login {
  id: string;
  authorizationUrl: string;
  state: "pending" | "succeeded" | "failed" | "cancelled";
  error?: string;
}

export function CloudAccountPanel({
  serviceUrl,
  onAuthenticated,
}: { serviceUrl?: string; onAuthenticated?: () => void } = {}) {
  const [account, setAccount] = useState<CloudConnectionStatus | null>(null);
  const [choice, setChoice] = useState<"official" | "selfhost">("official");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState<Login | null>(null);
  const callback = useRef(onAuthenticated);
  callback.current = onAuthenticated;
  const load = useCallback(async () => {
    const state = await cloudApi<CloudConnectionStatus>(
      "/api/v1/local/cloud" +
        (serviceUrl ? `?serviceUrl=${encodeURIComponent(serviceUrl)}` : ""),
    );
    setAccount(state);
    setChoice(state.official ? "official" : "selfhost");
    setAddress(state.official ? "" : state.serviceUrl);
  }, [serviceUrl]);
  useEffect(() => {
    let active = true;
    void load().catch((e) => {
      if (active) setError(message(e));
    });
    return () => {
      active = false;
    };
  }, [load]);
  useEffect(() => {
    if (!login) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await cloudApi<Login>(
          `/api/v1/local/cloud/login/${encodeURIComponent(login.id)}`,
        );
        if (!active) return;
        if (status.state === "pending") {
          timer = setTimeout(() => void poll(), 1000);
          return;
        }
        setLogin(null);
        if (status.state === "succeeded") {
          await load();
          if (active) callback.current?.();
        } else setError(status.error ?? "Sign-in was cancelled.");
      } catch (e) {
        if (active) {
          setError(message(e));
          setLogin(null);
        }
      }
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [login, load]);
  const target =
    serviceUrl ?? (choice === "official" ? OFFICIAL_CLOUD_URL : address.trim());
  const sameAccount = account?.serviceUrl === target;
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await cloudApi<Login>("/api/v1/local/cloud/login", {
        method: "POST",
        body: JSON.stringify({ serviceUrl: target }),
      });
      setLogin(next);
      await openCloudUrl(next.authorizationUrl);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      await cloudApi("/api/v1/local/cloud/logout", {
        method: "POST",
        body: JSON.stringify({ serviceUrl: target }),
      });
      await load();
      callback.current?.();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  if (!account && !error)
    return (
      <p role="status" aria-label="Loading cloud account">
        Loading cloud account…
      </p>
    );
  return (
    <section className="space-y-4" aria-label="Cloud account">
      <p className="text-sm text-muted-foreground">
        Local projects work without signing in. Signing in does not upload your
        projects.
      </p>
      {!serviceUrl ? (
        <RadioGroup
          aria-label="Cloud service"
          value={choice}
          onValueChange={(value) => {
            if (value === "official" || value === "selfhost") {
              setChoice(value);
              setError(null);
            }
          }}
          className="grid grid-cols-2 gap-2"
        >
          <RadioGroupItem
            value="official"
            disabled={busy || !!login}
            className="rounded-lg border p-3 text-left"
          >
            Official cloud
          </RadioGroupItem>
          <RadioGroupItem
            value="selfhost"
            disabled={busy || !!login}
            className="rounded-lg border p-3 text-left"
          >
            Self-hosted
          </RadioGroupItem>
        </RadioGroup>
      ) : (
        <p className="break-all text-sm">{serviceUrl}</p>
      )}
      {choice === "selfhost" && !serviceUrl ? (
        <label className="block space-y-1 text-sm">
          Service address
          <Input
            aria-label="Service address"
            type="url"
            placeholder="https://clash.example.com"
            value={address}
            disabled={busy || !!login}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {login ? (
        <div className="space-y-2" aria-live="polite">
          <p className="text-sm">Complete sign-in in your browser.</p>
          <a
            className="text-sm underline"
            href={login.authorizationUrl}
            target="_blank"
            rel="noreferrer"
          >
            Continue in browser
          </a>
          <Button
            variant="default"
            onClick={() => {
              void cloudApi(
                `/api/v1/local/cloud/login/${encodeURIComponent(login.id)}`,
                { method: "DELETE" },
              )
                .then(() => setLogin(null))
                .catch((e) => setError(message(e)));
            }}
          >
            Cancel sign-in
          </Button>
        </div>
      ) : sameAccount && account?.user ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">
              {account.user.name || account.user.email}
            </p>
            <p className="text-xs text-muted-foreground">
              {account.user.email}
            </p>
          </div>
          <Button
            variant="default"
            disabled={busy}
            onClick={() => void logout()}
          >
            Sign out
          </Button>
        </div>
      ) : (
        <Button disabled={busy || !target} onClick={() => void start()}>
          {busy ? "Connecting…" : "Sign in"}
        </Button>
      )}
    </section>
  );
}

export function ProjectCloudPanel({ projectId }: { projectId: string }) {
  const [state, setState] = useState<ProjectCloudJourney | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}/cloud-admission`;
  const load = useCallback(async () => {
    setState(await cloudApi<ProjectCloudJourney>(path));
  }, [path]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await cloudApi<ProjectCloudJourney>(path);
        if (active) {
          setState(next);
          setError(null);
        }
      } catch (e) {
        if (active) setError(message(e));
      } finally {
        if (active) timer = setTimeout(() => void poll(), 1500);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [path]);
  const enable = async () => {
    setBusy(true);
    setError(null);
    try {
      await cloudApi(path, { method: "POST", body: "{}" });
      await load();
    } catch (e) {
      setError(message(e));
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  const admission = state?.admission;
  const syncing =
    admission?.status === "pending" || admission?.status === "syncing";
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Enable sync for this project to access it on your other devices. Your
        working files stay local.
      </p>
      {state ? (
        <p className="break-all text-xs text-muted-foreground">
          Service: {state.serviceUrl}
        </p>
      ) : (
        <p role="status">Loading cloud connection…</p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {state?.accountMismatch ? (
        <p role="alert" className="text-sm">
          This project belongs to a different account on this service. Sign in
          with its original account.
        </p>
      ) : null}
      {state && !state.authenticated ? (
        <CloudAccountPanel
          serviceUrl={
            state.admission && state.admission.tenantId !== "pending"
              ? state.serviceUrl
              : undefined
          }
          onAuthenticated={() => void load()}
        />
      ) : null}
      {state?.authenticated ? (
        <>
          <p className="text-sm" aria-live="polite">
            {state.webUrl
              ? "Synced"
              : syncing
                ? "Syncing project data and media…"
                : admission?.status === "failed"
                  ? "Sync needs attention"
                  : "This project is local only."}
          </p>
          {admission?.lastError ? (
            <p role="alert" className="text-sm text-destructive">
              {admission.lastError}
            </p>
          ) : null}
          {state.webUrl ? (
            <Button
              disabled={!!error}
              onClick={() =>
                void openCloudUrl(state.webUrl!).catch((e) =>
                  setError(message(e)),
                )
              }
            >
              Open in Web
            </Button>
          ) : (
            <Button disabled={busy || syncing} onClick={() => void enable()}>
              {busy
                ? "Starting sync…"
                : admission && admission.status !== "local-only"
                  ? "Retry sync"
                  : "Enable cloud sync"}
            </Button>
          )}
        </>
      ) : null}
    </div>
  );
}
export function ProjectCloudButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  if (!isDesktopRuntime()) return null;
  return (
    <>
      <Tooltip label="Cloud sync">
        <IconButton
          label="Cloud sync"
          size="sm"
          className="shrink-0 text-content-secondary"
          icon={<Cloud className="h-4 w-4" />}
          onClick={() => setOpen(true)}
        />
      </Tooltip>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Cloud sync"
        description="Connect this project to your cloud account."
      >
        <ProjectCloudPanel projectId={projectId} />
      </Dialog>
    </>
  );
}
