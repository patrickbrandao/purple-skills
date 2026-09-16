/**
 * O fluxo da busca por requisição (`tmp/RAG-GOOGLE.md` §8.1, futuro `docs/14`).
 *
 * É o mesmo no `search_skills` do mcp-public e no `GET /api/skills?q=` do site,
 * então mora aqui uma vez só. O pacote continua sem importar
 * `@purple-skills/db`: quem chama passa as funções do banco.
 *
 * A regra que atravessa tudo: **cair para a busca textual nunca é erro.** Com o
 * driver desligado, sem chave, sem a migration aplicada, sem espaço, ou com o
 * provedor lento, a resposta sai em modo `text` — a mesma de antes do RAG. O
 * cliente recebe o campo `mode` para saber o que leu, não para escolher.
 *
 * Por isso nada aqui lança: o retorno é sempre "a perna vetorial saiu" ou "não
 * saiu, e o motivo ficou no log".
 */
import type { EmbeddingDriver, EmbeddingModel } from './driver.js';
import { DRIVERS_IMPLEMENTADOS, type RagProviderId } from './settings.js';

/**
 * Resolve o driver pelo id que o **banco** escolheu.
 *
 * A configuração do driver vive no banco e é lida por requisição, com cache
 * curto; as chaves vivem no ambiente e são lidas no boot. Passar uma função,
 * em vez de um driver pronto, é o que reconcilia os dois: o processo monta no
 * boot todos os drivers para os quais tem chave, e a busca escolhe entre eles
 * a cada requisição. Trocar o driver no painel passa a valer em dez segundos,
 * sem recriar container nenhum.
 */
export type DriverResolver = (id: RagProviderId) => EmbeddingDriver | null;

/** O que a busca precisa do banco. Injetado para o pacote não depender do db. */
export type SearchPorts = {
  /** Falso enquanto a migration do RAG não rodou. */
  ragSchemaReady: () => Promise<boolean>;
  /** Lê `rag.driver` e `rag.model`. */
  getRagSettings: () => Promise<{
    'rag.driver'?: { value: string | null };
    'rag.model'?: { value: string | null };
  }>;
  /** Acha o espaço; **não** cria — uma busca não pode inaugurar espaço vazio. */
  findRagSpace: (input: {
    driver: string;
    model: string;
    dimensions: number;
    documentPrefix: string;
    queryPrefix: string;
  }) => Promise<{ uuid: string } | null>;
};

export type SemanticSearchOptions = {
  ports: SearchPorts;
  /**
   * O driver. Um `EmbeddingDriver` fixo (ou `null`, sem chave nenhuma) para
   * quem só fala com um provedor; uma `DriverResolver` para escolher pelo que
   * o banco disser.
   */
  driver: EmbeddingDriver | null | DriverResolver;
  /** Prazo do embedding da consulta. */
  timeoutMs: number;
  /** Quanto tempo a configuração fica em cache. Padrão: 10 s (§4.1). */
  cacheMs?: number;
  log?: (mensagem: string) => void;
  now?: () => number;
};

/** O que `listSkills` recebe quando a perna vetorial saiu. */
export type SemanticOption = { spaceUuid: string; vector: number[] };

/** Por que a busca ficou textual — vai para o log, não para o cliente. */
export type TextReason =
  | 'consulta-vazia'
  | 'driver-off'
  | 'sem-driver'
  | 'sem-migration'
  | 'sem-espaco'
  | 'modelo-desconhecido'
  | 'falha-no-embedding';

export type SemanticResolution =
  | { mode: 'hybrid'; semantic: SemanticOption }
  | { mode: 'text'; semantic: undefined; reason: TextReason };

const TEXTO = (reason: TextReason): SemanticResolution => ({
  mode: 'text',
  semantic: undefined,
  reason,
});

type Cache = { at: number; driver: string; model: string | null };

/**
 * Monta o resolvedor. Ele guarda a configuração por poucos segundos: sem cache,
 * cada busca faria um SELECT a mais; com cache longo, desligar o driver no
 * painel demoraria a valer. Dez segundos é o que a §10 promete.
 */
