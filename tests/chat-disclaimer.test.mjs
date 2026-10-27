import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_DISCLAIMER,
  createChatDisclaimerFilter,
  splitChatDisclaimer,
  stripChatDisclaimer,
} from '../src/lib/chatDisclaimer.ts';

const notices = [
  CHAT_DISCLAIMER,
  '以上内容仅供健康参考，不构成诊断或治疗建议。',
  '以上内容仅供健康参考',
  '以上内容仅供健康参考。',
  '以上内容仅供健康科普参考',
  '以上内容仅供健康（科普）参考，不构成诊断或治疗建议。',
  '以上内容仅供健康(科普)参考,不构成诊断或治疗建议.',
  '以上内容仅供健康科普参考，不构成诊断或治疗建议',
];

test('the fixed footer keeps the canonical server wording', () => {
  assert.equal(CHAT_DISCLAIMER, '以上内容仅供健康科普参考，不构成诊断或治疗建议。');
});

test('complete and historical short notices become one canonical footer', () => {
  for (const notice of notices) {
    assert.deepEqual(splitChatDisclaimer(`可以先固定起床时间。\n\n${notice}`), {
      body: '可以先固定起床时间。', disclaimer: CHAT_DISCLAIMER,
    });
    assert.equal(stripChatDisclaimer(`可以先固定起床时间。\n\n${notice}`), '可以先固定起床时间。');
    assert.deepEqual(splitChatDisclaimer(notice), { body: '', disclaimer: CHAT_DISCLAIMER });
  }
});

test('ordinary content is emitted immediately without waiting for a whole sentence', () => {
  const filter = createChatDisclaimerFilter();
  assert.equal(filter.push('听起来你最近很辛苦'), '听起来你最近很辛苦');
  assert.equal(filter.push('，可以先慢慢呼吸。'), '，可以先慢慢呼吸。');
  assert.equal(filter.hasDisclaimer, false);
  assert.equal(filter.finish(), '');
});

test('every split boundary keeps all notice characters out of text and speech increments', () => {
  const body = '你好🙂，我们可以先聊聊今天的感受。\n\n';
  for (const notice of notices) {
    for (let split = 0; split <= notice.length; split += 1) {
      const filter = createChatDisclaimerFilter();
      const first = filter.push(body + notice.slice(0, split));
      assert.equal(first, body, `${notice}: first delta ending at ${split}`);
      const second = filter.push(notice.slice(split));
      assert.equal(second, '', `${notice}: second delta starting at ${split}`);
      assert.equal(filter.finish(), '', `${notice}: final flush at ${split}`);
      assert.equal(filter.hasDisclaimer, true);
    }
  }
});

test('single character deltas and all fixed widths preserve normal content and remove the notice', () => {
  for (const notice of notices) {
    const text = `你好🙂。\n\n${notice}\n`;
    for (let width = 1; width <= text.length; width += 1) {
      const filter = createChatDisclaimerFilter();
      let emitted = '';
      for (let index = 0; index < text.length; index += width) {
        const next = filter.push(text.slice(index, index + width));
        assert.doesNotMatch(next, /仅供健康|诊断或治疗/u);
        emitted += next;
      }
      emitted += filter.finish();
      assert.equal(emitted, '你好🙂。\n\n\n');
      assert.equal(filter.hasDisclaimer, true);
    }
  }
});

test('only a potential fixed prefix waits, and mismatched normal wording is released', () => {
  const filter = createChatDisclaimerFilter();
  assert.equal(filter.push('正文。以'), '正文。');
  assert.equal(filter.push('上内容仅供健康'), '');
  assert.equal(filter.push('教育使用，请及时就医。'), '以上内容仅供健康教育使用，请及时就医。');
  assert.equal(filter.finish(), '');
  assert.equal(filter.hasDisclaimer, false);
});

