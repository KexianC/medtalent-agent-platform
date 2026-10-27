import { useEffect, useRef, useState } from "react";
import { createWavRecorder } from "../lib/wavRecorder";

export function useWavRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const mounted = useRef(true);
  const recorder = useRef<ReturnType<typeof createWavRecorder>>();
  if (!recorder.current) {
    recorder.current = createWavRecorder((value) => {
      if (mounted.current) setIsRecording(value);
    });
  }
  const { start, stop, cancel } = recorder.current;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void cancel();
    };
  }, [cancel]);

  return { isRecording, start, stop, cancel };
}
