type ScrollMetrics = { scrollHeight: number; clientHeight: number; scrollTop: number };

export const chatBottomOffset = (metrics: Pick<ScrollMetrics, "scrollHeight" | "clientHeight">) =>
  Math.max(0, metrics.scrollHeight - metrics.clientHeight);

// Allow a little room for touch scrolling and fractional device pixels.
export const isChatNearBottom = (metrics: ScrollMetrics, threshold = 64) =>
  chatBottomOffset(metrics) - Math.max(0, metrics.scrollTop) <= threshold;

export function createChatScrollFollow(initialFollow = false) {
  let following = initialFollow, manualUntil = 0, direction: "up" | "down" = "up";
  return {
    shouldFollow: () => following,
    send() { following = true; manualUntil = 0; },
    pause() { following = false; manualUntil = 0; },
    gesture(nextDirection: "up" | "down", now = Date.now()) {
      direction = nextDirection;
      manualUntil = now + 2500;
      if (direction === "up") following = false;
    },
    scrolled(metrics: ScrollMetrics, now = Date.now()) {
      // A resized viewport or a stream append can emit scroll without user input.
      if (now > manualUntil || manualUntil === 0) return;
      if (!isChatNearBottom(metrics)) following = false;
      else if (direction === "down") following = true;
    },
  };
}

export function resolveChatViewport({
  layoutHeight, visibleHeight, offsetTop = 0, scale = 1, baselineHeight = layoutHeight, editorActive = false,
}: {
  layoutHeight: number; visibleHeight?: number; offsetTop?: number; scale?: number;
  baselineHeight?: number; editorActive?: boolean;
}) {
  // Pinch zoom is a user zoom, not an on-screen keyboard resize.
  const zoomed = Math.abs(scale - 1) > 0.01;
  const height = !zoomed && Number.isFinite(visibleHeight) && visibleHeight! > 0 ? visibleHeight! : layoutHeight;
  return {
    height,
    top: zoomed ? 0 : Math.max(0, offsetTop),
    keyboardOpen: !zoomed && editorActive && baselineHeight - height > 120,
  };
}
