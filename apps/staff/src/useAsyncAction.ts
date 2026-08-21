import { useCallback, useRef, useState } from "react";

type RunOptions = {
  successMessage?: string;
  setMessage: (message: string) => void;
};

export function useAsyncAction() {
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set());
  const pendingRef = useRef(pendingKeys);
  pendingRef.current = pendingKeys;

  const isPending = useCallback((key: string) => pendingKeys.has(key), [pendingKeys]);

  const run = useCallback(async (key: string, action: () => Promise<void>, options?: RunOptions) => {
    if (pendingRef.current.has(key)) return;
    const started = new Set(pendingRef.current);
    started.add(key);
    pendingRef.current = started;
    setPendingKeys(started);
    try {
      await action();
      if (options?.successMessage) options.setMessage(options.successMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options?.setMessage(message);
      throw error;
    } finally {
      const finished = new Set(pendingRef.current);
      finished.delete(key);
      pendingRef.current = finished;
      setPendingKeys(finished);
    }
  }, []);

  return { isPending, run };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
