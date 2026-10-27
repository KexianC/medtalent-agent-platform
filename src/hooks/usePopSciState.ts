import { useCallback, useEffect, useMemo, useState } from "react";
import type { PopSciType } from "@/data/popsciCatalog";

type PopSciKey = `${PopSciType}:${string}`;

interface PopSciStateData {
  liked: PopSciKey[];
  saved: PopSciKey[];
}

const STORAGE_KEY = "popsci_state_v1";

function safeParse(raw: string | null): PopSciStateData | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PopSciStateData>;
    return {
      liked: Array.isArray(parsed.liked) ? (parsed.liked as PopSciKey[]) : [],
      saved: Array.isArray(parsed.saved) ? (parsed.saved as PopSciKey[]) : [],
    };
  } catch {
    return null;
  }
}

function makeKey(type: PopSciType, id: string): PopSciKey {
  return `${type}:${id}`;
}

export function usePopSciState() {
  const [data, setData] = useState<PopSciStateData>(() => {
    const parsed = safeParse(localStorage.getItem(STORAGE_KEY));
    return parsed || { liked: [], saved: [] };
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data]);

  const isLiked = useCallback(
    (type: PopSciType, id: string) => data.liked.includes(makeKey(type, id)),
    [data.liked]
  );

  const isSaved = useCallback(
    (type: PopSciType, id: string) => data.saved.includes(makeKey(type, id)),
    [data.saved]
  );

  const toggleLiked = useCallback((type: PopSciType, id: string) => {
    const key = makeKey(type, id);
    setData((prev) => ({
      ...prev,
      liked: prev.liked.includes(key) ? prev.liked.filter((k) => k !== key) : [...prev.liked, key],
    }));
  }, []);

  const toggleSaved = useCallback((type: PopSciType, id: string) => {
    const key = makeKey(type, id);
    setData((prev) => ({
      ...prev,
      saved: prev.saved.includes(key) ? prev.saved.filter((k) => k !== key) : [...prev.saved, key],
    }));
  }, []);

  return useMemo(
    () => ({
      isLiked,
      isSaved,
      toggleLiked,
      toggleSaved,
      likedKeys: data.liked,
      savedKeys: data.saved,
      likedCount: data.liked.length,
      savedCount: data.saved.length,
    }),
    [data.liked, data.saved, isLiked, isSaved, toggleLiked, toggleSaved]
  );
}
