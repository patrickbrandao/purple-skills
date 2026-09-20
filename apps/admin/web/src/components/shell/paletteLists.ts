import type { CatalogSummary, VirtualMcpSummary } from '../../api.js';

/*
 * As duas listas que a paleta (⌘K) carrega inteiras: servidores e catálogos.
 * Sem React, para o teste rodar em node.
 *
 * Elas são buscadas a CADA abertura, como a busca de skills sempre foi. Quando
 * eram buscadas uma vez só, a paleta mostrava até o logout a foto da primeira
 * abertura — ela fica montada ao lado do shell e nenhuma navegação a remonta:
 * o catálogo criado depois não aparecia em "escolher catálogo", o servidor
 * criado depois sumia da busca e o apagado continuava nela (`tasks/069`).
 */

/** Compatível com o `setState` do React: valor, ou função do valor atual. */
type Setter<T> = (next: T | ((current: T) => T)) => void;

export type PaletteListsIo = {
  getMcps: () => Promise<{ items: VirtualMcpSummary[] }>;
  getCatalogs: () => Promise<{ items: CatalogSummary[] }>;
  /** `null` = ainda buscando (é o que a paleta mostra como "Buscando…"). */
  setMcps: Setter<VirtualMcpSummary[] | null>;
  setCatalogs: Setter<CatalogSummary[] | null>;
};

/**
 * Busca as listas de uma abertura e devolve o cancelamento dela — quem fechou
 * ou trocou de página não recebe a resposta atrasada por cima da nova.
 *
 * - **raiz**: servidores e catálogos. A lista anterior fica na tela enquanto a
 *   nova não chega, para os grupos não pularem a cada ⌘K; ali ela só navega.
 * - **escolher catálogo**: só os catálogos, e a lista anterior sai antes. O
 *   item escolhido vira gravação (o vínculo no canvas, o rascunho da skill), e
 *   um slug de foto velha é 404 na hora de salvar.
 *
 * Se a busca falha, fica o que já estava; sem nada, a lista vazia — `null`
 * deixaria a paleta em "Buscando…" para sempre.
 */
export function loadPaletteLists(page: 'root' | 'pick-catalog', io: PaletteListsIo): () => void {
  let cancelled = false;

  function load<T>(request: Promise<{ items: T[] }>, set: Setter<T[] | null>) {
    request.then(
      (data) => {
        if (!cancelled) set(data.items);
      },
      () => {
        if (!cancelled) set((current) => current ?? []);
      },
    );
  }

  if (page === 'pick-catalog') io.setCatalogs(null);
  else load(io.getMcps(), io.setMcps);
  load(io.getCatalogs(), io.setCatalogs);

  return () => {
    cancelled = true;
  };
}
