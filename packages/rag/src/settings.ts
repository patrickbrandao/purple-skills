/**
 * O registro único de configurações do RAG (`docs/14-rag.md` §5).
 *
 * Uma opção é descrita **uma vez** aqui, e daqui saem a leitura do ambiente, a
 * validação, a semeadura e o que o painel mostra. Sem isso, cada container
 * repetiria a mesma lista e elas divergiriam com o tempo.
 *
 * São dois registros, e eles se alimentam:
 *
 *   * `RAG_DRIVERS` — **por driver**: a variável da chave, a variável e o valor
 *     padrão da URL base, e os modelos que ele aceita;
 *   * `RAG_SETTINGS` — **por variável de ambiente**. As variáveis de chave e de
 *     URL base não são escritas à mão: saem de `RAG_DRIVERS`, e é isso que
 *     garante que acrescentar um driver não deixe metade do sistema sem saber
 *     da variável nova.
 *
 * A precedência é a da §5: **o ambiente semeia, o banco decide.** Vários
 * containers leem a mesma configuração; se o ambiente valesse sempre, um
 * container com a variável diferente divergiria dos outros em silêncio. Então
 * o admin grava o valor do ambiente só quando o banco ainda não tem linha, e
 * dali em diante quem manda é o banco — mudar o `.env` depois não altera nada,
 * e o admin registra um aviso quando os dois discordam.
 *
 * Nada de variável `config` em JSON: cada opção é uma variável própria.
 */
import { isPlaceholder, readIntEnv, readSecret, readTextEnv } from '@purple-skills/shared';
import type { EmbeddingModel } from './driver.js';
import {
  BASE_URL_GOOGLE,
  BASE_URL_OPENAI,
  BASE_URL_VOYAGE,
  MODELOS_GOOGLE,
  MODELOS_OPENAI,
  MODELOS_VOYAGE,
} from './models.js';

/** As chaves que este registro grava em `settings`. */
export type RagSettingKey = 'rag.driver' | 'rag.model';

/** O driver em uso. `off` desliga a busca semântica. */
export type RagDriverId = 'off' | 'google' | 'openai' | 'voyage';

/** Um driver de verdade: o `RagDriverId` sem o `off`. */
export type RagProviderId = Exclude<RagDriverId, 'off'>;

/** Os drivers previstos na interface, mas ainda sem implementação. */
export const DRIVERS_FUTUROS = ['cohere'] as const;

/** A chave onde o indexador publica o próprio estado. Não passa por este registro. */
export const CHAVE_ESTADO_INDEXADOR = 'rag.indexer.status';

/** Tudo que o projeto precisa saber de um driver antes de construí-lo. */
export type RagDriverInfo = {
  id: RagProviderId;
  /** Como o painel e o log o chamam. */
  label: string;
  /** Variável da chave. Aceita `<env>_FILE`, como todo segredo do projeto. */
  apiKeyEnv: string;
  /** Variável da URL base. */
  baseUrlEnv: string;
  /** URL base padrão, já com a versão da API. */
  baseUrlPadrao: string;
  /** Os modelos aceitos, na ordem; o primeiro é o padrão do driver. */
  models: readonly EmbeddingModel[];
};

/**
 * O registro por driver.
 *
 * Acrescentar um driver é acrescentar uma linha aqui e um arquivo com a classe
 * — o resto (variáveis do `.env`, validação de `RAG_MODEL`, opções do painel,
 * montagem a partir do ambiente) sai daqui sozinho.
 */
export const RAG_DRIVERS: readonly RagDriverInfo[] = [
  {
    id: 'google',
    label: 'Google — Gemini API',
    apiKeyEnv: 'RAG_GOOGLE_API_KEY',
    baseUrlEnv: 'RAG_GOOGLE_BASE_URL',
    baseUrlPadrao: BASE_URL_GOOGLE,
    models: MODELOS_GOOGLE,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    apiKeyEnv: 'RAG_OPENAI_API_KEY',
    baseUrlEnv: 'RAG_OPENAI_BASE_URL',
    baseUrlPadrao: BASE_URL_OPENAI,
    models: MODELOS_OPENAI,
  },
  {
    id: 'voyage',
    label: 'Voyage AI',
    apiKeyEnv: 'RAG_VOYAGE_API_KEY',
    baseUrlEnv: 'RAG_VOYAGE_BASE_URL',
    baseUrlPadrao: BASE_URL_VOYAGE,
    models: MODELOS_VOYAGE,
  },
];

