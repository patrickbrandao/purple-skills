/**
 * A escolha do driver pela configuração (§4.1 e §6 de `tmp/RAG-GOOGLE.md`).
 *
 * O que estes testes protegem é a reconciliação entre as duas metades da
 * configuração: as **chaves** vivem no ambiente e são lidas no boot; o
 * **driver em uso** vive no banco e muda pelo painel. Montar todos os drivers
 * com chave, e escolher entre eles na hora do uso, é o que faz a troca valer
 * sem recriar container.
 */
import { describe, expect, it } from 'vitest';
import { criarDriver, criarDriversDoAmbiente, modeloPadrao } from './index.js';
import { GoogleDriver } from './google.js';

describe('criarDriver', () => {
  it('com o driver off ou sem chave devolve nulo, sem lançar', () => {
    // São os dois casos normais de "a busca ainda não está ligada"; quem chama
    // cai no modo textual, e tratar exceção para isso seria ruído.
    expect(criarDriver({ driver: 'off', apiKey: 'k' })).toBeNull();
    expect(criarDriver({ driver: 'google', apiKey: undefined })).toBeNull();
    expect(criarDriver({ driver: 'google', apiKey: '' })).toBeNull();
  });

  it('escolhe a classe pelo driver', () => {
    const google = criarDriver({ driver: 'google', apiKey: 'k' });
    expect(google).toBeInstanceOf(GoogleDriver);
    expect(google?.id).toBe('google');
  });
});

describe('criarDriversDoAmbiente', () => {
  it('monta um driver por chave presente, e só por chave presente', () => {
    const { resolver, comChave } = criarDriversDoAmbiente({ RAG_GOOGLE_API_KEY: 'k' });

    expect(comChave).toEqual(['google']);
    expect(resolver('google')).toBeInstanceOf(GoogleDriver);
    // O banco pode pedir um driver para o qual este container não tem chave:
    // a resposta é nula, e a busca responde em modo textual.
    expect(resolver('openai')).toBeNull();
  });

  it('sem chave nenhuma não monta nada, e isso não é erro', () => {
    const { resolver, comChave, problemas } = criarDriversDoAmbiente({});
    expect(comChave).toEqual([]);
    expect(problemas).toEqual([]);
    expect(resolver('google')).toBeNull();
  });

  it('a chave de um driver não vale para outro', () => {
    const { comChave } = criarDriversDoAmbiente({ RAG_VOYAGE_API_KEY: 'k' });
    expect(comChave).toEqual(['voyage']);
  });

  it('um driver que não sobe não derruba os outros', () => {
    // `voyage` ainda não tem classe neste commit: ele entra em `problemas`, e
    // o `google` continua montado. É a regra que vale para sempre — chave
    // presente com driver quebrado não pode calar o provedor que funciona.
    const { resolver, comChave, problemas } = criarDriversDoAmbiente({
      RAG_GOOGLE_API_KEY: 'k',
      RAG_VOYAGE_API_KEY: 'k',
    });

    expect(comChave).toEqual(['google', 'voyage']);
    expect(resolver('google')).toBeInstanceOf(GoogleDriver);
    expect(problemas.map((p) => p.id)).toContain('voyage');
  });
});

describe('modeloPadrao', () => {
  it('é o primeiro modelo que o registro lista para o driver', () => {
    expect(modeloPadrao('google').id).toBe('gemini-embedding-2');
    expect(modeloPadrao('openai').id).toBe('text-embedding-3-small');
    expect(modeloPadrao('voyage').id).toBe('voyage-4-lite');
  });

  it('traz as dimensões e os prefixos, que são a identidade do espaço', () => {
    expect(modeloPadrao('google')).toMatchObject({
      dimensions: 3072,
      documentPrefix: 'title: none | text: ',
      queryPrefix: 'task: search result | query: ',
    });
    // Nos outros dois a distinção não é texto: os prefixos ficam vazios.
    expect(modeloPadrao('openai')).toMatchObject({ dimensions: 1536, documentPrefix: '', queryPrefix: '' });
    expect(modeloPadrao('voyage')).toMatchObject({ dimensions: 1024, documentPrefix: '', queryPrefix: '' });
  });
});
