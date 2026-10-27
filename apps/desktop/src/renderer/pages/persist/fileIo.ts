import { parseModuleLibraryJson, serializeModuleLibrary, type ModuleProfile } from '@rockzalct/shared';

/** localStorage key of the module library kept by the receiving-card page. */
export const LIBRARY_KEY = 'rockzalct.modules';

/** Read a file picked with <input type="file"> as text. */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('cannot read file'));
    reader.readAsText(file);
  });
}

/** Offer `text` as a download (Blob + temporary link; works in Electron and browsers). */
export function downloadTextFile(name: string, text: string, mime = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next tick so the browser has started the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** `rockzalct-screen-config-20260102-030405.json` from a Date (local time). */
export function configFileName(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `rockzalct-screen-config-${stamp}.json`;
}

export function loadModuleLibrary(): ModuleProfile[] {
  try {
    const text = localStorage.getItem(LIBRARY_KEY);
    if (!text) return [];
    const res = parseModuleLibraryJson(text);
    return res.ok ? res.profiles : [];
  } catch {
    return [];
  }
}

/** Add `profiles` to the stored library; a profile with the same name (any case) replaces the old one. Returns false when storage is unavailable. */
export function mergeModuleLibrary(profiles: readonly ModuleProfile[]): boolean {
  const names = new Set(profiles.map((p) => p.name.toLowerCase()));
  const next = [...loadModuleLibrary().filter((p) => !names.has(p.name.toLowerCase())), ...profiles].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  try {
    localStorage.setItem(LIBRARY_KEY, serializeModuleLibrary(next));
    return true;
  } catch {
    return false;
  }
}
