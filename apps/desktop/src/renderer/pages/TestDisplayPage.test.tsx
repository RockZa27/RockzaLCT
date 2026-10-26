import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TestPattern } from '@rockzalct/shared';
import { CONTROLLER, connectAndGo, makeFakeApi, renderApp } from '../testUtils';
import { TEST_PATTERNS } from './TestDisplayPage';

describe('TestDisplayPage', () => {
  it('disables all buttons when not connected', async () => {
    const { user } = renderApp(makeFakeApi());
    await user.click(screen.getByRole('button', { name: 'Test & Display' }));
    expect(screen.getByRole('button', { name: 'Red' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Blackout' })).toBeDisabled();
  });

  it('offers a button for every TestPattern in the contract', () => {
    // Compile-time exhaustiveness: adding a TestPattern to shared breaks this record.
    const all: Record<TestPattern, true> = {
      off: true,
      red: true,
      green: true,
      blue: true,
      white: true,
      'horizontal-lines': true,
      'vertical-lines': true,
      slash: true,
      grayscale: true,
    };
    expect([...TEST_PATTERNS].sort()).toEqual(Object.keys(all).sort());
  });

  it('pattern click calls setTestPattern and highlights the selection', async () => {
    const api = makeFakeApi();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Test & Display');

    const red = screen.getByRole('button', { name: 'Red' });
    expect(red).toHaveAttribute('aria-pressed', 'false');
    await user.click(red);
    expect(api.setTestPattern).toHaveBeenCalledWith(CONTROLLER.id, 'red');
    expect(screen.getByRole('button', { name: 'Red' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Grayscale' }));
    expect(api.setTestPattern).toHaveBeenLastCalledWith(CONTROLLER.id, 'grayscale');
    expect(screen.getByRole('button', { name: 'Red' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Grayscale' })).toHaveClass('selected');
  });

  it('display mode click calls setDisplayMode and highlights it', async () => {
    const api = makeFakeApi();
    const { user } = renderApp(api);
    await connectAndGo(user, screen, 'Test & Display');
    await user.click(screen.getByRole('button', { name: 'Freeze' }));
    expect(api.setDisplayMode).toHaveBeenCalledWith(CONTROLLER.id, 'freeze');
    expect(screen.getByRole('button', { name: 'Freeze' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not highlight when the device call fails', async () => {
    const { DeviceError } = await import('@rockzalct/shared');
    const api = makeFakeApi({
      setTestPattern: async () => {
        throw new DeviceError('NOT_CONNECTED', 'gone');
      },
    });
    const { user } = renderApp(api, 'en');
    await connectAndGo(user, screen, 'Test & Display');
    await user.click(screen.getByRole('button', { name: 'Blue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The controller is not connected.');
    expect(screen.getByRole('button', { name: 'Blue' })).toHaveAttribute('aria-pressed', 'false');
  });
});
