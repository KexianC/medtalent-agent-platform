import assert from 'node:assert/strict';
import test from 'node:test';
import { TANG_MOODS } from '../tang/guidanceModel.ts';
import { demoReply, DEMO_PREFIX } from './demoReplies.mjs';

test('every demo reply is labelled as a demo', () => {
  for (const question of ['第一次精神科就诊要准备什么？', '随便问问']) assert.ok(demoReply(question).startsWith(DEMO_PREFIX));
});

test('an unknown question admits the limit and keeps the emergency line', () => {
  const reply = demoReply('随便问问');
  assert.match(reply, /暂时无法回答/);
  assert.match(reply, /120/);
});

test('demo replies never suggest changing medication', () => {
  for (const question of ['我想了解抑郁症', '我想了解焦虑障碍', '长期失眠需要关注哪些信号？']) assert.doesNotMatch(demoReply(question), /加药|减药|停药|服用.*毫克/);
});

test('mood and scale messages get their own demo reply without a diagnosis', () => {
  assert.match(demoReply('我今天心情很低落，想找人聊聊。请先陪我说说此刻的感受。'), /谢谢你告诉我/);
  assert.match(demoReply('我今天有点焦虑，想一起梳理让我不安的事情。'), /谢谢你告诉我/);
  const reply = demoReply('我完成了焦虑自评 GAD-7，回顾的是近两周的感受，得分 7/21 分');
  assert.match(reply, /不能用于诊断/);
  assert.match(reply, /120/);
});

test('home article titles reuse a demo reply instead of the fallback', () => {
  for (const title of ['长期失眠，需要关注哪些信号？', '睡眠问题持续多久，建议寻求专业帮助？', '焦虑不只是“想太多”', '陪伴情绪低落的家人，可以从倾听开始']) assert.doesNotMatch(demoReply(title), /暂时无法回答/);
});

test('the five mood messages have distinct labelled replies with emergency guidance', () => {
  const replies = TANG_MOODS.map(mood => demoReply(mood.message));
  assert.equal(replies.length, 5);
  assert.equal(new Set(replies).size, 5);
  for (const reply of replies) {
    assert.ok(reply.startsWith(DEMO_PREFIX));
    assert.match(reply, /如遇紧急情况，请立即拨打 120 或前往急诊。/);
    assert.doesNotMatch(reply, /药物|用药|诊断为|联系你/);
  }
  for (const mood of TANG_MOODS.filter(mood => ['neutral', 'good', 'bright'].includes(mood.id))) {
    const reply = demoReply(mood.message);
    assert.doesNotMatch(reply, /低落|门诊|评估/);
    assert.match(reply, /？/);
  }
});

test('low and anxious mood replies ask about sleep, duration and daily impact', () => {
  for (const mood of TANG_MOODS.filter(mood => ['low', 'tense'].includes(mood.id))) {
    const reply = demoReply(mood.message);
    assert.ok(reply.startsWith(DEMO_PREFIX + '谢谢你告诉我'));
    assert.match(reply, /睡/);
    assert.match(reply, /持续多久/);
    assert.match(reply, /日常生活.*影响/);
    assert.match(reply, /持续或影响生活.*门诊当面评估/);
  }
  const lowReply = demoReply(TANG_MOODS.find(mood => mood.id === 'low').message);
  assert.match(lowReply, /不想活或伤害自己的想法，可拨打 12356/);
  assert.match(lowReply, /如已伤害自己或无法保证安全，请立即拨打 120/);
});

test('only complete mood messages select specific replies; other mood text keeps MOOD', () => {
  const genericMood = demoReply('我今天想聊点别的。');
  assert.match(genericMood, /谢谢你告诉我.*如果情绪持续低落/);
  for (const mood of TANG_MOODS) {
    assert.equal(demoReply(mood.message.slice(0, -1)), genericMood);
    assert.equal(demoReply(mood.message + '补充'), genericMood);
  }
});
