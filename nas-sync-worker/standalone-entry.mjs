import { sanitizeError } from "./sync.mjs";

async function runStandalone() {
  const argv = process.argv.slice(2);
  const entryPath = process.argv[1];

  // The source entry uses import.meta.url to detect direct ESM execution.
  // Hide the bundled CommonJS entry while loading it, then invoke main once.
  process.argv[1] = undefined;
  let main;
  try {
    ({ main } = await import("./index.mjs"));
  } finally {
    process.argv[1] = entryPath;
  }

  await main(argv, process.env);
}

runStandalone().catch((error) => {
  console.error(JSON.stringify({ event: "nas_minio_sync_start_failed", error: sanitizeError(error) }));
  process.exitCode = 1;
});
