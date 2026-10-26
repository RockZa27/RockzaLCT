import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeFakeApi, renderApp } from './testUtils';

describe('App shell', () => {
  it('defaults to Thai and the language toggle switches text', async () => {
    const { user } = renderApp(makeFakeApi(), null);
    expect(screen.getByRole('button', { name: 'การเชื่อมต่อ' })).toBeInTheDocument();
    expect(screen.getByTestId('connection-status')).toHaveTextContent('ยังไม่ได้เชื่อมต่อ');

    await user.click(screen.getByRole('button', { name: 'EN' }));
    expect(screen.getByRole('button', { name: 'Connection' })).toBeInTheDocument();
    expect(screen.getByTestId('connection-status')).toHaveTextContent('Not connected');

    await user.click(screen.getByRole('button', { name: 'ไทย' }));
    expect(screen.getByTestId('connection-status')).toHaveTextContent('ยังไม่ได้เชื่อมต่อ');
  });

  it('advanced login: wrong password shows error, right password shows level', async () => {
    const api = makeFakeApi();
    const { user } = renderApp(api);
    expect(screen.getByTestId('user-level')).toHaveTextContent('Level: Normal');

    await user.click(screen.getByRole('button', { name: 'Advanced login' }));
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('Wrong password')).toBeInTheDocument();
    expect(screen.getByTestId('user-level')).toHaveTextContent('Level: Normal');

    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('Level: Advanced')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.login).toHaveBeenLastCalledWith('secret');
  });
});
