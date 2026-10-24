import type { ReactNode } from 'react';

/** Bloco da área do cliente (título com ícone, ação à direita). */
export function Section({ icon, title, action, children, id }: { icon: ReactNode; title: string; action?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="scroll-mt-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-zinc-200">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold [&>svg]:size-5 [&>svg]:text-zinc-400">
          {icon} {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
