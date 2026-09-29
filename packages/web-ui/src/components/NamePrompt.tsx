import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";

/** Application-owned naming dialog; Electron does not implement window.prompt. */
export function useNamePrompt() {
  const inputId = useId();
  const [request, setRequest] = useState<{ title: string } | null>(null);
  const [name, setName] = useState("");
  const resolver = useRef<((value: string | null) => void) | null>(null);
  const finish = useCallback((value: string | null) => {
    resolver.current?.(value);
    resolver.current = null;
    setRequest(null);
  }, []);
  useEffect(
    () => () => {
      resolver.current?.(null);
      resolver.current = null;
    },
    [],
  );
  const requestName = useCallback((title: string, initialName = "") => {
    resolver.current?.(null);
    setName(initialName);
    setRequest({ title });
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);
  const namePrompt = (
    <Dialog
      open={request !== null}
      onClose={() => finish(null)}
      title={request?.title ?? "Name"}
      description="Choose a name to continue."
      size="sm"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) finish(name.trim());
        }}
      >
        <label
          htmlFor={inputId}
          className="block text-sm font-medium text-content-secondary"
        >
          {request?.title ?? "Name"}
        </label>
        <Input
          id={inputId}
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="mt-2 w-full"
        />
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={() => finish(null)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Continue
          </Button>
        </div>
      </form>
    </Dialog>
  );
  return { requestName, namePrompt };
}
