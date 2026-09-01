const DIACRITICS = /[̀-ͯ]/g;

/**
 * Converte um texto livre em um slug seguro para URLs.
 * Remove acentos, troca tudo que não for [a-z0-9] por hífen e colapsa hífens.
 */
export function slugify(input: string): string {
  const base = (input ?? '')
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
    .replace(/-+$/g, '');

  return base;
}

/**
 * Gera um slug único a partir de `name`, evitando colisões com `taken`.
 * Slugs vazios (ex: nome só com emojis) recebem o prefixo `skill`.
 */
export function uniqueSlug(name: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  const base = slugify(name) || 'skill';

  if (!set.has(base)) return base;

  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}-${i}`;
    if (!set.has(candidate)) return candidate;
  }

  return `${base}-${Date.now()}`;
}

/** Um slug é válido se for idempotente sob `slugify` e não estiver vazio. */
export function isValidSlug(slug: string): boolean {
  return typeof slug === 'string' && slug.length > 0 && slugify(slug) === slug;
}
