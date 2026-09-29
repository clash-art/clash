import { isDesktopRuntime } from "../lib/runtimeConfig";
/* eslint-disable @next/next/no-img-element */

import { motion } from "framer-motion";
import { useState, type PointerEventHandler } from "react";
import { Link } from "react-router";
import { Archive, Plus } from "@phosphor-icons/react";
import { useDraggable } from "@dnd-kit/core";
import type {
  ProjectCanvasPreview,
  ProjectCanvasPreviewNode,
  ProjectCanvasThumbnail,
  ResolvedAsset,
} from "@clash/shared-types";
import { archiveProject } from "@clash/web-ui/lib/clientActions";
import { useConfirm } from "./ConfirmDialog";
import { IconButton } from "./ui/icon-button";
import { Card } from "./ui/card";
import { Tooltip } from "./ui/tooltip";
import { assetPreviewMedia } from "../features/assets/media-url";
import type { DashboardProjectDragData } from "./dashboardComposerDnd";
import type { ProjectReference } from "./dashboardComposerReferences";

export interface ProjectWithAssets {
  id: string;
  name: string;
  createdAt?: Date | string | number;
  updatedAt: Date | string | number | null;
  assets?: ResolvedAsset[];
  canvasPreview?: ProjectCanvasPreview | null;
  canvasThumbnail?: ProjectCanvasThumbnail | null;
}

export interface ProjectCardProps {
  project: ProjectWithAssets;
  composerProjectReferenceId?: string | null;
  onAddProjectReference?: (project: ProjectReference) => void;
  onArchived?: (projectId: string) => void;
}

function isProjectPreviewAsset(asset: ResolvedAsset) {
  return (
    (asset.kind === "image" || asset.kind === "video") &&
    assetPreviewMedia(asset) !== null
  );
}

type PreviewNodeState =
  | "action"
  | "browser"
  | "document"
  | "group"
  | "image-editor"
  | "media"
  | "media-placeholder"
  | "timeline";

function previewNodeState(
  node: ProjectCanvasPreviewNode,
  hasMedia: boolean,
): PreviewNodeState {
  if (node.type === "group") return "group";
  if (node.type === "image" || node.type === "video") {
    return hasMedia ? "media" : "media-placeholder";
  }
  if (node.type.includes("action")) return "action";
  if (node.type.includes("browser")) return "browser";
  if (node.type.includes("image-editor")) return "image-editor";
  if (node.type.includes("video-editor") || node.type.includes("timeline")) {
    return "timeline";
  }
  return "document";
}

