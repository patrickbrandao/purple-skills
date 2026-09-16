/**
 * `@purple-skills/rag` — o que o indexador, o mcp-public, o site e o painel
 * precisam para a busca semântica, sem nenhum deles falar com o provedor
 * direto.
 *
 * O desenho está em `tmp/RAG-GOOGLE.md` (futuro `docs/14`). O pacote não
 * acessa o banco: quem grava é `@purple-skills/db`.
 */
export {
  assertVector,
  RagAuthError,
  RagConfigError,
  RagInputTooLongError,
  RagRateLimitError,
  RagTimeoutError,
  RagUnavailableError,
  type EmbeddingDriver,
  type EmbeddingModel,
  type UsoDeTokens,
} from './driver.js';

export { textSha256, textSha256Hex } from './hash.js';

export {
  chunkSkill,
  metaText,
  splitText,
  DEFAULT_MAX_FILE_BYTES,
  type ChunkOptions,
  type ChunkResult,
  type SkillForChunking,
  type SkillTextOccurrence,
  type SkippedFile,
} from './chunk.js';

export {
  decideSeed,
  driverDoModelo,
  driverInfo,
  modeloPadraoDe,
  modelosDo,
  parseBaseUrl,
  ragSetting,
  readApiKeyEnv,
  readBaseUrlEnv,
  readDriverEnv,
  readIndexIntervalEnv,
  readModelEnv,
  readQueryTimeoutEnv,
  CHAVE_ESTADO_INDEXADOR,
  DRIVERS_FUTUROS,
  DRIVERS_IMPLEMENTADOS,
  RAG_DRIVERS,
  RAG_SETTINGS,
  type RagDriverId,
  type RagDriverInfo,
  type RagProviderId,
  type RagSetting,
  type RagSettingKey,
  type SeedDecision,
} from './settings.js';

export {
  BASE_URL_GOOGLE,
  BASE_URL_OPENAI,
  BASE_URL_VOYAGE,
  GEMINI_EMBEDDING_2,
  MODELOS_GOOGLE,
  MODELOS_OPENAI,
  MODELOS_VOYAGE,
  TEXT_EMBEDDING_3_LARGE,
  TEXT_EMBEDDING_3_SMALL,
  VOYAGE_4,
  VOYAGE_4_LARGE,
  VOYAGE_4_LITE,
} from './models.js';


export { GoogleDriver, type GoogleDriverOptions } from './google.js';
export { OpenAIDriver, type OpenAIDriverOptions } from './openai.js';
export { VoyageDriver, type VoyageDriverOptions } from './voyage.js';

export {
  embutirEmLotes,
  lotes,
  retryAfterMs,
  ClienteHttp,
  type MapearErro,
  type OpcoesHttp,
  type Requisicao,
} from './http.js';

export {
  criarBuscaSemantica,
  logDaBusca,
  type DriverResolver,
  type SearchPorts,
  type SemanticOption,
  type SemanticResolution,
  type SemanticSearchOptions,
  type TextReason,
} from './search.js';

export {
  FakeDriver,
  MODELO_FALSO,
  semPrefixo,
  subirServidorFalso,
  vetorFalso,
  type FalhaSimulada,
  type ServidorFalso,
  type ServidorFalsoOptions,
} from './fake.js';

import { GoogleDriver } from './google.js';
import { OpenAIDriver } from './openai.js';
import { VoyageDriver } from './voyage.js';
import type { DriverResolver } from './search.js';
import type { EmbeddingDriver, EmbeddingModel } from './driver.js';
import { RagConfigError } from './driver.js';
import {
  driverInfo,
  readApiKeyEnv,
  readBaseUrlEnv,
  DRIVERS_IMPLEMENTADOS,
  type RagDriverId,
  type RagProviderId,
} from './settings.js';

/** Como cada driver é construído. Um driver novo entra aqui e no registro. */
type Construtor = (options: { apiKey: string; baseUrl?: string }) => EmbeddingDriver;

const CONSTRUTORES: Record<RagProviderId, Construtor> = {
  google: (options) => new GoogleDriver(options),
  openai: (options) => new OpenAIDriver(options),
  voyage: (options) => new VoyageDriver(options),
};

/**
 * Monta o driver da configuração em uso.
 *
 * Devolve `null` com o driver `off` e sem chave — quem chama cai no modo
 * textual em vez de tratar exceção para o caso normal de "a busca semântica
 * está desligada" ou "ninguém configurou a chave ainda". Driver sem
 * implementação, esse sim, lança: é erro de configuração, não estado normal.
 */
export function criarDriver(input: {
  driver: RagDriverId;
  apiKey: string | undefined;
  baseUrl?: string;
}): EmbeddingDriver | null {
  if (input.driver === 'off') return null;
  if (!input.apiKey) return null;
  return CONSTRUTORES[input.driver]({ apiKey: input.apiKey, baseUrl: input.baseUrl });
}

/** O que `criarDriversDoAmbiente` conseguiu montar. */
export type DriversDoAmbiente = {
  /** Resolve o driver pelo id que o **banco** escolheu. `null` = não dá. */
  resolver: DriverResolver;
  /** Ids com chave no ambiente, na ordem do registro. */
  comChave: RagProviderId[];
  /** Quem tinha chave mas não subiu, e por quê. */
  problemas: { id: RagProviderId; motivo: string }[];
};

/**
 * Monta **todos** os drivers para os quais o ambiente tem chave.
 *
 * Quem decide qual deles vale é o banco (§4.1), e o banco só é lido depois do
 * boot — daí montar todos e escolher na hora do uso. É também o que torna a
 * troca de driver pelo painel imediata: com as duas chaves no `.env`, mudar
 * `rag.driver` passa a valer no ciclo seguinte, sem recriar container nenhum.
 *
 * Um driver que não sobe não derruba os outros: o motivo fica em `problemas`,
 * para o boot registrar uma linha e seguir.
 */
export function criarDriversDoAmbiente(
  env: NodeJS.ProcessEnv = process.env,
): DriversDoAmbiente {
  const montados = new Map<RagProviderId, EmbeddingDriver>();
  const comChave: RagProviderId[] = [];
  const problemas: DriversDoAmbiente['problemas'] = [];

  for (const id of DRIVERS_IMPLEMENTADOS) {
    const apiKey = readApiKeyEnv(id, env);
    if (!apiKey) continue;
    comChave.push(id);
    try {
      montados.set(id, CONSTRUTORES[id]({ apiKey, baseUrl: readBaseUrlEnv(id, env) }));
    } catch (erro) {
      problemas.push({ id, motivo: erro instanceof Error ? erro.message : String(erro) });
    }
  }

  return {
    resolver: (id) => montados.get(id) ?? null,
    comChave,
    problemas,
  };
}

/** O modelo pelo id, para o driver em uso. */
export function modeloPeloId(driver: EmbeddingDriver, id: string): EmbeddingModel {
  const achado = driver.models.find((m) => m.id === id);
  if (!achado) {
    throw new RagConfigError(
      `o driver ${driver.id} não tem o modelo "${id}"; disponíveis: ${driver.models
        .map((m) => m.id)
        .join(', ')}`,
    );
  }
  return achado;
}

/** O modelo padrão do driver: o primeiro que o registro lista para ele. */
export function modeloPadrao(driver: RagProviderId): EmbeddingModel {
  const [primeiro] = driverInfo(driver).models;
  if (!primeiro) {
    throw new RagConfigError(`o driver ${driver} não declara modelo nenhum no registro`);
  }
  return primeiro;
}
