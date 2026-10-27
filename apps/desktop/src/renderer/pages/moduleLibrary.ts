import {
  parseModuleLibraryJson,
  serializeModuleLibrary,
  type ModuleProfile,
} from '@rockzalct/shared';

/** localStorage key of the module library (shared by the Receiving card and Smart Settings pages). */
export const LIBRARY_KEY = 'rockzalct.modules';

export function loadLibrary(): ModuleProfile[] {
  try {
    const text = localStorage.getItem(LIBRARY_KEY);
    if (!text) return [];
    const res = parseModuleLibraryJson(text);
    return res.ok ? res.profiles : [];
  } catch {
    return [];
  }
}

export function saveLibrary(profiles: ModuleProfile[]): void {
  try {
    localStorage.setItem(LIBRARY_KEY, serializeModuleLibrary(profiles));
  } catch {
    /* storage unavailable: the library stays in memory only */
  }
}

/** The library with `profile` added or replaced (same name, case-insensitive), sorted by name. */
export function withProfile(library: readonly ModuleProfile[], profile: ModuleProfile): ModuleProfile[] {
  return [...library.filter((p) => p.name.toLowerCase() !== profile.name.toLowerCase()), profile].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}
