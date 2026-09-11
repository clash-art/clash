import { useWheelGesture } from "./ui/gesture";

function ownsHorizontalScroll(
  target: EventTarget | null,
  boundary: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return true;
  if (
    target.closest(
      'input, textarea, select, [contenteditable="true"], [data-history-swipe="ignore"]',
    )
  )
    return true;
  for (let node: Element | null = target; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowX;
    if (/(auto|scroll)/.test(overflow) && node.scrollWidth > node.clientWidth)
      return true;
    if (node === boundary) break;
  }
  return false;
}

/** Desktop detail surfaces only: browsers retain their native history gestures. */
export function usePageHistorySwipe(back: () => void, enabled: boolean) {
  return useWheelGesture(
    ({ first, last, event, movement: [x, y], memo }) => {
      const gesture: { blocked: boolean } = first
        ? { blocked: ownsHorizontalScroll(event.target, event.currentTarget) }
        : memo;
      if (!gesture) return;
      // Trackpad scrolling uses pixel deltas. Never turn pinch-to-zoom or a
      // consumed editor/scroll-region event into page navigation.
      gesture.blocked ||=
        event.ctrlKey || event.deltaMode !== 0 || event.defaultPrevented;
      // Wait for the complete gesture (including momentum) so it cannot pop
      // several history entries. Small/diagonal scrolling remains scrolling.
      if (last && !gesture.blocked && x < -100 && Math.abs(x) > Math.abs(y) * 2)
        back();
      return gesture;
    },
    { enabled },
  );
}
