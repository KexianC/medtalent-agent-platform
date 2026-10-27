import test from "node:test";
import assert from "node:assert/strict";
import { chatBottomOffset, createChatScrollFollow, isChatNearBottom, resolveChatViewport } from "../src/lib/chatLayout.ts";

test("first long reply keeps following despite layout scroll events after an explicit send", () => {
  const follow = createChatScrollFollow();
  follow.send();
  follow.scrolled({ scrollHeight: 3512, clientHeight: 594, scrollTop: 85 }, 100);
  assert.equal(follow.shouldFollow(), true);
  follow.scrolled({ scrollHeight: 4100, clientHeight: 300, scrollTop: 2918 }, 200);
  assert.equal(follow.shouldFollow(), true);
});

test("real upward intent pauses including inertia; downward return to the tail restores follow", () => {
  const follow = createChatScrollFollow(true);
  follow.gesture("up", 100);
  follow.scrolled({ scrollHeight: 3512, clientHeight: 594, scrollTop: 2918 }, 101);
  assert.equal(follow.shouldFollow(), false, "a queued programmatic tail event cannot undo upward intent");
  follow.scrolled({ scrollHeight: 3512, clientHeight: 594, scrollTop: 2300 }, 2200);
  follow.scrolled({ scrollHeight: 3600, clientHeight: 594, scrollTop: 2300 }, 4000);
  assert.equal(follow.shouldFollow(), false);
  follow.gesture("down", 4100);
  follow.scrolled({ scrollHeight: 3600, clientHeight: 594, scrollTop: 2995 }, 4200);
  assert.equal(follow.shouldFollow(), true);
});

test("reference expansion cancels old scroll intent while a fresh send resumes follow", () => {
  const follow = createChatScrollFollow(true);
  follow.gesture("down", 100);
  follow.pause();
  follow.scrolled({ scrollHeight: 3512, clientHeight: 594, scrollTop: 2918 }, 110);
  assert.equal(follow.shouldFollow(), false);
  follow.gesture("up", 120);
  follow.send();
  follow.scrolled({ scrollHeight: 5000, clientHeight: 594, scrollTop: 2918 }, 130);
  assert.equal(follow.shouldFollow(), true);
});

test("chat follow preserves a reader above the tail and handles short content and elastic scrolling", () => {
  assert.equal(chatBottomOffset({ scrollHeight: 2400, clientHeight: 430 }), 1970);
  assert.equal(isChatNearBottom({ scrollHeight: 2400, clientHeight: 430, scrollTop: 1969.5 }), true);
  assert.equal(isChatNearBottom({ scrollHeight: 2400, clientHeight: 430, scrollTop: 1700 }), false);
  assert.equal(isChatNearBottom({ scrollHeight: 180, clientHeight: 430, scrollTop: -12 }), true);
  assert.equal(isChatNearBottom({ scrollHeight: 2400, clientHeight: 430, scrollTop: 1985 }), true);
});

test("both overlay and resized-layout keyboards use the visible viewport without subtracting the keyboard twice", () => {
  const overlay = resolveChatViewport({ layoutHeight: 812, visibleHeight: 484, baselineHeight: 812, editorActive: true });
  const resized = resolveChatViewport({ layoutHeight: 484, visibleHeight: 484, baselineHeight: 812, editorActive: true });
  assert.deepEqual(overlay, { height: 484, top: 0, keyboardOpen: true });
  assert.deepEqual(resized, overlay);
  assert.deepEqual(resolveChatViewport({ layoutHeight: 812, visibleHeight: 812, baselineHeight: 812, editorActive: true }), { height: 812, top: 0, keyboardOpen: false });
});

test("panned keyboard offsets, unavailable viewport data and pinch zoom remain distinct", () => {
  assert.deepEqual(resolveChatViewport({ layoutHeight: 812, visibleHeight: 484, offsetTop: 128, editorActive: true }), { height: 484, top: 128, keyboardOpen: true });
  assert.deepEqual(resolveChatViewport({ layoutHeight: 640, visibleHeight: 0 }), { height: 640, top: 0, keyboardOpen: false });
  assert.deepEqual(resolveChatViewport({ layoutHeight: 812, visibleHeight: 406, scale: 2, offsetTop: 20, editorActive: true }), { height: 812, top: 0, keyboardOpen: false });
  assert.equal(resolveChatViewport({ layoutHeight: 812, visibleHeight: 730, editorActive: true }).keyboardOpen, false);
});
