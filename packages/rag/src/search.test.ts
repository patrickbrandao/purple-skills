/**
 * O fluxo da busca por requisição (§8.1).
 *
 * O que estes testes protegem é a promessa que o PR 4 faz ao cliente: **cair
 * para a busca textual nunca é erro**. Cada caminho que poderia lançar — driver
 * desligado, sem chave, sem migration, sem espaço, provedor fora do ar,
 * provedor lento — tem que virar `mode: 'text'` em silêncio, com o motivo no
 * log e nada de exceção subindo até o handler.
 */
import { describe, expect, it, vi } from 'vitest';
import { criarBuscaSemantica, logDaBusca, type SearchPorts } from './search.js';
import { FakeDriver, MODELO_FALSO } from './fake.js';
import { RagTimeoutError, RagUnavailableError } from './driver.js';

const ESPACO = { uuid: '00000000-0000-7000-8000-00000000fa11' };

function portas(over: Partial<SearchPorts> = {}): SearchPorts {
  return {
    ragSchemaReady: async () => true,
    getRagSettings: async () => ({
      'rag.driver': { value: 'google' },
      'rag.model': { value: MODELO_FALSO.id },
    }),
    findRagSpace: async () => ESPACO,
    ...over,
  };
}

function busca(over: Partial<SearchPorts> = {}, driver: FakeDriver | null = new FakeDriver()) {
  const logs: string[] = [];
  const resolvedor = criarBuscaSemantica({
    ports: portas(over),
    driver,
    timeoutMs: 2000,
    log: (m) => logs.push(m),
  });
  return { resolvedor, logs };
}

describe('quando a perna vetorial sai', () => {
  it('devolve o espaço e o vetor da consulta', async () => {
    const { resolvedor } = busca();
    const r = await resolvedor.resolver('mensagem de commit');

    expect(r.mode).toBe('hybrid');
    expect(r.semantic?.spaceUuid).toBe(ESPACO.uuid);
    expect(r.semantic?.vector).toHaveLength(MODELO_FALSO.dimensions);
  });

  it('o espaço procurado é o do modelo, com os dois prefixos', async () => {
    const findRagSpace = vi.fn(async () => ESPACO);
    const { resolvedor } = busca({ findRagSpace });
    await resolvedor.resolver('x');

    expect(findRagSpace).toHaveBeenCalledWith({
      driver: 'fake',
      model: MODELO_FALSO.id,
      dimensions: MODELO_FALSO.dimensions,
      documentPrefix: MODELO_FALSO.documentPrefix,
      queryPrefix: MODELO_FALSO.queryPrefix,
    });
  });

  it('a consulta leva o prefixo de consulta, não o de documento', async () => {
    const driver = new FakeDriver();
    const { resolvedor } = busca({}, driver);
    await resolvedor.resolver('commits');

    expect(driver.recebidos).toEqual([
      { metodo: 'query', textos: [`${MODELO_FALSO.queryPrefix}commits`] },
    ]);
  });
});

