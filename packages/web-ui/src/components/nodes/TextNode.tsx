import {
  memo,
  useCallback,
} from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { Spinner } from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import { useOptionalLoroSyncContext } from "../LoroSyncContext";
import DraftPlaceholder from "./DraftPlaceholder";
import SourceHandleMenu from "./SourceHandleMenu";
import { normalizeStatus } from "@clash/web-ui/lib/assetStatus";
import { useRevisionHistory } from "@clash/web-ui/hooks/useRevisionHistory";
import { RevisionHistoryBadge } from "./RevisionHistoryBadge";
import { useOptionalTextNodeEditorContext } from "../TextNodeEditorContext";
import { TextDocumentNode } from "./TextDocumentNode";

const TextNode = ({
  data,
  selected,
  id,
}: NodeProps<Node<Record<string, any>>>) => {
  const label = data.label || "Text Node";
  const content = data.content ?? "# Hello World\nDouble click to edit.";
  const loroSync = useOptionalLoroSyncContext();
  const editorController = useOptionalTextNodeEditorContext();
  const revisionHistory = useRevisionHistory({
    projectId: loroSync?.projectId ?? null,
    nodeId: id,
    limit: 5,
  });

  const handleDoubleClick = useCallback(() => {
    editorController?.openEditor(id);
  }, [editorController, id]);

  const normalizedStatus = data.status
    ? normalizeStatus(data.status as string | undefined)
    : null;

  return (
      <div
        data-testid="text-node-drag-surface"
        className="group relative h-[400px] w-[300px] cursor-grab active:cursor-grabbing"
        onDoubleClick={handleDoubleClick}
      >
        <div
          className="pointer-events-none absolute -top-8 left-4 z-10 max-w-[272px] truncate font-display text-lg font-bold text-slate-700 dark:text-slate-300"
        >
          {label || "Text Node"}
        </div>

        {/* Main Card */}
        <div
          className={`w-full h-full bg-warm-muted rounded-matrix flex flex-col overflow-hidden transition-all duration-300 hover:shadow-lg ${
            selected
              ? "ring-4 ring-brand ring-offset-2"
              : "ring-1 ring-warm-border"
          }`}
        >
          <RevisionHistoryBadge
            nodeId={id}
            history={revisionHistory}
            className="absolute right-3 top-3 z-20"
          />
          {normalizedStatus === "draft" ? (
            <DraftPlaceholder nodeId={id} modality="text" />
          ) : normalizedStatus === "generating" ? (
            <div className="flex-1 p-8 flex items-center justify-center text-slate-700 dark:text-slate-300">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Spinner size={18} className="animate-spin" />
                Generating text...
              </div>
            </div>
          ) : (
            <div
              data-testid="text-node-preview"
              className="pointer-events-none relative flex flex-1 select-none flex-col p-8"
            >
              {/* Content Preview with Fade Out */}
              <div className="flex-1 relative overflow-hidden">
                <div
                  className="absolute inset-0"
                  style={{
                    maskImage:
                      "linear-gradient(to bottom, black 60%, transparent 100%)",
                  }}
                >
                  <div className="prose prose-slate prose-headings:text-content-primary prose-p:text-content-secondary">
                    <MarkdownPreview content={content} />
                  </div>
                </div>

                {/* Fade out gradient overlay */}
                <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-warm-muted to-transparent pointer-events-none" />
              </div>
            </div>
          )}
        </div>

        {/* Handle — consistent with ImageNode/other nodes */}
        <Handle
          type="target"
          position={Position.Left}
          style={{
            left: -8,
            top: "50%",
            transform: "translateY(-50%)",
            zIndex: 100,
          }}
          className="!h-4 !w-4 !border-4 !border-warm-surface !bg-stone-400 transition-all hover:scale-125 shadow-sm hover:!bg-brand"
        />
        <SourceHandleMenu nodeId={id} sourceType="text" />
      </div>
  );
};

// Simple markdown preview component
const MarkdownPreview = ({ content }: { content: string }) => {
  return (
    <div className="prose prose-lg max-w-none prose-slate prose-headings:font-bold prose-headings:text-content-primary prose-p:text-content-secondary prose-a:text-content-primary prose-a:underline prose-code:rounded prose-code:bg-warm-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:text-content-secondary">
      <ReactMarkdown>{content}</ReactMarkdown>
    </div>
  );
};

export default memo((props: NodeProps<Node<Record<string, any>>>) => props.data.documentRevision !== undefined
  ? <TextDocumentNode {...props} />
  : <TextNode {...props} />);
