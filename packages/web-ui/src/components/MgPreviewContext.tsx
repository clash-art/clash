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

export type MgPreviewRequest = {
  nodeId: string;
  nonce: number;
};

type MgPreviewContextValue = {
  previewNodeId: string | null;
  previewNonce: number;
  openMgPreview: (nodeId: string) => void;
  clearMgPreviewRequest: () => void;
};

const MgPreviewContext = createContext<MgPreviewContextValue | null>(null);

/**
 * Lightweight preview-session bus for Remotion/HTML Motion nodes.
 * Mirrors Hilo's "open into a dedicated MG surface" product feel without
 * pulling mg-edit-session-convergence or audio-master-clock into this phase.
 *
 * Parent may pass `externalRequest` (e.g. Assets sidebar select) so ProjectEditor
 * can open the same node-local fullscreen preview without lifting the modal.
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
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const lastExternalNonceRef = useRef(0);

  const openMgPreview = useCallback((nodeId: string) => {
    setPreviewNodeId(nodeId);
    setPreviewNonce((value) => value + 1);
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
      previewNodeId,
      previewNonce,
      openMgPreview,
      clearMgPreviewRequest,
    }),
    [clearMgPreviewRequest, openMgPreview, previewNodeId, previewNonce],
  );

  return (
    <MgPreviewContext.Provider value={value}>{children}</MgPreviewContext.Provider>
  );
}

export function useOptionalMgPreview() {
  return useContext(MgPreviewContext);
}

/** Open the node-local fullscreen preview when Assets (or peers) request it. */
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
