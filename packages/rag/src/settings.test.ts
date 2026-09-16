/**
 * O registro, a validação e a semeadura (§13.1 de `docs/14-rag.md`).
 *
 * A semeadura é testada como função pura: dados o ambiente e o banco, ela diz
 * se grava, se avisa ou se não faz nada. Quem lê e grava é o admin.
 */
import { describe, expect, it } from 'vitest';
import {
  decideSeed,
  modeloPadraoDe,
  modelosDo,
  parseBaseUrl,
  ragSetting,
  readBaseUrlEnv,
  readDriverEnv,
  readIndexIntervalEnv,
  readModelEnv,
  readQueryTimeoutEnv,
  DRIVERS_FUTUROS,
  DRIVERS_IMPLEMENTADOS,
  RAG_DRIVERS,
  RAG_SETTINGS,
} from './settings.js';
import { BASE_URL_GOOGLE, BASE_URL_OPENAI, BASE_URL_VOYAGE } from './models.js';

const MODELO_GOOGLE = modeloPadraoDe('google');

describe('o registro de configurações', () => {
  it('descreve cada opção uma vez só, com o par de cada driver', () => {
    const vars = RAG_SETTINGS.map((s) => s.env);
    expect(vars).toEqual([
      'RAG_DRIVER',
      'RAG_MODEL',
      'RAG_GOOGLE_API_KEY',
      'RAG_GOOGLE_BASE_URL',
      'RAG_OPENAI_API_KEY',
      'RAG_OPENAI_BASE_URL',
      'RAG_VOYAGE_API_KEY',
      'RAG_VOYAGE_BASE_URL',
      'RAG_QUERY_TIMEOUT_MS',
      'RAG_INDEX_INTERVAL_SECONDS',
    ]);
    expect(new Set(vars).size).toBe(vars.length);
  });

  it('o par chave/URL sai do registro de drivers, não de uma lista à mão', () => {
    for (const driver of RAG_DRIVERS) {
      expect(ragSetting(driver.apiKeyEnv).secret).toBe(true);
      expect(ragSetting(driver.baseUrlEnv).fallback).toBe(driver.baseUrlPadrao);
    }
    expect(DRIVERS_IMPLEMENTADOS).toEqual(['google', 'openai', 'voyage']);
    // O `cohere` é o único que sobrou para depois.
    expect(DRIVERS_FUTUROS).toEqual(['cohere']);
  });

  it('cada driver declara os modelos dele, e o primeiro é o padrão', () => {
    expect(modelosDo('google')).toEqual(['gemini-embedding-2']);
    expect(modelosDo('openai')).toEqual(['text-embedding-3-small', 'text-embedding-3-large']);
    expect(modelosDo('voyage')).toEqual(['voyage-4-lite', 'voyage-4', 'voyage-4-large']);
    expect(modeloPadraoDe('openai')).toBe('text-embedding-3-small');
    expect(modeloPadraoDe('voyage')).toBe('voyage-4-lite');
    // Com o driver desligado não há modelo que faça sentido oferecer.
    expect(modelosDo('off')).toEqual([]);
  });

  it('as URLs base padrão são as documentadas por cada provedor', () => {
    expect(BASE_URL_GOOGLE).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(BASE_URL_OPENAI).toBe('https://api.openai.com/v1');
    expect(BASE_URL_VOYAGE).toBe('https://api.voyageai.com/v1');
  });

  it('só `rag.driver` e `rag.model` vão para o banco; só a chave é segredo', () => {
    const noBanco = RAG_SETTINGS.filter((s) => s.key !== null).map((s) => s.key);
    expect(noBanco).toEqual(['rag.driver', 'rag.model']);

    const segredos = RAG_SETTINGS.filter((s) => s.secret).map((s) => s.env);
    expect(segredos).toEqual(['RAG_GOOGLE_API_KEY', 'RAG_OPENAI_API_KEY', 'RAG_VOYAGE_API_KEY']);

    // Editável no painel é exatamente o que vai para o banco.
    expect(RAG_SETTINGS.filter((s) => s.editable).map((s) => s.key)).toEqual([
      'rag.driver',
      'rag.model',
    ]);
  });

  it('opção desconhecida não é inventada', () => {
    expect(() => ragSetting('RAG_INEXISTENTE')).toThrow(/desconhecida/);
  });
});

