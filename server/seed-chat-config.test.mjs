import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { doctorProfiles } from "../src/data/doctorProfiles.ts";
import { createPlatformApp } from "./app.mjs";
import { HEALTH_EDUCATION_DISCLAIMER } from "./chat-core.mjs";

const expectedSlugs = [
  "fu-junfen", "chen-zhiling", "gong-wenbo", "chen-jinbiao", "wu-yuqin", "lin-jinfang",
  "luo-jun", "yu-weihua", "zhou-yong", "yu-wen", "tang-jinsong",
];
const specialtyPromptHeadings = {
  "fu-junfen": "儿童糖尿病与生长发育沟通重点",
  "chen-zhiling": "耳鼻喉症状与检查沟通重点",
  "gong-wenbo": "代谢管理与中医科普沟通重点",
  "chen-jinbiao": "肿瘤治疗与康复支持沟通重点",
  "wu-yuqin": "生活方式与习惯管理沟通重点",
  "lin-jinfang": "女性全生命周期健康沟通重点",
  "luo-jun": "肝胆肿瘤介入与围术期沟通重点",
  "yu-weihua": "普外科手术准备与康复沟通重点",
  "zhou-yong": "呼吸症状与长期管理沟通重点",
  "yu-wen": "睡眠、情绪与认知支持沟通重点",
  "tang-jinsong": "唐劲松医生方向的专属沟通风格",
};
const env = {
  AI_API_KEY: "synthetic-seed-chat-key",
  AI_API_URL: "https://seed-chat-provider.invalid/v1",
  AI_MODEL: "seed-chat-configured-model",
};

async function listenLocally(app) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = await new Promise((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(`${base}/api/health`);
      await response.arrayBuffer();
      assert.equal(response.status, 200);
      return { server, base };
    } catch (error) {
      await new Promise((resolve) => server.close(resolve));
      if (error?.cause?.message !== "bad port") throw error;
    }
  }
  throw new Error("Unable to allocate a Fetch-compatible loopback test port");
}

