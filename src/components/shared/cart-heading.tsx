import type { NDSCartridgeInfo } from "@/lib/systems/nds/nds-header";

/**
 * Heading rendered above an NDS scanner card. Shows the system-family
 * label ("DS" / "DSi" / "3DS") when known, otherwise a generic fallback.
 *
 * The "i" in "DSi" is intentionally wrapped in a span with `normal-case`
 * so it stays lowercase when the parent CardTitle applies CSS `uppercase`
 * — the platform's name is conventionally written "DSi" and uppercasing
 * to "DSI" would be wrong.
 */
export function CartHeading({ info }: { info: NDSCartridgeInfo | null }) {
  if (!info) return <>No cartridge detected</>;
  const family = info.meta?.cartFamily;
  if (family === "DSi") return <span className="normal-case">DSi</span>;
  if (family === "DS") return <>DS</>;
  if (family === "3DS") return <>3DS</>;
  return <>Cartridge detected</>;
}
