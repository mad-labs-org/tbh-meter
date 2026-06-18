import { cn } from "~/lib/utils";

interface ModalProps {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  className?: string;
}

/** Minimal in-app modal: dimmed overlay, centered panel, click-outside to close. */
export function Modal({ title, children, onClose, className }: ModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "w-full max-w-sm rounded-lg border border-surface-600 bg-surface-800 p-4 shadow-xl",
          className,
        )}
      >
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {children}
      </div>
    </div>
  );
}
