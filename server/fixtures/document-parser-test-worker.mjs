import v8 from "node:v8";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = Buffer.concat(chunks);
const separator = request.indexOf(0x0a);
const metadata = JSON.parse(request.subarray(0, separator).toString("utf8"));

if (metadata.name === "timeout.txt") {
  setInterval(() => {}, 1_000);
} else if (metadata.name === "memory-limit.txt") {
  process.stderr.write("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory private-source-must-not-leak");
  process.exit(134);
} else if (metadata.name === "crash.txt") {
  process.exit(17);
} else if (metadata.name === "overflow.txt") {
  process.stdout.write("x".repeat(4_096));
} else if (metadata.name === "stderr-overflow.txt") {
  process.stderr.write("x".repeat(4_096));
} else {
  const heapMiB = Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024);
  process.stdout.write(JSON.stringify({ ok: true, text: `${process.env.PARSER_TEST_SECRET ? "leaked" : "clean"}:${heapMiB}:${process.execArgv.join(",")}` }));
}
