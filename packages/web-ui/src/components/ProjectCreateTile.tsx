import { type FormEvent, useId, useRef, useState } from "react";
import { Plus } from "@phosphor-icons/react";

import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { InlineAlert } from "./ui/feedback";
import { Input } from "./ui/input";

interface ProjectCreateTileProps {
  ariaLabel: string;
  empty?: boolean;
  presentation?: "tile" | "header-action";
  onCreate: (projectName: string) => void | Promise<void>;
}

export default function ProjectCreateTile({
  ariaLabel,
  empty = false,
  presentation = "tile",
  onCreate,
}: ProjectCreateTileProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClose = () => {
    if (pending) return;
    setOpen(false);
    setName("");
    setError(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const projectName = name.trim();

    if (!projectName) {
      inputRef.current?.focus();
      return;
    }

    setPending(true);

    try {
      await onCreate(projectName);
      setOpen(false);
      setName("");
      setPending(false);
    } catch {
      setError("Could not create this project. Try again.");
      setPending(false);
    }
  };

  return (
    <>
      {presentation === "header-action" ? (
        <Button
          aria-label={ariaLabel}
          size="sm"
          shape="rounded"
          className="h-7 gap-1 rounded-md px-2 text-xs shadow-none focus-visible:ring-offset-warm-page"
          leftIcon={<Plus className="h-3.5 w-3.5" weight="regular" />}
          onClick={() => setOpen(true)}
        >
          Create project
        </Button>
      ) : (
        <Button
          aria-label={ariaLabel}
          className={`${empty ? "clash-project-create-tile--empty " : ""}clash-project-create-tile group flex aspect-video min-h-0 flex-col items-center justify-center gap-3 rounded-xl p-0 focus-visible:ring-offset-warm-page`}
          onClick={() => setOpen(true)}
        >
          <Plus
            className="h-9 w-9 text-content-muted transition-[color,transform] duration-[var(--motion-feedback-duration)] ease-[var(--motion-feedback-ease)] group-hover:scale-105 group-hover:text-brand motion-reduce:transform-none"
            weight="regular"
            aria-hidden="true"
          />
          <span className="text-sm font-medium text-content-secondary transition-colors group-hover:text-content-primary">
            New Project
          </span>
        </Button>
      )}

      <Dialog
        open={open}
        onClose={handleClose}
        title="Create project"
        description="Choose a name for the new project."
        size="sm"
        disableBackdropClose={pending}
      >
        <form
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
        >
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-content-secondary"
          >
            Project name
          </label>
          <Input
            ref={inputRef}
            id={inputId}
            autoFocus
            maxLength={120}
            value={name}
            aria-invalid={Boolean(error)}
            controlSize="lg"
            className="mt-2 w-full"
            onChange={(event) => setName(event.target.value)}
            placeholder="Untitled project"
          />
          {error ? (
            <InlineAlert tone="error" title={error} className="mt-2" />
          ) : null}

          <div className="mt-6 flex items-center justify-end gap-2">
            <Button disabled={pending} onClick={handleClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              className="min-w-28 rounded-md px-4 shadow-none"
              disabled={!name.trim() || pending}
            >
              {pending ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