function PreviewNodeContent({
  node,
  state,
}: {
  node: ProjectCanvasPreviewNode;
  state: PreviewNodeState;
}) {
  const shortSide = Math.min(node.width, node.height);
  const inset = Math.max(6, shortSide * 0.08);
  const innerWidth = Math.max(0, node.width - inset * 2);
  const innerHeight = Math.max(0, node.height - inset * 2);
  const barHeight = Math.max(3, Math.min(14, node.height * 0.07));
  const lineRadius = Math.min(5, barHeight / 2);
  const markClass = "clash-project-canvas-preview-content-mark";

  if (state === "group" || state === "media") return null;

  if (state === "action") {
    const badgeSize = Math.max(12, node.height * 0.46);
    return (
      <>
        <rect
          className={`${markClass} ${markClass}-badge`}
          x={inset}
          y={(node.height - badgeSize) / 2}
          width={badgeSize}
          height={badgeSize}
          rx={badgeSize * 0.28}
        />
        <rect
          className={`${markClass} ${markClass}-strong`}
          x={inset + badgeSize + inset * 0.7}
          y={node.height * 0.3}
          width={Math.max(8, innerWidth - badgeSize - inset * 0.7)}
          height={barHeight}
          rx={lineRadius}
        />
        <rect
          className={markClass}
          x={inset + badgeSize + inset * 0.7}
          y={node.height * 0.58}
          width={Math.max(8, (innerWidth - badgeSize) * 0.62)}
          height={barHeight * 0.72}
          rx={lineRadius}
        />
      </>
    );
  }

  if (state === "image-editor") {
    return (
      <>
        <rect
          className={`${markClass} ${markClass}-toolbar`}
          x={inset}
          y={inset}
          width={innerWidth}
          height={Math.max(barHeight * 1.4, innerHeight * 0.13)}
          rx={lineRadius}
        />
        <rect
          className={`${markClass} ${markClass}-frame`}
          x={inset * 1.8}
          y={inset + innerHeight * 0.24}
          width={Math.max(0, node.width - inset * 3.6)}
          height={Math.max(0, innerHeight * 0.58)}
          rx={lineRadius}
        />
      </>
    );
  }

  if (state === "timeline") {
    const trackY = inset + innerHeight * 0.58;
    return (
      <>
        <rect
          className={`${markClass} ${markClass}-preview`}
          x={inset}
          y={inset}
          width={innerWidth}
          height={innerHeight * 0.44}
          rx={lineRadius}
        />
        <rect
          className={`${markClass} ${markClass}-strong`}
          x={inset}
          y={trackY}
          width={innerWidth * 0.7}
          height={barHeight}
          rx={lineRadius}
        />
        <rect
          className={markClass}
          x={inset + innerWidth * 0.22}
          y={trackY + barHeight * 1.8}
          width={innerWidth * 0.68}
          height={barHeight}
          rx={lineRadius}
        />
      </>
    );
  }

  if (state === "browser") {
    return (
      <>
        <rect
          className={`${markClass} ${markClass}-toolbar`}
          x={inset}
          y={inset}
          width={innerWidth}
          height={Math.max(barHeight * 1.5, innerHeight * 0.14)}
          rx={lineRadius}
        />
        <rect
          className={`${markClass} ${markClass}-strong`}
          x={inset}
          y={inset + innerHeight * 0.34}
          width={innerWidth * 0.72}
          height={barHeight}
          rx={lineRadius}
        />
        <rect
          className={markClass}
          x={inset}
          y={inset + innerHeight * 0.52}
          width={innerWidth * 0.9}
          height={barHeight}
          rx={lineRadius}
        />
      </>
    );
  }

  if (state === "media-placeholder") {
    return (
      <>
        <rect
          className={`${markClass} ${markClass}-media-frame`}
          x={inset}
          y={inset}
          width={innerWidth}
          height={innerHeight}
          rx={lineRadius}
        />
        <rect
          className={`${markClass} ${markClass}-strong`}
          x={inset * 1.7}
          y={node.height * 0.67}
          width={Math.max(8, innerWidth * 0.68)}
          height={barHeight}
          rx={lineRadius}
        />
        <rect
          className={markClass}
          x={inset * 1.7}
          y={node.height * 0.76}
          width={Math.max(8, innerWidth * 0.42)}
          height={barHeight * 0.74}
          rx={lineRadius}
        />
      </>
    );
  }

  return (
    <>
      <rect
        className={`${markClass} ${markClass}-strong`}
        x={inset}
        y={node.height * 0.4}
        width={innerWidth * 0.78}
        height={barHeight}
        rx={lineRadius}
      />
      <rect
        className={markClass}
        x={inset}
        y={node.height * 0.55}
        width={innerWidth}
        height={barHeight}
        rx={lineRadius}
      />
      <rect
        className={markClass}
        x={inset}
        y={node.height * 0.7}
        width={innerWidth * 0.62}
        height={barHeight}
        rx={lineRadius}
      />
    </>
  );
}

