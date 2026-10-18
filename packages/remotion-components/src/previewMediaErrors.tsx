import React from "react";
import { Audio, Video } from "@remotion/media";

export type PreviewMediaError = { src: string; message: string };
export type PreviewMediaErrorReporter = (error: PreviewMediaError) => void;

/**
 * Only an interactive preview provides a reporter. Without one (export,
 * render-frame, thumbnails) media keeps Remotion's default error behaviour.
 */
const PreviewMediaErrorContext = React.createContext<PreviewMediaErrorReporter | null>(null);

export const PreviewMediaErrorProvider = PreviewMediaErrorContext.Provider;

type VideoProps = React.ComponentProps<typeof Video>;
type AudioProps = React.ComponentProps<typeof Audio>;

/**
 * `<Video>` from @remotion/media first tries its WebCodecs player and falls back
 * to a native element. Only the native fallback failing is terminal, and by
 * default it throws from a media event handler: the Player keeps its clock
 * running over a black layer and never reports a state. With a reporter the
 * terminal failure becomes an explicit preview error instead.
 */
export const ReportingVideo: React.FC<VideoProps> = (props) => {
  const report = React.useContext(PreviewMediaErrorContext);
  const fallbackOffthreadVideoProps = React.useMemo(() => report
    ? {
        ...props.fallbackOffthreadVideoProps,
        onError: (error: Error) => {
          props.fallbackOffthreadVideoProps?.onError?.(error);
          report({ src: props.src, message: error.message });
        },
      }
    : props.fallbackOffthreadVideoProps,
  [report, props.src, props.fallbackOffthreadVideoProps]);
  return <Video {...props} fallbackOffthreadVideoProps={fallbackOffthreadVideoProps} />;
};

export const ReportingAudio: React.FC<AudioProps> = (props) => {
  const report = React.useContext(PreviewMediaErrorContext);
  const fallbackHtml5AudioProps = React.useMemo(() => report
    ? {
        ...props.fallbackHtml5AudioProps,
        onError: (error: Error) => {
          props.fallbackHtml5AudioProps?.onError?.(error);
          report({ src: props.src, message: error.message });
        },
      }
    : props.fallbackHtml5AudioProps,
  [report, props.src, props.fallbackHtml5AudioProps]);
  return <Audio {...props} fallbackHtml5AudioProps={fallbackHtml5AudioProps} />;
};
