import type { SerialTransport } from "@/lib/transport/serial-transport";
import { CMD, ACK_OK } from "./gbxcart-commands";

/** Send a single command byte and optionally wait for ACK. */
export async function sendCommand(
  transport: SerialTransport,
  cmd: number,
  expectAck: boolean,
): Promise<void> {
  await transport.send(new Uint8Array([cmd]));
  if (expectAck) {
    const ack = await transport.receive(1, { timeout: 1000 });
    if (!ACK_OK.includes(ack[0])) {
      throw new Error(`Command 0x${cmd.toString(16)} failed: ACK=0x${ack[0].toString(16)}`);
    }
  }
}

/** Set a firmware variable. */
export async function setVariable(
  transport: SerialTransport,
  varDef: readonly [number, number],
  value: number,
  expectAck: boolean,
): Promise<void> {
  const [bitWidth, index] = varDef;
  const sizeBytes = bitWidth / 8;
  const packet = new Uint8Array(10);
  packet[0] = CMD.SET_VARIABLE;
  packet[1] = sizeBytes;
  // Key as big-endian uint32
  new DataView(packet.buffer).setUint32(2, index, false);
  // Value as big-endian uint32
  new DataView(packet.buffer).setUint32(6, value, false);
  await transport.send(packet);

  if (expectAck) {
    const ack = await transport.receive(1, { timeout: 1000 });
    if (!ACK_OK.includes(ack[0])) {
      throw new Error(`SET_VARIABLE failed: ACK=0x${ack[0].toString(16)}`);
    }
  }
}

/** Write a byte to a cartridge address (DMG). */
export async function cartWrite(
  transport: SerialTransport,
  address: number,
  value: number,
  expectAck: boolean,
): Promise<void> {
  const packet = new Uint8Array(6);
  packet[0] = CMD.DMG_CART_WRITE;
  new DataView(packet.buffer).setUint32(1, address, false);
  packet[5] = value;
  await transport.send(packet);

  if (expectAck) {
    const ack = await transport.receive(1, { timeout: 1000 });
    if (!ACK_OK.includes(ack[0])) {
      throw new Error(`CART_WRITE 0x${address.toString(16)}=0x${value.toString(16)} failed`);
    }
  }
}

/** Read ROM data. Returns accumulated bytes. */
export async function readRom(
  transport: SerialTransport,
  cmd: number,
  address: number,
  length: number,
  maxChunk: number,
  isAGB: boolean,
  onProgress?: (bytesRead: number, totalBytes: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const data = new Uint8Array(length);
  let offset = 0;

  while (offset < length) {
    if (signal?.aborted) throw new Error("Aborted");

    const chunkSize = Math.min(maxChunk, length - offset);
    const addr = isAGB ? (address + offset) >> 1 : address + offset;

    // Initialize for this chunk
    await setVariable(transport, [16, 0x00], chunkSize, true); // TRANSFER_SIZE
    await setVariable(transport, [32, 0x00], addr, true);       // ADDRESS

    // Calculate how many read commands needed for this chunk
    // Each read command returns TRANSFER_SIZE bytes
    const readsNeeded = Math.ceil(chunkSize / chunkSize); // 1 read per init
    for (let i = 0; i < readsNeeded; i++) {
      await transport.send(new Uint8Array([cmd]));
      const chunk = await transport.receive(chunkSize, { timeout: 5000 });
      data.set(chunk, offset);
      offset += chunk.length;
      onProgress?.(offset, length);
    }
  }

  return data;
}