function ProjectCanvasThumbnail({
  projectId,
  preview,
  assets,
}: {
  projectId: string;
  preview: ProjectCanvasPreview;
  assets: ResolvedAsset[];
}) {
  if (!preview.bounds || preview.nodes.length === 0) return null;
  const mediaByAssetId = new Map(
    assets.flatMap((asset) => {
      const media = assetPreviewMedia(asset);
      return media?.kind === "image" ? [[asset.id, media.source] as const] : [];
    }),
  );
  const span = Math.max(preview.bounds.width, preview.bounds.height);
  const padding = Math.max(32, span * 0.08);
  const viewBox = [
    preview.bounds.x - padding,
    preview.bounds.y - padding,
    preview.bounds.width + padding * 2,
    preview.bounds.height + padding * 2,
  ].join(" ");
  const idPrefix = projectId.replace(/[^a-zA-Z0-9_-]/gu, "-");
  const orderedNodes = [...preview.nodes].sort(
    (left, right) =>
      Number(right.type === "group") - Number(left.type === "group"),
  );

  return (
    <svg
      className="clash-project-canvas-preview"
      data-canvas-id={preview.canvasId}
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <defs>
        {orderedNodes.map((node, index) => (
          <clipPath id={`${idPrefix}-canvas-node-${index}`} key={node.id}>
            <rect width={node.width} height={node.height} rx="10" />
          </clipPath>
        ))}
      </defs>
      {orderedNodes.map((node, index) => {
        const mediaSource = node.assetId
          ? mediaByAssetId.get(node.assetId)
          : undefined;
        const state = previewNodeState(node, Boolean(mediaSource));
        const clipPath = `url(#${idPrefix}-canvas-node-${index})`;
        return (
          <g
            key={node.id}
            data-canvas-node-id={node.id}
            data-canvas-node-type={node.type}
            data-canvas-node-preview={state}
            transform={`translate(${node.x} ${node.y})`}
          >
            <rect
              className={`clash-project-canvas-preview-node clash-project-canvas-preview-node-${state}`}
              width={node.width}
              height={node.height}
              rx="10"
              vectorEffect="non-scaling-stroke"
            />
            {mediaSource ? (
              <image
                className="clash-project-card-preview-img"
                href={mediaSource}
                width={node.width}
                height={node.height}
                preserveAspectRatio="xMidYMid slice"
                clipPath={clipPath}
              />
            ) : null}
            {!mediaSource && state !== "group" ? (
              <g clipPath={clipPath}>
                <PreviewNodeContent node={node} state={state} />
                {node.label && state !== "action" ? (
                  <text
                    className="clash-project-canvas-preview-label"
                    x={Math.min(28, node.width * 0.08)}
                    y={Math.min(44, node.height * 0.18)}
                    fontSize={Math.max(14, Math.min(32, node.height * 0.12))}
                  >
                    {node.label}
                  </text>
                ) : null}
              </g>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function ProjectCanvasSnapshot({
  thumbnail,
}: {
  thumbnail: ProjectCanvasThumbnail;
}) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  return (
    <img
      className="clash-project-card-canvas-thumbnail"
      src={thumbnail.url}
      width={thumbnail.width}
      height={thumbnail.height}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      data-state={state}
      onLoad={() => setState("ready")}
      onError={() => setState("failed")}
    />
  );
}

export default function ProjectCard({
  project,
  composerProjectReferenceId = null,
  onAddProjectReference,
  onArchived,
}: ProjectCardProps) {
  const confirm = useConfirm();
  const projectReference: ProjectReference = {
    id: project.id,
    name: project.name || "Untitled",
  };
  const hasProjectReference = composerProjectReferenceId !== null;
  const isCurrentProjectReference =
    composerProjectReferenceId === projectReference.id;
  const canAddProject = Boolean(onAddProjectReference) && !hasProjectReference;
  const canDragProject =
    Boolean(onAddProjectReference) &&
    (!hasProjectReference || isCurrentProjectReference);
  const { listeners, setActivatorNodeRef, setNodeRef, isDragging } =
    useDraggable({
      id: `dashboard-project:${projectReference.id}`,
      data: {
        type: "dashboard-project-reference",
        reference: projectReference,
      } satisfies DashboardProjectDragData,
      disabled: !canDragProject,
    });
  const handleProjectPointerDown:
    PointerEventHandler<HTMLDivElement> | undefined = canDragProject
    ? (event) => {
        listeners?.onPointerDown?.(event);
      }
    : undefined;

  // Format Date
  const date = new Date(project.updatedAt || project.createdAt || new Date());
  const formattedDate = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);

  const allAssets = project.assets || [];
  const previewAssets = allAssets
    .filter(
      (asset) =>
        asset.lifecycle.state === "active" && isProjectPreviewAsset(asset),
    )
    .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    .slice(0, 4);
  const canvasPreview = project.canvasPreview;
  const canvasThumbnail = project.canvasThumbnail;
  const hasCanvasPreview = Boolean(
    canvasPreview?.bounds && canvasPreview.nodes.length > 0,
  );

  return (
    <article
      ref={setNodeRef}
      className="group/project-card relative"
      data-project-reference-dragging={isDragging || undefined}
    >
      <Link
        to={`/projects/${project.id}`}
        target={isDesktopRuntime() ? undefined : "_blank"}
        rel={isDesktopRuntime() ? undefined : "noopener noreferrer"}
        className="block"
      >
        <Card
          asChild
          interaction="border"
          slot="project-card-preview"
          className="relative mb-3 aspect-video overflow-hidden"
        >
          <motion.div
            ref={setActivatorNodeRef}
            className="clash-project-card-frame"
            whileTap={{ scale: 0.98 }}
            onPointerDown={handleProjectPointerDown}
          >
            {hasCanvasPreview && canvasPreview ? (
              <>
                <ProjectCanvasThumbnail
                  projectId={project.id}
                  preview={canvasPreview}
                  assets={canvasThumbnail ? [] : previewAssets}
                />
                {canvasThumbnail ? (
                  <ProjectCanvasSnapshot
                    key={canvasThumbnail.url}
                    thumbnail={canvasThumbnail}
                  />
                ) : null}
              </>
            ) : (
              <div className="clash-project-card-empty" aria-hidden="true">
                <span
                  data-slot="project-empty-copy"
                  className="clash-project-card-empty-copy"
                >
                  Nothing to see. Yet.
                </span>
              </div>
            )}
          </motion.div>
        </Card>

        {/* Text Content Below Card */}
        <div className="px-1">
          <h3 className="truncate text-sm font-medium text-content-primary transition-colors group-hover:text-brand">
            {project.name || "Untitled"}
          </h3>
          <p className="mt-1 text-xs text-content-muted">{formattedDate}</p>
        </div>
      </Link>

      {onAddProjectReference ? (
        <div className="pointer-events-none absolute left-3 top-3 z-10 opacity-0 transition-opacity group-hover/project-card:pointer-events-auto group-hover/project-card:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
          <Tooltip
            label={
              canAddProject
                ? `Add ${projectReference.name} to composer`
                : isCurrentProjectReference
                  ? `${projectReference.name} is already in the composer`
                  : "Remove the current project reference first"
            }
          >
            <IconButton
              label={`Add project ${projectReference.name} to composer`}
              icon={<Plus className="h-4 w-4" weight="bold" />}
              size="sm"
              disabled={!canAddProject}
              className="clash-project-card-action focus-visible:ring-offset-warm-page"
              onClick={() => onAddProjectReference(projectReference)}
            />
          </Tooltip>
        </div>
      ) : null}

      {/* Archive action (hover) */}
      <div className="pointer-events-none absolute right-3 top-3 z-10 opacity-0 transition-opacity group-hover/project-card:pointer-events-auto group-hover/project-card:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
        <IconButton
          label={`Archive project ${project.name || "Untitled"}`}
          icon={<Archive className="h-4 w-4" weight="bold" />}
          size="sm"
          className="clash-project-card-action focus-visible:ring-offset-warm-page"
          onClick={async () => {
            const ok = await confirm({
              title: "Archive project?",
              message: `${project.name || "Untitled"} will be hidden from the project browser. You can restore it from Settings → Archive.`,
              confirmText: "Archive",
            });

            if (ok) {
              await archiveProject(project.id);
              onArchived?.(project.id);
            }
          }}
        />
      </div>
    </article>
  );
}
