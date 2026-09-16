/**
 * O driver falso e o servidor falso (§6.3).
 *
 * Eles são ferramenta de teste, mas de teste de outras coisas — se o vetor
 * falso não for determinístico, ou se o servidor falso não remover o prefixo,
 * a suíte da busca começa a falhar por motivo errado. Daí testá-los também.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeDriver,
  MODELO_FALSO,
  semPrefixo,
  subirServidorFalso,
  vetorFalso,
  type ServidorFalso,
} from './fake.js';
import { GEMINI_EMBEDDING_2, GoogleDriver } from './google.js';

let servidor: ServidorFalso | null = null;

afterEach(async () => {
  await servidor?.fechar();
  servidor = null;
});

describe('o vetor falso', () => {
  it('é determinístico e normalizado', () => {
    const a = vetorFalso('mensagem de commit', 32);
    const b = vetorFalso('mensagem de commit', 32);
    expect(a).toEqual(b);

    const norma = Math.sqrt(a.reduce((acc, v) => acc + v * v, 0));
    expect(norma).toBeCloseTo(1, 10);
  });

  it('textos com palavras em comum ficam mais próximos que textos sem nada em comum', () => {
    const cosseno = (x: number[], y: number[]) => x.reduce((a, v, i) => a + v * y[i]!, 0);

    const consulta = vetorFalso('mensagem de commit', 128);
    const perto = vetorFalso('mensagem de commit padronizada', 128);
    const longe = vetorFalso('receita de bolo de fubá', 128);

    expect(cosseno(consulta, perto)).toBeGreaterThan(cosseno(consulta, longe));
  });

  it('o prefixo não soma ruído: o servidor falso o remove antes de calcular', () => {
    expect(semPrefixo(`${GEMINI_EMBEDDING_2.documentPrefix}oi`)).toBe('oi');
    expect(semPrefixo(`${GEMINI_EMBEDDING_2.queryPrefix}oi`)).toBe('oi');
    expect(semPrefixo('oi')).toBe('oi');

    expect(vetorFalso(`${GEMINI_EMBEDDING_2.documentPrefix}commits`, 32)).toEqual(
      vetorFalso('commits', 32),
    );
  });

  it('texto sem palavra nenhuma não vira vetor nulo', () => {
    // A distância do cosseno não é definida para o vetor de zeros.
    const v = vetorFalso('!!! ...', 16);
    expect(v.some((x) => x !== 0)).toBe(true);
  });
});

describe('o driver falso', () => {
  it('aplica o prefixo certo em cada método e guarda o que recebeu', async () => {
    const driver = new FakeDriver();
    await driver.embedDocuments(MODELO_FALSO, ['um', 'dois']);
    await driver.embedQuery(MODELO_FALSO, 'três');

    expect(driver.recebidos).toEqual([
      {
        metodo: 'documents',
        textos: [`${MODELO_FALSO.documentPrefix}um`, `${MODELO_FALSO.documentPrefix}dois`],
      },
      { metodo: 'query', textos: [`${MODELO_FALSO.queryPrefix}três`] },
    ]);
  });

  it('devolve um vetor por texto, no tamanho do modelo', async () => {
    const vetores = await new FakeDriver().embedDocuments(MODELO_FALSO, ['a', 'b', 'c']);
    expect(vetores).toHaveLength(3);
    for (const v of vetores) expect(v).toHaveLength(MODELO_FALSO.dimensions);
  });
});

describe('o servidor falso', () => {
  it('fala o protocolo do Google bem o bastante para o driver de verdade rodar', async () => {
    servidor = await subirServidorFalso();
    const driver = new GoogleDriver({ apiKey: 'qualquer', baseUrl: servidor.baseUrl });

    const consulta = await driver.embedQuery(GEMINI_EMBEDDING_2, 'commits');
    const documentos = await driver.embedDocuments(GEMINI_EMBEDDING_2, ['commits', 'bolo']);

    expect(consulta).toHaveLength(3072);
    expect(documentos).toHaveLength(2);
    // O fluxo inteiro sem chave e sem rede externa: é o que a §13.3 item 1 pede.
    expect(servidor.requisicoes).toHaveLength(2);
  });

  it('o documento e a consulta do mesmo texto dão o mesmo vetor, porque o prefixo é removido', async () => {
    servidor = await subirServidorFalso();
    const driver = new GoogleDriver({ apiKey: 'q', baseUrl: servidor.baseUrl });

    const [doc] = await driver.embedDocuments(GEMINI_EMBEDDING_2, ['commits']);
    const consulta = await driver.embedQuery(GEMINI_EMBEDDING_2, 'commits');
    expect(doc).toEqual(consulta);
  });

  it('a troca de falha no meio do teste vale para a requisição seguinte', async () => {
    servidor = await subirServidorFalso();
    const driver = new GoogleDriver({
      apiKey: 'q',
      baseUrl: servidor.baseUrl,
      maxRetries: 0,
    });

    await driver.embedQuery(GEMINI_EMBEDDING_2, 'x');
    servidor.simular('chave-invalida-401');
    await expect(driver.embedQuery(GEMINI_EMBEDDING_2, 'x')).rejects.toThrow(/recusou a chave/);
  });
});
