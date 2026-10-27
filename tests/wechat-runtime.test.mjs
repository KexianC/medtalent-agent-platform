import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../wechat-miniprogram/", import.meta.url));
function commonJs(file) {
  const context = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  return context.module.exports;
}
const config = commonJs("config.js");
const routes = commonJs("utils/routes.js");

test("only same-origin public doctor paths are shared; private state is stripped", () => {
  assert.equal(routes.pathFromWebViewUrl(config.h5Origin + "/d/tang-jinsong?question=private#record", config), "/d/tang-jinsong");
  assert.equal(routes.sharePath("/d/tang-jinsong?token=secret"), "/pages/webview/index?path=%2Fd%2Ftang-jinsong");
  for (const value of ["https://evil.test/d/tang-jinsong", config.h5Origin + ".evil.com/d/foo", config.h5Origin + "@evil.com/d/foo", config.h5Origin + "/admin", config.h5Origin + "/api/doctors", config.h5Origin + "/d/../admin", config.h5Origin + "/d/foo%2Fbar", config.h5Origin + "/d/foo\\bar"]) {
    assert.equal(routes.pathFromWebViewUrl(value, config), "", value);
  }
});

test("launch links fail closed and do not enable an arbitrary WebView destination", () => {
  for (const value of ["https://evil.com", "//evil.com", "%2F%2Fevil.com", "%252Fadmin", "%E0%A4%A", "/admin", "/d/a/../../admin"]) {
    assert.equal(routes.launchPath({ path: value }, config), "/", value);
  }
  assert.equal(routes.launchPath({ path: "%2Fd%2Ftang-jinsong" }, config), "/d/tang-jinsong");
  assert.equal(routes.launchPath({ path: "/d/tang-jinsong" }, config), "/d/tang-jinsong");
  for (const origin of ["http://example.com", "https://127.0.0.1", "https://user:pass@example.com", "https://example.com/admin", "https://example.com:8443", "https://a.local"]) {
    assert.equal(routes.h5Url("/", { ...config, h5Origin: origin }), "", origin);
  }
});

test("doctor Q&A entry survives launch, H5 and share while private state is stripped", () => {
  const doctorPath = "/d/tang-jinsong/ask";
  assert.equal(routes.publicPath(doctorPath + "/"), doctorPath);
  assert.equal(routes.launchPath({ path: encodeURIComponent(doctorPath + "/?question=private#record") }, config), doctorPath);
  assert.equal(routes.h5Url(doctorPath + "?token=secret#record", config), config.h5Origin + doctorPath);
  assert.equal(routes.pathFromWebViewUrl(config.h5Origin + doctorPath + "/?question=private#record", config), doctorPath);
  const share = routes.sharePath(doctorPath + "?question=private#record");
  assert.equal(share, "/pages/webview/index?path=%2Fd%2Ftang-jinsong%2Fask");
  assert.equal(routes.launchPath({ path: share.split("?path=")[1] }, config), doctorPath);
});

test("Q&A route extension rejects unknown subpaths and encoding bypasses", () => {
  for (const value of [
    "/d/tang-jinsong/record", "/d/tang-jinsong/ask/private", "/d/tang-jinsong/ask/../admin",
    "/d/tang-jinsong//ask", "/d/tang-jinsong/ASK", "/d/tang-jinsong/ask//",
    "/d/tang-jinsong/%61sk", "/d/tang-jinsong%2Fask", "/d/tang-jinsong/ask%3Ftoken=secret",
    "/d/tang-jinsong/ask\\private"
  ]) {
    assert.equal(routes.publicPath(value), "", value);
    assert.equal(routes.pathFromWebViewUrl(config.h5Origin + value, config), "", value);
    assert.equal(routes.launchPath({ path: encodeURIComponent(value) }, config), "/", value);
  }
  assert.equal(routes.pathFromWebViewUrl("https://evil.com/d/tang-jinsong/ask", config), "");
  assert.equal(routes.launchPath({ path: encodeURIComponent("https://evil.com/d/tang-jinsong/ask") }, config), "/");
});

function pageHarness() {
  let page;
  let timerId = 0;
  const timers = new Map();
  const requests = [];
  const networkHandlers = new Set();
  const calls = { loading: 0, hidden: 0 };
  const wx = {
    canIUse: () => true,
    getNetworkType: (options) => requests.push(options),
    onNetworkStatusChange: (handler) => networkHandlers.add(handler),
    offNetworkStatusChange: (handler) => networkHandlers.delete(handler),
    showNavigationBarLoading: () => { calls.loading++; },
    hideNavigationBarLoading: () => { calls.hidden++; },
    reLaunch: (options) => { calls.reLaunch = options; }
  };
  const context = {
    wx, Page: (definition) => { page = definition; },
    require: (file) => file.includes("routes") ? routes : config,
    setTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id)
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "pages/webview/index.js"), "utf8"), context);
  page.setData = (data, callback) => { Object.assign(page.data, data); if (callback) callback(); };
  return { page, wx, timers, requests, networkHandlers, calls, event: (attempt, src) => ({ currentTarget: { dataset: { attempt } }, detail: { src } }) };
}

