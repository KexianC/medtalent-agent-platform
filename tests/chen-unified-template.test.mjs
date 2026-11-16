import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { usesTangRecords } from '../src/lib/builderRuntime.ts';
import { doctorCustoms, enabledGroups, usesUnifiedTemplate } from '../src/features/services/doctorCustom.ts';
import { doctorProfiles } from '../src/data/doctorProfiles.ts';
import { doctorExperiences } from '../src/data/doctorExperience.ts';
import * as core from '../server/chat-core.mjs';
import * as unified from '../server/chat-core.mjs';

const chen = doctorProfiles.find(doctor => doctor.slug === 'chen-zhiling');
const tang = doctorProfiles.find(doctor => doctor.slug === 'tang-jinsong');
const offline = () => assert.fail('offline checks must not request a provider');

test('Chen uses the unified template with merged ENT entries and materials', () => {
  for (const doctor of [chen, tang]) assert.equal(usesUnifiedTemplate(doctor), true);
  const custom = doctorCustoms[chen.slug];
  assert.deepEqual(enabledGroups(custom).map(group => group.items), [
    ['科普宣教', '症状记录', '资料库'], ['就诊准备', '门诊指引', '留言咨询', '更多服务'],
  ]);
  assert.doesNotMatch(JSON.stringify(custom), /睡眠日记|量表自评|戒烟|今日心境|放松训练|用药记录|家属照护|检查报告解读/);
  assert.equal(custom.materials.length, 7);
  assert.ok(custom.materials.every(item => item.title && item.source));
  assert.doesNotMatch(JSON.stringify(custom.materials), /2013/);
  assert.ok(custom.videos.every(video => video.url.startsWith('https://m.youlai.cn/video/')));
  assert.deepEqual(chen.articles.map(article => article.id), ['czl-1', 'czl-2', 'czl-4', 'czl-5', 'czl-6', 'czl-7', 'czl-3']);
  assert.deepEqual(chen.topics, ['儿童鼻炎', '腺样体', '耳鸣眩晕', '鼻窦炎']);
  assert.deepEqual(custom.bio.topics, chen.topics);
  assert.equal(doctorExperiences[chen.slug].metric.value, '0');
  assert.equal(doctorExperiences[chen.slug].metric.progress, 0);
  assert.deepEqual(doctorExperiences[chen.slug].theme, doctorExperiences[tang.slug].theme);
});

test('Chen and Tang use the identical v1.14 crisis result and full reply, offline and streaming', async () => {
  for (const message of ['我不想活了', '我要打人', '我已经吃了一把安眠药', '妈妈晕倒了叫不醒', '我抽搐了', '我现在胸痛喘不上气', '我想死但是我不敢', '我撑不住了']) {
    const expected = await core.generateChatReply({ doctor: tang, message, env: {}, fetchImpl: offline }).catch(error => {
      assert.equal(error.code, 'AI_NOT_CONFIGURED');
      return null;
    });
    const request = { doctor: chen, message, env: {}, fetchImpl: offline };
    assert.deepEqual(unified.detectChatCrisis(request), core.detectChatCrisis({ ...request, doctor: tang }), message);
    if (!expected) {
      await assert.rejects(unified.generateChatReply(request), { code: 'AI_NOT_CONFIGURED' });
      continue;
    }
    assert.deepEqual(await unified.generateChatReply(request), expected, message);
    const events = [];
    for await (const event of unified.generateChatReplyStream(request)) events.push(event);
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), expected.reply, message);
    assert.equal(events.at(-1).crisisCategory, expected.crisisCategory, message);
  }
});

test('ordinary Chen questions preserve specialty identity and never inherit psychiatry scope or demo answers', async () => {
  for (const message of chen.quickQuestions) {
    const request = { doctor: chen, message, env: {}, fetchImpl: offline };
    assert.equal(unified.detectChatCrisis(request), null, message);
    await assert.rejects(unified.generateChatReply(request), { code: 'AI_NOT_CONFIGURED' });
  }
});

test('configured safety classification reuses Tang results and normal generation keeps Chen prompt', async () => {
  const env = { AI_API_KEY: 'synthetic-offline-test-key' };
  for (const level of ['safe', 'clear_risk', 'uncertain']) {
    let safetyCalls = 0, answerCalls = 0;
    const fetchImpl = async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.response_format?.type === 'json_object') {
        safetyCalls++;
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ level, subject: 'self', category: 'self_harm' }) } }] }) };
      }
      answerCalls++;
      assert.match(body.messages[0].content, /陈志凌/);
      assert.match(body.messages[0].content, /不判断病因/);
      assert.doesNotMatch(body.messages[0].content, /唐劲松医生方向/);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '可以整理症状记录和就诊问题。' } }] }) };
    };
    const request = { doctor: chen, message: '眩晕发作时可以记下哪些信息？', env, fetchImpl };
    const result = await unified.generateChatReply(request);
    assert.equal(safetyCalls, 1);
    assert.equal(answerCalls, level === 'safe' ? 1 : 0);
    if (level !== 'safe') {
      const expected = await core.generateChatReply({ ...request, doctor: tang });
      assert.deepEqual(result, expected);
    }
  }
});

