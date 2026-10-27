import { createContext, useCallback, useContext, useMemo, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { useDoctorLocalState, type DoctorPersistenceMeta } from '../../hooks/useDoctorLocalState';
import { emptyWellnessState, type WellnessState } from './types';
import { useDoctorTemplatePreview } from '../../hooks/doctorPreview';
import { normalizeState } from './stateModel';

export const WELLNESS_TEMPLATE_READ_ONLY_NOTICE = "模板为只读预览，请先创建草稿后保存记录或自评结果。";
type WellnessContextValue = { readOnly: boolean; doctorName: string; state: WellnessState; setState: Dispatch<SetStateAction<WellnessState>>; persistence: DoctorPersistenceMeta };
const WellnessContext = createContext<WellnessContextValue | null>(null);
export function WellnessProvider({ children, doctorSlug = 'yu-wen', doctorName = '喻雯' }: { children: ReactNode; doctorSlug?: string; doctorName?: string }) {
  const readOnly = useDoctorTemplatePreview();
  const [stored, setState, persistence] = useDoctorLocalState(doctorSlug, 'wellness-v1', emptyWellnessState());
  const state = useMemo(() => normalizeState(stored), [stored]);
  const updateState = useCallback<Dispatch<SetStateAction<WellnessState>>>(next => { if (readOnly) return; setState(previous => normalizeState(typeof next === 'function' ? next(normalizeState(previous)) : next)); }, [readOnly, setState]);
  return <WellnessContext.Provider value={{ readOnly, doctorName, state, setState: updateState, persistence }}>{children}</WellnessContext.Provider>;
}
export function useWellness() {
  const value = useContext(WellnessContext);
  if (!value) throw new Error('WellnessProvider is required');
  return value;
}
export function WellnessStorageNotice() {
  const { persistence, readOnly } = useWellness();
  if (readOnly) return <div className="yw-notice" role="status">{WELLNESS_TEMPLATE_READ_ONLY_NOTICE}</div>;
  if (persistence.status === 'ready') return null;
  if (persistence.storage === 'cloud') {
    if (persistence.cloudStatus === 'conflict') return <div className="yw-notice" role="status">记录与云端版本有冲突，请到“我的”选择保留版本。</div>;
    if (['pending', 'saving', 'loading'].includes(persistence.cloudStatus || '')) return <div className="yw-notice" role="status">正在同步到微信账户，完成后可跨设备查看。</div>;
    return <div className="yw-notice" role="status">记录尚未同步到微信账户，请联网后重试；同步完成前可在当前设备继续查看。<button type="button" onClick={persistence.retry}>重试同步</button></div>;
  }
  return <div className="yw-notice" role="status">当前浏览器暂时无法保存，新增内容仅保留在本次页面中。<button type="button" onClick={persistence.retry}>重试保存</button></div>;
}