/** Os ids dos drivers implementados, na ordem do registro. */
export const DRIVERS_IMPLEMENTADOS: readonly RagProviderId[] = RAG_DRIVERS.map((d) => d.id);

/** O que se sabe do driver. Lança para id que não é driver de verdade. */
export function driverInfo(id: RagProviderId): RagDriverInfo {
  const achado = RAG_DRIVERS.find((d) => d.id === id);
  if (!achado) throw new Error(`Driver de RAG desconhecido: ${id}`);
  return achado;
}

/** Os ids de modelo que o driver aceita. Vazio com o driver `off`. */
export function modelosDo(driver: RagDriverId): readonly string[] {
  if (driver === 'off') return [];
  return driverInfo(driver).models.map((m) => m.id);
}

/** O modelo padrão do driver: o primeiro do registro. */
export function modeloPadraoDe(driver: RagProviderId): string {
  const [primeiro] = driverInfo(driver).models;
  if (!primeiro) throw new Error(`O driver ${driver} não declara modelo nenhum`);
  return primeiro.id;
}

/** O driver que tem este modelo, ou `null` se nenhum tem. */
export function driverDoModelo(model: string): RagProviderId | null {
  return RAG_DRIVERS.find((d) => d.models.some((m) => m.id === model))?.id ?? null;
}

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
  /**
   * Valida e normaliza; lança erro com mensagem em português. `driver` é o
   * contexto de quem valida `RAG_MODEL`: o mesmo texto é válido num driver e
   * inválido no outro.
   */
  parse: (raw: string, driver?: RagDriverId) => string | number;
};

function parseDriver(raw: string): string {
  const valor = raw.trim().toLowerCase();
  if (valor === '' || valor === 'off') return 'off';
  if ((DRIVERS_IMPLEMENTADOS as readonly string[]).includes(valor)) return valor;

  const aceitos = ['off', ...DRIVERS_IMPLEMENTADOS].map((d) => `"${d}"`).join(', ');
  if ((DRIVERS_FUTUROS as readonly string[]).includes(valor)) {
    throw new Error(
      `RAG_DRIVER inválida: o driver "${valor}" ainda não foi implementado; use ${aceitos}`,
    );
  }
  throw new Error(`RAG_DRIVER inválida: esperado ${aceitos}, recebido "${raw}"`);
}

/**
 * Valida `RAG_MODEL` **contra os modelos do driver escolhido**.
 *
 * Sem driver — na validação solta do registro — vale qualquer modelo que algum
 * driver conheça: quem sabe o driver é quem chama, e recusar aqui o que o
 * driver certo aceitaria seria recusar por ignorância. Com o driver `off` o
 * modelo não tem efeito nenhum, e a mesma regra frouxa serve: o valor fica
 * guardado à espera de alguém ligar a busca.
 */
function parseModel(raw: string, driver?: RagDriverId): string {
  const valor = raw.trim();

  if (driver === undefined || driver === 'off') {
    if (driverDoModelo(valor) !== null) return valor;
    const todos = RAG_DRIVERS.flatMap((d) => d.models.map((m) => m.id)).join(', ');
    throw new Error(`RAG_MODEL inválida: "${raw}" não é modelo de driver nenhum; há ${todos}`);
  }

  const aceitos = modelosDo(driver);
  if (aceitos.includes(valor)) return valor;
  throw new Error(
    `RAG_MODEL inválida: o driver "${driver}" não tem "${raw}"; ele aceita ${aceitos.join(', ')}`,
  );
}

/**
 * A faixa de cada opção numérica, **uma vez só**.
 *
 * O `parse` do registro e o leitor do ambiente leem daqui. Antes o registro
 * descrevia as duas opções de prazo com `parse: (raw) => Number(raw)`, que
 * aceita `NaN` e negativo, enquanto os leitores aplicavam limites pelo
 * `readIntEnv`: a mesma opção tinha duas regras no mesmo pacote, e a frouxa era
 * justamente a do registro — que a §5.1 declara ser a descrição única.
 */
