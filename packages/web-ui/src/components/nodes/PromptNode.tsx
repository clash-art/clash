import { memo, useState, useCallback, useEffect } from "react";
import { Handle, Position, NodeProps, Node, useReactFlow } from "@xyflow/react";
import { X } from "@phosphor-icons/react";
import MilkdownEditor from "../MilkdownEditor";
import { useLoroSyncContext } from "../LoroSyncContext";
import { NodeModalDialog } from "./NodeModalDialog";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Input } from "../ui/input";

const PromptNode = ({
  data,
  selected,
  id,
}: NodeProps<Node<Record<string, any>>>) => {
  const [showModal, setShowModal] = useState(false);
  const [label, setLabel] = useState(data.label || "Prompt");
  const [content, setContent] = useState(
    data.content || "# Prompt\nEnter your prompt here...",
  );
  const { setNodes } = useReactFlow();
  // Access Loro sync context
  const { updateNode } = useLoroSyncContext();

  // Sync when data changes
  useEffect(() => {
    setLabel((prev: string) =>
      data.label && data.label !== prev ? data.label : prev,
    );

    setContent((prev: string) =>
      data.content && data.content !== prev ? data.content : prev,
    );
  }, [data.label, data.content]);

  const handleDoubleClick = useCallback(() => {
    setShowModal(true);
  }, []);

  const handleSave = useCallback(() => {
    setShowModal(false);
    // Update the node data locally
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === id) {
          return {
            ...node,
            data: {
              ...node.data,
              label,
              content,
            },
          };
        }
        return node;
      }),
    );

    // Sync to Loro
    updateNode(id, {
      data: {
        label,
        content,
      },
    });
  }, [id, label, content, setNodes, updateNode]);

  const handleCancel = useCallback(() => {
    setShowModal(false);
    // Reset to original values
    setLabel(data.label || "Prompt");
    setContent(data.content || "# Prompt\nEnter your prompt here...");
  }, [data.label, data.content]);

  const handleLabelChange = (evt: React.ChangeEvent<HTMLInputElement>) => {
    const newLabel = evt.target.value;
    setLabel(newLabel);
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === id) {
          return {
            ...node,
            data: {
              ...node.data,
              label: newLabel,
            },
          };
        }
        return node;
      }),
    );
  };

  const modalContent = (
    <NodeModalDialog
      open={showModal}
      onClose={handleCancel}
      ariaLabel={`Edit ${label || "prompt"}`}
    >
      {/* Header with Title Input */}
      <div className="px-12 pt-8 pb-2 flex justify-between items-start">
        <Input
          type="text"
          value={label}
          onChange={handleLabelChange}
          placeholder="Untitled Prompt"
          className="w-full text-4xl font-bold text-slate-900 dark:text-slate-50 placeholder:text-stone-300 bg-transparent border-none outline-none focus:outline-none"
          style={{
            fontFamily:
              "var(--font-space-grotesk), var(--font-inter), sans-serif",
            letterSpacing: "-0.02em",
          }}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={handleSave}
            className="clash-node-primary rounded-lg px-4 py-2 text-sm"
          >
            Save
          </Button>
          <IconButton
            label="Cancel edit"
            onClick={handleCancel}
            className="rounded-lg text-slate-700 hover:bg-warm-hover hover:text-slate-950 dark:text-slate-300"
            icon={<X className="w-5 h-5" weight="bold" />}
          />
        </div>
      </div>

      {/* Editor Content */}
      <div className="flex-1 overflow-y-auto bg-warm-surface">
        <MilkdownEditor value={content} onChange={setContent} />
      </div>
    </NodeModalDialog>
  );

  return (
    <>
      <div
        className="group relative w-[300px] h-[150px]"
        onDoubleClick={handleDoubleClick}
      >
        {/* Floating Title Input */}
        <div
          className="absolute -top-8 left-4 z-10"
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Input
            className="bg-transparent text-lg font-bold font-display text-slate-700 dark:text-slate-300 focus:text-slate-950 focus:outline-none"
            value={label}
            onChange={handleLabelChange}
            placeholder="Prompt"
          />
        </div>

        {/* Main Card - Smaller height and different styling */}
        <div
          className={`w-full h-full bg-warm-muted rounded-matrix flex flex-col overflow-hidden transition-all duration-300 hover:shadow-lg ${
            selected
              ? "ring-4 ring-brand ring-offset-2"
              : "ring-1 ring-warm-border"
          }`}
        >
          {/* Card Content */}
          <div className="flex-1 p-6 flex flex-col relative">
            {/* Content Preview with Fade Out */}
            <div className="flex-1 relative overflow-hidden">
              <div className="absolute inset-0">
                <div className="prose prose-sm prose-slate prose-headings:text-content-primary prose-p:leading-tight prose-p:text-content-secondary">
                  <MarkdownPreview content={content} />
                </div>
              </div>

              {/* Fade out gradient overlay */}
              <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-warm-muted to-transparent pointer-events-none" />
            </div>
          </div>
        </div>

        {/* Prompt nodes have output handle (source) to connect to action badges */}
        <Handle
          type="source"
          position={Position.Right}
          className="!h-4 !w-4 !translate-x-2 !border-4 !border-warm-surface !bg-brand transition-all hover:scale-125 shadow-sm"
        />
      </div>

      {modalContent}
    </>
  );
};

// Simple markdown preview component
const MarkdownPreview = ({ content }: { content: string }) => {
  return (
    <div
      className="prose prose-sm max-w-none prose-slate prose-headings:font-bold prose-headings:text-content-primary prose-p:text-content-secondary prose-a:text-brand prose-code:rounded prose-code:bg-brand-light prose-code:px-1.5 prose-code:py-0.5 prose-code:text-brand"
      dangerouslySetInnerHTML={{
        __html: content
          .replace(/^### (.*$)/gim, "<h3>$1</h3>")
          .replace(/^## (.*$)/gim, "<h2>$1</h2>")
          .replace(/^# (.*$)/gim, "<h1>$1</h1>")
          .replace(/\*\*(.*)\*\*/gim, "<strong>$1</strong>")
          .replace(/\*(.*)\*/gim, "<em>$1</em>")
          .replace(/\n/gim, "<br />"),
      }}
    />
  );
};

export default memo(PromptNode);
