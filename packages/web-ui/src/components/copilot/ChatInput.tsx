import { projectAssetMention } from "./projectAssetReferences";
import {
  forwardRef,
  useState,
  useRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  type ForwardedRef,
  type ReactNode,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowUp,
  Plus,
  Microphone,
  CircleNotch,
  X,
} from "@phosphor-icons/react";
import { lazy } from "react";
import { useTranslation } from "react-i18next";
import { useDropzone, type Accept } from "react-dropzone";
import { importProjectAssetFile } from "@clash/web-ui/lib/hooks/useAsset";
import { runtimeApiUrl } from "@clash/web-ui/lib/runtimeConfig";
import { Button } from "../ui/button";
import { ControlContextProvider } from "../ui/control-context";
import { IconButton } from "../ui/icon-button";
import { Input } from "../ui/input";
import { InlineAlert } from "../ui/feedback";
import {
  SpeechInputRecording,
  type SpeechInputCompletionIntent,
} from "../ai-elements/speech-input";
import type {
  AgentAnnotationDraft,
  CopilotProjectAssetReference,
} from "@clash/shared-types";
import type { MilkdownEditorHandle, MentionableNode } from "../MilkdownEditor";
import { AgentAnnotationTray } from "./AgentAnnotationBlock";
import {
  normalizeCopilotAssetComposerValue,
  projectAssetComposerMarker,
} from "./projectAssetReferences";
import {
  VoiceInputSetupPopover,
  type VoiceInputNotice,
} from "./VoiceInputSetupPopover";

// Lazy load MilkdownEditor to avoid SSR issues
const MilkdownEditor = lazy(() => import("../MilkdownEditor"));

// ─── Types ───────────────────────────────────────────────────

/** @deprecated Use the storage-neutral shared Project Asset reference type. */
export type UploadedAttachment = CopilotProjectAssetReference;

interface ChatInputProps {
  input: string;
  onInputChange: (value: string) => void;
  /** Called with markdown text + extracted asset keys on send */
  onSubmit: (
    text: string,
    attachments: UploadedAttachment[],
    annotations: AgentAnnotationDraft[],
  ) => void;
  onStop?: () => void;
  isProcessing?: boolean;
  isCreatingSession?: boolean;
  connected?: boolean;
  error?: string | null;
  onDismissError?: () => void;
  disabled?: boolean;
  /** Runtime mode can accept follow-up prompts while the current agent loop is still running. */
  allowSubmitWhileProcessing?: boolean;
  placeholder?: string;
  variant?: "default" | "hero";
  /** Presentational shell state; content can promote either shell to growing. */
  visualState?: "compact" | "expanded";
  mentionableNodes?: MentionableNode[];
  connectedNodeIds?: string[];
  onMentionAdded?: (nodeId: string) => void;
  /** Attachments are available only with an owning Project Asset scope. */
  projectId?: string;
  /** Lazily creates or resolves that owning Project scope before file import. */
  ensureProjectId?: () => Promise<string | null>;
  /** Opens a shared Asset library picker instead of the native file chooser. */
  onOpenAssetPicker?: () => void;
  /** Optional controls rendered inside the composer's bottom toolbar, next to attach. */
  toolbarAccessory?: ReactNode;
  /** Optional controls rendered on the right side before voice/send. */
  rightToolbarAccessory?: ReactNode;
  /** Structured references rendered inside the composer, above its editor. */
  referenceAccessory?: ReactNode;
  onCaretTargetChange?: (target: { x: number; y: number } | null) => void;
  /** Structured review context attached from Canvas, Timeline, or Director Stage. */
  annotationBlocks?: AgentAnnotationDraft[];
  onAnnotationRemove?: (annotationId: string) => void;
}

export interface ChatInputHandle {
  focus: () => void;
  insertAssetReference?: (reference: MentionableNode) => void;
}

interface LocalAudioConfig {
  asr: {
    enabled: boolean;
    ready: boolean;
    provider: string;
    base_url: string | null;
    model: string;
    setup?: {
      provider: string;
      runtime?: "builtin-rpc" | "provider-route";
      status: "disabled" | "needs-install" | "ready";
    };
  };
}

