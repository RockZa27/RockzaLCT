export { startSimulator, DEFAULT_PORT } from './server.js';
export type { SimulatorHandle } from './server.js';
export { ADDR, cardCountAddress, createState, handleRequest } from './state.js';
export type { SimulatorOptions, SimulatorState, ReceivingCardState } from './state.js';
export { DeviceMemory } from './memory.js';
export { RequestParser, buildResponse, computeCrc } from './protocol.js';
export { startHSeriesSimulator, DEFAULT_HSERIES_PORT } from './hseries/server.js';
export type { HSeriesSimulatorHandle } from './hseries/server.js';
export { createHSeriesState, handleHSeriesCommand } from './hseries/state.js';
export type { HSeriesSimulatorOptions, HSeriesSimulatorState, SimScreen, SimLayer, SimPreset, SimInput, SimOutput, SimSlot } from './hseries/state.js';
export { startTaurusSimulator, DEFAULT_TAURUS_PORT, DEFAULT_TAURUS_DISCOVERY_PORT } from './taurus/server.js';
export type { TaurusSimulatorHandle } from './taurus/server.js';
export {
  STATUS_BAD_REQUEST,
  STATUS_LOGIN_REFUSED,
  STATUS_NOT_LOGGED_IN,
  STATUS_OK,
  STATUS_UNKNOWN_COMMAND,
  createTaurusState, handleTaurusCommand, discoveryInfo, cmdKey, CMD as TAURUS_CMD } from './taurus/state.js';
export type { TaurusSimulatorOptions, TaurusSimulatorState, TaurusSession, TaurusReply } from './taurus/state.js';
export type { TaurusCodec, TaurusWirePacket } from './taurus/codec.js';
