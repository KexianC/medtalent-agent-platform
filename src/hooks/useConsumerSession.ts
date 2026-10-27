import { useSyncExternalStore } from 'react';
import { useDoctorPreview } from './doctorPreview';
import { getConsumerSession, subscribeConsumerSession } from '../lib/consumerSession';

export function useConsumerSession() {
  const preview = useDoctorPreview();
  const session = useSyncExternalStore(subscribeConsumerSession, getConsumerSession, getConsumerSession);
  return preview ? { ...session, status: 'guest' as const, user: null, loginPending: false, error: '' } : session;
}
