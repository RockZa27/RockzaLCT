/** Offer `text` as a file download through a Blob URL. Resolves false when the browser refuses. */
export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8'): boolean {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick so the download has started.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
}
