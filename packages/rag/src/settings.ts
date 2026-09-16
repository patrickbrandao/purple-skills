/**
 * O registro único de configurações do RAG (`tmp/RAG-GOOGLE.md` §4).
 *
 * Uma opção é descrita **uma vez** aqui, e daqui saem a leitura do ambiente, a
 * validação, a semeadura e o que o painel mostra. Sem isso, cada container
 * repetiria a mesma lista e elas divergiriam com o tempo.
 *
 * A precedência é a da §4.1: **o ambiente semeia, o banco decide.** Vários
 * containers leem a mesma configuração; se o ambiente valesse sempre, um
 * container com a variável diferente divergiria dos outros em silêncio. Então
 * o admin grava o valor do ambiente só quando o banco ainda não tem linha, e
 * dali em diante quem manda é o banco — mudar o `.env` depois não altera nada,
 * e o admin registra um aviso quando os dois discordam.
 *
 * Nada de variável `config` em JSON: cada opção é uma variável própria.
 */
import { readIntEnv, readTextEnv } from '@purple-skills/shared';

/** As chaves que este registro grava em `settings`. */
export type RagSettingKey = 'rag.driver' | 'rag.model';

/** O driver em uso. `off` desliga a busca semântica. */
export type RagDriverId = 'off' | 'google';

/** Os drivers previstos na interface, mas ainda sem implementação. */
export const DRIVERS_FUTUROS = ['openai', 'voyage', 'cohere'] as const;

/** O único modelo da v1. */
export const MODELO_PADRAO = 'gemini-embedding-2';

/** A chave onde o indexador publica o próprio estado. Não passa por este registro. */
export const CHAVE_ESTADO_INDEXADOR = 'rag.indexer.status';

export type RagSetting = {
  /** Chave em `settings`, ou nula para opção só de ambiente. */
  key: RagSettingKey | null;
  /** Nome da variável de ambiente. */
  env: string;
  /** Aceita `<env>_FILE`. */
  secret: boolean;
  /** Editável no painel. */
  editable: boolean;
  /** Padrão do código quando não há ambiente nem banco. */
  fallback: string | number | null;
  /** Valida e normaliza; lança erro com mensagem em português. */
  parse: (raw: string) => string | number;
};

/** URL base padrão da Gemini API, já com a versão. */
export const BASE_URL_PADRAO = 'https://generativelanguage.googleapis.com/v1beta';

function parseDriver(raw: string): string {
  const valor = raw.trim().toLowerCase();
  if (valor === '' || valor === 'off') return 'off';
  if (valor === 'google') return 'google';

  if ((DRIVERS_FUTUROS as readonly string[]).includes(valor)) {
    throw new Error(
      `RAG_DRIVER inválida: o driver "${valor}" ainda não foi implementado; use "google" ou "off"`,
    );
  }
  throw new Error(`RAG_DRIVER inválida: esperado "google" ou "off", recebido "${raw}"`);
}

function parseModel(raw: string): string {
  const valor = raw.trim();
  if (valor === MODELO_PADRAO) return valor;
  throw new Error(`RAG_MODEL inválida: a v1 só tem "${MODELO_PADRAO}", recebido "${raw}"`);
}

/**
 * A URL base é usada **como está**, sem acrescentar versão.
 *
 * O driver só concatena `/models/<modelo>:<método>`. Acrescentar `v1beta`
 * sozinho impediria apontar para o servidor falso, e esconderia do operador
 * qual versão da API está em uso.
 */
