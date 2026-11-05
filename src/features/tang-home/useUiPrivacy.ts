import { usesUnifiedTemplate } from '../services/doctorCustom';
import { useState, type Dispatch, type SetStateAction } from 'react';
import { doctorStorageKey, previewStorageSlug, useDoctorLocalState, useDoctorPreview, type DoctorPrivacySettings } from '../../hooks/useDoctorLocalState';

// Older releases saved voicePlayback=true by default. Require a new explicit
// choice for Tang, while keeping all other privacy fields and doctors intact.
export function useUiPrivacy(slug: string): [DoctorPrivacySettings, Dispatch<SetStateAction<DoctorPrivacySettings>>] {
  const preview = useDoctorPreview();
  const key = doctorStorageKey(preview ? previewStorageSlug(slug) : slug, 'voice-playback-opt-in-v02');
  const [stored, setStored] = useDoctorLocalState<DoctorPrivacySettings>(slug, 'privacy', { saveChat: true, voicePlayback: !usesUnifiedTemplate({ slug }), reminders: true });
  const [voiceChoice, setVoiceChoice] = useState(() => { try { return localStorage.getItem(key) === 'true'; } catch { return false; } });
  const settings = usesUnifiedTemplate({ slug }) ? { ...stored, voicePlayback: voiceChoice } : stored;
  const update: Dispatch<SetStateAction<DoctorPrivacySettings>> = next => {
    const value = typeof next === 'function' ? next(settings) : next;
    if (usesUnifiedTemplate({ slug })) {
      setVoiceChoice(value.voicePlayback);
      try { localStorage.setItem(key, String(value.voicePlayback)); } catch { /* 当前页面仍使用手动选择。 */ }
    }
    setStored(value);
  };
  return [settings, update];
}
