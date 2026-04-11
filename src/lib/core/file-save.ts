const hasFilePicker = "showSaveFilePicker" in window;

/**
 * Save data to a file. Uses the File System Access API if available
 * (native save dialog), otherwise falls back to a browser download.
 * If the user cancels the native dialog, does nothing.
 */
export async function saveFile(
  data: Uint8Array,
  suggestedName: string,
  extensions: string[],
): Promise<void> {
  if (hasFilePicker) {
    try {
      const handle = await (window as unknown as { showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle> })
        .showSaveFilePicker({
          suggestedName,
          types: [{ description: "File", accept: { "application/octet-stream": extensions } }],
        });
      const writable = await handle.createWritable();
      await writable.write(data.buffer as ArrayBuffer);
      await writable.close();
    } catch {
      // User cancelled — do nothing
    }
  } else {
    // Fallback: browser download
    const blob = new Blob([data.buffer as ArrayBuffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedName;
    a.click();
    URL.revokeObjectURL(url);
  }
}
