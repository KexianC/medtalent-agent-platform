import { useEffect, useState } from 'react';
import { localDateKey } from '../../hooks/useDoctorLocalState';
export function useWellnessDay() {
  const [day, setDay] = useState(localDateKey);
  useEffect(() => {
    let timer: number;
    const refresh = () => {
      setDay(localDateKey());
      window.clearTimeout(timer);
      const now = new Date();
      const next = new Date(now); next.setHours(24, 0, 0, 100);
      timer = window.setTimeout(refresh, Math.max(100, next.getTime() - now.getTime()));
    };
    refresh();
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return day;
}
