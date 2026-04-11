// Minimal NDEF parser for NTAG dumps — extracts URI and Text records.

const URI_PREFIXES: Record<number, string> = {
  0x00: "",
  0x01: "http://www.",
  0x02: "https://www.",
  0x03: "http://",
  0x04: "https://",
  0x05: "tel:",
  0x06: "mailto:",
  0x07: "ftp://anonymous:anonymous@",
  0x08: "ftp://ftp.",
  0x09: "ftps://",
  0x0a: "sftp://",
  0x0b: "smb://",
  0x0c: "nfs://",
  0x0d: "ftp://",
  0x0e: "dav://",
  0x0f: "news:",
  0x10: "telnet://",
  0x11: "imap:",
  0x12: "rtsp://",
  0x13: "urn:",
  0x14: "pop:",
  0x15: "sip:",
  0x16: "sips:",
  0x17: "tftp:",
  0x18: "btspp://",
  0x19: "btl2cap://",
  0x1a: "btgoep://",
  0x1b: "tcpobex://",
  0x1c: "irdaobex://",
  0x1d: "file://",
  0x1e: "urn:epc:id:",
  0x1f: "urn:epc:tag:",
  0x20: "urn:epc:pat:",
  0x21: "urn:epc:raw:",
  0x22: "urn:epc:",
  0x23: "urn:nfc:",
};

export interface NdefResult {
  uri: string | null;
  text: string | null;
}

/**
 * Parse NDEF records from an NTAG dump.
 * User data starts at page 4 (byte 16). Scans TLVs for the NDEF message
 * (type 0x03), then extracts the first URI and/or Text record found.
 */
export function parseNdef(dump: Uint8Array): NdefResult {
  const data = dump.subarray(16);
  const ndefBytes = findNdefTlv(data);
  if (!ndefBytes) return { uri: null, text: null };

  let uri: string | null = null;
  let text: string | null = null;
  let offset = 0;

  while (offset < ndefBytes.length) {
    const header = ndefBytes[offset++];
    const tnf = header & 0x07;
    const sr = header & 0x10;
    const il = header & 0x08;

    const typeLength = ndefBytes[offset++];
    const payloadLength = sr
      ? ndefBytes[offset++]
      : (ndefBytes[offset++] << 24) |
        (ndefBytes[offset++] << 16) |
        (ndefBytes[offset++] << 8) |
        ndefBytes[offset++];
    const idLength = il ? ndefBytes[offset++] : 0;

    const type = ndefBytes[offset];
    offset += typeLength + idLength;
    const payload = ndefBytes.subarray(offset, offset + payloadLength);
    offset += payloadLength;

    // TNF 0x01 = NFC Forum well-known type
    if (tnf === 0x01 && typeLength === 1) {
      if (type === 0x55 && !uri) {
        // URI record: byte 0 = prefix code, rest = suffix
        const prefix = URI_PREFIXES[payload[0]] ?? "";
        uri = prefix + new TextDecoder().decode(payload.subarray(1));
      } else if (type === 0x54 && !text) {
        // Text record: byte 0 = status (bit 7 = encoding, bits 5-0 = lang length)
        const langLen = payload[0] & 0x3f;
        text = new TextDecoder().decode(payload.subarray(1 + langLen));
      }
    }

    if (header & 0x40) break; // ME (Message End)
  }

  return { uri, text };
}

function findNdefTlv(data: Uint8Array): Uint8Array | null {
  let offset = 0;
  while (offset < data.length) {
    const type = data[offset++];
    if (type === 0x00) continue;
    if (type === 0xfe) break;

    let length: number;
    if (data[offset] === 0xff) {
      length = (data[offset + 1] << 8) | data[offset + 2];
      offset += 3;
    } else {
      length = data[offset++];
    }

    if (type === 0x03) return data.subarray(offset, offset + length);
    offset += length;
  }
  return null;
}
