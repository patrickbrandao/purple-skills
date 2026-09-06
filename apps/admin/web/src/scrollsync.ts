/** O que a sincronia precisa saber de um painel — sem depender do DOM. */
export type ScrollBox = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/**
 * Posição do painel seguidor para ele mostrar a mesma **fração** rolada do
 * painel que manda.
 *
 * Fonte e render não têm a mesma altura (um `##` renderizado ocupa o triplo da
 * linha que o gerou, um bloco de código ocupa o mesmo), então copiar o
 * `scrollTop` cru desencontraria os dois. A fração mantém começo, meio e fim
 * batendo; entre eles o render escorrega conforme a mistura de títulos, listas
 * e código do trecho.
 *
 * Devolve `null` quando não há o que espelhar: painel escondido (o modo de um
 * painel só zera as alturas) ou conteúdo que cabe inteiro, sem rolagem.
 */
export function syncedScrollTop(lead: ScrollBox, follow: ScrollBox): number | null {
  const leadRange = lead.scrollHeight - lead.clientHeight;
  const followRange = follow.scrollHeight - follow.clientHeight;
  if (leadRange <= 0 || followRange <= 0) return null;

  // O navegador limita `scrollTop` à faixa rolável, mas a conta não depende
  // disso: fixar a fração em [0, 1] mantém o seguidor dentro do fim do texto
  // mesmo com rolagem elástica, que reporta valores fora da faixa.
  const fraction = Math.min(Math.max(lead.scrollTop / leadRange, 0), 1);
  return fraction * followRange;
}
