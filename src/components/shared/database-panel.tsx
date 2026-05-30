import { useRef } from "react";
import type { useNoIntro } from "@/hooks/use-nointro";
import type { useAmiiboDb } from "@/hooks/use-amiibo-db";

type NoIntroState = ReturnType<typeof useNoIntro>;
type AmiiboDbState = ReturnType<typeof useAmiiboDb>;

interface DatabasePanelProps {
  nointro: NoIntroState;
  amiiboDb: AmiiboDbState;
}

export function DatabasePanel({ nointro, amiiboDb }: DatabasePanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // AmiiboAPI ships JSON; No-Intro DATs are XML. Route by extension.
      if (file.name.toLowerCase().endsWith(".json")) {
        amiiboDb.importDb(file);
      } else {
        nointro.importDat(file);
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const busy = nointro.loading || amiiboDb.loading;
  const hasAny = nointro.systemNames.length > 0 || amiiboDb.loaded;

  return (
    <div className="border-b border-border px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[10px] uppercase tracking-widest text-muted-foreground">
          Databases
        </h2>
        <label className="cursor-pointer">
          <span className="inline-flex h-6 items-center rounded-md border border-input px-2 text-[10px] font-medium hover:bg-accent hover:text-accent-foreground">
            {busy ? "..." : "+ DB"}
          </span>
          <input
            ref={fileRef}
            type="file"
            accept=".dat,.xml,.json"
            className="hidden"
            onChange={handleFile}
          />
        </label>
      </div>
      {(nointro.error || amiiboDb.error) && (
        <div className="mb-1 text-[10px] text-destructive">
          {nointro.error ?? amiiboDb.error}
        </div>
      )}
      {hasAny ? (
        <div className="flex flex-col gap-0.5">
          {nointro.systemNames.map((name) => (
            <div key={name} className="text-[10px] text-muted-foreground">
              {name.replace("Nintendo - ", "")}
              <span className="ml-1 text-muted-foreground/50">
                ({nointro.dbs.get(name)?.entryCount.toLocaleString()})
              </span>
            </div>
          ))}
          {amiiboDb.loaded && (
            <div className="text-[10px] text-muted-foreground">
              Amiibo
              <span className="ml-1 text-muted-foreground/50">
                ({amiiboDb.entryCount.toLocaleString()})
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="text-[10px] text-muted-foreground/50">
          Import a No-Intro DAT or AmiiboAPI database
        </div>
      )}
    </div>
  );
}
