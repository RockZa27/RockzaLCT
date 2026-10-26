import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  ControllerInfo,
  DeviceApi,
  DeviceErrorCode,
  DiscoveredController,
  DisplayMode,
  TestPattern,
  UserLevel,
} from '@rockzalct/shared';
import { decodeError } from '../../common/ipcError';
import { wrapDeviceApi } from '../deviceClient';

export interface Toast {
  id: number;
  kind: 'error' | 'info';
  /** Present for errors: localised via `error.<code>`. */
  code?: DeviceErrorCode;
  /** Present for info toasts: already-localised text. */
  text?: string;
}

export interface AppState {
  api: DeviceApi;
  discovered: DiscoveredController[];
  scanning: boolean;
  scan(netHosts: string[]): Promise<void>;
  connectedId: string | null;
  connecting: boolean;
  info: ControllerInfo | null;
  connect(id: string): Promise<void>;
  disconnect(): Promise<void>;
  level: UserLevel['level'];
  login(password: string): Promise<boolean>;
  pattern: TestPattern | null;
  mode: DisplayMode | null;
  setPattern(p: TestPattern): Promise<void>;
  setMode(m: DisplayMode): Promise<void>;
  toasts: Toast[];
  pushInfo(text: string): void;
  /** Run a device call; failures become localised error toasts and resolve to undefined. */
  run<T>(fn: () => Promise<T>): Promise<T | undefined>;
  dismissToast(id: number): void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ api: rawApi, children }: { api: DeviceApi; children: ReactNode }) {
  const api = useMemo(() => wrapDeviceApi(rawApi), [rawApi]);
  const [discovered, setDiscovered] = useState<DiscoveredController[]>([]);
  const [scanning, setScanning] = useState(false);
  const [connectedId, setConnectedId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [info, setInfo] = useState<ControllerInfo | null>(null);
  const [level, setLevel] = useState<UserLevel['level']>('normal');
  const [pattern, setPatternState] = useState<TestPattern | null>(null);
  const [mode, setModeState] = useState<DisplayMode | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToast = useRef(1);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const addToast = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = nextToast.current++;
      setToasts((t) => [...t, { ...toast, id }]);
      setTimeout(() => dismissToast(id), 6000);
    },
    [dismissToast],
  );

  const pushInfo = useCallback((text: string) => addToast({ kind: 'info', text }), [addToast]);

  /** Run a device call; on failure show a toast and resolve to undefined. */
  const guard = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (e) {
        addToast({ kind: 'error', code: decodeError(e).code });
        return undefined;
      }
    },
    [addToast],
  );

  const scan = useCallback(
    async (netHosts: string[]) => {
      setScanning(true);
      try {
        const found = await guard(() => api.discover(netHosts.length ? { netHosts } : undefined));
        if (found) setDiscovered(found);
      } finally {
        setScanning(false);
      }
    },
    [api, guard],
  );

  const connect = useCallback(
    async (id: string) => {
      setConnecting(true);
      try {
        const result = await guard(() => api.connect(id));
        if (result) {
          setConnectedId(id);
          setInfo(result);
          setPatternState(null);
          setModeState(null);
        }
      } finally {
        setConnecting(false);
      }
    },
    [api, guard],
  );

  const disconnect = useCallback(async () => {
    if (!connectedId) return;
    const ok = await guard(async () => {
      await api.disconnect(connectedId);
      return true;
    });
    if (ok) {
      setConnectedId(null);
      setInfo(null);
      setPatternState(null);
      setModeState(null);
    }
  }, [api, guard, connectedId]);

  const login = useCallback(
    async (password: string) => {
      const ok = await guard(() => api.login(password));
      if (ok) setLevel('advanced');
      return ok === true;
    },
    [api, guard],
  );

  const setPattern = useCallback(
    async (p: TestPattern) => {
      if (!connectedId) return;
      const ok = await guard(async () => {
        await api.setTestPattern(connectedId, p);
        return true;
      });
      if (ok) setPatternState(p);
    },
    [api, guard, connectedId],
  );

  const setMode = useCallback(
    async (m: DisplayMode) => {
      if (!connectedId) return;
      const ok = await guard(async () => {
        await api.setDisplayMode(connectedId, m);
        return true;
      });
      if (ok) setModeState(m);
    },
    [api, guard, connectedId],
  );

  const value: AppState = {
    api,
    discovered,
    scanning,
    scan,
    connectedId,
    connecting,
    info,
    connect,
    disconnect,
    level,
    login,
    pattern,
    mode,
    setPattern,
    setMode,
    toasts,
    pushInfo,
    run: guard,
    dismissToast,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