test('normal health advice, quoted notices and crisis instructions are not broadly deleted', () => {
  const replies = [
    '',
    '  建议先保持规律作息。\n',
    '这不构成诊断或治疗建议，具体情况需要线下评估。',
    '以上内容仅供健康参考资料整理使用，请带去医院。',
    '以上内容仅供健康参考价值讨论，不构成其他用途。',
    '“以上内容仅供健康参考”这句话说明资料的用途。',
    `请阅读这句说明：“${CHAT_DISCLAIMER}”`,
    '如果以上内容仅供健康参考，那么还需要明确适用范围。',
    '如果你正有伤害自己的念头，请立即联系120或110，远离可能伤害自己的物品，并请信任的人陪在身边。',
  ];
  for (const text of replies) {
    assert.deepEqual(splitChatDisclaimer(text), { body: text, disclaimer: null });
    const filter = createChatDisclaimerFilter();
    let result = '';
    for (const character of text) result += filter.push(character);
    result += filter.finish();
    assert.equal(result, text);
    assert.equal(filter.hasDisclaimer, false);
  }
});

test('crisis response body survives when followed by the platform footer', () => {
  const crisis = '你现在的安全最重要。请立即联系120或110，并请信任的人陪着你，不要独自承受。';
  assert.deepEqual(splitChatDisclaimer(`${crisis}\n\n${CHAT_DISCLAIMER}`), {
    body: crisis, disclaimer: CHAT_DISCLAIMER,
  });
});

test('multiple fixed notices collapse into one footer while subsequent advice survives', () => {
  const text = `先慢慢呼吸。${CHAT_DISCLAIMER}\n\n之后也可以记录一下睡眠。\n以上内容仅供健康参考。`;
  assert.deepEqual(splitChatDisclaimer(text), {
    body: '先慢慢呼吸。\n\n之后也可以记录一下睡眠。', disclaimer: CHAT_DISCLAIMER,
  });
});

test('trailing spaces, line boundaries and an unfinished ordinary prefix are handled explicitly', () => {
  assert.deepEqual(splitChatDisclaimer('建议规律作息。\n以上内容仅供健康参考 \t'), {
    body: '建议规律作息。', disclaimer: CHAT_DISCLAIMER,
  });
  const filter = createChatDisclaimerFilter();
  assert.equal(filter.push('以上内容仅供健康'), '');
  assert.equal(filter.finish(), '以上内容仅供健康');
  assert.equal(filter.hasDisclaimer, false);
  assert.equal(filter.finish(), '');
  assert.equal(filter.push('late callback'), '');
});

test('a canceled reply can be discarded without leaking its held notice into a new reply', () => {
  const canceled = createChatDisclaimerFilter();
  assert.equal(canceled.push('建议规律作息。\n以上内容仅供健康科普参'), '建议规律作息。\n');
  // Cancellation deliberately does not finish/flush the abandoned instance.
  const next = createChatDisclaimerFilter();
  assert.equal(next.push('新的回答。'), '新的回答。');
  assert.equal(next.finish(), '');
  assert.equal(next.hasDisclaimer, false);
});

const decoratedNotices = [
  `**${CHAT_DISCLAIMER}**`,
  `__${CHAT_DISCLAIMER}__`,
  `# ${CHAT_DISCLAIMER}`,
  `### ${CHAT_DISCLAIMER}`,
  `###### **${CHAT_DISCLAIMER}**`,
  `- ${CHAT_DISCLAIMER}`,
  `* ${CHAT_DISCLAIMER}`,
  `+ ${CHAT_DISCLAIMER}`,
  `1. ${CHAT_DISCLAIMER}`,
  `12) ${CHAT_DISCLAIMER}`,
  `- **${CHAT_DISCLAIMER}**`,
  `提醒：${CHAT_DISCLAIMER}`,
  `提醒: ${CHAT_DISCLAIMER}`,
  `温馨提示：${CHAT_DISCLAIMER}`,
  `**提醒：${CHAT_DISCLAIMER}**`,
  `提醒：**${CHAT_DISCLAIMER}**`,
  `提醒： **${CHAT_DISCLAIMER}**`,
  `- **温馨提示：${CHAT_DISCLAIMER}**`,
  '**以上内容仅供健康参考**。',
  '**以上内容仅供健康参考**',
  '- 以上内容仅供健康参考',
  `**${CHAT_DISCLAIMER}`,
  `**${CHAT_DISCLAIMER}*`,
];

