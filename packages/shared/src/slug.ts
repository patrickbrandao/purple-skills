const DIACRITICS = /[̀-ͯ]/g;

/**
 * Teto do slug. É o corte do `slugify` e, por consequência, o que `isValidSlug`
 * cobra: acima dele nenhum texto é idempotente sob `slugify`.
 */
const MAX_SLUG = 96;

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
    .slice(0, MAX_SLUG)
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
    const candidate = withSuffix(base, `-${i}`);
    if (!set.has(candidate)) return candidate;
  }

  return withSuffix(base, `-${Date.now()}`);
}

/**
 * Acrescenta o sufixo de desempate **dentro** do teto, encurtando a base.
 *
 * Posto depois do corte do `slugify`, o sufixo escapava dele: uma base de 96
 * caracteres virava um slug de 98 que o próprio `isValidSlug` recusa — e quem o
 * gerou foi o sistema (`resolveSlug`, `freeVirtualMcpSlug` e `freeCatalogSlug`
 * do banco devolvem este valor direto para o `INSERT`). O resultado voltava
 * depois como "slug inválido" na edição, num campo que ninguém digitou.
 *
 * Cortar a base não muda nada no caso comum: só entra em ação quando ela já
 * está no teto.
 */
function withSuffix(base: string, suffix: string): string {
  if (base.length + suffix.length <= MAX_SLUG) return `${base}${suffix}`;
  return `${base.slice(0, MAX_SLUG - suffix.length).replace(/-+$/g, '')}${suffix}`;
}

/** Um slug é válido se for idempotente sob `slugify` e não estiver vazio. */
export function isValidSlug(slug: string): boolean {
  return typeof slug === 'string' && slug.length > 0 && slugify(slug) === slug;
}