interface VoiceConfigCacheEntry {
  promise: Promise<LocalAudioConfig>;
  expiresAt: number;
  value?: LocalAudioConfig;
}

const voiceConfigCacheByFetch = new WeakMap<
  typeof fetch,
  Map<string, VoiceConfigCacheEntry>
>();
const VOICE_CONFIG_READY_CACHE_TTL_MS = 30_000;
const VOICE_CONFIG_UNAVAILABLE_CACHE_TTL_MS = 1_000;

function voiceConfigNotice(config?: LocalAudioConfig): VoiceInputNotice {
  if (!config || !config.asr.enabled) {
    return {
      message: "Enable voice input in Voice input settings first.",
      action: { label: "Open Voice input", href: "/settings?section=audio" },
    };
  }
  return {
    message: "Deploy the selected ASR model in Models first.",
    action: { label: "Open Models", href: "/settings?section=models" },
  };
}

function voiceTranscriptionNotice(error: unknown): VoiceInputNotice {
  const message = error instanceof Error ? error.message : String(error);
  if (/Local ASR is not enabled/i.test(message)) return voiceConfigNotice();
  if (/Selected ASR model is not deployed/i.test(message))
    return voiceConfigNotice({
      asr: {
        enabled: true,
        ready: false,
        provider: "builtin-funasr",
        base_url: null,
        model: "",
      },
    });
  return { message };
}

async function loadLocalAudioConfig(): Promise<LocalAudioConfig> {
  const fetchImpl = globalThis.fetch;
  const url = runtimeApiUrl("/api/v1/local/audio/voice-input");
  let cache = voiceConfigCacheByFetch.get(fetchImpl);
  if (!cache) {
    cache = new Map();
    voiceConfigCacheByFetch.set(fetchImpl, cache);
  }

  const cached = cache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const request = fetchImpl(url, { credentials: "include" }).then(
    async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as LocalAudioConfig;
    },
  );
  const entry: VoiceConfigCacheEntry = {
    promise: request,
    expiresAt: Number.POSITIVE_INFINITY,
  };
  cache.set(url, entry);
  void request.then(
    (config) => {
      if (cache?.get(url) === entry) {
        entry.value = config;
        entry.expiresAt =
          Date.now() +
          (config.asr.enabled && config.asr.ready
            ? VOICE_CONFIG_READY_CACHE_TTL_MS
            : VOICE_CONFIG_UNAVAILABLE_CACHE_TTL_MS);
      }
    },
    () => {
      if (cache?.get(url) === entry) cache.delete(url);
    },
  );
  return request;
}

function peekLocalAudioConfig(): LocalAudioConfig | undefined {
  const fetchImpl = globalThis.fetch;
  const url = runtimeApiUrl("/api/v1/local/audio/voice-input");
  const cached = voiceConfigCacheByFetch.get(fetchImpl)?.get(url);
  if (!cached || cached.expiresAt <= Date.now()) return undefined;
  return cached.value;
}

async function transcribeLocalAudio(blob: Blob): Promise<string> {
  const type = blob.type || "audio/webm";
  const form = new FormData();
  form.append("file", new File([blob], `voice-${Date.now()}.webm`, { type }));
  const res = await fetch(runtimeApiUrl("/api/v1/local/audio/transcriptions"), {
    method: "POST",
    credentials: "include",
    body: form,
  });
  const json = (await res.json().catch(() => null)) as {
    text?: string;
    error?: string;
  } | null;
  if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
  if (!json?.text) throw new Error("Local ASR returned no transcript");
  return json.text;
}

