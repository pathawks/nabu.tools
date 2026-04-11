import { hexStr } from "@/lib/core/hashing";

interface HexPreviewProps {
  data: Uint8Array;
  offset?: number;
  rows?: number;
}

export function HexPreview({ data, offset = 0, rows = 6 }: HexPreviewProps) {
  if (!data || data.length === 0) return null;

  const lines = [];
  for (let r = 0; r < rows; r++) {
    const addr = offset + r * 16;
    if (addr >= data.length) break;
    let hex = "";
    let ascii = "";
    for (let c = 0; c < 16; c++) {
      const i = addr + c;
      if (i < data.length) {
        hex += data[i].toString(16).padStart(2, "0") + " ";
        ascii += data[i] >= 0x20 && data[i] < 0x7f ? String.fromCharCode(data[i]) : "\u00b7";
      } else {
        hex += "   ";
        ascii += " ";
      }
      if (c === 7) hex += " ";
    }
    lines.push(
      <div key={r} className="flex gap-3">
        <span className="text-ring">{hexStr(addr)}</span>
        <span className="text-muted-foreground">{hex}</span>
        <span className="text-chart-2">{ascii}</span>
      </div>,
    );
  }

  return (
    <pre className="m-0 overflow-x-auto rounded border border-border bg-background p-3 font-mono text-[11px] leading-relaxed">
      {lines}
    </pre>
  );
}