const FAIXAS = {
  RAG_QUERY_TIMEOUT_MS: { min: 1, max: 120_000 },
  RAG_INDEX_INTERVAL_SECONDS: { min: 1, max: 86_400 },
  RAG_INDEX_TIMEOUT_MS: { min: 1_000, max: 600_000 },
} as const;

/** A opção numérica do registro, para o `parse` e o leitor não divergirem. */
type OpcaoNumerica = keyof typeof FAIXAS;

/**
 * Valida um inteiro com os mesmos limites e a mesma mensagem do `readIntEnv`
 * do `shared` — que é o que os leitores aplicam sobre o ambiente.
 */
function inteiroDaFaixa(env: OpcaoNumerica): (raw: string) => number {
  const { min, max } = FAIXAS[env];
  return (raw: string): number => {
    const valor = Number(raw.trim());
    if (!Number.isSafeInteger(valor) || valor < min || valor > max) {
      throw new Error(
        `${env} inválida: esperado um inteiro entre ${min} e ${max}, recebido "${raw}"`,
      );
    }
    return valor;
  };
}

/** Lê do ambiente uma opção numérica: o padrão e a faixa saem do registro. */
function lerInteiroDoRegistro(env: OpcaoNumerica, processEnv: NodeJS.ProcessEnv): number {
  return readIntEnv(env, Number(ragSetting(env).fallback), { ...FAIXAS[env], env: processEnv });
}

/**
 * A URL base é usada **como está**, sem acrescentar versão.
 *
 * O driver só concatena o caminho do método. Acrescentar a versão sozinho
 * impediria apontar para o servidor falso, e esconderia do operador qual
 * versão da API está em uso.
 */
export function parseBaseUrl(raw: string, env = 'RAG_GOOGLE_BASE_URL'): string {
  const valor = raw.trim();
  let url: URL;
  try {
    url = new URL(valor);
  } catch {
    throw new Error(`${env} inválida: esperada uma URL absoluta, recebido "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${env} inválida: esperado http ou https, recebido "${url.protocol}"`);
  }
  return valor.replace(/\/+$/, '');
}

