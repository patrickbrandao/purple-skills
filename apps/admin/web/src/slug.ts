/**
 * Espelha `packages/shared/src/slug.ts` — o slug definitivo é o do servidor.
 * Aqui serve só para sugerir o slug enquanto o nome é digitado.
 */
const DIACRITICS = /[̀-ͯ]/g;

export function slugify(input: string): string {
  return (input ?? '')
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
    .replace(/-+$/g, '');
}
