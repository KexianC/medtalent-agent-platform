import assert from "node:assert/strict";
import test from "node:test";
import { createSafeReplyStream } from "./safe-reply-stream.mjs";

function filterChunks(chunks, secrets = []) {
  const filter = createSafeReplyStream(secrets);
  const output = chunks.map((chunk) => filter.push(chunk));
  output.push(filter.finish());
  return output.join("");
}

test("safe clauses are available before finish, including short Chinese comma phrases", () => {
  const filter = createSafeReplyStream(["provider-api-key-for-test"]);
  assert.equal(filter.push("听起来这几天你很疲惫，"), "听起来这几天你很疲惫，");
  assert.equal(filter.push("我们先从"), "");
  assert.equal(filter.push("睡眠变化谈起。"), "我们先从睡眠变化谈起。");
  assert.equal(filter.finish(), "");
});

test("credential prefixes that contain clause punctuation stay private across every split", () => {
  const secret = "key-part，private-tail。done";
  const text = `先固定起床时间。${secret} 然后记录白天状态。`;
  for (let split = 0; split <= text.length; split += 1) {
    const output = filterChunks([text.slice(0, split), text.slice(split)], [secret]);
    assert.equal(output.includes(secret), false, `split ${split}`);
    assert.equal(output.includes("private-tail"), false, `split ${split}`);
    assert.match(output, /先固定起床时间。/u);
    assert.match(output, /然后记录白天状态。/u);
  }
});

test("encoded configured credentials are filtered even when emitted one character at a time", () => {
  const secret = "api/secret:+encoded-7";
  const representations = [
    secret,
    encodeURIComponent(secret),
    encodeURIComponent(secret).replace(/%[A-F0-9]{2}/gu, (part) => part.toLowerCase()),
    encodeURIComponent(secret).replace("%2F", "%2f"),
    secret.split("").map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
    Buffer.from(secret).toString("base64"),
  ];
  for (const encoded of representations) {
    const output = filterChunks([...`可以继续记录。${encoded} 请关注白天功能。`], [secret]);
    assert.equal(output.includes(encoded), false);
    assert.match(output, /已过滤/u);
    assert.match(output, /请关注白天功能。/u);
  }
});

test("private-key bodies remain withheld through punctuation and missing END markers", () => {
  for (const end of ["-----END PRIVATE KEY-----", ""]) {
    const text = `先观察作息。-----BEGIN PRIVATE KEY-----\nPRIVATE-MATERIAL，NEVER-EXPOSE。\n${end}`;
    const output = filterChunks([...text]);
    assert.equal(output.includes("PRIVATE-MATERIAL"), false);
    assert.equal(output.includes("NEVER-EXPOSE"), false);
    assert.equal(output.includes("PRIVATE KEY"), false);
    assert.match(output, /先观察作息。/u);
    assert.match(output, /已过滤/u);
  }
});

test("unknown credential assignments and Authorization tokens cannot leak across clauses", () => {
  const cases = [
    'api_key="PRIVATE，ASSIGNMENT。MATERIAL"',
    'api_key="PRIVATE，ASSIGNMENT。MATERIAL',
    'api\nkey="PRIVATE，ASSIGNMENT。MATERIAL"',
    'secret\naccess\nkey = "PRIVATE，ASSIGNMENT。MATERIAL"',
    'x\namz\nsecurity\ntoken = "PRIVATE，ASSIGNMENT。MATERIAL"',
    'Authorization:\nBearer PRIVATE.ASSIGNMENT.MATERIAL',
    'Basic\nPRIVATE.ASSIGNMENT.MATERIAL',
    'private_key=PRIVATE，ASSIGNMENT。MATERIAL',
    'password="PRIVATE\\"，ASSIGNMENT。MATERIAL"',
    'cookie="PRIVATE，ASSIGNMENT。MATERIAL"',
  ];
  for (const assignment of cases) {
    const output = filterChunks([...`先规律休息。${assignment}`]);
    assert.doesNotMatch(output, /PRIVATE|ASSIGNMENT|MATERIAL/u, assignment);
    assert.match(output, /先规律休息。/u);
    assert.match(output, /已过滤/u);
  }
});

test("URL authority waits for the actual boundary before filtering legacy multiple-at userinfo", () => {
  const text = "先记录睡眠。mysql://PRIVATE，USER:SECRET。PART@MORE@host.example/path 然后复盘。";
  const output = filterChunks([...text]);
  assert.doesNotMatch(output, /PRIVATE|SECRET|PART|MORE/u);
  assert.match(output, /mysql:\/\/.+@host\.example\/path/u);
  assert.match(output, /然后复盘。/u);
});

test("complete redaction markers do not contain a configured credential", () => {
  for (const secret of ["已过滤", "⟦", "[redacted]", "a", "key，prefix"]) {
    const output = filterChunks([...`正文。${secret} 结束。`], [secret]);
    assert.equal(output.includes(secret), false, secret);
  }
});
