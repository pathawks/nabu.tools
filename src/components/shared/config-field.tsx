import { AlertTriangle } from "lucide-react";
import type { ResolvedConfigField } from "@/lib/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";

function Linkify({ text }: { text: string }) {
  const urlPattern =
    /((?:https?:\/\/)?[\w.-]+\.(?:com|org|net|io)(?::\d+)?(?:\/\S*)?)/;
  const parts = text.split(urlPattern);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a
            key={i}
            href={part.startsWith("http") ? part : `https://${part}`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

interface ConfigFieldProps {
  field: ResolvedConfigField;
  onChange: (value: unknown) => void;
}

export function ConfigField({ field, onChange }: ConfigFieldProps) {
  if (field.type === "hidden") return null;

  return (
    // min-w-0: as a grid item this would otherwise refuse to shrink below
    // its content (a long select label), overflowing into the next column.
    <div className="flex min-w-0 flex-col gap-1">
      <label className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {field.label}
        {field.autoDetected && (
          <span className="ml-2 rounded-sm bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-primary">
            auto
          </span>
        )}
        {field.locked && !field.autoDetected && (
          <span className="ml-2 text-muted-foreground">(locked)</span>
        )}
      </label>

      {field.type === "readonly" && (
        <span className="text-sm text-card-foreground">
          {String(field.value)}
        </span>
      )}

      {field.type === "select" && field.options && (
        <Select
          value={String(field.value)}
          onValueChange={(v) => {
            const opt = field.options?.find((o) => String(o.value) === v);
            onChange(opt ? opt.value : v);
          }}
          disabled={field.locked}
        >
          <SelectTrigger className="h-9 w-full bg-background font-mono text-sm">
            <SelectValue>
              <span className="truncate">
                {
                  field.options.find(
                    (o) => String(o.value) === String(field.value),
                  )?.label
                }
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {field.options.map((opt) => (
              <SelectItem
                key={String(opt.value)}
                value={String(opt.value)}
                disabled={opt.disabled}
              >
                <span className="flex flex-col">
                  <span>{opt.label}</span>
                  {opt.hint && (
                    <span className="text-[11px] text-muted-foreground">
                      {opt.hint}
                    </span>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {field.type === "text" && (
        <input
          type="text"
          value={String(field.value)}
          onChange={(e) => onChange(e.target.value)}
          disabled={field.locked}
          className="h-9 rounded-md border border-input bg-background px-3 font-mono text-sm text-card-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
      )}

      {field.type === "checkbox" && (
        <div className="flex items-center gap-2">
          <Checkbox
            checked={field.value as boolean}
            onCheckedChange={(v) => onChange(v)}
            disabled={field.locked}
          />
          {field.helpText && (
            <span className="text-xs text-muted-foreground">
              <Linkify text={field.helpText} />
            </span>
          )}
        </div>
      )}

      {field.type !== "checkbox" && field.helpText && (
        <span className="text-[11px] text-muted-foreground">
          <Linkify text={field.helpText} />
        </span>
      )}

      {field.lockedReason && (
        <span className="text-[11px] text-primary/70">{field.lockedReason}</span>
      )}

      {field.warning && (
        <span className="flex items-start gap-1 text-[11px] text-chart-3">
          <AlertTriangle className="mt-px size-3 shrink-0" />
          <span>{field.warning}</span>
        </span>
      )}
    </div>
  );
}
