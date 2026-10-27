// Run only on a trusted operator machine. Credentials and tokens never enter the image or receipt.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const receipt = { status: "preflight", createdAt: new Date().toISOString() };
let receiptFile;
class SafeError extends Error {}

async function loadNativeModule(relativePath) {
  const context = { module: { exports: {} } };
  vm.runInNewContext(await readFile(resolve(root, relativePath), "utf8"), context, { timeout: 1000 });
  return context.module.exports;
}

async function postJson(url, body) {
  return fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000), redirect: "error",
  });
}

function apiError(stage, payload) {
  const code = Number(payload?.errcode);
  const messages = {
    40125: "微信 AppSecret 无效", 40164: "调用 IP 不在微信接口白名单中",
    40013: "微信 AppID 无效", 40001: "微信接口凭证无效", 41030: "微信页面路径不可用，请检查正式发布版本",
    85096: "路径包含微信保留参数", 45009: "微信接口调用额度已达上限", 45029: "小程序码数量已达上限",
    89503: "微信要求管理员确认此次调用", 89506: "微信管理员已拒绝该 IP 调用", 89507: "微信管理员已拒绝该 IP 调用",
  };
  receipt.stage = stage;
  receipt.errcode = Number.isFinite(code) ? code : null;
  throw new SafeError(messages[code] || `${stage}未成功，微信错误码 ${Number.isFinite(code) ? code : "未知"}`);
}

try {
  const { values } = parseArgs({ options: { agent: { type: "string" }, name: { type: "string" }, env: { type: "string", default: "release" }, generate: { type: "boolean", default: false } } });
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(values.agent || "")) throw new SafeError("请使用 --agent 指定有效的智能体标识");
  if (!["release", "trial", "develop"].includes(values.env)) throw new SafeError("--env 仅支持 release、trial、develop");
  const project = JSON.parse(await readFile(resolve(root, "wechat-miniprogram/project.config.json"), "utf8"));
  const config = await loadNativeModule("wechat-miniprogram/config.js");
  const routes = await loadNativeModule("wechat-miniprogram/utils/routes.js");
  const app = JSON.parse(await readFile(resolve(root, "wechat-miniprogram/app.json"), "utf8"));
  if (!app.pages.includes("pages/webview/index")) throw new SafeError("小程序未注册 WebView 页面");
  if (project.appid !== "wx7a4c71565eeee4b9" || config.h5Origin !== "https://agent.hzmwmt.com") throw new SafeError("小程序配置与预期应用不一致");
  const h5Path = `/d/${values.agent}`;
  const path = routes.sharePath(h5Path).replace(/^\//, "");
  const options = Object.fromEntries(new URLSearchParams(path.split("?")[1]));
  if (routes.launchPath(options, config) !== h5Path) throw new SafeError("小程序直达路径校验失败");
  let doctor;
  try {
    const directoryResponse = await fetch(`${config.h5Origin}/api/doctors`, { signal: AbortSignal.timeout(15000), redirect: "error" });
    receipt.directoryStatus = directoryResponse.status;
    if (directoryResponse.ok) {
      const directory = await directoryResponse.json();
      if (!Array.isArray(directory)) throw new SafeError("公开智能体目录格式无效");
      doctor = directory.find(item => item.slug === values.agent);
      if (!doctor) throw new SafeError("目标智能体不在已发布的公开目录中");
      receipt.targetVerifiedInPublicDirectory = true;
    }
  } catch (error) {
    if (error instanceof SafeError) throw error;
    receipt.directoryStatus = "unavailable";
  }
  if (!doctor) {
    // --name supplies an operator-selected display label; it does not imply publication or availability.
    if (!values.name?.trim()) throw new SafeError("暂时无法验证公开目录，可在确认目标后用 --name 提供显示名称");
    doctor = { name: values.name.trim() };
    receipt.targetVerifiedInPublicDirectory = false;
  }
  const outDir = resolve(root, "output/wechat/codes", `${values.agent}-${values.env}-${Date.now()}`);
  await mkdir(outDir, { recursive: true });
  receiptFile = resolve(outDir, "receipt.json");
  Object.assign(receipt, { appid: project.appid, agent: values.agent, name: doctor.name, envVersion: values.env, path, h5Url: routes.h5Url(h5Path, config), width: 1280 });
  if (!values.generate) {
    receipt.status = "prepared";
  } else {
    if (process.env.WECHAT_APP_ID !== project.appid || !process.env.WECHAT_APP_SECRET) throw new SafeError("请在服务端环境配置匹配的 WECHAT_APP_ID 和 WECHAT_APP_SECRET");
    receipt.stage = "获取微信接口凭证";
    const tokenResponse = await postJson("https://api.weixin.qq.com/cgi-bin/stable_token", {
      grant_type: "client_credential", appid: project.appid, secret: process.env.WECHAT_APP_SECRET, force_refresh: false,
    });
    const tokenResult = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenResult.access_token) apiError(receipt.stage, tokenResult);
    receipt.stage = "生成小程序码";
    const result = await postJson(`https://api.weixin.qq.com/wxa/getwxacode?access_token=${encodeURIComponent(tokenResult.access_token)}`, {
      path, env_version: values.env, width: 1280, auto_color: false, line_color: { r: 0, g: 0, b: 0 }, is_hyaline: false,
    });
    const bytes = Buffer.from(await result.arrayBuffer());
    const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!result.ok || (!isPng && !isJpeg)) {
      let payload;
      try { payload = JSON.parse(bytes.toString("utf8")); } catch { throw new SafeError("微信未返回有效的 PNG/JPEG 图片"); }
      apiError(receipt.stage, payload);
    }
    const imageFile = resolve(outDir, `${values.agent}-${values.env}.${isPng ? "png" : "jpg"}`);
    await writeFile(imageFile, bytes, { flag: "wx" });
    Object.assign(receipt, { status: "generated", imageFile, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), generatedAt: new Date().toISOString(), realDeviceScanVerified: false });
    delete receipt.stage;
  }
} catch (error) {
  receipt.status = "failed";
  receipt.message = error instanceof SafeError ? error.message : "生成过程未完成，请检查网络连接或本地文件配置";
  process.exitCode = 1;
}
if (receiptFile) await writeFile(receiptFile, JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ ...receipt, receiptFile }, null, 2));
