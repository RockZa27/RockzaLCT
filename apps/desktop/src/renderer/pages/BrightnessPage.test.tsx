import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CONTROLLER, connectAndGo, makeFakeApi, renderApp } from '../testUtils';

describe('BrightnessPage', () => {
  it('is disabled while not connected', async () => {
    const api = makeFakeApi();
    const { user } = renderApp(api);
    await user.click(screen.getByRole('button', { name: 'Brightness' }));
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByLabelText('Global brightness')).toBeDisabled();
    expect(screen.getByLabelText('Global brightness (number)')).toBeDisabled();
    expect(api.getBrightness).not.toHaveBeenCalled();
  });

  it('loads current values, applies with the right args and shows the read-back', async () => {
    const getBrightness = vi.fn(async (_id: string) => ({ percent: 40, red: 100, green: 100, blue: 100 }));
    const api = makeFakeApi({ getBrightness });
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Brightness');

    await waitFor(() => expect(screen.getByLabelText('Global brightness (number)')).toHaveValue(40));

    fireEvent.change(screen.getByLabelText('Global brightness (number)'), { target: { value: '65' } });
    fireEvent.change(screen.getByLabelText('Red gain'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('Blue gain (number)'), { target: { value: '80' } });
    expect(screen.getByLabelText('Global brightness')).toHaveValue('65');

    // After apply the device reports what it actually stored.
    getBrightness.mockResolvedValueOnce({ percent: 65, red: 90, green: 100, blue: 80 });
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(api.setBrightness).toHaveBeenCalledWith(CONTROLLER.id, {
        percent: 65,
        red: 90,
        green: 100,
        blue: 80,
      }),
    );
    await waitFor(() => expect(screen.getByTestId('readback-percent')).toHaveTextContent('65%'));
    expect(screen.getByTestId('readback-blue')).toHaveTextContent('80%');
  });

  it('clamps out-of-range numbers to 0..100', async () => {
    const api = makeFakeApi();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Brightness');
    const input = await screen.findByLabelText('Global brightness (number)');
    fireEvent.change(input, { target: { value: '250' } });
    expect(input).toHaveValue(100);
  });

  it('shows a localised toast when apply fails', async () => {
    const { DeviceError } = await import('@rockzalct/shared');
    const api = makeFakeApi({
      setBrightness: async () => {
        throw new DeviceError('INVALID_ARGUMENT', 'bad');
      },
    });
    const { user } = renderApp(api, 'en');
    await connectAndGo(user, screen, 'Brightness');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid value.');
  });
});

describe('BrightnessPage: review regressions', () => {
  it('never offers a writable default: a failed read disables Apply and inputs, shows the error and a Retry that recovers', async () => {
    const { DeviceError } = await import('@rockzalct/shared');
    const getBrightness = vi
      .fn()
      .mockRejectedValueOnce(new DeviceError('TIMEOUT', 'x'))
      .mockResolvedValue({ percent: 55, red: 100, green: 100, blue: 100 });
    const api = makeFakeApi({ getBrightness });
    const { user } = renderApp(api, 'en');
    await connectAndGo(user, screen, 'Brightness');
    expect(await screen.findByTestId('bri-load-error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByLabelText('Global brightness')).toBeDisabled();
    expect(screen.getByLabelText('Global brightness (number)')).toBeDisabled();
    expect(api.setBrightness).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled());
    expect(screen.getByLabelText('Global brightness (number)')).toHaveValue(55);
    expect(screen.queryByTestId('bri-load-error')).not.toBeInTheDocument();
  });

  it('keeps Apply disabled while the first read is still in flight', async () => {
    let resolve: (v: { percent: number; red: number; green: number; blue: number }) => void = () => {};
    const api = makeFakeApi({ getBrightness: vi.fn(() => new Promise((r) => { resolve = r; })) as never });
    const { user } = renderApp(api, 'en');
    await connectAndGo(user, screen, 'Brightness');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    resolve({ percent: 30, red: 100, green: 100, blue: 100 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled());
  });
});
