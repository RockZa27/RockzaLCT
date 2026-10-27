// Command-level tests of the Taurus simulator state. The wire framing is not tested here: the
// simulator has no dependency on @novastar/taurus (the codec is handed in), so the framing and the
// whole client<->simulator conversation are tested with the real library in
// packages/device/test/taurus.test.ts.
import { describe, expect, it } from 'vitest';
import {
  STATUS_BAD_REQUEST,
  STATUS_NOT_LOGGED_IN,
  STATUS_OK,
  STATUS_UNKNOWN_COMMAND,
  TAURUS_CMD,
  createTaurusState,
  handleTaurusCommand,
  type TaurusSession,
} from '../src/index.js';

const [W, T, A] = [0, 1, 2] as const;
const run = (
  state: ReturnType<typeof createTaurusState>,
  session: TaurusSession,
  cmd: readonly [number, number, number],
  body?: unknown,
) => handleTaurusCommand(state, session, cmd[W], cmd[T], cmd[A], body);

describe('Taurus simulator state', () => {
  it('refuses everything but login until a session logged in with the configured password', () => {
    const state = createTaurusState({ password: 'pw' });
    const session: TaurusSession = { authed: false };
    expect(run(state, session, TAURUS_CMD.getBrightness).status).toBe(STATUS_NOT_LOGGED_IN);

    const wrong = run(state, session, TAURUS_CMD.login, { sn: state.sn, username: 'admin', password: 'no' });
    expect(wrong).toMatchObject({ status: STATUS_OK, body: { logined: false } });
    expect(session.authed).toBe(false);

    // the serial number is part of the credentials, as in the library's login body
    expect(run(state, session, TAURUS_CMD.login, { sn: 'other', username: 'admin', password: 'pw' }).body).toMatchObject({
      logined: false,
    });
    expect(run(state, session, TAURUS_CMD.login, { sn: state.sn, username: 'admin', password: 'pw' }).body).toMatchObject({
      logined: true,
    });
    expect(run(state, session, TAURUS_CMD.getBrightness).status).toBe(STATUS_OK);
    expect(state.logins).toEqual({ accepted: 1, rejected: 2 });
  });

  it('login is per session', () => {
    const state = createTaurusState({ password: 'pw' });
    const a: TaurusSession = { authed: false };
    const b: TaurusSession = { authed: false };
    run(state, a, TAURUS_CMD.login, { sn: state.sn, username: 'admin', password: 'pw' });
    expect(run(state, b, TAURUS_CMD.getBrightness).status).toBe(STATUS_NOT_LOGGED_IN);
  });

  it('validates writes and answers unknown commands', () => {
    const state = createTaurusState({ password: 'pw' });
    const s: TaurusSession = { authed: true };
    expect(run(state, s, TAURUS_CMD.setBrightness, { ratio: 101 }).status).toBe(STATUS_BAD_REQUEST);
    expect(run(state, s, TAURUS_CMD.setBrightness, {}).status).toBe(STATUS_BAD_REQUEST);
    expect(state.ratio).toBe(60);
    expect(run(state, s, TAURUS_CMD.setBrightness, { ratio: 12, solidity: true }).status).toBe(STATUS_OK);
    expect(state).toMatchObject({ ratio: 12, persistedRatio: 12 });
    expect(run(state, s, TAURUS_CMD.setVideoConfig, { videoMode: 7, videoSource: 0 }).status).toBe(STATUS_BAD_REQUEST);
    expect(handleTaurusCommand(state, s, 99, 99, 99, undefined).status).toBe(STATUS_UNKNOWN_COMMAND);
  });
});
