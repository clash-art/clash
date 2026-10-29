import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { MgOpenSurface, type MgOpenSession } from "./MgOpenSurface";

export type { MgOpenSession };

export type MgPreviewRequest = {
  nodeId: string;
  nonce: number;
};

type MgPreviewContextValue = {
  session: MgOpenSession | null;
  /** Assets (or peers) request open by nodeId; matching node opens full session. */
  previewNodeId: string | null;
  previewNonce: number;
  openMgPreview: (session: MgOpenSession) => void;
  closeMgPreview: () => void;
  clearMgPreviewRequest: () => void;
};

const MgPreviewContext = createContext<MgPreviewContextValue | null>(null);

/**
 * Dedicated MG open session — Hilo-homage full-bleed stage + inspector.
 * Preview-only; does not pull mg-edit-session-convergence or audio-master-clock.
 *
 * Parent may pass `externalRequest` (e.g. Assets sidebar select) so ProjectEditor
 * can open the same surface without lifting node payloads; the matching Canvas
 * node supplies the session via `useMgPreviewOpenRequest`.
 */
export function MgPreviewProvider({
  children,
  externalRequest = null,
  onExternalRequestConsumed,
}: {
  children: ReactNode;
  externalRequest?: MgPreviewRequest | null;
  onExternalRequestConsumed?: () => void;
}) {
  const [session, setSession] = useState<MgOpenSession | null>(null);
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const lastExternalNonceRef = useRef(0);

  const openMgPreview = useCallback((next: MgOpenSession) => {
    setSession(next);
    setPreviewNodeId(null);
  }, []);

  const closeMgPreview = useCallback(() => {
    setSession(null);
  }, []);

  const clearMgPreviewRequest = useCallback(() => {
    setPreviewNodeId(null);
  }, []);

  useEffect(() => {
    if (!externalRequest) return;
    if (externalRequest.nonce === lastExternalNonceRef.current) return;
    lastExternalNonceRef.current = externalRequest.nonce;
    setPreviewNodeId(externalRequest.nodeId);
    setPreviewNonce(externalRequest.nonce);
    onExternalRequestConsumed?.();
  }, [externalRequest, onExternalRequestConsumed]);

  const value = useMemo(
    () => ({
      session,
      previewNodeId,
      previewNonce,
      openMgPreview,
      closeMgPreview,
      clearMgPreviewRequest,
    }),
    [
      clearMgPreviewRequest,
      closeMgPreview,
      openMgPreview,
      previewNodeId,
      previewNonce,
      session,
    ],
  );

  return (
    <MgPreviewContext.Provider value={value}>
      {children}
      {session ? (
        <MgOpenSurface session={session} onClose={closeMgPreview} />
      ) : null}
    </MgPreviewContext.Provider>
  );
}

export function useOptionalMgPreview() {
  return useContext(MgPreviewContext);
}

/** Open the shared MG surface when Assets (or peers) request this nodeId. */
export function useMgPreviewOpenRequest(
  nodeId: string,
  onOpen: () => void,
): void {
  const ctx = useOptionalMgPreview();
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const lastNonceRef = useRef(0);

  useEffect(() => {
    if (!ctx || ctx.previewNodeId !== nodeId) return;
    if (ctx.previewNonce === lastNonceRef.current) return;
    lastNonceRef.current = ctx.previewNonce;
    onOpenRef.current();
    ctx.clearMgPreviewRequest();
  }, [
    ctx,
    nodeId,
    ctx?.previewNodeId,
    ctx?.previewNonce,
    ctx?.clearMgPreviewRequest,
  ]);
}
