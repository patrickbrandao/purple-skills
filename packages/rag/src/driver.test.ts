/**
 * O vocabulário dos erros (`docs/14-rag.md` §6 e §9).
 *
 * O `kind` é o que atravessa a fronteira do processo: o indexador o publica em
 * `rag.indexer.status`, e o painel decide o estado da chave por ele. Estes
 * testes fixam as duas metades do contrato — o valor de cada classe, e que as
 * duas subclasses mudam **só** o estado exibido, nunca a política de tentativas.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ragErrorKind,
  RagAuthError,
  RagConfigError,
  RagInputTooLongError,
  RagOriginError,
  RagQuotaError,
  RagRateLimitError,
  RagTimeoutError,
  RagUnavailableError,
} from './driver.js';
import { ClienteHttp } from './http.js';

describe('o kind de cada erro', () => {
  it.each([
    [new RagAuthError('x'), 'auth'],
    [new RagOriginError('x'), 'origin'],
    [new RagConfigError('x'), 'config'],
    [new RagQuotaError('x'), 'quota'],
    [new RagRateLimitError('x', null), 'rate-limit'],
    [new RagInputTooLongError('x'), 'input-too-long'],
    [new RagUnavailableError('x'), 'unavailable'],
    [new RagTimeoutError('x'), 'timeout'],
  ] as const)('%o → %s', (erro, esperado) => {
    // Os valores são publicados no banco e lidos por outro container: renomear
    // um deles quebra o painel de quem atualizou um lado só.
    expect(erro.kind).toBe(esperado);
    expect(ragErrorKind(erro)).toBe(esperado);
  });

  it('erro que não é do pacote não tem kind', () => {
    // Falha do banco, `TypeError` de rede, erro de quem chamou: nada disso diz
    // coisa alguma sobre o provedor, e é isso que o `null` publica.
    expect(ragErrorKind(new Error('constraint violada'))).toBeNull();
    expect(ragErrorKind(new TypeError('fetch failed'))).toBeNull();
    expect(ragErrorKind('texto solto')).toBeNull();
    expect(ragErrorKind(undefined)).toBeNull();
    // Um objeto qualquer com `kind` não passa: o vocabulário é o das classes.
    expect(ragErrorKind({ kind: 'auth' })).toBeNull();
  });

  it('o nome é o da subclasse, para o log dizer qual erro foi', () => {
    expect(new RagQuotaError('x').name).toBe('RagQuotaError');
    expect(new RagOriginError('x').name).toBe('RagOriginError');
  });
});

describe('as subclasses herdam a política', () => {
  it('RagQuotaError é um RagConfigError, e RagOriginError é um RagAuthError', () => {
    // É por `instanceof` da classe-base que `http.ts` deixa de tentar de novo e
    // que o indexador encerra o ciclo. Trocar a base para `Error` faria o 429
    // sem crédito cair no recuo e queimar o ciclo inteiro.
    expect(new RagQuotaError('x')).toBeInstanceOf(RagConfigError);
    expect(new RagOriginError('x')).toBeInstanceOf(RagAuthError);
    // E não o contrário: configuração recusada não é conta sem crédito.
    expect(new RagConfigError('x')).not.toBeInstanceOf(RagQuotaError);
    expect(new RagAuthError('x')).not.toBeInstanceOf(RagOriginError);
  });

  it.each([
    ['RagQuotaError', () => new RagQuotaError('sem crédito')],
    ['RagOriginError', () => new RagOriginError('origem recusada')],
  ] as const)('o ClienteHttp não tenta de novo diante de %s', async (_nome, criar) => {
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;
    const esperas: number[] = [];
    const http = new ClienteHttp('o provedor', {
      fetchImpl,
      maxRetries: 5,
      sleep: async (ms) => void esperas.push(ms),
    });

    const erro = criar();
    await expect(
      http.pedir({ url: 'https://exemplo.test/v1/embeddings', headers: {}, corpo: {} }, () => {
        throw erro;
      }),
    ).rejects.toBe(erro);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(esperas).toEqual([]);
  });
});

/**
 * `RagUnavailableError` é, por escrito, "408, 5xx ou falha de rede". A falha de
 * rede que sobrava das tentativas saía do `ClienteHttp` como veio do `fetch` — um
 * `TypeError` cru —, e por isso **sem classe**: o indexador a publicava com
 * `lastErrorKind: null`, que é o que ele reserva para erro que não veio do
 * provedor (refatiar, gravar o vetor).
 */
describe('a falha de rede que sobra das tentativas', () => {
  const pedido = { url: 'https://exemplo.test/v1/embeddings', headers: {}, corpo: {} };
  const naoMapeia = (): never => {
    throw new Error('sem resposta, o mapeamento não é chamado');
  };

  it('sai como RagUnavailableError, com a causa na mensagem e em `cause`', async () => {
    // O formato do undici: a mensagem é sempre "fetch failed", e quem diz o que
    // houve é a causa.
    const falha = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.exemplo.test'), {
        code: 'ENOTFOUND',
      }),
    });
    const fetchImpl = vi.fn(async () => {
      throw falha;
    }) as unknown as typeof fetch;
    const esperas: number[] = [];
    const http = new ClienteHttp('a OpenAI', {
      fetchImpl,
      maxRetries: 2,
      sleep: async (ms) => void esperas.push(ms),
    });

    const erro = (await http.pedir(pedido, naoMapeia).catch((e: unknown) => e)) as Error;

    expect(erro).toBeInstanceOf(RagUnavailableError);
    expect(ragErrorKind(erro)).toBe('unavailable');
    expect(erro.message).toContain('a OpenAI não respondeu');
    expect(erro.message).toContain('ENOTFOUND api.exemplo.test');
    expect(erro.cause).toBe(falha);
    // A política não mudou: as mesmas tentativas, com o mesmo recuo.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(esperas).toEqual([500, 1000]);
  });

  it('resposta 200 ilegível também é indisponibilidade, não erro sem classe', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>gateway</html>', { status: 200 }),
    ) as unknown as typeof fetch;
    const http = new ClienteHttp('a Voyage', { fetchImpl, maxRetries: 1, sleep: async () => {} });

    const erro = await http.pedir(pedido, naoMapeia).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(RagUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('o erro do pacote que sobra das tentativas sai como veio', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    const http = new ClienteHttp('o Google', { fetchImpl, maxRetries: 1, sleep: async () => {} });
    const doDriver = new RagUnavailableError('o Google está indisponível (503 UNAVAILABLE)');

    await expect(
      http.pedir(pedido, () => {
        throw doDriver;
      }),
    ).rejects.toBe(doDriver);
  });
});
