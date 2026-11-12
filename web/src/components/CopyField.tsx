import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button, Field, inputClass } from './ui';

/** Campo só de leitura com botão de copiar (URLs e tokens para colar em outro site). */
export function CopyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <input readOnly value={value} className={`${inputClass} font-mono text-xs`} onFocus={(e) => e.target.select()} />
        <Button
          type="button"
          variant="ghost"
          className="shrink-0 !px-3"
          aria-label={`Copiar ${label}`}
          onClick={() =>
            navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </Field>
  );
}
