import type { ReactNode } from 'react';

export const inputClass =
  'w-full rounded-lg border border-purple-400/15 bg-ink-850 px-3.5 py-2.5 text-sm text-purple-50 placeholder-slate-600 outline-none transition focus:border-purple-500/60 focus:ring-2 focus:ring-purple-500/20';

export const labelClass = 'block text-xs font-semibold tracking-wide text-slate-400 uppercase';

export function Button({
  children,
  variant = 'primary',
  className = '',
  ...props
}: {
  children: ReactNode;
  variant?: 'primary' | 'ghost' | 'danger';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const variants = {
    primary:
      'bg-gradient-to-br from-purple-500 to-purple-700 text-white shadow-lg shadow-purple-950/40 hover:from-purple-400 hover:to-purple-600',
    ghost:
      'border border-purple-400/20 bg-ink-850 text-purple-100 hover:border-purple-400/45 hover:bg-ink-800',
    danger: 'border border-red-500/30 bg-red-950/40 text-red-300 hover:bg-red-900/50',
  };

  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-purple-400/12 bg-ink-850/70 p-5 ${className}`}>
      {children}
    </div>
  );
}

export function Badge({ isPublic }: { isPublic: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-medium ${
        isPublic ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-500/15 text-slate-400'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${isPublic ? 'bg-emerald-400' : 'bg-slate-500'}`} />
      {isPublic ? 'pública' : 'privada'}
    </span>
  );
}
