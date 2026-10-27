// 微信 JS 运行环境不依赖浏览器 URL / URLSearchParams。
// 分享只传公开路径，绝不携带对话、健康记录、令牌或任意目标网址。
function normalizeOrigin(value) {
  if (typeof value !== "string") return "";
  const origin = value.replace(/\/$/, "");
  const match = /^https:\/\/([a-z0-9.-]+)$/i.exec(origin);
  if (!match) return "";
  const host = match[1].toLowerCase();
  const labels = host.split(".");
  if (labels.length < 2 || /^[\d.]+$/.test(host) || /(?:^|\.)(?:local|localhost|internal|test|invalid|example)$/.test(host)) return "";
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return "";
  return "https://" + host;
}

function publicPath(value) {
  if (typeof value !== "string" || value.length > 1024 || /[\\\s%]/.test(value)) return "";
  // 丢弃所有查询和 hash，避免从分享链接带出用户数据。
  const pathname = value.split(/[?#]/)[0];
  if (pathname === "/") return "/";
  const match = /^\/d\/([a-z0-9][a-z0-9-]{1,62}[a-z0-9])(\/ask)?\/?$/.exec(pathname);
  return match ? "/d/" + match[1] + (match[2] || "") : "";
}

function decodePath(value) {
  if (typeof value !== "string") return "";
  try { return publicPath(decodeURIComponent(value)); } catch (_) { return ""; }
}

function homePath(config) { return publicPath(config.homePath) || "/"; }

function launchPath(options, config) {
  return decodePath(options && options.path) || homePath(config);
}

function pathFromWebViewUrl(value, config) {
  const origin = normalizeOrigin(config.h5Origin);
  if (!origin || typeof value !== "string") return "";
  if (value === origin) return "/";
  // 必须以 origin + / 开始，拒绝同名前缀域名、userinfo 与开放重定向。
  if (value.indexOf(origin + "/") !== 0) return "";
  return publicPath(value.slice(origin.length));
}

function h5Url(path, config) {
  const origin = normalizeOrigin(config.h5Origin);
  return origin ? origin + (publicPath(path) || homePath(config)) : "";
}

function sharePath(path) {
  return "/pages/webview/index?path=" + encodeURIComponent(publicPath(path) || "/");
}

module.exports = { normalizeOrigin, publicPath, decodePath, launchPath, pathFromWebViewUrl, h5Url, sharePath };
