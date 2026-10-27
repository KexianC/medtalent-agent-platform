function today(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function id(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
function number(value) { return value === undefined ? '暂无' : String(Math.round(value * 100) / 100); }
function dateTime(value) {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '日期未知';
}
function confirm(content) {
  return new Promise(resolve => wx.showModal({ title: '请确认', content, success: value => resolve(Boolean(value.confirm)), fail: () => resolve(false) }));
}
function scopeNotice(runtime, slug, section) {
  const meta = runtime.data.get(slug, section, null), account = runtime.session.get();
  if (account.user) {
    if (meta.status === 'synced') return '记录已同步到微信账户，可跨设备查看。';
    if (meta.status === 'conflict') return '记录与云端版本有冲突，请到“我的”选择保留版本。';
    if (['pending', 'saving', 'loading'].includes(meta.status)) return '正在同步到微信账户，完成后可跨设备查看。';
    return '记录尚未同步到微信账户，请联网后重试同步。';
  }
  return meta.status === 'ready' ? '记录保存在当前设备，仅供个人查看与整理。' : '当前更改尚未保存到本机，请重试保存。';
}
function linePlot(points, key) {
  const values = points.map(p => p.measurements ? p.measurements[key] : p.metrics && p.metrics[key]);
  const actual = values.filter(v => typeof v === 'number');
  const low = actual.length ? Math.min(...actual) : 0, high = actual.length ? Math.max(...actual) : 1;
  const y = v => low === high ? 78 : 130 - ((v - low) / (high - low)) * 104;
  return {
    hasData: actual.length > 0, flat: low === high, low: number(low), high: number(high),
    plotPoints: points.map((p, index) => ({ date: p.dateKey, label: p.label, value: values[index], display: number(values[index]), x: 38 + index * 258 / Math.max(1, points.length - 1), y: y(values[index]), filled: values[index] !== undefined })),
    plotLines: points.flatMap((p, index) => {
      if (index === 0 || values[index] === undefined || values[index - 1] === undefined) return [];
      return [{ x1: 38 + (index - 1) * 258 / Math.max(1, points.length - 1), x2: 38 + index * 258 / Math.max(1, points.length - 1), y1: y(values[index - 1]), y2: y(values[index]) }];
    }),
  };
}
function invalidatePlot(component, canvasId) {
  const paints = component._plotPaints;
  if (paints) delete paints[canvasId];
  if (component._alive !== false && component.data.plotImage) component.setData({ plotImage: '', plotImageReady: false });
}
function plotImageState(component, canvasId, event, failed) {
  const paint = component._plotPaints && component._plotPaints[canvasId], target = event.currentTarget.dataset;
  if (!paint || !paint.current() || paint.status === 'failed' || paint.token !== Number(target.token) || paint.path !== target.src || paint.path !== component.data.plotImage) return;
  paint.status = failed ? 'failed' : 'ready';
  component.setData(failed ? { plotImage: '', plotImageReady: false } : { plotImageReady: true });
}
function paintPlot(component, canvasId, plot, color, pointColor) {
  const paints = component._plotPaints || (component._plotPaints = Object.create(null));
  const owner = component.owner, slug = component.data && component.data.doctor && component.data.doctor.slug;
  const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(), ratio = info.pixelRatio || 1;
  const content = JSON.stringify(plot), key = JSON.stringify([owner, slug, content, color, pointColor, info.windowWidth, ratio]);
  // Visibility callbacks and unchanged record refreshes must not generate another temporary image.
  if (paints[canvasId] && paints[canvasId].key === key) return;
  const boundPlot = component.data && component.data.plot === plot;
  const paintState = { key, token: component._plotImageToken = (component._plotImageToken || 0) + 1, status: 'pending' };
  const current = paintState.current = () => paints[canvasId] === paintState && component._alive !== false && !component._pageHidden && owner === component.owner && slug === (component.data && component.data.doctor && component.data.doctor.slug) && (!boundPlot || JSON.stringify(component.data.plot) === content);
  paints[canvasId] = paintState;
  if (component.data.plotImage) component.setData({ plotImage: '', plotImageReady: false });
  if (!current()) return;
  const query = component.createSelectorQuery();
  query.select(`#${canvasId}`).fields({ node: true, size: true }).exec(results => {
    const found = results && results[0];
    if (!current()) return;
    if (!found || !found.node || !found.width || !found.height) { delete paints[canvasId]; return; }
    const canvas = found.node, ctx = canvas.getContext('2d');
    canvas.width = Math.round(found.width * ratio); canvas.height = Math.round(found.height * ratio);
    const paint = () => {
      if (!current()) return;
      const scale = ratio * found.width / 320;
      ctx.scale(scale, scale);
      ctx.clearRect(0, 0, 320, 165); ctx.strokeStyle = '#dfe7e3'; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      for (const y of [130, 26]) { ctx.beginPath(); ctx.moveTo(38, y); ctx.lineTo(296, y); ctx.stroke(); }
      ctx.setLineDash([]); ctx.font = '10px sans-serif'; ctx.fillStyle = '#64756e'; ctx.textAlign = 'right';
      ctx.fillText(plot.low, 30, plot.flat ? 82 : 134);
      if (!plot.flat) ctx.fillText(plot.high, 30, 30);
      for (let index = 0; index < plot.plotPoints.length; index++) {
        const point = plot.plotPoints[index], previous = plot.plotPoints[index - 1]; if (!point.filled) continue;
        if (previous && previous.filled) { ctx.strokeStyle = color || '#568876'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(previous.x, previous.y); ctx.lineTo(point.x, point.y); ctx.stroke(); }
        ctx.beginPath(); ctx.arc(point.x, point.y, 3.8, 0, Math.PI * 2); ctx.fillStyle = pointColor || color || '#568876'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      }
      ctx.fillStyle = '#64756e'; ctx.textAlign = 'left'; ctx.fillText(plot.plotPoints[0] && plot.plotPoints[0].label || '', 38, 154); ctx.textAlign = 'right'; ctx.fillText(plot.plotPoints[plot.plotPoints.length - 1] && plot.plotPoints[plot.plotPoints.length - 1].label || '', 296, 154);
      // The 2D backing pixels are correct even when an offscreen canvas has not
      // been composited. Present those same pixels as a native image when ready.
      if (typeof wx.canvasToTempFilePath !== 'function') { paintState.status = 'failed'; return; }
      try {
        wx.canvasToTempFilePath({ canvas, destWidth: canvas.width, destHeight: canvas.height, fileType: 'png', success(result) {
          if (!current() || paintState.status !== 'pending') return;
          if (!result.tempFilePath) { paintState.status = 'failed'; return; }
          paintState.status = 'loading';
          paintState.path = result.tempFilePath;
          component.setData({ plotImage: result.tempFilePath, plotImageToken: paintState.token, plotImageReady: false });
        }, fail() { if (current()) paintState.status = 'failed'; } }, component);
      } catch (_) { if (current()) paintState.status = 'failed'; }
    };
    // Submit after the native canvas has applied its backing-size reset.
    if (typeof canvas.requestAnimationFrame === 'function') canvas.requestAnimationFrame(paint);
    else paint();
  });
}
module.exports = { today, id, number, dateTime, confirm, scopeNotice, linePlot, paintPlot, invalidatePlot, plotImageState };
