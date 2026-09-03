import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Button({
  children,
  variant = 'primary',
  size,
  className = '',
  ...props
}: {
  children: ReactNode;
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'lg';
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = ['btn', `btn-${variant}`, size ? `btn-${size}` : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button {...props} className={classes}>
      {children}
    </button>
  );
}

export function Panel({
  children,
  className = '',
  title,
  icon,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  icon?: ReactNode;
}) {
  return (
    <section className={`panel ${className}`.trim()}>
      {title && (
        <h2>
          {icon}
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

export function Badge({ isPublic }: { isPublic: boolean }) {
  return (
    <span className={`badge ${isPublic ? 'public' : 'private'}`}>
      <span className="dot" />
      {isPublic ? 'pública' : 'privada'}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && (
        <span className="mt-1.5 block text-xs" style={{ color: 'var(--text-faint)' }}>
          {hint}
        </span>
      )}
    </label>
  );
}
