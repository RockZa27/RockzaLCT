import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeviceError,
  type MonitorCardReading,
  type MonitorSnapshot,
  type MonitorSnapshotOptions,
} from '@rockzalct/shared';
import { CONTROLLER, connectAndGo, makeFakeApi, renderApp } from '../testUtils';
import { resetMonitorStore } from './monitor/store';

let clock = 1_700_000_000_000;

const card = (portIndex: number, cardIndex: number, extra: Partial<MonitorCardReading> = {}): MonitorCardReading => ({
  portIndex,
  cardIndex,
  state: 'online',
  temperatureRaw: 40,
  humidityRaw: 50,
  voltageRaw: 50,
  ...extra,
});

/** Snapshot of the two cards in testUtils.INFO: port 0 card 0 and port 1 card 0. */
function snap(a: Partial<MonitorCardReading> = {}, b: Partial<MonitorCardReading> = {}, over: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  clock += 10_000;
  return {
    controllerId: CONTROLLER.id,
    takenAt: clock,
    sender: {
      portLinks: [
        { portIndex: 0, detected: 1, expected: 1, status: 'up' },
        { portIndex: 1, detected: 1, expected: 1, status: 'up' },
      ],
      dviStatusRaw: 1,
      temperatureRaw: 33,
    },
    cards: [card(0, 0, a), card(1, 0, b)],
    requestCount: 7,
    ...over,
  };
}

const monitorApi = (impl: (id: string, options?: MonitorSnapshotOptions) => Promise<MonitorSnapshot>) =>
  makeFakeApi({ readMonitorSnapshot: vi.fn(impl) });

async function open(api: ReturnType<typeof makeFakeApi>) {
  const view = renderApp(api);
  await connectAndGo(view.user, screen, 'Monitoring');
  return view;
}

const calls = (api: ReturnType<typeof makeFakeApi>): number => (api.readMonitorSnapshot as ReturnType<typeof vi.fn>).mock.calls.length;

/** jsdom's Blob has no text(); read it through FileReader. */
const readBlob = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

const setHidden = (hidden: boolean): void => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

beforeEach(() => {
  resetMonitorStore();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'hidden');
  vi.restoreAllMocks();
});

