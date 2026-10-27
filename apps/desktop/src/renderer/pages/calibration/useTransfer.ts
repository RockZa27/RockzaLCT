import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoefficientTransferOptions } from '@rockzalct/shared';

export interface TransferProgress {
  phase: 'download' | 'backup' | 'upload';
  done: number;
  total: number;
}

/** Progress + cancel flag for one chunked transfer at a time. */
export function useTransfer() {
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const cancelled = useRef(false);
  /** True once the owning page unmounted: the transfer is cancelled and nothing new may start. */
  const unmounted = useRef(false);

  // Leaving the page cancels the running transfer: it must not keep writing invisibly.
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      cancelled.current = true;
    };
  }, []);

  const start = useCallback((phase: TransferProgress['phase'], total: number): CoefficientTransferOptions => {
    cancelled.current = unmounted.current;
    setProgress({ phase, done: 0, total });
    return {
      onProgress: (done, all) => setProgress({ phase, done, total: all }),
      isCancelled: () => cancelled.current,
    };
  }, []);
  const stop = useCallback(() => setProgress(null), []);
  const cancel = useCallback(() => {
    cancelled.current = true;
  }, []);

  return { progress, start, stop, cancel, unmounted };
}
