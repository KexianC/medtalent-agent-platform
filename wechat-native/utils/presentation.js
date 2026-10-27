'use strict';

// These are the same Phosphor icon names used by the H5. The build creates native PNGs.
const iconAliases = {
  child: 'baby', endocrine: 'drop', ent: 'ear', respiratory: 'wind', oncology: 'plusCircle',
  digestive: 'firstAid', mental: 'brain', arrow: 'arrowRight', caretRight: 'chevron',
  shieldCheck: 'shield', chatCircleDots: 'chat',
  firstAidKit: 'firstAid', genderFemale: 'women', chartLineUp: 'chart',
  bookmark: 'book', userCircle: 'user', house: 'home', squaresFour: 'services', squares: 'services',
  notePencil: 'edit', trash: 'delete', floppyDisk: 'save', microphone: 'mic',
  paperPlane: 'send', speakerHigh: 'speaker', lockKey: 'lock', x: 'close',
};
function icon(name, tone) {
  return '/assets/icons/' + (iconAliases[name] || name || 'clipboard') + '-' + (tone || 'ink') + '.png';
}
function assetUrl(path) {
  if (!path) return '';
  // Bundled brand and illustration assets stay local; published portraits remain server managed.
  if (/^\/assets\/(brand|icons)\//.test(path) || /\/fu-growth-(hero|curve)\.png$/.test(path)) return path;
  try { return require('./runtime').getRuntime().api.assetUrl(path); } catch (_) { return path; }
}
function genericExperience(doctor) {
  const accent = /^#[0-9a-f]{6}$/i.test(doctor.accent) ? doctor.accent : '#4e988f';
  return {
    tagline: doctor.specialty || '健康知识 · 日常陪伴', eyebrow: 'PERSONAL HEALTH JOURNEY',
    heroIcon: 'clipboard', primaryTitle: '每日健康记录',
    primarySubtitle: '整理身体感受、生活习惯和想咨询的问题，帮助自己看清变化。',
    cta: '开始记录今天的状态',
    metric: { label: '近 7 日记录完成度', value: '0 / 7 天', note: '完成记录后显示真实进度', progress: 0 },
    steps: [
      { icon: 'clipboard', title: '记录当前状态', description: '记下身体感受、出现时间与变化' },
      { icon: 'calendar', title: '梳理生活习惯', description: '补充睡眠、饮食、活动等信息' },
      { icon: 'stethoscope', title: '准备咨询问题', description: '整理需要向专业人员了解的事项' },
    ],
    concerns: (doctor.quickQuestions && doctor.quickQuestions.length ? doctor.quickQuestions : ['如何整理健康问题，方便线下咨询？', '日常健康记录应该包含哪些信息？']).slice(0, 2).map(title => ({ icon: 'clipboard', title, description: '进入智能问答，进一步了解相关信息' })),
    reminder: '记录仅供个人梳理和就医准备，不替代专业诊疗。',
    theme: { accent, accentStrong: '#31564f', accentRgb: [1, 3, 5].map(p => parseInt(accent.slice(p, p + 2), 16)).join(', '), surface: doctor.accentSoft || '#eaf5ef', canvas: '#f7f3ea', ink: '#143c38' },
  };
}
function portraitCropStyle(doctor, naturalWidth, naturalHeight, width, height) {
  const scale = Math.max(width / naturalWidth, height / naturalHeight);
  const imageWidth = naturalWidth * scale; const imageHeight = naturalHeight * scale;
  const positions = (doctor.portraitPosition || '50% 50%').split(/\s+/).map(part => /%$/.test(part) ? Math.min(100, Math.max(0, parseFloat(part))) / 100 : 0.5);
  return 'position:absolute;width:' + imageWidth + 'px;height:' + imageHeight + 'px;left:' + ((width - imageWidth) * positions[0]) + 'px;top:' + ((height - imageHeight) * (positions[1] === undefined ? 0.5 : positions[1])) + 'px;';
}
const knowledgeFocus = {
  'fu-junfen': '儿童糖尿病与生长发育科普', 'chen-zhiling': '鼻炎、听力与耳鼻喉健康科普',
  'gong-wenbo': '代谢健康与中医生活调养科普', 'chen-jinbiao': '肿瘤健康知识与康复科普',
  'wu-yuqin': '体重管理与健康生活方式科普', 'lin-jinfang': '女性生殖内分泌健康科普',
  'luo-jun': '肝胆肿瘤介入知识科普', 'yu-weihua': '胃肠肝胆与代谢健康科普',
  'zhou-yong': '呼吸健康与肺部疾病科普', 'yu-wen': '睡眠、情绪与认知健康科普',
  'tang-jinsong': '精神心理、睡眠与早期干预科普',
};
function decorateDoctor(doctor) {
  return Object.assign({}, doctor, {
    initial: (doctor.name || '').slice(0, 1), portraitUrl: assetUrl(doctor.portrait),
    portraitStyle: 'transform:translateY(' + (doctor.portraitTranslateY || '0%') + ') scale(' + (doctor.portraitScale || 1) + ');transform-origin:' + (doctor.portraitTransformOrigin || '50% 50%') + ';',
    portraitBackground: doctor.portraitBackground || doctor.accentSoft,
    focus: knowledgeFocus[doctor.slug] || doctor.specialty || doctor.intro || '',
  });
}
function formatText(text) {
  return String(text || '').replace(/\*\*/g, '').replace(/^#{1,6}\s+/gm, '').replace(/^---+$/gm, '').replace(/^[-*]\s+/gm, '• ').trim();
}
function sheetGeometry(info, maxHeight) {
  const height = Number(info.windowHeight) || 812;
  const inset = info.safeArea ? Math.max(0, (Number(info.screenHeight) || height) - Number(info.safeArea.bottom)) : 0;
  const safe = Number.isFinite(inset) ? inset : 0;
  const stage = Math.max(1, height - (Number(info.statusBarHeight) || 20) - 44 - safe);
  const source = typeof maxHeight === 'number' ? Math.min(stage * 0.88, maxHeight) : stage * 0.88;
  return { totalHeight: source + safe, scrollHeight: Math.max(120, Math.floor(source - 41)) };
}
function sheetMaxHeight(maxHeight) {
  let info = {};
  try { info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(); } catch (_) { /* The fallback remains bounded during host startup. */ }
  return sheetGeometry(info, maxHeight).scrollHeight;
}
function fitSheet(component, maxHeight, preserveFraction) {
  const current = () => component.data && !component._sheetFitUnavailable && component.data.sheetMotion !== 'sheet-exit' && (component.data.sheetOpen || component.data.selected || component.data.selectedService);
  if (!component.createSelectorQuery || !current()) return;
  const scope = () => {
    const data = component.data, props = component.properties || {};
    return JSON.stringify([props.doctor && props.doctor.slug, props.ownerKey, props.mode, data.selected && data.selected.id, data.selectedService && data.selectedService.title, data.saved]);
  };
  const expectedScope = scope(), revision = (component._sheetFitRevision || 0) + 1;
  component._sheetFitRevision = revision;
  component.createSelectorQuery().select('.sheet-content').boundingClientRect().exec(results => {
    if (!current() || revision !== component._sheetFitRevision || scope() !== expectedScope || !results || !results[0]) return;
    // CSS applies the live viewport cap. Keeping natural height here lets an
    // already-open sheet expand again after a keyboard or window resize.
    const measured = Number(results[0].height);
    if (!Number.isFinite(measured) || measured <= 0) return;
    const height = preserveFraction === true ? measured : Math.ceil(measured);
    if (height !== component.data.sheetHeight) component.setData({ sheetHeight: height });
  });
}
const wellnessFeatures = [
  { id: 'diary', title: '睡眠与情绪日记', description: '记录睡眠、心情和今天的感受', icon: 'moon', section: 'manage' },
  { id: 'breathing', title: '呼吸放松', description: '跟随节奏，给自己片刻安静', icon: 'wind', section: 'services' },
  { id: 'meditation', title: '冥想课程', description: '聆听引导，回到当下', icon: 'headphones', section: 'services' },
  { id: 'assessment', title: '心理自评', description: '用完整问答了解近期感受', icon: 'clipboard', section: 'services' },
  { id: 'goals', title: '我的目标与打卡', description: '从一个自己能做到的小目标开始', icon: 'run', section: 'manage' },
  { id: 'report', title: '健康趋势报告', description: '回看自己的记录与变化', icon: 'chart', section: 'manage' },
  { id: 'health', title: '生理健康记录', description: '记录步数、体重和日常指标', icon: 'heart', section: 'manage' },
  { id: 'mbti', title: 'MBTI 趣味探索', description: '了解自己的偏好，没有标准答案', icon: 'brain', section: 'services' },
  { id: 'cards', title: '趣味占卜卡', description: '随机抽一张卡，换个角度想一想', icon: 'sparkle', section: 'services' },
];
module.exports = { icon, assetUrl, genericExperience, createGenericExperience: genericExperience, decorateDoctor, portraitCropStyle, knowledgeFocus, formatText, sheetGeometry, sheetMaxHeight, fitSheet, wellnessFeatures };