test("all eleven seeded agents support published normal and streaming chat with inherited model configuration", async (t) => {
  assert.deepEqual(doctorProfiles.map((doctor) => doctor.slug).sort(), [...expectedSlugs].sort());
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "medtalent-seed-chat-test-"));
  const providerRequests = [];
  let expectedDoctor;
  let platform;
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (platform) await platform.close();
    const target = path.resolve(directory);
    if (path.dirname(target) === path.resolve(os.tmpdir())
      && path.basename(target).startsWith("medtalent-seed-chat-test-")) {
      await fs.rm(target, { recursive: true, force: true });
    }
  });
  platform = await createPlatformApp({
    env,
    dataDir: path.join(directory, "data"),
    seedDoctors: doctorProfiles,
    startWorker: false,
    disableRateLimits: true,
    // Every external-model call terminates here. No provider/NAS connection is made.
    fetchImpl: async (url, options) => {
      assert.equal(url, `${env.AI_API_URL}/chat/completions`);
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, `Bearer ${env.AI_API_KEY}`);
      const payload = JSON.parse(options.body);
      assert.ok(expectedDoctor, "a request must belong to the currently tested agent");
      assert.equal(payload.model, env.AI_MODEL);
      assert.equal(payload.messages[0].role, "system");
      assert.ok(payload.messages[0].content.includes(`以${expectedDoctor.name}医生专业方向配置`));
      assert.ok(payload.messages[0].content.includes(expectedDoctor.specialty));
      assert.ok(payload.messages[0].content.includes(expectedDoctor.department));
      assert.ok(payload.messages[0].content.includes(expectedDoctor.config.systemPrompt));
      assert.match(payload.messages[0].content, /不得进行诊断/);
      assert.ok(payload.messages[0].content.includes(`【${specialtyPromptHeadings[expectedDoctor.slug]}】`));
      for (const [slug, heading] of Object.entries(specialtyPromptHeadings)) {
        if (slug !== expectedDoctor.slug) assert.ok(!payload.messages[0].content.includes(`【${heading}】`), "specialty instructions stay with the selected agent");
      }
      assert.match(payload.messages[0].content, /聊天没有代办工具，不能声称已经保存/);
      assert.equal(payload.max_tokens, expectedDoctor.config.maxTokens);
      assert.equal(payload.temperature, expectedDoctor.config.temperature);
      assert.equal(payload.top_p, expectedDoctor.config.topP);
      assert.deepEqual(payload.messages.at(-1), { role: "user", content: "请介绍你的健康科普范围。" });
      assert.ok(payload.messages.some((message) => message.content.includes("未检索到已审核且相关的知识资料")));
      providerRequests.push({ slug: expectedDoctor.slug, stream: payload.stream });
      const content = `测试助手 ${expectedDoctor.slug} 已收到健康科普问题。`;
      if (!payload.stream) return Response.json({ choices: [{ message: { content } }] });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const listener = await listenLocally(platform.app);
  server = listener.server;
  const request = (route, slug) => fetch(`${listener.base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ doctorSlug: slug, message: "请介绍你的健康科普范围。" }),
  });

  for (const profile of doctorProfiles) {
    await t.test(profile.slug, async () => {
      expectedDoctor = await platform.database.getAgent(profile.slug, true);
      assert.equal(expectedDoctor.slug, profile.slug);
      assert.equal(expectedDoctor.status, "published");
      assert.equal(expectedDoctor.config.model, "", "seed model must inherit the configured provider model");
      assert.ok(expectedDoctor.config.systemPrompt);
      assert.ok(expectedDoctor.config.welcomeMessage);

      const normal = await request("/api/chat", profile.slug);
      assert.equal(normal.status, 200);
      const result = await normal.json();
      assert.equal(result.model, env.AI_MODEL);
      assert.ok(result.reply.includes(profile.slug));
      assert.ok(result.reply.endsWith(HEALTH_EDUCATION_DISCLAIMER));
      assert.equal(result.retrievalMode, "none");
      assert.deepEqual(result.citations, []);

      const streamed = await request("/api/chat/stream", profile.slug);
      assert.equal(streamed.status, 200);
      assert.match(streamed.headers.get("content-type"), /application\/x-ndjson/);
      const events = (await streamed.text()).trim().split("\n").map(JSON.parse);
      assert.equal(events[0].type, "meta");
      assert.equal(events.at(-1).type, "done");
      assert.ok(events.slice(1, -1).length >= 1);
      assert.ok(events.slice(1, -1).every((event) => event.type === "delta"));
      if (profile.slug !== "tang-jinsong") assert.equal(events.length, 3);
      assert.equal(events[0].model, env.AI_MODEL);
      const streamedReply = events.slice(1, -1).map((event) => event.text).join("");
      assert.ok(streamedReply.includes(profile.slug));
      assert.ok(streamedReply.endsWith(HEALTH_EDUCATION_DISCLAIMER));
      assert.equal(events.at(-1).model, env.AI_MODEL);
      assert.equal(events.at(-1).retrievalMode, "none");
      assert.deepEqual(events.at(-1).citations, []);
      assert.deepEqual(providerRequests.filter((item) => item.slug === profile.slug), [
        { slug: profile.slug, stream: false }, { slug: profile.slug, stream: true },
      ]);
    });
  }
  assert.equal(providerRequests.length, 22);
  const usage = platform.database.sqlite.prepare("SELECT agent_slug,model,success FROM usage ORDER BY rowid").all();
  assert.equal(usage.length, 22);
  for (const slug of expectedSlugs) {
    const entries = usage.filter((entry) => entry.agent_slug === slug);
    assert.equal(entries.length, 2);
    assert.ok(entries.every((entry) => entry.model === env.AI_MODEL && entry.success === 1));
  }
});
