import type { PlatformAgent } from './platformApi';
export type SavedEditorDraft = { version: 1; owner: string; slug: string; savedAt: string; baseHash: string; agent: PlatformAgent };
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const prefix = 'medtalent:admin-editor:v1:';
export const editorDraftKey = (owner: string, slug: string) => { if (!owner || !slug) throw new Error('草稿暂存缺少账户或智能体标识。'); return prefix + encodeURIComponent(owner) + ':' + encodeURIComponent(slug); };
export function readEditorDraft(storage: DraftStorage, owner: string, slug: string): SavedEditorDraft | null {
  const raw = storage.getItem(editorDraftKey(owner, slug)); if (!raw) return null;
  let value: SavedEditorDraft; try { value = JSON.parse(raw); } catch { throw new Error('本地暂存格式异常，可选择丢弃后重新编辑。'); }
  if (value.version !== 1 || value.owner !== owner || value.slug !== slug || !value.agent || value.agent.slug !== slug || typeof value.baseHash !== 'string' || !Number.isFinite(Date.parse(value.savedAt))) throw new Error('本地暂存校验未通过，不能恢复到当前账户。');
  return value;
}
export function writeEditorDraft(storage: DraftStorage, owner: string, agent: PlatformAgent, baseHash: string, date = new Date()): SavedEditorDraft {
  const saved: SavedEditorDraft = { version: 1, owner, slug: agent.slug, savedAt: date.toISOString(), baseHash, agent: structuredClone(agent) };
  storage.setItem(editorDraftKey(owner, agent.slug), JSON.stringify(saved)); return saved;
}
export const discardEditorDraft = (storage: DraftStorage, owner: string, slug: string) => storage.removeItem(editorDraftKey(owner, slug));
