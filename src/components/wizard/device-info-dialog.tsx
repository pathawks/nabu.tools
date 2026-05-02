import { useState } from "react";
import { Check, Copy, ExternalLink, Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { DeviceDef } from "@/lib/core/devices";
import { buildUdevRule, formatUsbId, isLinuxLike } from "@/lib/core/udev";

const TRANSPORT_LABEL: Record<DeviceDef["transport"], string> = {
  serial: "Web Serial",
  webhid: "WebHID",
  webusb: "WebUSB",
  nfc: "Web NFC",
  http: "HTTP",
};

const RULES_FILE_URL =
  "https://github.com/pathawks/nabu.tools/blob/main/linux/99-nabu.rules";

const RELOAD_COMMANDS = `sudo udevadm control --reload-rules && sudo udevadm trigger`;

interface DeviceInfoDialogProps {
  device: DeviceDef;
}

export function DeviceInfoDialog({ device }: DeviceInfoDialogProps) {
  const usbId = formatUsbId(device);
  const rule = buildUdevRule(device);

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`About ${device.name}`}
          />
        }
      >
        <Info />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{device.name}</DialogTitle>
          {device.models && device.models.length > 0 && (
            <DialogDescription className="font-mono text-xs">
              {device.models.join(" · ")}
            </DialogDescription>
          )}
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <p className="text-card-foreground">{device.description}</p>

          <DetailRow label="Systems">
            {device.systems.map((s) => s.name).join(", ")}
          </DetailRow>

          {usbId && (
            <DetailRow label="USB ID">
              <span className="font-mono">{usbId}</span>
              <span className="ml-2 text-muted-foreground">
                ({TRANSPORT_LABEL[device.transport]})
              </span>
            </DetailRow>
          )}

          {device.homepage && (
            <DetailRow label="Homepage">
              <a
                href={device.homepage}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline underline-offset-3 hover:text-foreground"
              >
                {new URL(device.homepage).host}
                <ExternalLink className="size-3" />
              </a>
            </DetailRow>
          )}

          {rule && (
            <details
              className="mt-2 rounded-md border border-border bg-muted/30 px-3 py-2"
              open={isLinuxLike()}
            >
              <summary className="cursor-pointer select-none text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                Linux setup
              </summary>
              <div className="mt-3 flex flex-col gap-3 text-xs">
                <p className="text-card-foreground">
                  Linux blocks browser access to USB devices by default. Add a
                  udev rule to grant your desktop user access:
                </p>
                <CodeBlock
                  label="Append to /etc/udev/rules.d/99-nabu.rules"
                  value={rule}
                />
                <CodeBlock label="Reload and replug" value={RELOAD_COMMANDS} />
                <p className="text-muted-foreground">
                  Or download{" "}
                  <a
                    href={RULES_FILE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 underline underline-offset-3 hover:text-foreground"
                  >
                    99-nabu.rules
                    <ExternalLink className="size-3" />
                  </a>{" "}
                  with rules for every supported device.
                </p>
              </div>
            </details>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <span className="text-card-foreground">{children}</span>
    </div>
  );
}

function CodeBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Best-effort; clipboard API unavailable in some contexts.
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <div className="flex items-start gap-2 rounded-md border border-border bg-background p-2">
        <pre className="flex-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-snug">
          {value}
        </pre>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onCopy}
          aria-label={copied ? "Copied" : "Copy to clipboard"}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}
