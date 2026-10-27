import { useEffect, useState } from 'react';
import type { PlatformAgent } from './platformApi';
import { discardEditorDraft, readEditorDraft, writeEditorDraft, type SavedEditorDraft } from './editorDrafts';
export function useEditorAutosave({ owner, agent, dirty, canEdit, baseHash }: { owner?: string; agent: PlatformAgent; dirty: boolean; canEdit: boolean; baseHash: string }) {
  const [initial] = useState(() => { try { return { saved: owner && canEdit ? readEditorDraft(window.localStorage, owner, agent.slug) : null, error: '' }; } catch (error) { return { saved: null, error: error instanceof Error ? error.message : '当前浏览器不能读取暂存。' }; } });
  const [recovery, setRecovery] = useState<SavedEditorDraft | null>(initial.saved); const [error, setError] = useState(initial.error); const [savedAt, setSavedAt] = useState('');
  const discard = () => { if (owner) { try { discardEditorDraft(window.localStorage, owner, agent.slug); setError(''); } catch { setError('浏览器拒绝删除暂存，请检查本地存储权限。'); return false; } } setRecovery(null); setSavedAt(''); return true; };
  useEffect(() => {
    if (!owner || !canEdit || recovery) return;
    if (!dirty) return;
    const timer = window.setTimeout(() => { try { const value = writeEditorDraft(window.localStorage, owner, agent, baseHash); setSavedAt(value.savedAt); setError(''); } catch { setError('本地自动暂存失败。当前编辑仍在页面中，请保存到服务器或导出配置。'); } }, 700);
    return () => window.clearTimeout(timer);
  }, [owner, agent, dirty, canEdit, recovery, baseHash]);
  return { recovery, error, savedAt, discard, consume: () => setRecovery(null) };
}
