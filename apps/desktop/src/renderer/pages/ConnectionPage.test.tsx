import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DeviceError } from '@rockzalct/shared';
import { CONTROLLER, INFO, makeFakeApi, renderApp } from '../testUtils';

describe('ConnectionPage', () => {
  it('scan -> connect shows controller info and receiving cards', async () => {
    const api = makeFakeApi();
    const { user } = renderApp(api);

    expect(screen.getByTestId('connection-status')).toHaveTextContent('Not connected');
    await user.click(screen.getByRole('button', { name: 'Scan' }));
    expect(await screen.findByText('COM9')).toBeInTheDocument();
    expect(api.discover).toHaveBeenCalledWith(undefined);

    await user.click(screen.getByRole('button', { name: 'Connect' }));
    const info = await screen.findByTestId('controller-info');
    expect(api.connect).toHaveBeenCalledWith(CONTROLLER.id);
    expect(within(info).getByText(INFO.model)).toBeInTheDocument();
    expect(within(info).getByText('9.9.9')).toBeInTheDocument();
    const cards = within(info).getByRole('table', { name: 'Receiving cards' });
    expect(within(cards).getByText('RC-A')).toBeInTheDocument();
    expect(within(cards).getByText('RC-B')).toBeInTheDocument();
    expect(screen.getByTestId('connection-status')).toHaveTextContent('Connected: TestCtrl 9000');
  });

  it('passes the optional host list to discover', async () => {
    const api = makeFakeApi();
    const { user } = renderApp(api);
    await user.type(screen.getByLabelText(/Network hosts/), '10.0.0.1, 10.0.0.2');
    await user.click(screen.getByRole('button', { name: 'Scan' }));
    await screen.findByText('COM9');
    expect(api.discover).toHaveBeenCalledWith({ netHosts: ['10.0.0.1', '10.0.0.2'] });
  });

  it('disconnect clears the controller info', async () => {
    const api = makeFakeApi();
    const { user } = renderApp(api);
    await user.click(screen.getByRole('button', { name: 'Scan' }));
    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    await screen.findByTestId('controller-info');
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(api.disconnect).toHaveBeenCalledWith(CONTROLLER.id);
    expect(screen.queryByTestId('controller-info')).not.toBeInTheDocument();
    expect(screen.getByTestId('connection-status')).toHaveTextContent('Not connected');
  });

  it('shows a Thai message for a DeviceError code (default language is Thai)', async () => {
    const api = makeFakeApi({
      discover: async () => {
        throw new DeviceError('TIMEOUT', 'device did not answer');
      },
    });
    const { user } = renderApp(api, 'th');
    await user.click(screen.getByRole('button', { name: 'ค้นหา' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('ตัวควบคุมไม่ตอบสนองภายในเวลาที่กำหนด');
  });

  it('decodes errors that crossed the context bridge as encoded messages', async () => {
    const { encodeErrorMessage } = await import('../../common/ipcError');
    const api = makeFakeApi({
      connect: async () => {
        throw new Error(encodeErrorMessage({ code: 'NOT_FOUND', message: 'x' }));
      },
    });
    const { user } = renderApp(api, 'th');
    await user.click(screen.getByRole('button', { name: 'ค้นหา' }));
    await user.click(await screen.findByRole('button', { name: 'เชื่อมต่อ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ไม่พบตัวควบคุม');
  });
});
