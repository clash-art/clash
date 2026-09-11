import { useState } from "react";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import type { SyncRecoveryDraft } from "../lib/syncRecovery";
import type { ProjectLoadErrorMessage } from "@clash/shared-types";

export function SyncRecoveryDialog({ rejected, backup, loadError, onRetryLoad, onRecover, onReload = () => window.location.reload() }: {
  rejected: boolean;
  loadError?: ProjectLoadErrorMessage;
  onRetryLoad?: () => void;
  backup?: SyncRecoveryDraft;
  onRecover: () => Promise<void>;
  onReload?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dismissedBackup, setDismissedBackup] = useState<string>();
  const open = rejected || Boolean(backup && backup.id !== dismissedBackup);
  const download = () => {
    if (!backup) return;
    const bytes = new Uint8Array(backup.snapshot);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `clash-recovery-${backup.projectId}-${backup.id}.loro`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const recover = async () => {
    setBusy(true);
    setError(undefined);
    try { await onRecover(); onReload(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setBusy(false); }
  };
  if (loadError) return <Dialog open title="Project could not open"
    description="Opening stopped before the project could sync. Resolve the problem below, then retry. Your local draft is preserved."
    hideCloseButton disableBackdropClose onClose={() => {}}>
    <div className="flex flex-col gap-4 p-5">
      <p role="alert" className="whitespace-pre-wrap break-words text-sm text-red-600">{loadError.message}</p>
      {onRetryLoad && <div className="flex justify-end"><Button variant="primary" onClick={onRetryLoad}>Retry opening project</Button></div>}
    </div>
  </Dialog>;
  return <Dialog open={open} title={rejected ? "Local changes were not saved" : "Local recovery copy available"}
    description={rejected
      ? "Sync is paused. Save a local recovery copy, then reload the project's accepted state. Your local edits will remain in the recovery copy for comparison and manual reapplication."
      : "The previous local draft is preserved on this device. Download it before clearing browser storage. It is not automatically applied to the project."}
    hideCloseButton={rejected} disableBackdropClose={rejected}
    onClose={() => { if (!rejected && backup) setDismissedBackup(backup.id); }}>
    <div className="flex flex-col gap-4 p-5">
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {backup && <Button onClick={download}>{rejected ? "Download previous recovery copy" : "Download local copy"}</Button>}
        {rejected
          ? <Button variant="primary" disabled={busy} onClick={() => void recover()}>{busy ? "Saving recovery copy…" : "Save local copy and reload"}</Button>
          : <Button onClick={() => setDismissedBackup(backup?.id)}>Continue</Button>}
      </div>
    </div>
  </Dialog>;
}