describe('a validação do ambiente', () => {
  it('RAG_DRIVER aceita os três drivers, off e vazio', () => {
    expect(readDriverEnv({ RAG_DRIVER: 'google' })).toBe('google');
    expect(readDriverEnv({ RAG_DRIVER: 'openai' })).toBe('openai');
    expect(readDriverEnv({ RAG_DRIVER: 'voyage' })).toBe('voyage');
    expect(readDriverEnv({ RAG_DRIVER: 'off' })).toBe('off');
    expect(readDriverEnv({ RAG_DRIVER: '' })).toBe('off');
    expect(readDriverEnv({})).toBe('off');
    // Não é sensível a caixa nem a espaço em volta.
    expect(readDriverEnv({ RAG_DRIVER: '  GOOGLE ' })).toBe('google');
  });

  it('o driver previsto mas não implementado derruba o boot dizendo isso', () => {
    expect(() => readDriverEnv({ RAG_DRIVER: 'cohere' })).toThrow(/ainda não foi implementado/);
  });

  it('driver desconhecido derruba o boot', () => {
    expect(() => readDriverEnv({ RAG_DRIVER: 'pinecone' })).toThrow(/RAG_DRIVER inválida/);
  });

  it('RAG_MODEL é validada contra os modelos do driver escolhido', () => {
    expect(readModelEnv({ RAG_DRIVER: 'google', RAG_MODEL: MODELO_GOOGLE })).toBe(MODELO_GOOGLE);
    expect(readModelEnv({ RAG_DRIVER: 'openai', RAG_MODEL: 'text-embedding-3-large' })).toBe(
      'text-embedding-3-large',
    );

    // Sem RAG_MODEL, vale o padrão **do driver escolhido**.
    expect(readModelEnv({})).toBe(MODELO_GOOGLE);
    expect(readModelEnv({ RAG_DRIVER: 'voyage' })).toBe('voyage-4-lite');

    // O modelo existe, mas é de outro driver: é aí que a validação por driver
    // paga por si — a combinação erraria só na primeira chamada à API.
    expect(() => readModelEnv({ RAG_DRIVER: 'openai', RAG_MODEL: MODELO_GOOGLE })).toThrow(
      /o driver "openai" não tem/,
    );
    expect(() => readModelEnv({ RAG_DRIVER: 'google', RAG_MODEL: 'voyage-4' })).toThrow(
      /o driver "google" não tem/,
    );
    // Modelo de driver nenhum.
    expect(() => readModelEnv({ RAG_MODEL: 'gemini-embedding-1' })).toThrow(/RAG_MODEL inválida/);
  });

  it('a URL base é usada como está, sem ganhar versão, e sem barra final', () => {
    expect(parseBaseUrl('https://exemplo.test/v1beta/')).toBe('https://exemplo.test/v1beta');
    expect(parseBaseUrl('http://127.0.0.1:9999/v1beta')).toBe('http://127.0.0.1:9999/v1beta');
    // Sem variável, o padrão de cada driver.
    expect(readBaseUrlEnv('google', {})).toBe(BASE_URL_GOOGLE);
    expect(readBaseUrlEnv('openai', {})).toBe(BASE_URL_OPENAI);
    expect(readBaseUrlEnv('voyage', {})).toBe(BASE_URL_VOYAGE);
    // E cada um lê a variável dele.
    expect(readBaseUrlEnv('openai', { RAG_OPENAI_BASE_URL: 'http://127.0.0.1:1/v1/' })).toBe(
      'http://127.0.0.1:1/v1',
    );
    // A versão nunca é acrescentada: o que o operador escreveu é o que vale.
    expect(parseBaseUrl('https://exemplo.test')).toBe('https://exemplo.test');
  });

  it('URL base relativa ou com esquema errado derruba o boot, dizendo a variável', () => {
    expect(() => parseBaseUrl('/v1beta')).toThrow(/URL absoluta/);
    expect(() => parseBaseUrl('ftp://exemplo.test')).toThrow(/http ou https/);
    expect(() => readBaseUrlEnv('voyage', { RAG_VOYAGE_BASE_URL: '/v1' })).toThrow(
      /RAG_VOYAGE_BASE_URL inválida/,
    );
  });

  it('os numéricos seguem readIntEnv: inválido derruba, ausente cai no padrão', () => {
    expect(readQueryTimeoutEnv({})).toBe(2000);
    expect(readQueryTimeoutEnv({ RAG_QUERY_TIMEOUT_MS: '500' })).toBe(500);
    expect(() => readQueryTimeoutEnv({ RAG_QUERY_TIMEOUT_MS: '2s' })).toThrow(/inválida/);

    expect(readIndexIntervalEnv({})).toBe(30);
    expect(readIndexIntervalEnv({ RAG_INDEX_INTERVAL_SECONDS: '5' })).toBe(5);
    expect(() => readIndexIntervalEnv({ RAG_INDEX_INTERVAL_SECONDS: '0' })).toThrow(/inválida/);
  });
});

