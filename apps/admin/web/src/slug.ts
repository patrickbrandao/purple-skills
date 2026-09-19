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

/**
 * O slug **enquanto se digita**, para o campo do formulário.
 *
 * Existe porque o servidor passou a **recusar** com 400 o slug explícito
 * inválido, em vez de corrigi-lo em silêncio (`tasks/049`): o campo mandava o
 * que a pessoa digitasse e ela descobria o problema no Salvar.
 *
 * Não é o `slugify`: ele apara o hífen do fim, e quem digita "minha-skill" veria
 * o hífen sumir a cada tecla. Aqui o hífen do fim sobrevive — é o único trecho
 * que ainda pode virar válido com a próxima letra — e o `onBlur` do campo passa
 * o valor pelo `slugify` de verdade. O resto é igual: acento cai, maiúscula
 * baixa, o que não é `a-z0-9` vira hífen, hífen repetido colapsa, hífen no
 * começo não entra e o teto é 96.
 */
export function slugEmDigitacao(input: string): string {
  return (input ?? '')
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 96);
}