/**
 * O registro por variável de ambiente.
 *
 * O par chave/URL base de cada driver sai de `RAG_DRIVERS`: escrevê-lo à mão
 * aqui seria repetir a lista que a §4.2 manda existir uma vez só.
 */
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
    fallback: modeloPadraoDe('google'),
    parse: parseModel,
  },
  ...RAG_DRIVERS.flatMap((driver): RagSetting[] => [
    {
      key: null,
      env: driver.apiKeyEnv,
      secret: true,
      editable: false,
      fallback: null,
      parse: (raw) => raw,
    },
    {
      key: null,
      env: driver.baseUrlEnv,
      secret: false,
      editable: false,
      fallback: driver.baseUrlPadrao,
      parse: (raw) => parseBaseUrl(raw, driver.baseUrlEnv),
    },
  ]),
  {
    key: null,
    env: 'RAG_QUERY_TIMEOUT_MS',
    secret: false,
    editable: false,
    fallback: 2000,
    parse: inteiroDaFaixa('RAG_QUERY_TIMEOUT_MS'),
  },
  {
    key: null,
    env: 'RAG_INDEX_INTERVAL_SECONDS',
    secret: false,
    editable: false,
    fallback: 30,
    parse: inteiroDaFaixa('RAG_INDEX_INTERVAL_SECONDS'),
  },
  {
    key: null,
    env: 'RAG_INDEX_TIMEOUT_MS',
    secret: false,
    editable: false,
    // Prazo de **uma** chamada de indexação, tentativas incluídas. Não existia
    // prazo nenhum: um provedor que aceita a conexão e não responde segurava a
    // rodada pelos prazos internos do undici multiplicados pelas tentativas, e
    // o painel mostrava dado velho sem dizer que o ciclo estava pendurado. O
    // padrão é folgado de propósito — prazo curto transforma lote grande em
    // falha recorrente.
    fallback: 120_000,
    parse: inteiroDaFaixa('RAG_INDEX_TIMEOUT_MS'),
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

/**
 * Lê e valida `RAG_MODEL`, **contra os modelos do driver que o ambiente
 * escolheu**. Sem `RAG_MODEL`, vale o modelo padrão desse driver.
 */
export function readModelEnv(env: NodeJS.ProcessEnv = process.env): string {
  const driver = readDriverEnv(env);
  const raw = env.RAG_MODEL;
  if (raw === undefined || raw.trim() === '') {
    return modeloPadraoDe(driver === 'off' ? 'google' : driver);
  }
  return parseModel(raw, driver);
}

/** Lê e valida a URL base **deste** driver. */
export function readBaseUrlEnv(
  driver: RagProviderId,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const info = driverInfo(driver);
  return parseBaseUrl(readTextEnv(info.baseUrlEnv, info.baseUrlPadrao, env), info.baseUrlEnv);
}

/**
 * Lê a chave **deste** driver, com o `_FILE` tendo prioridade.
 *
 * O placeholder do `.env.example` (`CHANGE_ME` e afins) vale como **chave
 * ausente**, e não como chave: as três variáveis saem do exemplo preenchidas
 * com ele, e o passo a passo só manda trocar a do driver que se vai usar.
 * Promovido a credencial, ele fazia o boot dizer "chave presente para: google,
 * openai, voyage", calava o aviso de "nenhuma chave", e — ligado um driver no
 * painel — mandava texto de skill ao provedor com `CHANGE_ME` a cada ciclo e a
 * consulta de cada busca, com o painel mostrando "recusada" onde o certo é
 * "não configurada".
 *
 * Não lança, de propósito: a busca semântica é opcional, e placeholder em
 * chave do RAG não derruba boot nenhum — a guarda que lança segue fora do
 * `readSecret` (ver `assertNotPlaceholder`). Quem chama já trata `undefined`
 * como "sem chave": o driver não é montado, o boot avisa, o indexador só
 * refatia e a busca responde em modo textual sem chamar ninguém.
 */
export function readApiKeyEnv(
  driver: RagProviderId,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const chave = readSecret(driverInfo(driver).apiKeyEnv, env);
  return chave === undefined || isPlaceholder(chave) ? undefined : chave;
}

/** Prazo do embedding da consulta, em milissegundos. */
export function readQueryTimeoutEnv(env: NodeJS.ProcessEnv = process.env): number {
  return lerInteiroDoRegistro('RAG_QUERY_TIMEOUT_MS', env);
}

/** Intervalo da varredura do indexador, em segundos. */
export function readIndexIntervalEnv(env: NodeJS.ProcessEnv = process.env): number {
  return lerInteiroDoRegistro('RAG_INDEX_INTERVAL_SECONDS', env);
}

/**
 * Prazo de uma chamada de indexação ao provedor, em milissegundos.
 *
 * É o orçamento de tempo de **um lote**, tentativas e recuos incluídos — o
 * `signal` que o `http.ts` usa para não deixar a rodada pendurada num provedor
 * que aceita a conexão e não responde. O lote cortado não se perde: a rodada
 * seguinte retoma de onde parou, porque o que foi gravado ficou gravado.
 */
export function readIndexTimeoutEnv(env: NodeJS.ProcessEnv = process.env): number {
  return lerInteiroDoRegistro('RAG_INDEX_TIMEOUT_MS', env);
}

/** O que a semeadura decidiu fazer com uma chave. */
export type SeedDecision =
  | { action: 'gravar'; key: RagSettingKey; value: string }
  | { action: 'nada'; key: RagSettingKey; value: string; reason: 'sem-ambiente' | 'igual' }
  | { action: 'avisar'; key: RagSettingKey; value: string; env: string; warning: string };

/**
 * Decide o que fazer com uma chave no boot do admin (§5). Função pura: quem
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
  /** Driver em que validar `rag.model`. Omitido, vale qualquer driver. */
  driver?: RagDriverId;
  /** Como o painel descreve quem mudou, para a mensagem de aviso. */
  changedBy?: string | null;
}): SeedDecision {
  const setting = RAG_SETTINGS.find((s) => s.key === input.key);
  if (!setting) throw new Error(`Chave de RAG desconhecida: ${input.key}`);

  const bruto = input.envValue?.trim();
  const doAmbiente =
    bruto === undefined || bruto === '' ? null : String(setting.parse(bruto, input.driver));

  if (input.dbValue === null) {
    if (doAmbiente === null) {
      const padrao =
        input.key === 'rag.model' && input.driver !== undefined && input.driver !== 'off'
          ? modeloPadraoDe(input.driver)
          : String(setting.fallback);
      return { action: 'nada', key: input.key, value: padrao, reason: 'sem-ambiente' };
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