test("loaded pages survive offline events; unloading cancels listeners/timers and late callbacks", () => {
  const h = pageHarness();
  h.page.onLoad({});
  const url = h.page.data.src;
  assert.equal(h.timers.size, 1);
  h.page.onWebLoad(h.event(1, url));
  assert.equal(h.timers.size, 0);
  for (const handler of h.networkHandlers) handler({ isConnected: false, networkType: "none" });
  assert.equal(h.page.data.src, url);
  assert.equal(h.page.data.failed, false);
  h.page.retry();
  const queued = h.requests.at(-1);
  h.page.onUnload();
  queued.success({ networkType: "wifi" });
  assert.equal(h.networkHandlers.size, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.page.data.attempt, 1);
});

test("retry remounts safely; obsolete load/error callbacks cannot clobber new page", () => {
  const h = pageHarness();
  h.page.onLoad({ path: "/d/tang-jinsong" });
  const obsoleteTimeout = [...h.timers.values()][0];
  h.page.onWebError(h.event(1));
  assert.equal(h.page.data.failed, true);
  assert.equal(h.page.data.src, "");
  h.page.retry();
  h.requests.at(-1).success({ networkType: "wifi" });
  assert.equal(h.page.data.attempt, 2);
  h.page.onWebError(h.event(1));
  h.page.onWebLoad(h.event(1, config.h5Origin + "/d/another-doctor"));
  obsoleteTimeout();
  assert.equal(h.page.data.failed, false);
  assert.equal(h.page.currentPath, "/d/tang-jinsong");
  h.page.onWebLoad(h.event(2, h.page.data.src));
  assert.equal(h.timers.size, 0);
});

test("timeouts expose recovery; retry refreshes network status rather than getting stuck offline", () => {
  const h = pageHarness();
  h.page.onLoad({});
  [...h.timers.values()][0]();
  assert.equal(h.page.data.failed, true);
  h.page.retry();
  h.requests.at(-1).success({ networkType: "none" });
  assert.equal(h.page.data.src, "");
  h.page.retry();
  h.requests.at(-1).success({ networkType: "wifi" });
  assert.equal(h.page.data.failed, false);
  assert.equal(h.page.data.src, config.h5Origin + "/");
});

test("sharing a conversation never screenshots the page or includes its query parameters", () => {
  const h = pageHarness();
  h.page.onLoad({});
  const result = h.page.onShareAppMessage({ webViewUrl: config.h5Origin + "/d/tang-jinsong?question=private" });
  assert.equal(result.path, "/pages/webview/index?path=%2Fd%2Ftang-jinsong");
  assert.equal(result.imageUrl, "/assets/medtalent-logo.png");
  assert.ok(fs.existsSync(path.join(root, result.imageUrl)));
});

test("WebView Q&A launch and retry keep the direct entry and share only its public path", () => {
  const h = pageHarness();
  const doctorPath = "/d/tang-jinsong/ask";
  const sharePath = "/pages/webview/index?path=%2Fd%2Ftang-jinsong%2Fask";
  h.page.onLoad({ path: encodeURIComponent(doctorPath + "/") });
  assert.equal(h.page.data.src, config.h5Origin + doctorPath);
  h.page.onWebLoad(h.event(1, config.h5Origin + doctorPath + "?question=private#record"));
  assert.equal(h.page.currentPath, doctorPath);
  assert.equal(h.page.onShareAppMessage({}).path, sharePath);
  const share = h.page.onShareAppMessage({ webViewUrl: config.h5Origin + doctorPath + "?token=secret" });
  assert.equal(share.path, sharePath);
  assert.equal(share.imageUrl, "/assets/medtalent-logo.png");
  h.page.onWebError(h.event(1));
  h.page.retry();
  h.requests.at(-1).success({ networkType: "wifi" });
  assert.equal(h.page.data.src, config.h5Origin + doctorPath);
  assert.equal(h.page.data.attempt, 2);
  h.page.onUnload();
});

test("WebView follows a public Q&A navigation without accepting a later private subpath", () => {
  const h = pageHarness();
  h.page.onLoad({ path: "/d/tang-jinsong" });
  h.page.onWebLoad(h.event(1, config.h5Origin + "/d/tang-jinsong/ask/"));
  assert.equal(h.page.currentPath, "/d/tang-jinsong/ask");
  h.page.onWebLoad(h.event(1, config.h5Origin + "/d/tang-jinsong/ask/private"));
  assert.equal(h.page.currentPath, "/d/tang-jinsong/ask");
  assert.equal(h.page.onShareAppMessage({ webViewUrl: "https://evil.com/d/tang-jinsong/ask" }).path,
    "/pages/webview/index?path=%2Fd%2Ftang-jinsong%2Fask");
  h.page.onUnload();
});