async function warmupLocalVoiceInput(): Promise<void> {
  const res = await fetch(
    runtimeApiUrl("/api/v1/local/audio/voice-input/warmup"),
    {
      method: "POST",
      credentials: "include",
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ─── Helpers ─────────────────────────────────────────────────

function classifyFile(
  file: File,
): CopilotProjectAssetReference["kind"] | undefined {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return undefined;
}

const DROPZONE_ACCEPT = {
  "image/*": [],
  "video/*": [],
  "audio/*": [],
} satisfies Accept;

// ─── Component ───────────────────────────────────────────────

function ComposerInlineContent({
  isHero,
  children,
}: {
  isHero: boolean;
  children: ReactNode;
}) {
  if (isHero) return <>{children}</>;
  return (
    <div
      data-slot="composer-inline-content"
      className="flex min-h-[var(--composer-body-min-height)] w-full flex-col items-start gap-1.5 px-1"
    >
      {children}
    </div>
  );
}

function ChatInputInner(
  {
    input,
    onInputChange,
    onSubmit,
    onStop,
    isProcessing = false,
    isCreatingSession = false,
    error,
    onDismissError,
    disabled = false,
    allowSubmitWhileProcessing = false,
    placeholder,
    variant = "default",
    visualState = "expanded",
    mentionableNodes,
    connectedNodeIds,
    onMentionAdded,
    projectId,
    ensureProjectId,
    onOpenAssetPicker,
    toolbarAccessory,
    rightToolbarAccessory,
    referenceAccessory,
    onCaretTargetChange,
    annotationBlocks = [],
    onAnnotationRemove,
  }: ChatInputProps,
  ref: ForwardedRef<ChatInputHandle>,
) {
  const { t } = useTranslation();
  const resolvedPlaceholder =
    placeholder ??
    t("copilot.chatInput.placeholderDefault", {
      defaultValue: "Ask anything…",
    });
  const editorRef = useRef<MilkdownEditorHandle>(null);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const [uploading, setUploading] = useState(0);

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        editorRef.current?.focus();
      },
      insertAssetReference(reference) {
        editorRef.current?.insertAtCursor(
          `${projectAssetMention(reference.label, reference.id)} `,
        );
      },
    }),
    [],
  );

  // ─── File upload → insert into editor on complete ──────────
  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const owningProjectId = projectId ?? (await ensureProjectId?.());
      if (!owningProjectId) return;
      Array.from(files).forEach(async (file) => {
        const type = classifyFile(file);
        if (!type) return;
        const name = file.name;

        setUploading((n) => n + 1);
        try {
          let md: string;
          const asset = await importProjectAssetFile(owningProjectId, file, {
            kind: type,
          });
          if (!asset.url)
            throw new Error("Imported Project Asset is not locally available");
          const marker = projectAssetComposerMarker(asset.id);
          if (type === "image") md = `![${name}](${asset.url} "${marker}")`;
          else if (type === "video")
            md = `[🎬 ${name}](${asset.url} "${marker}")`;
          else md = `[🔊 ${name}](${asset.url} "${marker}")`;
          editorRef.current?.insertAtCursor(md + " ");
        } catch (err) {
          console.error("[ChatInput] upload failed:", err);
          editorRef.current?.insertAtCursor(
            t("copilot.chatInput.uploadFailed", { name }),
          );
        } finally {
          setUploading((n) => n - 1);
        }
      });
    },
    [ensureProjectId, projectId, t],
  );

  const actionLocked = isCreatingSession || disabled;
  const attachmentsEnabled = Boolean(
    projectId || ensureProjectId || onOpenAssetPicker,
  );
  const submitLocked =
    actionLocked || (isProcessing && !allowSubmitWhileProcessing);
  const hasAnnotationContent = annotationBlocks.some(
    (annotation) =>
      annotation.note.trim() || annotation.target.selection?.exact.trim(),
  );
  const canSend =
    Boolean(input.trim() || hasAnnotationContent) &&
    !submitLocked &&
    uploading === 0;
  const showQueuedSend = isProcessing && allowSubmitWhileProcessing && canSend;
  const isHero = variant === "hero";
  const hasAttachmentContent = useMemo(
    () =>
      normalizeCopilotAssetComposerValue(input, mentionableNodes ?? []).assets
        .length > 0,
    [input, mentionableNodes],
  );
  // The controlled markdown value is the only authority on how tall the editor
  // must be. Layout keys off this instead of measuring the caret at runtime.
  const inputState = !input.trim()
    ? "empty"
    : /\r|\n/.test(input.trim())
      ? "multiline"
      : "single-line";

  // ─── Submit ──────────────────────────────────────────────
  const handleFormSubmit = useCallback(() => {
    const raw = input.trim();
    if ((!raw && !hasAnnotationContent) || uploading > 0 || submitLocked)
      return;
    const normalized = normalizeCopilotAssetComposerValue(
      raw,
      mentionableNodes ?? [],
    );
    onInputChange("");
    editorRef.current?.clear();
    onCaretTargetChange?.(null);
    onSubmit(normalized.text, normalized.assets, annotationBlocks);
  }, [
    annotationBlocks,
    hasAnnotationContent,
    input,
    onCaretTargetChange,
    onInputChange,
    onSubmit,
    mentionableNodes,
    submitLocked,
    uploading,
  ]);

  const updateCaretTarget = useCallback(() => {
    if (!onCaretTargetChange) return;
    const host = editorHostRef.current;
    const selection = document.getSelection?.();
    if (
      !host ||
      !selection ||
      selection.rangeCount === 0 ||
      !selection.isCollapsed
    ) {
      onCaretTargetChange(null);
      return;
    }

    const anchor = selection.anchorNode;
    const anchorElement =
      anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentNode;
    if (!anchorElement || !host.contains(anchorElement)) {
      onCaretTargetChange(null);
      return;
    }

    const range = selection.getRangeAt(0).cloneRange();
    let rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      const marker = document.createElement("span");
      marker.textContent = "\u200b";
      range.insertNode(marker);
      rect = marker.getBoundingClientRect();
      marker.remove();
    }

    if (rect.width === 0 && rect.height === 0) {
      onCaretTargetChange(null);
      return;
    }

    onCaretTargetChange({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  }, [onCaretTargetChange]);

  useEffect(() => {
    if (!onCaretTargetChange) return;
    return () => onCaretTargetChange(null);
  }, [onCaretTargetChange]);

  // ─── ASR ─────────────────────────────────────────────────
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isCheckingVoice, setIsCheckingVoice] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState<VoiceInputNotice | null>(null);
  const [recordingElapsedSeconds, setRecordingElapsedSeconds] = useState(0);
  const [voiceCompletionIntent, setVoiceCompletionIntent] =
    useState<SpeechInputCompletionIntent | null>(null);
  const voiceAttemptRef = useRef(0);
  const getLocalAudioConfig = useCallback(() => loadLocalAudioConfig(), []);

  useEffect(() => {
    void getLocalAudioConfig().catch(() => undefined);
  }, [getLocalAudioConfig]);

  const startListening = useCallback(() => {
    if (isCheckingVoice || isListening) return;
    setVoiceNotice(null);
    const cachedConfig = peekLocalAudioConfig();
    if (
      cachedConfig &&
      (!cachedConfig.asr.enabled || !cachedConfig.asr.ready)
    ) {
      setVoiceNotice(voiceConfigNotice(cachedConfig));
      return;
    }

    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setVoiceNotice({
        message: "Local microphone recording is unavailable in this browser.",
      });
      return;
    }

    const attempt = voiceAttemptRef.current + 1;
    voiceAttemptRef.current = attempt;
    setRecordingElapsedSeconds(0);
    setVoiceCompletionIntent(null);
    setIsListening(true);
    setIsCheckingVoice(true);

    // Readiness was prefetched when the composer mounted. A cold or slow
    // request must not sit in front of microphone startup, so validate it
    // in parallel and only interrupt this exact attempt if it is unusable.
    void getLocalAudioConfig()
      .then(
        (audioConfig) => {
          if (voiceAttemptRef.current !== attempt) return;
          if (!audioConfig.asr.enabled || !audioConfig.asr.ready) {
            setIsCheckingVoice(false);
            voiceAttemptRef.current += 1;
            setIsListening(false);
            setVoiceNotice(voiceConfigNotice(audioConfig));
            return;
          }
          if (audioConfig.asr.setup?.runtime === "builtin-rpc") {
            void warmupLocalVoiceInput().catch(() => undefined);
          }
        },
        () => {
          if (voiceAttemptRef.current !== attempt) return;
          setIsCheckingVoice(false);
          voiceAttemptRef.current += 1;
          setIsListening(false);
          setVoiceNotice(voiceConfigNotice());
        },
      )
      .finally(() => {
        if (voiceAttemptRef.current === attempt) setIsCheckingVoice(false);
      });
  }, [getLocalAudioConfig, isCheckingVoice, isListening]);

  const finishVoice = useCallback(
    async (blob: Blob, intent: SpeechInputCompletionIntent) => {
      if (isTranscribing) return;
      voiceAttemptRef.current += 1;
      setVoiceCompletionIntent(intent);
      setIsTranscribing(true);
      setIsListening(false);
      setIsCheckingVoice(false);
      setVoiceNotice(null);
      try {
        if (!blob.size) {
          setVoiceNotice({ message: "No microphone audio was captured." });
          return;
        }
        const text = (await transcribeLocalAudio(blob)).trim();
        if (!text) return;
        const combinedText = input.trim() ? `${input.trim()} ${text}` : text;
        if (intent === "send") {
          const normalized = normalizeCopilotAssetComposerValue(
            combinedText,
            mentionableNodes ?? [],
          );
          onInputChange("");
          editorRef.current?.clear();
          onCaretTargetChange?.(null);
          onSubmit(normalized.text, normalized.assets, annotationBlocks);
        } else {
          onInputChange(combinedText);
        }
      } catch (err) {
        setVoiceNotice(voiceTranscriptionNotice(err));
      } finally {
        setIsTranscribing(false);
        setVoiceCompletionIntent(null);
      }
    },
    [
      annotationBlocks,
      input,
      isTranscribing,
      mentionableNodes,
      onCaretTargetChange,
      onInputChange,
      onSubmit,
    ],
  );

  const handleRecordingError = useCallback((error: unknown) => {
    voiceAttemptRef.current += 1;
    setIsListening(false);
    setIsCheckingVoice(false);
    setVoiceCompletionIntent(null);
    const message = error instanceof Error ? error.message : String(error);
    setVoiceNotice({
      message: /permission|denied|notallowed/i.test(message)
        ? "Microphone permission is required for local ASR."
        : "Local microphone recording failed.",
    });
  }, []);

  const handleDropAccepted = useCallback(
    (files: File[]) => {
      if (files.length > 0) void handleFiles(files);
    },
    [handleFiles],
  );
  const { getRootProps, getInputProps, open, isDragActive } = useDropzone({
    accept: DROPZONE_ACCEPT,
    disabled: actionLocked || !attachmentsEnabled,
    multiple: true,
    noClick: true,
    noKeyboard: true,
    onDropAccepted: handleDropAccepted,
  });
  const openAttachments = useCallback(() => {
    if (onOpenAssetPicker) {
      onOpenAssetPicker();
      return;
    }
    open();
  }, [onOpenAssetPicker, open]);
  const composerVisualState =
    inputState === "multiline" ||
    hasAttachmentContent ||
    annotationBlocks.length > 0 ||
    isListening ||
    isTranscribing
      ? "growing"
      : visualState;
  return (
    <ControlContextProvider value="composer">
      <div className={isHero ? "" : "composer-stack-card relative w-full"}>
        <Input
          {...getInputProps({
            "aria-hidden": true,
            tabIndex: -1,
          })}
          className="hidden"
        />

        {/* Error banner */}
        <AnimatePresence>
          {!isHero && error && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              className="mb-2"
            >
              <InlineAlert
                tone="error"
                title={error}
                action={
                  onDismissError ? (
                    <IconButton
                      label="Dismiss error"
                      icon={<X className="h-3.5 w-3.5" weight="bold" />}
                      size="sm"
                      onClick={onDismissError}
                      className="text-current opacity-60 hover:bg-black/5 hover:text-current hover:opacity-100"
                    />
                  ) : undefined
                }
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Main input card */}
        <div
          {...getRootProps({
            className: `clash-chat-input-surface ${
              isHero
                ? ""
                : "composer-control-row-inset composer-radius relative flex flex-col gap-[var(--composer-section-gap)] py-[var(--composer-card-padding-block)] app-composer-surface composer-card transition-shadow"
            } ${isDragActive ? "ring-2 ring-brand/40 ring-offset-2 ring-offset-warm-surface" : ""}`,
          })}
          data-composer-visual-state={composerVisualState}
          data-input-state={inputState}
          data-has-attachments={hasAttachmentContent ? "true" : "false"}
          data-has-annotations={annotationBlocks.length > 0 ? "true" : "false"}
          data-recording={isListening || isTranscribing ? "true" : "false"}
        >
          <div
            className={isHero ? "clash-chat-input-hero-layout" : ""}
            data-input-state={isHero ? inputState : undefined}
          >
            <ComposerInlineContent isHero={isHero}>
              {referenceAccessory ? (
                <div
                  data-slot="composer-reference-accessory"
                  className="clash-chat-input-reference-accessory"
                >
                  {referenceAccessory}
                </div>
              ) : null}
              <AgentAnnotationTray
                annotations={annotationBlocks}
                disabled={actionLocked}
                onRemove={onAnnotationRemove}
              />
              <div
                ref={editorHostRef}
                data-input-state={inputState}
                data-chat-typography="body"
                aria-disabled={actionLocked || undefined}
                className={`clash-chat-input-editor relative ${isHero ? "clash-chat-input-editor--hero" : "clash-chat-input-editor--default"} milkdown-chat-input w-full text-left chat-scroll-hidden overflow-y-auto ${actionLocked ? "pointer-events-none opacity-60" : ""}`}
                onFocusCapture={() =>
                  window.requestAnimationFrame(updateCaretTarget)
                }
                onBlurCapture={(event) => {
                  if (
                    !event.currentTarget.contains(
                      event.relatedTarget as Node | null,
                    )
                  ) {
                    onCaretTargetChange?.(null);
                  }
                }}
                onKeyUp={() => window.requestAnimationFrame(updateCaretTarget)}
                onPointerUp={() =>
                  window.requestAnimationFrame(updateCaretTarget)
                }
                onInput={() => window.requestAnimationFrame(updateCaretTarget)}
              >
                <MilkdownEditor
                  ref={editorRef}
                  value={input}
                  onChange={onInputChange}
                  onSubmit={handleFormSubmit}
                  placeholder={resolvedPlaceholder}
                  promptModalities={["text", "image", "video", "audio"]}
                  mentionableNodes={mentionableNodes}
                  connectedNodeIds={connectedNodeIds}
                  onMentionAdded={onMentionAdded}
                />
              </div>

              {/* Uploading indicator */}
              {uploading > 0 && (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-1.5 px-4 pb-1 text-xs text-slate-700 dark:text-slate-300"
                >
                  <CircleNotch
                    className="w-3 h-3 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  <span>
                    {t("copilot.chatInput.uploading", { count: uploading })}
                  </span>
                </div>
              )}
            </ComposerInlineContent>

            {/* Bottom toolbar */}
            {isListening || isTranscribing ? (
              <SpeechInputRecording
                elapsedSeconds={recordingElapsedSeconds}
                processingIntent={voiceCompletionIntent}
                regionLabel={t("copilot.chatInput.voice")}
                recordingDurationLabel={t(
                  "copilot.chatInput.recordingDuration",
                )}
                stopAndTranscribeLabel={t(
                  "copilot.chatInput.stopAndTranscribe",
                )}
                stopTranscribeAndSendLabel={t(
                  "copilot.chatInput.stopTranscribeAndSend",
                )}
                onCompletionIntentChange={setVoiceCompletionIntent}
                onRecordingProgress={setRecordingElapsedSeconds}
                onRecordingComplete={(blob, intent) =>
                  void finishVoice(blob, intent)
                }
                onRecordingError={handleRecordingError}
                className={isHero ? "px-5" : "px-4"}
                leading={
                  attachmentsEnabled ? (
                    <IconButton
                      onClick={openAttachments}
                      disabled={actionLocked}
                      label={t("copilot.chatInput.attach")}
                      shape="rounded"
                      size="sm"
                      data-composer-attach="true"
                      icon={<Plus className="h-4 w-4" weight="bold" />}
                      className="clash-chat-input-icon-control shrink-0"
                    />
                  ) : undefined
                }
              />
            ) : (
              <div
                className={`clash-chat-input-actions clash-chat-input-toolbar-row items-center ${isHero ? "" : "flex items-center justify-between gap-2"}`}
              >
                <div
                  className={`clash-chat-input-toolbar-start flex min-w-0 items-center gap-0.5 ${isHero ? "" : "-m-1 flex-1 overflow-hidden p-1"}`}
                >
                  {attachmentsEnabled ? (
                    <IconButton
                      onClick={openAttachments}
                      disabled={actionLocked}
                      label={t("copilot.chatInput.attach")}
                      shape="rounded"
                      size="sm"
                      data-composer-attach="true"
                      icon={<Plus className="w-4 h-4" weight="bold" />}
                      className="clash-chat-input-icon-control"
                    />
                  ) : null}
                  {toolbarAccessory ? (
                    <div className="clash-chat-input-toolbar-accessory min-w-0">
                      {toolbarAccessory}
                    </div>
                  ) : null}
                </div>
                <div
                  className="clash-chat-input-toolbar-end flex min-w-0 shrink-0 items-center justify-end gap-0.5"
                  data-composer-run-actions="true"
                >
                  {rightToolbarAccessory ? (
                    <div className="clash-chat-input-toolbar-config min-w-0">
                      {rightToolbarAccessory}
                    </div>
                  ) : null}
                  <VoiceInputSetupPopover
                    open={Boolean(voiceNotice)}
                    onOpenChange={(open) => {
                      if (open) {
                        void startListening();
                      } else {
                        setVoiceNotice(null);
                      }
                    }}
                    notice={voiceNotice}
                    trigger={
                      <IconButton
                        disabled={actionLocked || isCheckingVoice}
                        aria-busy={isCheckingVoice}
                        label={t("copilot.chatInput.voice")}
                        shape="rounded"
                        size="sm"
                        className="clash-chat-input-icon-control"
                        icon={
                          isCheckingVoice ? (
                            <CircleNotch
                              className="w-4 h-4 animate-spin motion-reduce:animate-none"
                              weight="bold"
                            />
                          ) : (
                            <Microphone className="w-4 h-4" weight="bold" />
                          )
                        }
                      />
                    }
                  />
                  {showQueuedSend ? (
                    <IconButton
                      onClick={handleFormSubmit}
                      disabled={!canSend}
                      label={t("copilot.chatInput.send")}
                      shape="rounded"
                      size="sm"
                      className="clash-chat-input-icon-control clash-chat-input-primary"
                      icon={<ArrowUp className="w-3.5 h-3.5" weight="bold" />}
                    />
                  ) : null}
                  {isProcessing && onStop ? (
                    <IconButton
                      onClick={onStop}
                      label={t("copilot.chatInput.stop")}
                      shape="rounded"
                      size="sm"
                      className="clash-chat-input-icon-control"
                      icon={
                        <span className="h-2.5 w-2.5 rounded-[3px] bg-current" />
                      }
                    />
                  ) : (
                    <IconButton
                      onClick={handleFormSubmit}
                      disabled={!canSend && !isCreatingSession}
                      label={t("copilot.chatInput.send")}
                      aria-busy={isCreatingSession || uploading > 0}
                      shape="rounded"
                      size="sm"
                      className={`clash-chat-input-icon-control ${
                        isCreatingSession || uploading > 0
                          ? "clash-chat-input-primary focus-visible:ring-ring"
                          : canSend
                            ? "clash-chat-input-primary focus-visible:ring-ring"
                            : "bg-warm-muted text-slate-500 dark:text-slate-500 cursor-not-allowed focus-visible:ring-ring"
                      }`}
                      icon={
                        isCreatingSession || uploading > 0 ? (
                          <CircleNotch className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" />
                        ) : (
                          <ArrowUp className="w-3.5 h-3.5" weight="bold" />
                        )
                      }
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </ControlContextProvider>
  );
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  ChatInputInner,
);
ChatInput.displayName = "ChatInput";