export function criarBuscaSemantica(options: SemanticSearchOptions) {
  const cacheMs = options.cacheMs ?? 10_000;
  const log = options.log ?? (() => {});
  const agora = options.now ?? (() => Date.now());
  let cache: Cache | null = null;
  /** Lembra que o schema já apareceu, para não repetir o `to_regclass` sempre. */
  let schemaPronto = false;

  async function configuracao(): Promise<Cache> {
    if (cache !== null && agora() - cache.at < cacheMs) return cache;
    const settings = await options.ports.getRagSettings();
    cache = {
      at: agora(),
      driver: settings['rag.driver']?.value ?? 'off',
      model: settings['rag.model']?.value ?? null,
    };
    return cache;
  }

  return {
    /** Esquece o cache. Usado nos testes e por quem acabou de gravar a config. */
    invalidar() {
      cache = null;
    },

    /**
     * Resolve a perna vetorial de uma consulta. Nunca lança: qualquer tropeço
     * vira modo textual.
     */
    async resolver(query: string | null | undefined): Promise<SemanticResolution> {
      const consulta = (query ?? '').trim();
      if (consulta === '') return TEXTO('consulta-vazia');

      // Driver fixo e nulo: não há chave nenhuma, então não vale nem gastar o
      // SELECT da configuração para descobrir qual deles usaríamos.
      const fixo = typeof options.driver === 'function' ? undefined : options.driver;
      if (fixo === null) return TEXTO('sem-driver');

      let config: Cache;
      try {
        config = await configuracao();
      } catch (erro) {
        log(`[rag] não consegui ler a configuração: ${mensagem(erro)}`);
        return TEXTO('driver-off');
      }
      if (config.driver === 'off') return TEXTO('driver-off');

      let driver: EmbeddingDriver | null;
      if (fixo !== undefined) {
        driver = fixo;
      } else if (!(DRIVERS_IMPLEMENTADOS as readonly string[]).includes(config.driver)) {
        log(`[rag] rag.driver="${config.driver}" não é um driver conhecido`);
        return TEXTO('sem-driver');
      } else {
        driver = (options.driver as DriverResolver)(config.driver as RagProviderId);
      }
      // O banco pede um driver para o qual este container não tem chave.
      if (driver === null) return TEXTO('sem-driver');

      // As tabelas podem não existir: `findRagSpace` bateria em 42P01.
      if (!schemaPronto) {
        try {
          schemaPronto = await options.ports.ragSchemaReady();
        } catch (erro) {
          log(`[rag] não consegui conferir o schema: ${mensagem(erro)}`);
          return TEXTO('sem-migration');
        }
        if (!schemaPronto) return TEXTO('sem-migration');
      }

      const modelo = driver.models.find((m) => m.id === (config.model ?? driver.models[0]?.id));
      if (!modelo) {
        log(`[rag] modelo "${config.model}" não existe no driver ${driver.id}`);
        return TEXTO('modelo-desconhecido');
      }

      let espaco: { uuid: string } | null;
      try {
        espaco = await options.ports.findRagSpace({
          driver: driver.id,
          model: modelo.id,
          dimensions: modelo.dimensions,
          documentPrefix: modelo.documentPrefix,
          queryPrefix: modelo.queryPrefix,
        });
      } catch (erro) {
        // Schema derrubado entre uma busca e outra: volta a conferir.
        schemaPronto = false;
        log(`[rag] não consegui achar o espaço: ${mensagem(erro)}`);
        return TEXTO('sem-espaco');
      }
      // Espaço ainda não criado: o indexador é quem o cria, no primeiro ciclo.
      if (espaco === null) return TEXTO('sem-espaco');

      const vetor = await embutirComPrazo(driver, modelo, consulta, options.timeoutMs, log);
      if (vetor === null) return TEXTO('falha-no-embedding');

      return { mode: 'hybrid', semantic: { spaceUuid: espaco.uuid, vector: vetor } };
    },
  };
}

/**
 * Embute a consulta com um prazo. Estourar o prazo é um caso previsto, não um
 * incidente: a resposta sai textual e o cliente não espera pelo provedor.
 */
async function embutirComPrazo(
  driver: EmbeddingDriver,
  modelo: EmbeddingModel,
  consulta: string,
  timeoutMs: number,
  log: (m: string) => void,
): Promise<number[] | null> {
  const controle = new AbortController();
  const alarme = setTimeout(() => controle.abort(), timeoutMs);
  try {
    return await driver.embedQuery(modelo, consulta, controle.signal);
  } catch (erro) {
    log(`[rag] consulta sem embedding, respondendo em modo textual: ${mensagem(erro)}`);
    return null;
  } finally {
    clearTimeout(alarme);
  }
}

function mensagem(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

/**
 * Formata a linha de log do resultado (§8.1 item 7).
 *
 * As distâncias vão para o log e **não** para o cliente: sem corte por
 * distância, toda consulta ganha vizinhos, e expor números que ainda não
 * significam nada convidaria a filtrar por eles.
 */
export function logDaBusca(
  mode: 'text' | 'hybrid',
  neighbors: readonly { slug: string; distance: number }[],
): string {
  if (mode === 'text') return '[rag] modo texto';
  const lista = neighbors.map((n) => `${n.slug}=${n.distance.toFixed(4)}`).join(' ');
  return `[rag] modo híbrido, ${neighbors.length} vizinhos${lista ? `: ${lista}` : ''}`;
}
