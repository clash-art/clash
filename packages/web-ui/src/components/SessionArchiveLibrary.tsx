import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ArrowCounterClockwise,
  Archive,
  Folder,
  Trash,
} from "@phosphor-icons/react";

import {
  listArchivedProjects,
  purgeProject,
  restoreProject,
  type ProjectListItem,
} from "../lib/clientActions";
import {
  useSessionHistory,
  type SessionInfo,
} from "../hooks/useSessionHistory";
import { Button } from "./ui/button";
import { InlineAlert } from "./ui/feedback";
import {
  SettingsEmptyState,
  SettingsSectionHeader,
  SettingsSectionLayout,
} from "./SettingsPrimitives";

type ProjectArchiveState =
  | { status: "loading"; projects: ProjectListItem[] }
  | { status: "ready"; projects: ProjectListItem[] }
  | { status: "error"; projects: ProjectListItem[]; message: string };

export function SessionArchiveLibrary() {
  const {
    archivedSessions,
    archiveStatus,
    archiveError,
    loadArchivedSessions,
    restoreSession,
    deleteSession,
  } = useSessionHistory(undefined, { loadActive: false });
  const [projects, setProjects] = useState<ProjectArchiveState>({
    status: "loading",
    projects: [],
  });
  const [confirming, setConfirming] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setProjects((current) => ({
      status: "loading",
      projects: current.projects,
    }));
    try {
      const next = await listArchivedProjects();
      setProjects({ status: "ready", projects: next });
    } catch (error) {
      setProjects({
        status: "error",
        projects: [],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void loadArchivedSessions();
    void loadProjects();
  }, [loadArchivedSessions, loadProjects]);

  const removeProject = useCallback((id: string) => {
    setProjects((current) => ({
      ...current,
      projects: current.projects.filter((project) => project.id !== id),
    }));
  }, []);

  return (
    <SettingsSectionLayout>
      <SettingsSectionHeader
        icon={<Archive className="size-5" weight="bold" />}
        title="Archive Library"
        description="Restore archived work or permanently remove it."
      />

      <ArchiveCollection
        title="Sessions"
        description="Archived conversations are hidden from project session history."
        loading={archiveStatus === "idle" || archiveStatus === "loading"}
        error={archiveStatus === "error" ? archiveError : null}
        empty={archivedSessions.length === 0}
        onRetry={() => void loadArchivedSessions()}
      >
        {archivedSessions.map((session) => {
          const title = session.title?.trim() || "Untitled session";
          const key = `session:${session.threadId}`;
          return (
            <ArchiveRow
              key={session.threadId}
              icon={<Archive className="size-4" weight="duotone" />}
              title={title}
              metadata={sessionArchiveMetadata(session)}
              restoreLabel={`Restore ${title}`}
              deleteLabel={`Delete ${title} permanently`}
              confirming={confirming === key}
              onRestore={() => void restoreSession(session.threadId)}
              onRequestDelete={() => setConfirming(key)}
              onCancelDelete={() => setConfirming(null)}
              onConfirmDelete={() => {
                setConfirming(null);
                void deleteSession(session.threadId);
              }}
            />
          );
        })}
      </ArchiveCollection>

      <ArchiveCollection
        title="Projects"
        description="Archived projects are hidden from the project browser."
        loading={projects.status === "loading"}
        error={projects.status === "error" ? projects.message : null}
        empty={projects.projects.length === 0}
        onRetry={() => void loadProjects()}
      >
        {projects.projects.map((project) => {
          const key = `project:${project.id}`;
          return (
            <ArchiveRow
              key={project.id}
              icon={<Folder className="size-4" weight="duotone" />}
              title={project.name}
              metadata={archiveDate(project.deletedAt || project.updatedAt)}
              restoreLabel={`Restore ${project.name}`}
              deleteLabel={`Delete ${project.name} permanently`}
              confirming={confirming === key}
              onRestore={() => {
                const previous = projects;
                removeProject(project.id);
                void restoreProject(project.id).catch(() =>
                  setProjects(previous),
                );
              }}
              onRequestDelete={() => setConfirming(key)}
              onCancelDelete={() => setConfirming(null)}
              onConfirmDelete={() => {
                const previous = projects;
                setConfirming(null);
                removeProject(project.id);
                void purgeProject(project.id).catch(() =>
                  setProjects(previous),
                );
              }}
            />
          );
        })}
      </ArchiveCollection>
    </SettingsSectionLayout>
  );
}

function ArchiveCollection({
  title,
  description,
  loading,
  error,
  empty,
  onRetry,
  children,
}: {
  title: string;
  description: string;
  loading: boolean;
  error?: string | null;
  empty: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`archive-${title.toLowerCase()}`}
      className="space-y-3"
    >
      <div>
        <h2
          id={`archive-${title.toLowerCase()}`}
          className="text-sm font-semibold text-foreground"
        >
          {title}
        </h2>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
      {loading ? (
        <ArchiveSkeleton />
      ) : error ? (
        <InlineAlert
          tone="error"
          title={`Could not load archived ${title.toLowerCase()}`}
          message={error}
          action={
            <Button size="sm" onClick={onRetry}>
              Retry
            </Button>
          }
        />
      ) : empty ? (
        <SettingsEmptyState>
          No archived {title.toLowerCase()}. Archived {title.toLowerCase()} will
          appear here.
        </SettingsEmptyState>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {children}
        </ul>
      )}
    </section>
  );
}

function ArchiveRow({
  icon,
  title,
  metadata,
  restoreLabel,
  deleteLabel,
  confirming,
  onRestore,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  icon: ReactNode;
  title: string;
  metadata: string;
  restoreLabel: string;
  deleteLabel: string;
  confirming: boolean;
  onRestore: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  return (
    <li className="py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-foreground">
            {title}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {metadata}
          </div>
        </div>
        {confirming ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" onClick={onCancelDelete}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              aria-label="Confirm permanent delete"
              onClick={onConfirmDelete}
            >
              Delete permanently
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              aria-label={restoreLabel}
              leftIcon={<ArrowCounterClockwise className="size-4" />}
              onClick={onRestore}
            >
              Restore
            </Button>
            <Button
              size="sm"
              aria-label={deleteLabel}
              className="text-destructive hover:text-destructive"
              leftIcon={<Trash className="size-4" />}
              onClick={onRequestDelete}
            >
              Delete
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

function ArchiveSkeleton() {
  return (
    <div role="status" aria-label="Loading archive" className="space-y-2 py-2">
      {[0, 1].map((row) => (
        <div key={row} className="h-12 animate-pulse rounded-lg bg-muted" />
      ))}
    </div>
  );
}

function sessionArchiveMetadata(session: SessionInfo): string {
  const identity =
    session.agentId || (session.type === "runtime" ? "Local" : "Cloud");
  const date = archiveDate(session.archivedAt || session.updatedAt);
  return date ? `${identity} · ${date}` : identity;
}

function archiveDate(value?: string): string {
  if (!value) return "Archived";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Archived";
  return `Archived ${new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date)}`;
}
