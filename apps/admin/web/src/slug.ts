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

/** O sufixo de desempate cabe **dentro** do teto de 96, como no `withSuffix` do shared. */
const MAX_SLUG = 96;

/**
 * O slug **sugerido** para uma cópia: `minha-skill` → `minha-skill-2`.
 *
 * É o primeiro candidato do `uniqueSlug` do shared, que é quem escolhe de
 * verdade. A clonagem deriva o slug do **slug do original** (`cloneSlugTx` do
 * banco), nunca do nome, e o original sempre ocupa a base — por isso o
 * desempate começa em `-2` e por isso clonar uma cópia empilha
 * (`minha-skill-2` → `minha-skill-2-2`) em vez de andar o número. Empilhar é
 * feio, mas andar mentiria: o endereço sugerido não seria o que nasce, e no
 * objeto cujo nome termina em número de verdade a cópia de `python-3` é
 * `python-3-2`, nunca `python-4`.
 *
 * Só sugestão: o diálogo **não manda** o campo intocado, então um `-2` já
 * ocupado vira `-3` no servidor, sem 409 e sem a pessoa precisar saber.
 */
export function slugDaCopia(slug: string): string {
  const base = slug ?? '';
  if (!base) return base;
  // Perto do teto o sufixo não cabe: encurta a base e apara o hífen do corte,
  // senão sai um slug de 98 que o próprio servidor recusa como inválido.
  const cabe = base.length + 2 <= MAX_SLUG ? base : base.slice(0, MAX_SLUG - 2).replace(/-+$/g, '');
  return `${cabe}-2`;
}
