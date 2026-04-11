// Amiibo NTAG215 data parsing — UID, BCC checks, ModelInfo

import type { CartridgeInfo } from "@/lib/types";

const SERIES_NAMES: Record<number, string> = {
  0x00: "Super Smash Bros.",
  0x01: "Super Mario",
  0x02: "Chibi-Robo",
  0x03: "Yoshi's Woolly World",
  0x04: "Splatoon",
  0x05: "Animal Crossing",
  0x06: "8-Bit Mario",
  0x07: "Skylanders",
  0x09: "The Legend of Zelda",
  0x0a: "Shovel Knight",
  0x0c: "Kirby",
  0x0d: "Pokemon",
  0x0e: "Mario Sports Superstars",
  0x0f: "Monster Hunter",
  0x10: "BoxBoy!",
  0x11: "Pikmin",
  0x12: "Fire Emblem",
  0x13: "Metroid",
  0x14: "Others",
  0x15: "Mega Man",
  0x16: "Diablo",
};

const FIGURE_TYPES: Record<number, string> = {
  0: "Figure",
  1: "Card",
  2: "Yarn",
};

// UID byte positions within the NTAG215 dump (skipping BCC bytes at 3 and 8)
const UID_POSITIONS = [0, 1, 2, 4, 5, 6, 7] as const;
const MODELINFO_OFFSET = 84;

export interface AmiiboData {
  uid: Uint8Array;
  uidHex: string;
  uidFormatted: string;
  uidValid: boolean;
  isAmiibo: boolean;
  modelInfo: AmiiboModelInfo | null;
}

export interface AmiiboModelInfo {
  amiiboId: string;
  gameId: number;
  characterId: number;
  characterVariant: number;
  figureType: number;
  figureTypeName: string;
  modelNumber: number;
  series: number;
  seriesName: string;
}

export function parseAmiiboData(buffer: Uint8Array): AmiiboData {
  const uid = new Uint8Array(UID_POSITIONS.map((i) => buffer[i]));

  // BCC (Block Check Character) validation
  const expectedBcc0 = 0x88 ^ buffer[0] ^ buffer[1] ^ buffer[2];
  const expectedBcc1 = buffer[4] ^ buffer[5] ^ buffer[6] ^ buffer[7];
  const uidValid = buffer[3] === expectedBcc0 && buffer[8] === expectedBcc1;

  // ModelInfo: bytes 84-95 (unencrypted region)
  const mi = buffer.slice(MODELINFO_OFFSET, MODELINFO_OFFSET + 12);

  // Real Amiibo: byte 91 (mi[7]) === 0x02, figure type (mi[3]) <= 0x02
  const isAmiibo = mi[7] === 0x02 && mi[3] <= 0x02;

  let modelInfo: AmiiboModelInfo | null = null;
  if (isAmiibo) {
    const idWord = (mi[0] << 8) | mi[1];
    modelInfo = {
      amiiboId: toHex(mi.slice(0, 8)),
      gameId: idWord & 0x3ff,
      characterId: (idWord >> 10) & 0x3f,
      characterVariant: mi[2],
      figureType: mi[3],
      figureTypeName: FIGURE_TYPES[mi[3]] ?? `Unknown (${mi[3]})`,
      modelNumber: (mi[4] << 8) | mi[5],
      series: mi[6],
      seriesName: SERIES_NAMES[mi[6]] ?? `Unknown (0x${mi[6].toString(16)})`,
    };
  }

  const uidHex = toHex(uid);
  const uidFormatted = Array.from(uid, (b) =>
    b.toString(16).padStart(2, "0").toUpperCase(),
  ).join(":");

  return { uid, uidHex, uidFormatted, uidValid, isAmiibo, modelInfo };
}

export function amiiboToCartridgeInfo(
  parsed: AmiiboData,
  rawData: Uint8Array,
): CartridgeInfo {
  return {
    title: parsed.modelInfo?.seriesName ?? "NFC Tag",
    romSize: rawData.length,
    rawHeader: rawData.slice(0, 96),
    meta: {
      uid: parsed.uid,
      uidHex: parsed.uidHex,
      uidFormatted: parsed.uidFormatted,
      uidValid: parsed.uidValid,
      isAmiibo: parsed.isAmiibo,
      ...(parsed.modelInfo ?? {}),
    },
  };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
