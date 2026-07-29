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
    setPendingKeys((current) => new Set(current).add(key));
    try {
      await action();
      if (options?.successMessage) options.setMessage(options.successMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options?.setMessage(message);
      throw error;
    } finally {
      setPendingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, []);

  return { isPending, run };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
