import { useState, useEffect } from "react";
import { Copy, Check, Loader2, ArrowLeft } from "lucide-react";
import { cn } from "~/lib/utils";

interface DebugLogViewProps {
  onBack: () => void;
}

export function DebugLogView({ onBack }: DebugLogViewProps) {
  const [info, setInfo] = useState<string | "loading" | "error">("loading");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    window.meter
      .debugInfo()
      .then(setInfo)
      .catch(() => setInfo("error"));
  }, []);

  const copyToClipboard = async () => {
    if (typeof info !== "string") return;
    await navigator.clipboard.writeText(info);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-surface-600 px-4 py-2.5">
        <button
          onClick={onBack}
          className="flex cursor-pointer items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <ArrowLeft className="size-3" />
          Back to Settings
        </button>
        {typeof info === "string" && (
          <button
            onClick={copyToClipboard}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-colors",
              copied
                ? "bg-emerald-600/15 text-emerald-300"
                : "bg-surface-700 text-zinc-200 hover:bg-surface-600",
            )}
          >
            {copied ? (
              <>
                <Check className="size-3.5" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="size-3.5" />
                Copy to clipboard
              </>
            )}
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto">
        {info === "loading" ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-500">
            <Loader2 className="size-4 animate-spin" />
            Collecting debug info...
          </div>
        ) : info === "error" ? (
          <div className="flex h-full items-center justify-center text-sm text-red-400">
            Failed to collect debug info.
          </div>
        ) : (
          <pre className="select-all whitespace-pre-wrap break-all p-4 font-mono text-xs text-zinc-300">
            {info}
          </pre>
        )}
      </div>
    </div>
  );
}
