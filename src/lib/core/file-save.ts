const hasFilePicker = "showSaveFilePicker" in window;

// Characters that are unsafe in filenames across Windows, Linux, and macOS.
// Stripping them keeps a cartridge title or No-Intro name usable verbatim
// without the save dialog rejecting it (matches the NDS handler's set).
const RESERVED_CHARS = /[<>:"/\\|?*]/g;

function sanitizeFilename(name: string): string {
  // Collapse whitespace runs left behind by stripped characters
  // (e.g. "NES / Famicom" → "NES  Famicom" → "NES Famicom").
  return (
    name.replace(RESERVED_CHARS, "").replace(/\s+/g, " ").trim() || "dump"
  );
}

/**
 * Save data to a file. Uses the File System Access API if available
 * (native save dialog), otherwise falls back to a browser download.
 *
 * Resolves on success or if the user cancels the native dialog. Rejects if
 * the file couldn't actually be written, so callers can surface the failure
 * instead of leaving the user believing a one-shot dump reached disk.
 */
export async function saveFile(
  data: Uint8Array,
  suggestedName: string,
  extensions: string[],
): Promise<void> {
  const filename = sanitizeFilename(suggestedName);

  if (hasFilePicker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await (
        window as unknown as {
          showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle>;
        }
      ).showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: "File",
            accept: { "application/octet-stream": extensions },
          },
        ],
      });
    } catch (error) {
      // The picker rejects with AbortError when the user dismisses it — not a
      // failure. Anything else (e.g. a name the browser refuses) is, so it
      // falls through to the throw below.
      if (error instanceof DOMException && error.name === "AbortError") return;
      throw error;
    }

    // A destination is chosen; a write/close failure means the bytes never
    // reached disk, so let it propagate to the caller.
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  } else {
    // `data` is a valid BlobPart; the cast sidesteps a TS6 ArrayBufferLike-vs-
    // ArrayBuffer variance false-positive without copying the bytes.
    const blob = new Blob([data as BlobPart], {
      type: "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    // Defer the revoke: revoking in the same tick as click() can cancel the
    // download before the browser has started fetching the blob.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
