import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { doctorProfiles } from '../src/data/doctorProfiles.ts';
import { routeChatForEvaluation, detectCrisisRisk, detectMedicalSafetyRisk } from '../server/chat-core.mjs';
import { isUsableProviderCredential } from '../server/output-safety.mjs';
import { parseArgs, parseCsv, planCases, scoreResult, summarize, renderResultsCsv, renderSummary } from './crisis-eval-lib.mjs';

// Deliberately never load dotenv, databases, or runtime configuration files.
export async function main(args = process.argv.slice(2), { env = process.env, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const secrets = [env.AI_API_KEY, env.DEEPSEEK_API_KEY].filter(value => typeof value === 'string' && value.length);
  const redact = value => secrets.sort((a, b) => b.length - a.length).reduce((text, secret) => text.replaceAll(secret, '[已过滤]'), String(value));
  const print = value => log(redact(value));
  try {
    const options = parseArgs(args);
    const apiKey = env.AI_API_KEY || env.DEEPSEEK_API_KEY;
    if (!apiKey) { print('未配置 AI_API_KEY 或 DEEPSEEK_API_KEY；退出码 2。'); return 2; }
    if (!isUsableProviderCredential(apiKey)) { print('模型密钥配置无效；退出码 2。'); return 2; }
    const doctor = doctorProfiles.find(profile => profile.slug === (options.doctor || 'tang-jinsong'));
    if (!doctor) { print(`现有 seed 缺少 ${options.doctor || 'tang-jinsong'}；退出码 2。`); return 2; }
    const jobs = planCases(parseCsv(await readFile(options.csv, 'utf8')), options);
    const count = new Set(jobs.map(job => job.item.id)).size;
    const expectedCalls = jobs.filter(({ item }) => {
      const question = item.message.trim().slice(0, 2000);
      return !detectCrisisRisk(question) && !detectMedicalSafetyRisk(question);
    }).length;
    print(`题数：${count}；路由请求次数：${jobs.length}；预计模型调用次数：${expectedCalls}（关键词命中不调用模型）。`);
    if (!jobs.length) { print('没有可评测题目；退出码 2。'); return 2; }
    if (!options.yes) { print('预览结束；传 --yes 才会调用模型。'); return 0; }
    // Fail before paid calls if the output directory cannot be used.
    await mkdir(options.out, { recursive: true });
    const results = new Array(jobs.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const index = next++, job = jobs[index];
        const started = performance.now();
        let modelCalled = false;
        const trackedFetch = (...params) => { modelCalled = true; return fetchImpl(...params); };
        let result;
        try {
          result = await routeChatForEvaluation({ doctor, message: job.item.message, history: job.item.history, env, fetchImpl: trackedFetch });
        } catch {
          // Never serialize errors: providers can reflect credentials in them.
          result = { route: 'uncertain', layer: modelCalled ? 'model' : 'keyword', modelCalled, durationMs: performance.now() - started, failedFallback: true };
        }
        results[index] = { ...job, ...result, passed: scoreResult(job.item, result) };
      }
    }));
    await writeFile(path.join(options.out, 'results.csv'), redact(renderResultsCsv(results)), 'utf8');
    await writeFile(path.join(options.out, 'summary.md'), redact(renderSummary(results)), 'utf8');
    const summary = summarize(results);
    print(`结果已写入指定目录。结论：${summary.conclusion}；退出码 ${summary.exitCode}。`);
    return summary.exitCode;
  } catch {
    print('评测配置、题集或输出错误；请检查参数及文件权限。退出码 2。');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
