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

/** `rockzalct-coefficients-p1c2-20260102-030405.json` (port and card 1-based, local time). */
export function coefficientFileName(
  portIndex: number,
  cardIndex: number,
  kind: 'coefficients' | 'backup' = 'coefficients',
  now: Date = new Date(),
): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `rockzalct-${kind}-p${portIndex + 1}c${cardIndex + 1}-${stamp}.json`;
}