describe('a semeadura (§4.1)', () => {
  it('banco vazio e ambiente definido: grava', () => {
    const d = decideSeed({ key: 'rag.driver', envValue: 'google', dbValue: null });
    expect(d).toEqual({ action: 'gravar', key: 'rag.driver', value: 'google' });
  });

  it('banco vazio e ambiente ausente: não grava, e vale o padrão do código', () => {
    const d = decideSeed({ key: 'rag.driver', envValue: undefined, dbValue: null });
    expect(d).toEqual({ action: 'nada', key: 'rag.driver', value: 'off', reason: 'sem-ambiente' });

    // Vazio é tratado como ausente: o compose repassa `FOO: ${FOO:-}`.
    expect(decideSeed({ key: 'rag.driver', envValue: '   ', dbValue: null }).action).toBe('nada');
  });

  it('banco preenchido e ambiente igual: não faz nada', () => {
    const d = decideSeed({ key: 'rag.driver', envValue: 'google', dbValue: 'google' });
    expect(d).toEqual({ action: 'nada', key: 'rag.driver', value: 'google', reason: 'igual' });
  });

  it('banco preenchido e ambiente diferente: o banco manda, e sai o aviso', () => {
    const d = decideSeed({
      key: 'rag.driver',
      envValue: 'google',
      dbValue: 'off',
      changedBy: 'ana@exemplo em 15/09/2026',
    });

    expect(d.action).toBe('avisar');
    if (d.action !== 'avisar') throw new Error('esperado avisar');
    // O valor em uso continua sendo o do banco.
    expect(d.value).toBe('off');
    expect(d.env).toBe('google');
    expect(d.warning).toBe(
      '[rag] RAG_DRIVER=google ignorada: o banco já define rag.driver=off ' +
        '(alterado no painel por ana@exemplo em 15/09/2026)',
    );
  });

  it('o aviso funciona sem saber quem mudou', () => {
    const d = decideSeed({ key: 'rag.model', envValue: MODELO_GOOGLE, dbValue: 'voyage-4' });
    if (d.action !== 'avisar') throw new Error('esperado avisar');
    expect(d.warning).toBe(
      `[rag] RAG_MODEL=${MODELO_GOOGLE} ignorada: o banco já define rag.model=voyage-4`,
    );
  });

  it('o ambiente inválido é recusado antes de virar linha no banco', () => {
    expect(() => decideSeed({ key: 'rag.driver', envValue: 'cohere', dbValue: null })).toThrow(
      /ainda não foi implementado/,
    );
    // E o modelo é recusado no driver errado, não só quando não existe.
    expect(() =>
      decideSeed({ key: 'rag.model', envValue: MODELO_GOOGLE, dbValue: null, driver: 'voyage' }),
    ).toThrow(/o driver "voyage" não tem/);
  });

  it('sem ambiente, o padrão de rag.model é o do driver em uso', () => {
    const d = decideSeed({ key: 'rag.model', envValue: undefined, dbValue: null, driver: 'openai' });
    expect(d).toEqual({
      action: 'nada',
      key: 'rag.model',
      value: 'text-embedding-3-small',
      reason: 'sem-ambiente',
    });
  });

  it('o valor semeado é o normalizado, não o que veio escrito', () => {
    const d = decideSeed({ key: 'rag.driver', envValue: ' GOOGLE ', dbValue: null });
    expect(d).toEqual({ action: 'gravar', key: 'rag.driver', value: 'google' });
  });
});
