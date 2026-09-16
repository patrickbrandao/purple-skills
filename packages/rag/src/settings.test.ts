/**
 * O registro, a validação e a semeadura (§13.1 de `tmp/RAG-GOOGLE.md`).
 *
 * A semeadura é testada como função pura: dados o ambiente e o banco, ela diz
 * se grava, se avisa ou se não faz nada. Quem lê e grava é o admin.
 */
import { describe, expect, it } from 'vitest';
import {
  decideSeed,
  parseBaseUrl,
  ragSetting,
  readBaseUrlEnv,
  readDriverEnv,
  readIndexIntervalEnv,
  readModelEnv,
  readQueryTimeoutEnv,
  BASE_URL_PADRAO,
  MODELO_PADRAO,
  RAG_SETTINGS,
} from './settings.js';

describe('o registro de configurações', () => {
  it('descreve cada opção uma vez só, e as seis da §4.2', () => {
    const vars = RAG_SETTINGS.map((s) => s.env);
    expect(vars).toEqual([
      'RAG_DRIVER',
      'RAG_MODEL',
      'RAG_GOOGLE_API_KEY',
      'RAG_GOOGLE_BASE_URL',
      'RAG_QUERY_TIMEOUT_MS',
      'RAG_INDEX_INTERVAL_SECONDS',
    ]);
    expect(new Set(vars).size).toBe(vars.length);
  });

  it('só `rag.driver` e `rag.model` vão para o banco; só a chave é segredo', () => {
    const noBanco = RAG_SETTINGS.filter((s) => s.key !== null).map((s) => s.key);
    expect(noBanco).toEqual(['rag.driver', 'rag.model']);

    const segredos = RAG_SETTINGS.filter((s) => s.secret).map((s) => s.env);
    expect(segredos).toEqual(['RAG_GOOGLE_API_KEY']);

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
  it('RAG_DRIVER aceita google, off e vazio', () => {
    expect(readDriverEnv({ RAG_DRIVER: 'google' })).toBe('google');
    expect(readDriverEnv({ RAG_DRIVER: 'off' })).toBe('off');
    expect(readDriverEnv({ RAG_DRIVER: '' })).toBe('off');
    expect(readDriverEnv({})).toBe('off');
    // Não é sensível a caixa nem a espaço em volta.
    expect(readDriverEnv({ RAG_DRIVER: '  GOOGLE ' })).toBe('google');
  });

  it('os drivers previstos mas não implementados derrubam o boot dizendo isso', () => {
    for (const driver of ['openai', 'voyage', 'cohere']) {
      expect(() => readDriverEnv({ RAG_DRIVER: driver })).toThrow(/ainda não foi implementado/);
    }
  });

  it('driver desconhecido derruba o boot', () => {
    expect(() => readDriverEnv({ RAG_DRIVER: 'pinecone' })).toThrow(/RAG_DRIVER inválida/);
  });

  it('RAG_MODEL só aceita o modelo da v1', () => {
    expect(readModelEnv({ RAG_MODEL: MODELO_PADRAO })).toBe(MODELO_PADRAO);
    expect(readModelEnv({})).toBe(MODELO_PADRAO);
    expect(() => readModelEnv({ RAG_MODEL: 'gemini-embedding-1' })).toThrow(/RAG_MODEL inválida/);
  });

  it('a URL base é usada como está, sem ganhar versão, e sem barra final', () => {
    expect(parseBaseUrl('https://exemplo.test/v1beta/')).toBe('https://exemplo.test/v1beta');
    expect(parseBaseUrl('http://127.0.0.1:9999/v1beta')).toBe('http://127.0.0.1:9999/v1beta');
    // Sem variável, o padrão do Google.
    expect(readBaseUrlEnv({})).toBe(BASE_URL_PADRAO);
    // A versão nunca é acrescentada: o que o operador escreveu é o que vale.
    expect(parseBaseUrl('https://exemplo.test')).toBe('https://exemplo.test');
  });

  it('URL base relativa ou com esquema errado derruba o boot', () => {
    expect(() => parseBaseUrl('/v1beta')).toThrow(/URL absoluta/);
    expect(() => parseBaseUrl('ftp://exemplo.test')).toThrow(/http ou https/);
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
    const d = decideSeed({ key: 'rag.model', envValue: MODELO_PADRAO, dbValue: 'outro-modelo' });
    if (d.action !== 'avisar') throw new Error('esperado avisar');
    expect(d.warning).toBe(
      `[rag] RAG_MODEL=${MODELO_PADRAO} ignorada: o banco já define rag.model=outro-modelo`,
    );
  });

  it('o ambiente inválido é recusado antes de virar linha no banco', () => {
    expect(() => decideSeed({ key: 'rag.driver', envValue: 'openai', dbValue: null })).toThrow(
      /ainda não foi implementado/,
    );
  });

  it('o valor semeado é o normalizado, não o que veio escrito', () => {
    const d = decideSeed({ key: 'rag.driver', envValue: ' GOOGLE ', dbValue: null });
    expect(d).toEqual({ action: 'gravar', key: 'rag.driver', value: 'google' });
  });
});
