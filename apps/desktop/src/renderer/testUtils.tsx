import { vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ControllerInfo, DeviceApi, DiscoveredController } from '@rockzalct/shared';
import { App } from './App';
import type { Lang } from './i18n/dictionary';

export const CONTROLLER: DiscoveredController = {
  id: 'serial:COM9',
  transport: 'serial',
  address: 'COM9',
  label: 'COM9',
};

export const INFO: ControllerInfo = {
  id: CONTROLLER.id,
  model: 'TestCtrl 9000',
  firmwareVersion: '9.9.9',
  outputPorts: 2,
  receivingCards: [
    { portIndex: 0, cardIndex: 0, model: 'RC-A', firmwareVersion: '1.0.0' },
    { portIndex: 1, cardIndex: 0, model: 'RC-B', firmwareVersion: '1.1.0' },
  ],
};

/** A DeviceApi made of vi.fn() mocks with sensible defaults; override per test. */
export function makeFakeApi(overrides: Partial<DeviceApi> = {}) {
  const api = {
    discover: vi.fn(async () => [CONTROLLER]),
    connect: vi.fn(async () => INFO),
    disconnect: vi.fn(async () => undefined),
    getBrightness: vi.fn(async () => ({ percent: 40, red: 100, green: 100, blue: 100 })),
    setBrightness: vi.fn(async (_id: string, v: object) => ({
      percent: 40,
      red: 100,
      green: 100,
      blue: 100,
      ...v,
    })),
    setTestPattern: vi.fn(async () => undefined),
    setDisplayMode: vi.fn(async () => undefined),
    login: vi.fn(async (pw: string) => pw === 'secret'),
    ...overrides,
  };
  return api as typeof api & DeviceApi;
}

export function renderApp(api: DeviceApi, lang: Lang | null = 'en') {
  const user = userEvent.setup();
  const utils = render(<App api={api} initialLang={lang ?? undefined} />);
  return { user, ...utils };
}

/** Scan, connect to the fake controller, then open another nav page by its label. */
export async function connectAndGo(
  user: ReturnType<typeof userEvent.setup>,
  screen: typeof import('@testing-library/react').screen,
  navLabel?: string,
) {
  await user.click(screen.getByRole('button', { name: 'Scan' }));
  await user.click(await screen.findByRole('button', { name: 'Connect' }));
  await screen.findByTestId('controller-info');
  if (navLabel) await user.click(screen.getByRole('button', { name: navLabel }));
}