describe('MonitorPage', () => {
  it('reads nothing and is disabled while not connected', async () => {
    const api = monitorApi(async () => snap());
    const { user } = renderApp(api);
    await user.click(screen.getByRole('button', { name: 'Monitoring' }));
    expect(screen.getByText('Connect to a controller first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh now' })).toBeDisabled();
    expect(screen.getByLabelText('Refresh interval')).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(calls(api)).toBe(0);
  });

  it('reads on open at the normal user level, passing the controller cards, and colours tiles by worst status', async () => {
    const api = monitorApi(async () =>
      snap({ temperatureRaw: 65 }, { state: 'offline', error: 'No response', temperatureRaw: undefined }),
    );
    await open(api);

    const tileA = await screen.findByTestId('card-tile-0-0');
    expect(screen.getByTestId('user-level')).toHaveTextContent('Level: Normal');
    expect(api.readMonitorSnapshot).toHaveBeenCalledWith(CONTROLLER.id, {
      cards: [
        { portIndex: 0, cardIndex: 0 },
        { portIndex: 1, cardIndex: 0 },
      ],
    });
    expect(tileA).toHaveAttribute('data-health', 'warning');
    expect(tileA).toHaveTextContent('Port 1 · Card 1');
    expect(tileA).toHaveTextContent('Warning');
    expect(tileA).toHaveTextContent('Temp (raw) 65');
    const tileB = screen.getByTestId('card-tile-1-0');
    expect(tileB).toHaveAttribute('data-health', 'offline');
    expect(tileB).toHaveTextContent('Offline');

    expect(screen.getByTestId('count-online')).toHaveTextContent('Online: 1');
    expect(screen.getByTestId('count-offline')).toHaveTextContent('Offline: 1');
    expect(screen.getByTestId('count-warning')).toHaveTextContent('Warnings: 1');
    expect(screen.getByTestId('last-update')).toHaveTextContent('7 requests');
    // raw-value disclaimer is shown
    expect(screen.getByText(/nothing is converted to °C or V/)).toBeInTheDocument();
  });

  it('shows per-card detail for the selected card and the sender port links', async () => {
    const api = monitorApi(async () =>
      snap(
        {},
        {
          temperatureRaw: 44,
          humidityRaw: 61,
          voltageRaw: 48,
          bitErrorRaw: [1, 2, 3],
          monitorCard: {
            temperatureRaw: 35,
            smokeRaw: 0,
            fanRaw: [10, 20, 30, 40],
            voltageRaw: [1, 2, 3, 4, 5, 6, 7, 8, 9],
            moduleStatusRaw: [0, 0],
          },
        },
        {
          sender: {
            portLinks: [
              { portIndex: 0, detected: 1, expected: 1, status: 'up' },
              { portIndex: 1, detected: 0, expected: 1, status: 'down' },
            ],
            dviStatusRaw: 3,
          },
        },
      ),
    );
    const { user } = await open(api);
    await user.click(await screen.findByTestId('card-tile-1-0'));

    expect(screen.getByTestId('card-tile-1-0')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('detail-temperature')).toHaveTextContent('44');
    expect(screen.getByTestId('detail-humidity')).toHaveTextContent('61');
    expect(screen.getByTestId('detail-voltage')).toHaveTextContent('48');
    expect(screen.getByTestId('detail-biterror')).toHaveTextContent('1 2 3');
    expect(screen.getByTestId('detail-fans')).toHaveTextContent('10 20 30 40');
    expect(screen.getByTestId('detail-smoke')).toHaveTextContent('0');

    expect(within(screen.getByTestId('port-link-1')).getByText('Down')).toBeInTheDocument();
    expect(within(screen.getByTestId('port-link-0')).getByText('Up')).toBeInTheDocument();
    expect(screen.getByTestId('sender-dvi')).toHaveTextContent('3');
    // the sender-level problem is also an alert
    expect(screen.getByTestId('alert-port:1:link')).toHaveTextContent('Port 2: no receiving cards seen (expected 1)');
  });

  it('polls on the selected interval and stops when switched off', async () => {
    const api = monitorApi(async () => snap());
    const { user } = await open(api);
    await screen.findByTestId('card-tile-0-0');
    expect(calls(api)).toBe(1); // immediate read; default interval is 10 s
    expect(screen.getByTestId('polling-note')).toHaveTextContent('Refreshing every 10 s.');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(calls(api)).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(calls(api)).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(calls(api)).toBe(3);

    await user.selectOptions(screen.getByLabelText('Refresh interval'), '5');
    const before = calls(api);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100);
    });
    expect(calls(api) - before).toBe(3);

    await user.selectOptions(screen.getByLabelText('Refresh interval'), '0');
    expect(screen.getByTestId('polling-note')).toHaveTextContent('Automatic refresh is off.');
    const stopped = calls(api);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(calls(api)).toBe(stopped);

    // manual refresh still works with polling off
    await user.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => expect(calls(api)).toBe(stopped + 1));
  });

  it('offers the 5 / 10 / 30 / 60 second intervals and off', async () => {
    const api = monitorApi(async () => snap());
    await open(api);
    const select = await screen.findByLabelText('Refresh interval');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Off', '5 s', '10 s', '30 s', '60 s']);
  });

  it('does not overlap polls: the next one is scheduled after the previous finished', async () => {
    let release: (() => void) | undefined;
    let active = 0;
    let maxActive = 0;
    const api = monitorApi(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      active -= 1;
      return snap();
    });
    await open(api);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000); // first poll is still pending the whole time
    });
    expect(calls(api)).toBe(1);
    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(maxActive).toBe(1);
  });

  it('pauses while the window is hidden and reads again as soon as it is shown', async () => {
    const api = monitorApi(async () => snap());
    await open(api);
    await screen.findByTestId('card-tile-0-0');
    expect(calls(api)).toBe(1);

    setHidden(true);
    expect(screen.getByTestId('polling-note')).toHaveTextContent('Paused while this window is hidden.');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(calls(api)).toBe(1);

    setHidden(false);
    await waitFor(() => expect(calls(api)).toBe(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_500);
    });
    expect(calls(api)).toBe(3);
  });

  it('stops polling when the page is left or the controller is disconnected', async () => {
    const api = monitorApi(async () => snap());
    const { user } = await open(api);
    await screen.findByTestId('card-tile-0-0');
    await user.click(screen.getByRole('button', { name: 'Connection' }));
    const afterLeave = calls(api);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(calls(api)).toBe(afterLeave);

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await user.click(screen.getByRole('button', { name: 'Monitoring' }));
    expect(screen.getByText('Connect to a controller first.')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(calls(api)).toBe(afterLeave);
  });

  it('keeps its history when the page is left and re-opened', async () => {
    const api = monitorApi(async () => snap({ temperatureRaw: 70 }));
    const { user } = await open(api);
    await screen.findByTestId('card-tile-0-0');
    expect(screen.getAllByTestId('history-row')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Connection' }));
    await user.click(screen.getByRole('button', { name: 'Monitoring' }));
    // the remembered snapshot is shown at once; the re-read adds no duplicate "raised" event
    expect(screen.getByTestId('card-tile-0-0')).toBeInTheDocument();
    await waitFor(() => expect(calls(api)).toBeGreaterThanOrEqual(2));
    expect(screen.getAllByTestId('history-row')).toHaveLength(1);
  });

  it('stops polling and says so when the device reports NOT_CONNECTED', async () => {
    const api = monitorApi(async () => {
      throw new DeviceError('NOT_CONNECTED', 'gone');
    });
    const { user } = await open(api);
    expect(await screen.findByTestId('monitor-error')).toHaveTextContent('The controller is not connected.');
    expect(calls(api)).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(calls(api)).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => expect(calls(api)).toBe(2));
  });

  it('keeps polling after an ordinary failure and recovers', async () => {
    let n = 0;
    const api = monitorApi(async () => {
      n += 1;
      if (n === 1) throw new DeviceError('TIMEOUT', 'slow');
      return snap();
    });
    await open(api);
    expect(await screen.findByTestId('monitor-error')).toHaveTextContent('did not respond in time');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_500);
    });
    expect(await screen.findByTestId('card-tile-0-0')).toBeInTheDocument();
    expect(screen.queryByTestId('monitor-error')).not.toBeInTheDocument();
  });

  it('logs alert transitions with timestamps: raised, escalated, relaxed, cleared', async () => {
    const queue = [
      snap({ temperatureRaw: 40 }),
      snap({ temperatureRaw: 62 }), // warning raised
      snap({ temperatureRaw: 80 }), // escalated to critical
      snap({ temperatureRaw: 62 }), // eased
      snap({ temperatureRaw: 40 }), // cleared
    ];
    let last = queue[queue.length - 1]!;
    const api = monitorApi(async () => {
      const next = queue.shift();
      if (next) last = next;
      return last;
    });
    await open(api);
    await screen.findByTestId('card-tile-0-0');
    expect(screen.getByTestId('alerts-none')).toBeInTheDocument();
    expect(screen.getByTestId('history-none')).toBeInTheDocument();

    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_500);
      });
    }
    await waitFor(() => expect(screen.getAllByTestId('history-row')).toHaveLength(4));
    // newest first
    const rows = screen.getAllByTestId('history-row').map((r) => r.textContent ?? '');
    expect(rows[0]).toContain('Cleared');
    expect(rows[1]).toContain('Eased');
    expect(rows[2]).toContain('Escalated');
    expect(rows[3]).toContain('Raised');
    expect(rows[3]).toMatch(/\d{4}/); // a timestamp is printed
    expect(rows[2]).toContain('temperature 80 (raw) reached the limit 75');
    expect(screen.getByTestId('alerts-none')).toBeInTheDocument(); // cleared again
    expect(screen.getByTestId('card-tile-0-0')).toHaveAttribute('data-health', 'ok');

    await act(async () => {
      screen.getByRole('button', { name: 'Clear history' }).click();
    });
    expect(screen.getByTestId('history-none')).toBeInTheDocument();
  });

  it('draws an inline SVG temperature trend for the selected card once there are two readings', async () => {
    let t = 40;
    const api = monitorApi(async () => snap({ temperatureRaw: (t += 2) }));
    await open(api);
    await screen.findByTestId('card-tile-0-0');
    expect(screen.getByTestId('trend-empty')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_500);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const chart = await screen.findByTestId('trend-chart');
    expect(chart.tagName.toLowerCase()).toBe('svg');
    expect(chart).toHaveAttribute('data-points', '3');
    expect(chart).toHaveAccessibleName('Temperature trend of port 1 card 1, raw values from 42 to 46');
    expect(chart.querySelector('polyline')).not.toBeNull();
  });

  it('applies thresholds from the settings, validates them and remembers them', async () => {
    const api = monitorApi(async () => snap({ temperatureRaw: 55 }));
    const { user } = await open(api);
    await screen.findByTestId('card-tile-0-0');
    expect(screen.getByTestId('card-tile-0-0')).toHaveAttribute('data-health', 'ok'); // default warning is 60

    const warn = screen.getByLabelText('Temperature warning at or above (raw)');
    await user.clear(warn);
    await user.type(warn, '50');
    await user.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(screen.getByTestId('card-tile-0-0')).toHaveAttribute('data-health', 'warning'));
    expect(await screen.findByText('Limits saved')).toBeInTheDocument();

    // warning above critical is refused and nothing changes
    await user.clear(warn);
    await user.type(warn, '90');
    await user.click(screen.getByRole('button', { name: 'Save limits' }));
    expect(screen.getByTestId('settings-problems')).toHaveTextContent('must not exceed');
    expect(screen.getByTestId('card-tile-0-0')).toHaveAttribute('data-health', 'warning');

    // the saved limits survive a remount through localStorage
    expect(JSON.parse(localStorage.getItem('rockzalct.monitor.settings')!).thresholds.temperatureWarnRaw).toBe(50);
    await user.click(screen.getByRole('button', { name: 'Connection' }));
    await user.click(screen.getByRole('button', { name: 'Monitoring' }));
    expect(screen.getByLabelText('Temperature warning at or above (raw)')).toHaveValue(50);

    // an emptied field disables that limit
    await user.clear(screen.getByLabelText('Temperature warning at or above (raw)'));
    await user.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(screen.getByTestId('card-tile-0-0')).toHaveAttribute('data-health', 'ok'));

    await user.click(screen.getByRole('button', { name: 'Restore defaults' }));
    expect(screen.getByLabelText('Temperature warning at or above (raw)')).toHaveValue(60);
  });

  it('flags a card as critical from a voltage limit and passes the optional read flags', async () => {
    localStorage.setItem(
      'rockzalct.monitor.settings',
      JSON.stringify({ intervalS: 30, thresholds: { voltageLowRaw: 45, voltageHighRaw: 60 }, includeBitErrorRate: true, functionCardAddress: 4 }),
    );
    const api = monitorApi(async () => snap({ voltageRaw: 40 }));
    await open(api);
    await screen.findByTestId('card-tile-0-0');
    expect(api.readMonitorSnapshot).toHaveBeenCalledWith(CONTROLLER.id, expect.objectContaining({ includeBitErrorRate: true, functionCardAddress: 4 }));
    expect(screen.getByTestId('alert-card:0:0:voltage')).toHaveTextContent('voltage 40 (raw) is below 45');
    expect(screen.getByTestId('card-tile-0-0')).toHaveAttribute('data-health', 'warning');
    expect(screen.getByTestId('polling-note')).toHaveTextContent('Refreshing every 30 s.');
  });

  it('survives unusable localStorage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const api = monitorApi(async () => snap());
    const { user } = await open(api);
    expect(await screen.findByTestId('card-tile-0-0')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Refresh interval'), '30');
    expect(screen.getByTestId('polling-note')).toHaveTextContent('Refreshing every 30 s.');
  });

  it('exports the readings and the alert events as CSV downloads', async () => {
    const blobs: Blob[] = [];
    const created = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:mock';
    });
    const revoked = vi.fn();
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked });
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });

    const api = monitorApi(async () => snap({ temperatureRaw: 70 }, { state: 'offline', error: 'No response' }));
    const { user } = await open(api);
    await screen.findByTestId('card-tile-0-0');

    await user.click(screen.getByRole('button', { name: 'Export readings (CSV)' }));
    await user.click(screen.getByRole('button', { name: 'Export alerts (CSV)' }));
    expect(created).toHaveBeenCalledTimes(2);
    expect(clicked[0]).toMatch(/^rockzalct-readings-.*\.csv$/);
    expect(clicked[1]).toMatch(/^rockzalct-alerts-.*\.csv$/);

    const readings = await readBlob(blobs[0]!);
    const lines = readings.trim().split('\r\n');
    expect(lines[0]).toBe('time,controller,port,card,state,temperature_raw,humidity_raw,voltage_raw,error');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/,serial:COM9,0,0,online,70,50,50,$/);
    expect(lines[2]).toMatch(/,serial:COM9,1,0,offline,.*,No response$/);

    const events = (await readBlob(blobs[1]!)).trim().split('\r\n');
    expect(events[0]).toBe('time,controller,event,severity,kind,port,card,value_raw,threshold_raw,detail');
    expect(events.slice(1).map((l) => l.split(',')[2])).toEqual(['raised', 'raised']);
  });

  it('renders in Thai', async () => {
    const api = monitorApi(async () => snap({ temperatureRaw: 90 }));
    const view = renderApp(api, 'th');
    await view.user.click(screen.getByRole('button', { name: 'ค้นหา' }));
    await view.user.click(await screen.findByRole('button', { name: 'เชื่อมต่อ' }));
    await screen.findByTestId('controller-info');
    await view.user.click(screen.getAllByRole('button', { name: 'ตรวจสอบสถานะ' })[0]!);
    expect(await screen.findByRole('heading', { name: 'ตรวจสอบสถานะ' })).toBeInTheDocument();
    expect(await screen.findByTestId('card-tile-0-0')).toHaveTextContent('พอร์ต 1 · การ์ด 1');
    expect(screen.getByTestId('alert-card:0:0:temperature')).toHaveTextContent('อุณหภูมิ 90 (ดิบ) ถึงขีดจำกัด 75');
  });
});
