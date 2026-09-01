import { useEffect, useState } from 'react';
import { CheckIcon, LinkIcon } from './Icons.js';

type Props = {
  value: string;
  label?: string;
  className?: string;
};

/** Copia um texto para a área de transferência, com fallback para navegadores antigos. */
export function CopyButton({ value, label = 'Copiar link', className = '' }: Props) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const input = document.createElement('textarea');
        input.value = value;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        document.body.removeChild(input);
      }
      setCopied(true);
    } catch {
      window.prompt('Copie o link:', value);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={`inline-flex items-center gap-2 rounded-lg border border-purple-400/20 bg-ink-800 px-4 py-2.5 text-sm font-medium text-purple-100 transition hover:border-purple-400/50 hover:bg-ink-700 ${className}`}
      aria-live="polite"
    >
      {copied ? <CheckIcon className="h-4 w-4 text-emerald-400" /> : <LinkIcon />}
      {copied ? 'Link copiado!' : label}
    </button>
  );
}
