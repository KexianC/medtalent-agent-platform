'use strict';
const { spring, calcGeneratorDuration, cubicBezier } = require('./models/motion');
const { noticeSpring, noticeOpacityDuration, noticeOpacityEase, noticeDistance } = require('./home-motion-config');
const states = new WeakMap();
const frameDuration = 16;
const opacityEase = cubicBezier(...noticeOpacityEase);
const clampOpacity = value => Math.max(0, Math.min(1, value));
const selector = '.journey-notice';
const style = (y, opacity) => 'opacity:' + clampOpacity(opacity) + ';transform:translateY(' + y + 'px);';
const clearNative = component => {
  if (typeof component.clearAnimation === 'function') component.clearAnimation(selector, { opacity: true, translateY: true });
};

function currentMotion(motion, now) {
  if (!motion) return { y: -noticeDistance, opacity: 0, velocity: 0 };
  const elapsed = Math.max(0, now - motion.start);
  let y = motion.targetY, velocity = 0;
  if (elapsed < motion.springDuration) {
    const delta = Math.min(elapsed, frameDuration);
    const previous = motion.generator.next(elapsed - delta).value;
    y = motion.generator.next(elapsed).value;
    // Approximate MotionValue's previous RAF sample (its maximum delta is 30ms).
    velocity = delta ? (y - previous) * 1000 / delta : 0;
  }
  const progress = Math.min(1, elapsed / noticeOpacityDuration);
  return { y, velocity, opacity: motion.opacityFrom + (motion.opacityTarget - motion.opacityFrom) * opacityEase(progress) };
}

function resetNotice(component) {
  const state = states.get(component);
  if (!state) return;
  state.run += 1;
  clearTimeout(state.timer);
  clearNative(component);
  states.delete(component);
}

function transitionNotice(component, open) {
  let state = states.get(component);
  if (!state) { state = { run: 0, timer: null, motion: null }; states.set(component, state); }
  clearTimeout(state.timer); state.timer = null;
  const run = ++state.run, now = Date.now();
  const current = currentMotion(state.motion, now);
  const targetY = open ? 0 : -noticeDistance, opacityTarget = open ? 1 : 0;
  const options = Object.assign({}, noticeSpring, { keyframes: [current.y, targetY], velocity: current.velocity });
  const springDuration = calcGeneratorDuration(spring(options));
  const duration = Math.max(springDuration, noticeOpacityDuration);
  const generator = spring(options);
  const valid = () => states.get(component) === state && run === state.run;
  if (component.properties && component.properties.reduceMotion) {
    clearNative(component);
    state.motion = { start: now, springDuration: 0, targetY, opacityFrom: opacityTarget, opacityTarget };
    component.setData({ noticeOpen: open, noticeMounted: open, noticeStyle: style(targetY, opacityTarget), noticeAnimation: {}, noticeAnimationFallback: false, noticeMotion: '' });
    return 0;
  }
  const native = typeof component.animate === 'function' && typeof component.clearAnimation === 'function';
  let finished = false;
  const finish = () => {
    if (!valid() || finished) return;
    finished = true;
    clearTimeout(state.timer); state.timer = null;
    if (!open) {
      clearNative(component); state.motion = null;
      component.setData({ noticeMounted: false, noticeStyle: '', noticeMotion: '' });
    } else component.setData({ noticeStyle: style(targetY, opacityTarget) }, () => { if (valid()) clearNative(component); });
  };
  // A wx:if node must exist in the view before native keyframes are submitted.
  // One keyframe animation avoids createAnimation's queued zero-duration step.
  component.setData({ noticeOpen: open, noticeMounted: true, noticeStyle: native ? style(current.y, current.opacity) : '', noticeAnimation: {}, noticeAnimationFallback: !native, noticeMotion: native ? '' : open ? 'home-notice-enter' : 'home-notice-exit' }, () => {
    if (!valid()) return;
    clearNative(component);
    state.motion = { start: Date.now(), generator, springDuration, targetY, opacityFrom: current.opacity, opacityTarget };
    state.timer = setTimeout(finish, duration);
    if (!native) return;
    const frames = [];
    for (let time = 0;; time = Math.min(time + frameDuration, duration)) {
      frames.push({ offset: time / duration, ease: 'linear', translateY: time >= springDuration ? targetY : generator.next(time).value, opacity: clampOpacity(current.opacity + (opacityTarget - current.opacity) * opacityEase(Math.min(1, time / noticeOpacityDuration))) });
      if (time === duration) break;
    }
    component.animate(selector, frames, duration, finish);
  });
  return duration;
}

module.exports = { transitionNotice, resetNotice };
