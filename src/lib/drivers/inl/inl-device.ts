/**
 * INL Retro Programmer — WebUSB device wrapper.
 *
 * Provides typed methods for the INL dictionary-based protocol,
 * mapping to the Lua dict.io(), dict.nes(), dict.buffer(), dict.operation() API.
 *
 * All communication uses USB vendor control transfers:
 *   bRequest = dictionary ID
 *   wValue   = (misc << 8) | opcode
 *   wIndex   = operand
 */

import {
  DICT,
  BUFFER,
  INL_DEVICE_FILTER,
  RETURN,
  SUCCESS,
} from "./inl-opcodes";

export class INLDevice {
  private device: USBDevice | null = null;
  private onDisconnect?: () => void;

  get connected(): boolean {
    return this.device?.opened ?? false;
  }

  get firmwareVersion(): string {
    if (!this.device) return "unknown";
    return `${this.device.deviceVersionMajor}.${this.device.deviceVersionMinor}`;
  }

  get productName(): string {
    return this.device?.productName ?? "INL Retro Programmer";
  }

  /** Prompt user to select device. */
  async connect(): Promise<void> {
    const device = await navigator.usb!.requestDevice({
      filters: [INL_DEVICE_FILTER],
    });
    await this.openDevice(device);
  }

  /** Reconnect to a previously authorized device. */
  async connectWithDevice(device: USBDevice): Promise<void> {
    await this.openDevice(device);
  }

  private async openDevice(device: USBDevice): Promise<void> {
    await device.open();
    await device.selectConfiguration(1);
    await device.claimInterface(0);
    this.device = device;
    navigator.usb!.addEventListener("disconnect", this.handleDisconnect);
  }

  async disconnect(): Promise<void> {
    navigator.usb!.removeEventListener("disconnect", this.handleDisconnect);
    if (this.device?.opened) {
      try {
        await this.device.releaseInterface(0);
      } catch {
        /* best-effort */
      }
      try {
        await this.device.close();
      } catch {
        /* best-effort */
      }
    }
    this.device = null;
  }

  onDisconnected(handler: () => void): void {
    this.onDisconnect = handler;
  }

  private handleDisconnect = (event: USBConnectionEvent) => {
    if (event.device === this.device) {
      this.device = null;
      this.onDisconnect?.();
    }
  };

  // ─── Dictionary Methods ─────────────────────────────────────────────────

  /**
   * Send a PINPORT dictionary command.
   *
   * The reference host sends ALL commands as USB IN transfers (default RL=1),
   * reading back the error byte. CTL_RD (opcode 6) has RL=4.
   * Read operations (>= 0x80) have RL=3.
   */
  async pinport(opcode: number, operand = 0, misc = 0): Promise<number> {
    const returnLength = opcode === 6 ? 4 : opcode >= 0x80 ? 3 : 1;
    return this.controlIn(DICT.PINPORT, opcode, operand, misc, returnLength);
  }

  /** Send an IO dictionary command. */
  async io(opcode: number, operand = 0): Promise<number | null> {
    const returnLength = opcode >= 0x80 ? 3 : 1;
    if (opcode >= 0x80)
      return this.controlIn(DICT.IO, opcode, operand, 0, returnLength);
    await this.controlIn(DICT.IO, opcode, operand, 0, returnLength);
    return null;
  }

  /**
   * Send a NES dictionary command.
   *
   * The reference host sends ALL NES commands as USB IN transfers.
   * Write opcodes (< 0x80) have no RL defined, so default RL=1 (error byte).
   * Read opcodes (>= 0x80) have RL=3 (error + length + data), except
   * GET_BANK_TABLE (0x86) which has RL=4.
   */
  async nes(opcode: number, operand = 0, misc = 0): Promise<number> {
    const returnLength = opcode >= 0x80 ? (opcode === 0x86 ? 4 : 3) : 1;
    return this.controlIn(DICT.NES, opcode, operand, misc, returnLength);
  }

  /**
   * Send a BUFFER dictionary command.
   * All args follow the universal format: wValue=(misc<<8)|opcode, wIndex=operand.
   * The `misc` byte carries the buffer index for per-buffer ops (SET_MEM_N_PART etc.),
   * or the numbanks for allocation ops.
   *
   * The reference sends all buffer commands as IN transfers (default RL=1).
   * Return lengths from shared_dict_buffer.h:
   *   0x50 GET_PRI_ELEMENTS RL=8, 0x51 GET_SEC_ELEMENTS RL=8,
   *   0x52 GET_PAGE_NUM RL=4, 0x60-0x6F RL=3, all others RL=1.
   */
  async buffer(opcode: number, operand = 0, misc = 0): Promise<number> {
    let returnLength = 1;
    if (opcode === 0x50 || opcode === 0x51) returnLength = 8;
    else if (opcode === 0x52) returnLength = 4;
    else if (opcode >= 0x60 && opcode <= 0x6f) returnLength = 3;
    return this.controlIn(DICT.BUFFER, opcode, operand, misc, returnLength);
  }

  /** Send an OPERATION dictionary command. */
  async operation(opcode: number, operand = 0): Promise<number> {
    const returnLength = opcode >= 0x40 ? 3 : 1;
    return this.controlIn(DICT.OPER, opcode, operand, 0, returnLength);
  }

  /** Read a 128-byte payload from the buffer system. */
  async payloadIn(length = 128): Promise<Uint8Array> {
    if (!this.device) throw new Error("Device not connected");

    const result = await this.device.controlTransferIn(
      {
        requestType: "vendor",
        recipient: "device",
        request: DICT.BUFFER,
        value: BUFFER.BUFF_PAYLOAD,
        index: 0,
      },
      length,
    );

    if (!result.data) return new Uint8Array(0);
    return new Uint8Array(
      result.data.buffer,
      result.data.byteOffset,
      result.data.byteLength,
    );
  }

  // ─── Low-level Control Transfers ────────────────────────────────────────

  private async controlIn(
    dict: number,
    opcode: number,
    operand = 0,
    misc = 0,
    returnLength = 1,
  ): Promise<number> {
    if (!this.device) throw new Error("Device not connected");

    const value = ((misc & 0xff) << 8) | (opcode & 0xff);

    const result = await this.device.controlTransferIn(
      {
        requestType: "vendor",
        recipient: "device",
        request: dict,
        value,
        index: operand & 0xffff,
      },
      returnLength,
    );

    if (!result.data || result.data.byteLength < 1) {
      throw new Error(
        `No response from device (dict=${dict}, op=0x${opcode.toString(16)})`,
      );
    }

    const view = new Uint8Array(
      result.data.buffer,
      result.data.byteOffset,
      result.data.byteLength,
    );

    if (view[RETURN.ERR_IDX] !== SUCCESS) {
      throw new Error(
        `Device error 0x${view[RETURN.ERR_IDX].toString(16)} (dict=${dict}, op=0x${opcode.toString(16)})`,
      );
    }

    return view.length > RETURN.DATA_IDX ? view[RETURN.DATA_IDX] : 0;
  }
}
