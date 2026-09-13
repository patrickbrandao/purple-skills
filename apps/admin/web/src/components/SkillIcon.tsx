import { useState } from 'react';

/**
 * O ícone de uma skill, num ladrilho: emoji, imagem (URL) ou — sem ícone ou
 * com a imagem quebrada — um monograma com as iniciais sobre uma cor derivada
 * do slug, para que a mesma skill tenha sempre a mesma cara.
 */
export function SkillIcon({
  icon,
  name,
  slug,
  size,
  className = '',
}: {
  icon: string | null | undefined;
  name: string;
  slug: string;
  size?: 'sm' | 'lg';
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const classes = ['skill-icon', size ?? '', className].filter(Boolean).join(' ');

  if (icon && !broken) {
    if (/^https?:\/\//.test(icon)) {
      return (
        <span className={classes} title={name}>
          <img src={icon} alt="" loading="lazy" onError={() => setBroken(true)} />
        </span>
      );
    }
    return (
      <span className={classes} title={name} aria-hidden>
        {icon}
      </span>
    );
  }

  return (
    <span
      className={`${classes} mono-tile`}
      title={name}
      style={{ background: monogramColor(slug || name) }}
      aria-hidden
    >
      <span className="mono">{initials(name || slug)}</span>
    </span>
  );
}

/** Duas letras: as iniciais das duas primeiras palavras, ou as duas primeiras letras. */
export function initials(text: string): string {
  const words = text
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0] ?? '?').slice(0, 2).toUpperCase();
}

/** Matiz estável a partir do texto; saturação e luz fixas para ler bem nos dois temas. */
export function monogramColor(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 42% 40%)`;
}
