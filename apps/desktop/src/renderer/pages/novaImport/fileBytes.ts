/** Read a file picked with <input type="file"> as bytes (the renderer has no file-system access). */
export function readFileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('cannot read file'));
    reader.readAsArrayBuffer(file);
  });
}

/** "1 min 45 s" style duration for the broadcast estimate. */
export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}
