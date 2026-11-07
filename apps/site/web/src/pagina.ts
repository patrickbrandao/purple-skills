/**
 * O número de página que vem do `?page=` da URL.
 *
 * A URL é entrada de fora — link compartilhado, salvo antes de skills serem
 * despublicadas, ou editado à mão —, e o `Math.max(1, Number(…))` de antes não
 * a domava: `?page=abc` dava `NaN` (o paginador mostrava "NaN / N", com os dois
 * botões habilitados) e `?page=1.5` pedia o offset 6, repetindo metade da
 * página anterior (relatório 022 da auditoria de 2026-11-07).
 *
 * Devolve sempre um inteiro maior ou igual a 1; o que não é número vira 1 e a
 * fração é truncada.
 */
export function paginaDaUrl(bruto: string | null): number {
  const lida = Math.trunc(Number(bruto ?? '1'));
  return Number.isFinite(lida) && lida > 1 ? lida : 1;
}

/** Quantas páginas cabem em `total` itens, nunca menos de uma. */
export function totalDePaginas(total: number, porPagina: number): number {
  return Math.max(1, Math.ceil(total / porPagina));
}

/**
 * A página para onde levar quem está além da última, ou `null` quando a página
 * pedida existe. Sem isso, `?page=99` com três páginas dizia "Nenhuma skill
 * pública encontrada" logo abaixo de um contador com total positivo, e o
 * "Anterior" levava à 98, também vazia.
 */
export function paginaPresa(pagina: number, total: number, porPagina: number): number | null {
  const ultima = totalDePaginas(total, porPagina);
  return pagina > ultima ? ultima : null;
}