const unavailableReply = '服务暂时繁忙，请稍后再试。如果你现在有伤害自己的想法或身体急症，请拨打 12356 或 120。';
const configuredEnv = { AI_API_KEY: 'synthetic-offline-test-key' };
const safeClassification = () => Response.json({
  choices: [{ message: { content: JSON.stringify({ level: 'safe', subject: 'self' }) } }],
});

async function runUnifiedRequest(stream, request) {
  if (!stream) return unified.generateChatReply(request);
  const events = [];
  for await (const event of unified.generateChatReplyStream(request)) events.push(event);
  return {
    ...events.at(-1),
    reply: events.filter(event => event.type === 'delta').map(event => event.text).join(''),
    events,
  };
}

function answerResponse(body, reply) {
  assert.match(body.messages[0].content, /陈志凌/);
  assert.match(body.messages[0].content, /不判断病因/);
  assert.doesNotMatch(body.messages[0].content, /唐劲松/);
  return body.stream
    ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`)
    : Response.json({ choices: [{ message: { content: reply } }] });
}

test('Chen returns exact unavailable reply after two classifier failures in both paths', async () => {
  for (const stream of [false, true]) {
    let classifierCalls = 0, answerCalls = 0;
    const result = await runUnifiedRequest(stream, {
      doctor: chen, message: '眩晕怎么办', env: configuredEnv,
      fetchImpl: async (_url, options) => {
        if (JSON.parse(options.body).response_format?.type === 'json_object') {
          classifierCalls++;
          throw new Error('simulated classifier failure');
        }
        answerCalls++;
        throw new Error('answer must not be requested');
      },
    });
    assert.equal(classifierCalls, 2);
    assert.equal(answerCalls, 0);
    assert.equal(result.reply, unavailableReply);
    assert.match(result.reply, /12356/);
    assert.match(result.reply, /120/);
    assert.doesNotMatch(result.reply, /自杀/);
    assert.equal(result.model, 'safety-unavailable');
    assert.equal(result.scope, 'unavailable');
    assert.equal('crisis' in result, false);
    assert.equal('crisisCategory' in result, false);
    if (stream) assert.deepEqual(result.events, [
      { type: 'meta', model: 'safety-unavailable', scope: 'unavailable' },
      { type: 'delta', text: unavailableReply },
      { type: 'done', model: 'safety-unavailable', scope: 'unavailable' },
    ]);
  }
});

test('Chen preserves keyword crises and risk-cue fallbacks when classifiers fail', async () => {
  for (const stream of [false, true]) for (const [message, calls] of [
    ['我不想活了最近想自杀', 0], ['胸痛', 2],
  ]) {
    let classifierCalls = 0, answerCalls = 0;
    const request = { doctor: chen, message, env: configuredEnv, fetchImpl: async (_url, options) => {
      if (JSON.parse(options.body).response_format?.type === 'json_object') {
        classifierCalls++;
        throw new Error('simulated classifier failure');
      }
      answerCalls++;
      throw new Error('answer must not be requested');
    } };
    const result = await runUnifiedRequest(stream, request);
    assert.equal(classifierCalls, calls);
    assert.equal(answerCalls, 0);
    assert.notEqual(result.reply, unavailableReply);
    assert.notEqual(result.scope, 'unavailable');
    assert.equal(result.crisis, true);
    assert.equal(result.model, calls ? 'safety-uncertain' : 'safety-intervention');
    assert.equal(result.crisisCategory, calls ? 'uncertain' : 'self_harm');
    assert.match(result.reply, calls ? /120/ : /12356/);
    // Match the complete core result/event contract, including crisis metadata.
    if (stream) {
      const expected = [];
      for await (const event of core.generateChatReplyStream({ ...request, doctor: tang })) expected.push(event);
      assert.deepEqual(result.events, expected);
    } else assert.deepEqual(result, await core.generateChatReply({ ...request, doctor: tang }));
  }
});

test('Chen generates one specialty answer after classifier retry succeeds', async () => {
  for (const stream of [false, true]) {
    let classifierCalls = 0, answerCalls = 0;
    const result = await runUnifiedRequest(stream, {
      doctor: chen, message: '眩晕怎么办', env: configuredEnv,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.response_format?.type === 'json_object') {
          classifierCalls++;
          if (classifierCalls === 1) throw new Error('simulated first failure');
          return safeClassification();
        }
        answerCalls++;
        return answerResponse(body, '可以整理症状记录和就诊问题。');
      },
    });
    assert.equal(classifierCalls, 2);
    assert.equal(answerCalls, 1);
    assert.match(result.reply, /可以整理症状记录和就诊问题。/);
    assert.equal('crisis' in result, stream);
    if (stream) assert.equal(result.crisis, false);
    assert.notEqual(result.model, 'scope-guidance');
  }
});

test('Chen discards Tang out-of-scope and clarification replies in both paths', async () => {
  for (const stream of [false, true]) for (const [message, scope] of [
    ['股票价格是多少', 'unrelated'], ['这个呢？', 'clarify'],
  ]) {
    assert.equal(core.classifyTangQuestion(message), scope);
    const tangResult = await core.generateChatReply({ doctor: tang, message, env: configuredEnv, fetchImpl: safeClassification });
    assert.equal(tangResult.scope, scope);
    let classifierCalls = 0, answerCalls = 0;
    const result = await runUnifiedRequest(stream, {
      doctor: chen, message, env: configuredEnv,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        if (body.response_format?.type === 'json_object') { classifierCalls++; return safeClassification(); }
        answerCalls++;
        return answerResponse(body, '请描述需要咨询的眩晕相关问题。');
      },
    });
    assert.equal(classifierCalls, 1);
    assert.equal(answerCalls, 1);
    assert.match(result.reply, /请描述需要咨询的眩晕相关问题。/);
    assert.notEqual(result.reply, tangResult.reply);
    assert.equal('scope' in result, false);
  }
});

const appSource = readFileSync(new URL('../src/pages/DoctorApp.tsx', import.meta.url), 'utf8');
const accountSource = readFileSync(new URL('../src/features/account/ConsumerAccount.tsx', import.meta.url), 'utf8');

test('chat mood and assessment guidance stays Tang-only while recommended questions remain shared', () => {
  assert.equal(usesTangRecords(chen), false);
  assert.equal(usesTangRecords(tang), true);
  assert.match(appSource, /\{usesTangRecords\(doctor\) && hasVoiceConversation && <TangChatGuidance/);
  assert.match(appSource, /: tang && \(tangPanel === "量表自评" \|\| tangPanel === "今日心境"\) \? <TangChatGuidance/);
  assert.match(appSource, /<summary>推荐问题<\/summary>[\s\S]*?doctor\.quickQuestions\.slice\(0, usesTangRecords\(doctor\) \? 3 : 5\)\.map/);
  // 科普正文转述指南，可以出现“情绪管理”；这里只防精神科模块的文字带过来。
  const { articleDetails, ...chenConfig } = doctorCustoms[chen.slug];
  assert.ok(articleDetails);
  assert.doesNotMatch(JSON.stringify([chen, doctorExperiences[chen.slug], chenConfig]), /心理自评|心情|睡眠日记|情绪|放松/);
});

test('Chen account copy and record-deletion confirmation do not inherit psychological assessments', () => {
  assert.match(accountSource, /doctorSlug === 'chen-zhiling' \? '登录后，对话、收藏、健康记录将保存在你的云端账户。你可在设置中关闭对话保存。' : '登录后，对话、收藏、健康记录和心理自评将保存在你的云端账户/);
  assert.match(accountSource, /'chat-assessments-v1': doctorSlug === 'chen-zhiling' \? '自评记录' : '心理自评'/);
  assert.match(appSource, /account\.user \? \(usesTangRecords\(doctor\) \? "关闭后将清除账户中保存的对话与心理自评[^"\n]*" : "关闭后将清除账户中保存的对话，[^"\n]*"\)/);
  assert.match(appSource, /account\.user \? \(usesTangRecords\(doctor\) \? "将对话与心理自评保存在账户中[^"\n]*" : "将对话历史保存在账户中/);
});

test('only non-Tang unified home resources use factual FAQ headings', () => {
  assert.match(appSource, /unified && !isTang \? "FAQ" : "WEEKLY FOCUS"/);
  assert.match(appSource, /unified && !isTang \? "常见问题" : "本周大家最关心"/);
});

test('empty non-Tang unified education bypasses article and video headings', () => {
  assert.match(appSource, /const educationEmpty = unified && !tang && !doctor\.articles\.length && !custom\?\.videos\.length\s*&& !doctor\.content\.some\(item => item\.type === "article" \|\| item\.type === "faq"\)/);
  assert.match(appSource, /tangPanel === "科普宣教" \|\| tangPanel === "健康宣教" \? educationEmpty \? <p className="tang-svc-note">内容待医生提供<\/p> : unified \? <TangEducationPanel/);
});

test('Chen clinic names the hospital and sends unconfirmed times to the booking page', () => {
  assert.deepEqual(doctorCustoms[chen.slug].bio.clinics, [{ campus: '杭州市中医院', times: ['院区和时间请以医院当日预约页面为准'] }]);
});

test('Chen home keeps ENT identity and uses the Tang article cards', () => {
  const experience = doctorExperiences[chen.slug];
  assert.equal(experience.tagline, '畅快呼吸 · 清晰聆听');
  assert.equal(experience.eyebrow, 'ENT CARE JOURNEY');
  assert.equal(experience.primaryTitle, '耳鼻喉症状记录');
  assert.match(appSource, /\(tangBio \? tangBio.tags : doctor.topics.slice\(0, 3\)\)/);
  assert.match(appSource, /<span className="journey-eyebrow">\{experience.eyebrow\}<\/span>/);
  assert.match(appSource, /<b>\{experience.tagline\}<\/b>/);
  assert.doesNotMatch(appSource, /ChenArticleCard/);
});

const specialtyReply = async message => (await unified.generateChatReply({ doctor: chen, message, env: {}, fetchImpl: offline }).catch(error => {
  assert.equal(error.code, 'AI_NOT_CONFIGURED', message);
  return null;
}))?.reply ?? null;

test('Chen specialty rules catch the spoken forms missed when the model is unavailable', async () => {
  for (const [message, action] of [
    ['今早一侧听不清', '当天'], ['今天早上左耳听不见了', '当天'], ['听力骤降', '当天'], ['说话含糊', '120'],
    ['头晕。说话含糊', '120'], ['扁桃体术后新鲜出血', '120'], ['孩子把钮扣电池塞进鼻子', '120'], ['孩子喉鸣发紫', '120'],
    ['孩子喉鸣', '急诊'], ['眼周肿视物模糊', '120'], ['鼻血止不住', '120'], ['流了很多鼻血', '120'],
  ]) {
    const reply = await specialtyReply(message);
    assert.ok(reply, message);
    assert.ok(reply.includes(action), message);
  }
});

test('Chen specialty rules do not fire on ordinary or past-tense wording', async () => {
  for (const message of ['鼻血不多，鼻涕很多', '鼻涕很多，鼻血不多', '以前鼻血很多，今天问鼻塞', '孩子从小说话含糊', '扁桃体术后多久会出血', '什么是纽扣电池', ...chen.articles.map(article => article.title)]) {
    assert.equal(await specialtyReply(message), null, message);
  }
});

test('Chen quick questions cover five directions and his field summary only lists numbers', async () => {
  assert.equal(chen.quickQuestions.length, 5);
  const { buildFieldVisitSummary } = await import('../src/features/services/visitSummary.mjs');
  const { getSpecialtyRecordConfig } = await import('../src/lib/specialtyRecords.ts');
  const fields = getSpecialtyRecordConfig(chen.slug).fields;
  assert.equal(buildFieldVisitSummary([], { today: '2026-11-04', fields }), null);
  const summary = buildFieldVisitSummary([
    { dateKey: '2026-11-03', measurements: { tinnitusScore: 4 }, note: '午后明显' },
    { dateKey: '2026-11-04', measurements: { tinnitusScore: 6, vertigoAttackCount: 1 } },
    { dateKey: '2026-01-01', measurements: { tinnitusScore: 10 } },
  ], { today: '2026-11-04', fields, questions: '要不要复查听力' });
  assert.match(summary, /有记录 2 天/);
  assert.match(summary, /耳鸣自评分：5 分/);
  assert.match(summary, /午后明显/);
  assert.match(summary, /要不要复查听力/);
  assert.doesNotMatch(summary, /好转|恶化|加重/);
});

test('Chen education bodies stay free of doses and every article has a named source', async () => {
  const { chenArticleDetails, chenDemoReply } = await import('../src/features/services/chenEducation.ts');
  for (const detail of Object.values(chenArticleDetails)) {
    assert.ok(detail.source);
    assert.doesNotMatch(detail.body.join(''), /\d+\s*(?:mg|毫克|片|粒|喷)|每日.次|泼尼松|地塞米松|方药|倍他司汀/);
  }
  for (const question of [...chen.quickQuestions, ...chen.articles.map(article => article.title)]) {
    assert.match(chenDemoReply(question), /演示回答/);
    assert.doesNotMatch(chenDemoReply(question), /暂时无法回答/, question);
  }
});

test('Chen bio shows nothing marked unconfirmed', () => {
  assert.doesNotMatch(JSON.stringify(doctorCustoms[chen.slug].bio), /待确认|待医生/);
  assert.deepEqual(doctorCustoms[chen.slug].expertSections, []);
});
