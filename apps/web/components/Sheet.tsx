'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

/**
 * The one overlay: a native <dialog> (focus stays inside, Escape closes, the page behind is
 * inert), centred on a desk, a bottom sheet on a phone.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        // A press on the backdrop (the dialog element itself, outside the panel) closes it.
        if (e.target === ref.current) onClose();
      }}
      aria-labelledby="sheet-title"
      className="m-0 mt-auto w-full max-w-none bg-transparent p-0 backdrop:bg-ink/45 backdrop:backdrop-blur-[2px] open:scrim-in sm:m-auto sm:max-w-xl"
    >
      {open && (
        <div className="sheet-in flex max-h-[92svh] flex-col overflow-hidden rounded-t-2xl bg-card shadow-overlay sm:rounded-2xl">
          <div className="flex items-start gap-4 border-b border-line px-6 pb-4 pt-5">
            <div className="min-w-0 flex-1">
              <h2 id="sheet-title" className="text-lg font-semibold text-ink">
                {title}
              </h2>
              {description && <p className="mt-1 text-muted">{description}</p>}
            </div>
            <button type="button" onClick={onClose} className="btn btn-quiet -me-2 -mt-1 h-10 w-10 p-0" aria-label="Close">
              <X size={18} aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer && <div className="border-t border-line bg-page px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
