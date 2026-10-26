// Model <-> hardware snapshot conversion and input checking (pure).
import {
  computeCardPlacements,
  computePortRegions,
  isComplexLayoutScreen,
  type CabinetRef,
  type CabinetSizeOverride,
  type LayoutHardwareState,
  type LayoutModel,
  type LayoutScreen,
  type PortChain,
} from './layoutModel.js';

/** What writing `model` stores on the controller (also what the mock keeps and a read returns). */
export function planLayoutWrite(model: LayoutModel): LayoutHardwareState {
  return {
    complexScreen: isComplexLayoutScreen(model.screen),
    ports: computePortRegions(model).map((r) => ({
      port: r.port,
      enabled: true,
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
    })),
    cards: computeCardPlacements(model).map((c) => ({
      port: c.port,
      index: c.index,
      x: c.portX,
      y: c.portY,
      width: c.width,
      height: c.height,
      cabinetNumber: c.cabinetNumber,
    })),
  };
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isRef = (v: unknown): v is CabinetRef =>
  typeof v === 'object' && v !== null && isInt((v as CabinetRef).row) && isInt((v as CabinetRef).col);

/**
 * Structural check for a LayoutModel arriving over IPC (types only, no semantic validation:
 * run validateLayout afterwards). Returns null when the shape is wrong.
 */
export function parseLayoutModel(v: unknown): LayoutModel | null {
  if (typeof v !== 'object' || v === null) return null;
  const m = v as Partial<LayoutModel>;
  const s = m.screen as Partial<LayoutScreen> | undefined;
  if (typeof s !== 'object' || s === null) return null;
  if (s.kind !== 'standard' && s.kind !== 'complex') return null;
  if (![s.rows, s.cols, s.cabinetWidth, s.cabinetHeight].every(isInt)) return null;
  if (!Array.isArray(s.overrides)) return null;
  for (const o of s.overrides) {
    if (!isRef(o) || !isInt((o as CabinetSizeOverride).width) || !isInt((o as CabinetSizeOverride).height)) return null;
  }
  if (!Array.isArray(m.ports)) return null;
  for (const p of m.ports) {
    if (typeof p !== 'object' || p === null || !isInt((p as PortChain).port)) return null;
    if (!Array.isArray((p as PortChain).cabinets) || !(p as PortChain).cabinets.every(isRef)) return null;
  }
  return v as LayoutModel;
}