test('Markdown and reminder labels are removed with the notice without empty list or heading markers', () => {
  for (const notice of decoratedNotices) {
    assert.deepEqual(splitChatDisclaimer(`建议规律作息。\n\n${notice}`), {
      body: '建议规律作息。', disclaimer: CHAT_DISCLAIMER,
    }, notice);
    assert.deepEqual(splitChatDisclaimer(notice), { body: '', disclaimer: CHAT_DISCLAIMER }, notice);
  }
});

test('every decorated-notice split keeps its text and Markdown markers out of streamed output', () => {
  const body = '请先慢慢呼吸。\n\n';
  for (const notice of decoratedNotices) {
    for (let split = 0; split <= notice.length; split += 1) {
      const filter = createChatDisclaimerFilter();
      assert.equal(filter.push(body + notice.slice(0, split)), body, `${notice}: opening split ${split}`);
      assert.equal(filter.push(notice.slice(split)), '', `${notice}: closing split ${split}`);
      assert.equal(filter.finish(), '', `${notice}: final split ${split}`);
      assert.equal(filter.hasDisclaimer, true);
    }
    const filter = createChatDisclaimerFilter();
    assert.equal(filter.push(body), body);
    for (const character of notice) assert.equal(filter.push(character), '', `${notice}: character ${character}`);
    assert.equal(filter.finish(), '');
    assert.equal(filter.hasDisclaimer, true);
  }
});

test('real headings, list advice, labels, emphasis and crisis contact numbers stay intact', () => {
  const replies = [
    '# 健康建议\n- 可以先保持规律作息。\n- 如果持续不适，请及时就医。',
    '### **睡眠记录**\n1. 记录入睡时间。\n12) 向医生说明近期用药。',
    '**你现在的安全最重要。**\n提醒：请立即联系120或110，请信任的人陪在身边。',
    '温馨提示：建议只是一般健康信息，不能代替医生对具体情况的判断。',
    '提醒：以上内容仅供健康参考资料整理使用，请带去医院。',
    '- **以上内容仅供健康参考资料整理使用**。',
    '以上内容仅供健康科普参考价值讨论。',
  ];
  for (const reply of replies) {
    assert.deepEqual(splitChatDisclaimer(reply), { body: reply, disclaimer: null });
    const filter = createChatDisclaimerFilter();
    let emitted = '';
    for (const character of reply) emitted += filter.push(character);
    emitted += filter.finish();
    assert.equal(emitted, reply);
    assert.equal(filter.hasDisclaimer, false);
  }
});

test('quoted and fenced examples are preserved, while a later actual footer is removed', () => {
  const examples = [
    `> ${CHAT_DISCLAIMER}\n> 这是引用内容。`,
    `> **${CHAT_DISCLAIMER}**`,
    `请阅读：“**${CHAT_DISCLAIMER}**”`,
    `\`\`\`text\n${CHAT_DISCLAIMER}\n\`\`\``,
    `~~~text\n**${CHAT_DISCLAIMER}**\n~~~`,
    `~~~~text\n~~~\n${CHAT_DISCLAIMER}\n~~~~`,
  ];
  for (const example of examples) {
    assert.deepEqual(splitChatDisclaimer(example), { body: example, disclaimer: null });
    const text = `${example}\n\n提醒：${CHAT_DISCLAIMER}`;
    assert.deepEqual(splitChatDisclaimer(text), { body: example, disclaimer: CHAT_DISCLAIMER });
    const filter = createChatDisclaimerFilter();
    let emitted = '';
    for (const character of text) emitted += filter.push(character);
    emitted += filter.finish();
    assert.equal(emitted, `${example}\n\n`);
  }
});
