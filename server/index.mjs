import { createPlatformApp } from "./app.mjs";

const port = Number(process.env.PORT || 8788);
const host = process.env.HOST || "127.0.0.1";
const platform = await createPlatformApp();
const server = platform.app.listen(port, host, () => {
  console.log(`Medtalent Agent Platform: http://${host}:${port}`);
  console.log("API /api/health · 管理后台 /admin · 数据目录由 DATA_DIR 配置");
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 85000);
  deadline.unref();
  const drained = new Promise((resolve) => server.close(resolve));
  await platform.knowledge.stop();
  await drained;
  await platform.close();
  clearTimeout(deadline);
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
