import { describe, expect, it } from 'vitest';
import type { CatalogSummary, VirtualMcpSummary } from '../../api.js';
import { loadPaletteLists, type PaletteListsIo } from './paletteLists.js';

// Só o slug importa aqui; o resto dos resumos não entra na conta.
const mcp = (slug: string) => ({ slug }) as VirtualMcpSummary;
const catalogo = (slug: string) => ({ slug }) as CatalogSummary;

const slugs = (lista: { slug: string }[] | null) => lista?.map((item) => item.slug) ?? null;

/** O estado da paleta e uma API de mentira, cujas respostas o teste controla. */
function paleta(servidor: { mcps: string[]; catalogs: string[] }) {
  const estado = { mcps: null as VirtualMcpSummary[] | null, catalogs: null as CatalogSummary[] | null };
  const chamadas = { mcps: 0, catalogs: 0 };
  let falhar = false;
  // As respostas ficam retidas até o teste soltar: é assim que se vê o que a
  // tela mostra ENQUANTO busca, e o que acontece com a resposta atrasada.
  let soltar: (() => void)[] = [];

  const responder = <T>(itens: () => T[]) =>
    new Promise<{ items: T[] }>((resolve, reject) => {
      const foto = itens();
      const recusar = falhar;
      soltar.push(() => (recusar ? reject(new Error('rede caiu')) : resolve({ items: foto })));
    });

  const io: PaletteListsIo = {
    getMcps: () => {
      chamadas.mcps += 1;
      return responder(() => servidor.mcps.map(mcp));
    },
    getCatalogs: () => {
      chamadas.catalogs += 1;
      return responder(() => servidor.catalogs.map(catalogo));
    },
    setMcps: (next) => {
      estado.mcps = typeof next === 'function' ? next(estado.mcps) : next;
    },
    setCatalogs: (next) => {
      estado.catalogs = typeof next === 'function' ? next(estado.catalogs) : next;
    },
  };

  return {
    io,
    estado,
    chamadas,
    falharDaquiEmDiante: () => {
      falhar = true;
    },
    /** Entrega as respostas retidas e espera os `then` rodarem. */
    async chegar() {
      const lote = soltar;
      soltar = [];
      for (const entregar of lote) entregar();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe('listas da paleta ⌘K: buscadas a cada abertura (tasks/069)', () => {
  it('o catálogo criado depois da primeira abertura aparece em "escolher catálogo"', async () => {
    const servidor = { mcps: ['principal'], catalogs: ['time-b'] };
    const p = paleta(servidor);

    // 1ª abertura, na raiz (⌘K ou a lupa das listas): carrega as duas listas.
    loadPaletteLists('root', p.io);
    await p.chegar();
    expect(slugs(p.estado.catalogs)).toEqual(['time-b']);

    // A pessoa cria "Time A" e volta à skill → "Adicionar a um catálogo".
    servidor.catalogs = ['time-a', 'time-b'];
    loadPaletteLists('pick-catalog', p.io);
    await p.chegar();

    // Com a lista buscada uma vez só, aqui continuava ['time-b'].
    expect(slugs(p.estado.catalogs)).toEqual(['time-a', 'time-b']);
    expect(p.chamadas.catalogs).toBe(2);
  });

  it('servidor criado aparece e servidor apagado some, na abertura seguinte', async () => {
    const servidor = { mcps: ['antigo', 'principal'], catalogs: [] as string[] };
    const p = paleta(servidor);
    loadPaletteLists('root', p.io);
    await p.chegar();

    servidor.mcps = ['novo', 'principal'];
    loadPaletteLists('root', p.io);
    await p.chegar();

    expect(slugs(p.estado.mcps)).toEqual(['novo', 'principal']);
    expect(p.chamadas.mcps).toBe(2);
  });

  it('na raiz a lista anterior fica na tela enquanto a nova não chega', async () => {
    const p = paleta({ mcps: ['principal'], catalogs: ['time-b'] });
    loadPaletteLists('root', p.io);
    await p.chegar();

    loadPaletteLists('root', p.io);
    // Resposta ainda retida: nada de `null` no meio, senão os grupos pulam a cada ⌘K.
    expect(slugs(p.estado.mcps)).toEqual(['principal']);
    expect(slugs(p.estado.catalogs)).toEqual(['time-b']);
  });

  it('em "escolher catálogo" a lista anterior sai antes: foto velha ali vira 404 no Salvar', async () => {
    const p = paleta({ mcps: ['principal'], catalogs: ['time-b'] });
    loadPaletteLists('root', p.io);
    await p.chegar();

    loadPaletteLists('pick-catalog', p.io);
    expect(p.estado.catalogs).toBeNull(); // a paleta mostra "Buscando…"
    await p.chegar();
    expect(slugs(p.estado.catalogs)).toEqual(['time-b']);
    // Esta página não lista servidores: não os busca, e não mexe nos da raiz.
    expect(p.chamadas.mcps).toBe(1);
    expect(slugs(p.estado.mcps)).toEqual(['principal']);
  });

  it('quem fechou (ou trocou de página) não recebe a resposta atrasada', async () => {
    const servidor = { mcps: ['principal'], catalogs: ['time-b'] };
    const p = paleta(servidor);
    const cancelar = loadPaletteLists('root', p.io);
    cancelar();
    await p.chegar();

    expect(p.estado.mcps).toBeNull();
    expect(p.estado.catalogs).toBeNull();
  });

  it('se a busca falha, fica o que já estava; sem nada, a lista vazia (e não "Buscando…" para sempre)', async () => {
    const p = paleta({ mcps: ['principal'], catalogs: ['time-b'] });
    loadPaletteLists('root', p.io);
    await p.chegar();

    p.falharDaquiEmDiante();
    loadPaletteLists('root', p.io);
    await p.chegar();
    expect(slugs(p.estado.mcps)).toEqual(['principal']);
    expect(slugs(p.estado.catalogs)).toEqual(['time-b']);

    loadPaletteLists('pick-catalog', p.io);
    await p.chegar();
    expect(p.estado.catalogs).toEqual([]);
  });
});