export function parseBaseUrl(raw: string): string {
  const valor = raw.trim();
  let url: URL;
  try {
    url = new URL(valor);
  } catch {
    throw new Error(`RAG_GOOGLE_BASE_URL inválida: esperada uma URL absoluta, recebido "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`RAG_GOOGLE_BASE_URL inválida: esperado http ou https, recebido "${url.protocol}"`);
  }
  return valor.replace(/\/+$/, '');
}

/** O registro. Cada opção aparece aqui uma vez só. */
export const RAG_SETTINGS: readonly RagSetting[] = [
  {
    key: 'rag.driver',
    env: 'RAG_DRIVER',
    secret: false,
    editable: true,
    fallback: 'off',
    parse: parseDriver,
  },
  {
    key: 'rag.model',
    env: 'RAG_MODEL',
    secret: false,
    editable: true,
    fallback: MODELO_PADRAO,
    parse: parseModel,
  },
  {
    key: null,
    env: 'RAG_GOOGLE_API_KEY',
    secret: true,
    editable: false,
    fallback: null,
    parse: (raw) => raw,
  },
  {
    key: null,
    env: 'RAG_GOOGLE_BASE_URL',
    secret: false,
    editable: false,
    fallback: BASE_URL_PADRAO,
    parse: parseBaseUrl,
  },
  {
    key: null,
    env: 'RAG_QUERY_TIMEOUT_MS',
    secret: false,
    editable: false,
    fallback: 2000,
    parse: (raw) => Number(raw),
  },
  {
    key: null,
    env: 'RAG_INDEX_INTERVAL_SECONDS',
    secret: false,
    editable: false,
    fallback: 30,
    parse: (raw) => Number(raw),
  },
];

/** A opção do registro com esta variável de ambiente. */
export function ragSetting(env: string): RagSetting {
  const achado = RAG_SETTINGS.find((s) => s.env === env);
  if (!achado) throw new Error(`Opção de RAG desconhecida: ${env}`);
  return achado;
}

/**
 * Lê e valida `RAG_DRIVER` do ambiente. Valor inválido derruba o boot, como
 * manda a convenção do projeto — desligar em silêncio é pior que não subir.
 */
export function readDriverEnv(env: NodeJS.ProcessEnv = process.env): RagDriverId {
  const raw = env.RAG_DRIVER;
  if (raw === undefined || raw.trim() === '') return 'off';
  return parseDriver(raw) as RagDriverId;
}

/** Lê e valida `RAG_MODEL` do ambiente. */
export function readModelEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.RAG_MODEL;
  if (raw === undefined || raw.trim() === '') return MODELO_PADRAO;
  return parseModel(raw);
}

/** Lê e valida `RAG_GOOGLE_BASE_URL`. */
export function readBaseUrlEnv(env: NodeJS.ProcessEnv = process.env): string {
  return parseBaseUrl(readTextEnv('RAG_GOOGLE_BASE_URL', BASE_URL_PADRAO, env));
}

/** Prazo do embedding da consulta, em milissegundos. */
export function readQueryTimeoutEnv(env: NodeJS.ProcessEnv = process.env): number {
  return readIntEnv('RAG_QUERY_TIMEOUT_MS', 2000, { min: 1, max: 120_000, env });
}

/** Intervalo da varredura do indexador, em segundos. */
export function readIndexIntervalEnv(env: NodeJS.ProcessEnv = process.env): number {
  return readIntEnv('RAG_INDEX_INTERVAL_SECONDS', 30, { min: 1, max: 86_400, env });
}

/** O que a semeadura decidiu fazer com uma chave. */
export type SeedDecision =
  | { action: 'gravar'; key: RagSettingKey; value: string }
  | { action: 'nada'; key: RagSettingKey; value: string; reason: 'sem-ambiente' | 'igual' }
  | { action: 'avisar'; key: RagSettingKey; value: string; env: string; warning: string };

/**
 * Decide o que fazer com uma chave no boot do admin (§4.1). Função pura: quem
 * a chama lê o banco antes e grava depois.
 *
 * - banco vazio e ambiente definido → grava (ator `ambiente`);
 * - banco vazio e ambiente ausente  → nada, e vale o padrão do código;
 * - banco preenchido e igual        → nada;
 * - banco preenchido e diferente    → **não grava** e devolve o aviso.
 *
 * O último caso é o que evita a divergência silenciosa: quem mudou pelo painel
 * mandou, e o `.env` esquecido não desfaz a mudança pelas costas.
 */
export function decideSeed(input: {
  key: RagSettingKey;
  envValue: string | undefined;
  dbValue: string | null;
  /** Como o painel descreve quem mudou, para a mensagem de aviso. */
  changedBy?: string | null;
}): SeedDecision {
  const setting = RAG_SETTINGS.find((s) => s.key === input.key);
  if (!setting) throw new Error(`Chave de RAG desconhecida: ${input.key}`);

  const bruto = input.envValue?.trim();
  const doAmbiente = bruto === undefined || bruto === '' ? null : String(setting.parse(bruto));

  if (input.dbValue === null) {
    if (doAmbiente === null) {
      return { action: 'nada', key: input.key, value: String(setting.fallback), reason: 'sem-ambiente' };
    }
    return { action: 'gravar', key: input.key, value: doAmbiente };
  }

  if (doAmbiente === null || doAmbiente === input.dbValue) {
    return { action: 'nada', key: input.key, value: input.dbValue, reason: 'igual' };
  }

  const quem = input.changedBy ? ` (alterado no painel por ${input.changedBy})` : '';
  return {
    action: 'avisar',
    key: input.key,
    value: input.dbValue,
    env: doAmbiente,
    warning:
      `[rag] ${setting.env}=${doAmbiente} ignorada: ` +
      `o banco já define ${input.key}=${input.dbValue}${quem}`,
  };
}