describe('cair para textual nunca é erro', () => {
  it('consulta vazia não chama o provedor', async () => {
    const driver = new FakeDriver();
    const { resolvedor } = busca({}, driver);

    for (const vazia of ['', '   ', null, undefined]) {
      const r = await resolvedor.resolver(vazia);
      expect(r.mode).toBe('text');
    }
    expect(driver.recebidos).toHaveLength(0);
  });

  it('driver off no banco: modo texto, mesmo com o driver montado', async () => {
    const driver = new FakeDriver();
    const { resolvedor } = busca(
      { getRagSettings: async () => ({ 'rag.driver': { value: 'off' } }) },
      driver,
    );
    const r = await resolvedor.resolver('commits');

    expect(r).toMatchObject({ mode: 'text', reason: 'driver-off' });
    expect(driver.recebidos).toHaveLength(0);
  });

  it('sem chave (driver nulo): modo texto, sem nem ler a configuração', async () => {
    const getRagSettings = vi.fn();
    const { resolvedor } = busca({ getRagSettings }, null);
    const r = await resolvedor.resolver('commits');

    expect(r).toMatchObject({ mode: 'text', reason: 'sem-driver' });
    expect(getRagSettings).not.toHaveBeenCalled();
  });

  it('sem a migration: modo texto, e findRagSpace nem é chamada', async () => {
    const findRagSpace = vi.fn();
    const { resolvedor } = busca({ ragSchemaReady: async () => false, findRagSpace });
    const r = await resolvedor.resolver('commits');

    expect(r).toMatchObject({ mode: 'text', reason: 'sem-migration' });
    // É o ponto do relatório do PR 1: sem a 020, findRagSpace lançaria 42P01.
    expect(findRagSpace).not.toHaveBeenCalled();
  });

  it('espaço ainda não criado: modo texto', async () => {
    const { resolvedor } = busca({ findRagSpace: async () => null });
    const r = await resolvedor.resolver('commits');
    expect(r).toMatchObject({ mode: 'text', reason: 'sem-espaco' });
  });

  it('provedor fora do ar: modo texto, com o motivo no log', async () => {
    const driver = new FakeDriver();
    vi.spyOn(driver, 'embedQuery').mockRejectedValue(new RagUnavailableError('503'));
    const { resolvedor, logs } = busca({}, driver);

    const r = await resolvedor.resolver('commits');
    expect(r).toMatchObject({ mode: 'text', reason: 'falha-no-embedding' });
    expect(logs.join('\n')).toContain('modo textual');
  });

  it('provedor lento: o prazo estoura e a resposta não espera', async () => {
    const driver = new FakeDriver();
    vi.spyOn(driver, 'embedQuery').mockRejectedValue(new RagTimeoutError('prazo estourado'));
    const { resolvedor } = busca({}, driver);

    const r = await resolvedor.resolver('commits');
    expect(r).toMatchObject({ mode: 'text', reason: 'falha-no-embedding' });
  });

  it('o banco fora do ar na leitura da configuração não derruba a busca', async () => {
    const { resolvedor } = busca({
      getRagSettings: async () => {
        throw new Error('conexão recusada');
      },
    });
    const r = await resolvedor.resolver('commits');
    expect(r.mode).toBe('text');
  });

  it('modelo que o driver não conhece: modo texto', async () => {
    const { resolvedor } = busca({
      getRagSettings: async () => ({
        'rag.driver': { value: 'google' },
        'rag.model': { value: 'modelo-que-nao-existe' },
      }),
    });
    const r = await resolvedor.resolver('commits');
    expect(r).toMatchObject({ mode: 'text', reason: 'modelo-desconhecido' });
  });

  it('o schema derrubado depois de pronto volta a ser conferido', async () => {
    let pronto = true;
    let explode = false;
    const { resolvedor } = busca({
      ragSchemaReady: async () => pronto,
      findRagSpace: async () => {
        if (explode) throw new Error('relation "rag_spaces" does not exist');
        return ESPACO;
      },
    });

    expect((await resolvedor.resolver('x')).mode).toBe('hybrid');

    explode = true;
    pronto = false;
    expect((await resolvedor.resolver('x')).mode).toBe('text');
    // A próxima já sabe que precisa conferir de novo, em vez de bater no 42P01.
    expect((await resolvedor.resolver('x'))).toMatchObject({ reason: 'sem-migration' });
  });
});

describe('o cache da configuração', () => {
  it('não relê o banco a cada busca', async () => {
    const getRagSettings = vi.fn(async () => ({
      'rag.driver': { value: 'google' },
      'rag.model': { value: MODELO_FALSO.id },
    }));
    const { resolvedor } = busca({ getRagSettings });

    await resolvedor.resolver('a');
    await resolvedor.resolver('b');
    await resolvedor.resolver('c');
    expect(getRagSettings).toHaveBeenCalledTimes(1);
  });

  it('desligar o driver vale em até 10 segundos, sem reiniciar nada', async () => {
    let driverAtual = 'google';
    let relogio = 0;
    const resolvedor = criarBuscaSemantica({
      ports: portas({ getRagSettings: async () => ({ 'rag.driver': { value: driverAtual } }) }),
      driver: new FakeDriver(),
      timeoutMs: 2000,
      now: () => relogio,
    });

    expect((await resolvedor.resolver('x')).mode).toBe('hybrid');

    driverAtual = 'off';
    // Dentro da janela, o valor antigo ainda vale.
    relogio = 9_000;
    expect((await resolvedor.resolver('x')).mode).toBe('hybrid');

    // Passada a janela, o banco manda — é a promessa da §10.
    relogio = 10_001;
    expect((await resolvedor.resolver('x'))).toMatchObject({ mode: 'text', reason: 'driver-off' });
  });

  it('invalidar força a releitura na próxima busca', async () => {
    const getRagSettings = vi.fn(async () => ({ 'rag.driver': { value: 'google' } }));
    const { resolvedor } = busca({ getRagSettings });

    await resolvedor.resolver('a');
    resolvedor.invalidar();
    await resolvedor.resolver('b');
    expect(getRagSettings).toHaveBeenCalledTimes(2);
  });
});

describe('a linha de log', () => {
  it('no modo híbrido, traz os vizinhos e as distâncias', () => {
    expect(
      logDaBusca('hybrid', [
        { slug: 'commit-conventional', distance: 0.1234 },
        { slug: 'code-review', distance: 0.4567 },
      ]),
    ).toBe('[rag] modo híbrido, 2 vizinhos: commit-conventional=0.1234 code-review=0.4567');
  });

  it('no modo texto, não inventa número nenhum', () => {
    expect(logDaBusca('text', [])).toBe('[rag] modo texto');
  });
});
