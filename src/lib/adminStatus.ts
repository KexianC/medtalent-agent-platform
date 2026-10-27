export const ADMIN_STATUS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  draft: '草稿',
  published: '已发布',
  archived: '已归档',
  queued: '排队中',
  running: '执行中',
  processing: '处理中',
  review: '待审核',
  ready: '已生效',
  error: '失败',
  deleted: '已删除',
  completed: '已完成',
  failed: '失败',
  success: '成功',
  partial: '部分完成',
  idle: '尚未同步',
  configured: '已配置',
  not_configured: '未配置',
});

export function adminStatusLabel(value?: string) {
  const status = value || 'idle';
  return ADMIN_STATUS_LABELS[status] || status;
}
