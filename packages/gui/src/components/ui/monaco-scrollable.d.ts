// Narrow facade for monaco-editor 0.56.0's private scrollableElement module.
// See scroll-viewport.md before upgrading the pinned dependency.
declare module 'monaco-editor/base/browser/ui/scrollbar/scrollableElement.js' {
  export class DomScrollableElement {
    constructor(element: HTMLElement, options: {
      className?: string;
      handleMouseWheel?: boolean;
      scrollPredominantAxis?: boolean;
      useShadows?: boolean;
      consumeMouseWheelIfScrollbarIsNeeded?: boolean;
    });
    getDomNode(): HTMLElement;
    scanDomNode(): void;
    delegateScrollFromMouseWheelEvent(event: WheelEvent): void;
    dispose(): void;
  }
}
