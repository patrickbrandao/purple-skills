/**
 * A busca semântica no painel (`tmp/RAG-GOOGLE.md` §4.1 e §9, futuro
 * `docs/14`).
 *
 * O admin é o **único** que semeia a configuração e o único que a edita. Ele
 * também é o único container que **não** recebe a chave da API: quem sabe se
 * ela existe e se o Google a aceitou é o indexador, que publica isso em
 * `rag.indexer.status`. Daí o painel ler o estado do banco em vez de tentar
 * descobrir sozinho.
 *
 * A precedência é a da §4.1: **o ambiente semeia, o banco decide.** No primeiro
 * boot o valor do ambiente vira linha; dali em diante quem manda é o painel, e
 * um `.env` divergente só gera aviso no log — nunca desfaz pelas costas o que
 * alguém mudou na tela.
 */
import {
  getRagSettings,
  markAllSkillsStale,
  ragCoverage,
  ragSchemaReady,
  findRagSpace,
  seedRagSetting,
  setRagSetting,
  badRequest,
  conflict,
  type RagCoverage,
} from '@purple-skills/db';
import {
  decideSeed,
  GEMINI_EMBEDDING_2,
  MODELO_PADRAO,
  readDriverEnv,
  readModelEnv,
  type RagDriverId,
  type RagSettingKey,
} from '@purple-skills/rag';
import type { AuditActor } from '@purple-skills/shared';

/** De onde veio o valor em uso, para o painel mostrar. */
export type RagOrigem = 'banco' | 'ambiente' | 'padrão';

export type RagValor = {
  value: string;
  origem: RagOrigem;
  /** Quando a linha do banco mudou pela última vez. */
  updatedAt: string | null;
  /** Definido quando o ambiente diz outra coisa e está sendo ignorado. */
  ambienteIgnorado: string | null;
};

/** O estado que o indexador publica a cada ciclo. Formato é dele. */
export type RagEstadoIndexador = {
  at?: string;
  driver?: string;
  model?: string;
  spaceUuid?: string;
  keyPresent?: boolean;
  texts?: number;
  withVector?: number;
  pendingTexts?: number;
  staleSkills?: number;
  lastError?: string | null;
  lastErrorAt?: string | null;
};

/** Como o painel resume a situação da chave (§9). */
export type RagEstadoChave = 'presente' | 'ausente' | 'recusada' | 'cota-esgotada' | 'desconhecido';

export type RagPainel = {
  driver: RagValor;
  model: RagValor;
  /** Opções que o select oferece. */
  drivers: readonly RagDriverId[];
  models: readonly string[];
  /** Falso enquanto a migration `020` não rodou. */
  schemaReady: boolean;
  /** `null` enquanto o indexador não criou o espaço. */
  spaceUuid: string | null;
  coverage: RagCoverage | null;
  indexer: RagEstadoIndexador | null;
  keyState: RagEstadoChave;
  /**
   * O aviso fixo da §9. O painel **não sabe** o nível da chave, então ele é
   * sempre exibido: com uma chave gratuita o Google usa o conteúdo enviado,
   * inclusive o de skills privadas, e revisores humanos podem lê-lo.
   */
  freeTierWarning: string;
};

export const AVISO_NIVEL_GRATUITO =
  'No nível gratuito do Google, o conteúdo enviado — inclusive o de skills privadas — ' +
  'é usado para melhorar produtos, e revisores humanos podem lê-lo. Para que não seja, ' +
  'gere a chave num projeto com faturamento ativo. No EEE, na Suíça e no Reino Unido, ' +
  'só o nível pago é permitido para quem oferece o serviço a usuários dessas regiões.';

/**
 * Semeia as duas chaves no boot. Chamado uma vez, na subida do admin.
 *
 * Devolve os avisos a registrar no log: um por chave em que o ambiente diverge
 * do banco. Não lança — configuração inválida no ambiente já derrubou o boot
 * antes, na leitura.
 */
export async function semearRag(): Promise<string[]> {
  const avisos: string[] = [];

  // Valor inválido aqui derruba o boot, como manda a convenção do projeto.
  const doAmbiente: Record<RagSettingKey, string | undefined> = {
    'rag.driver': process.env.RAG_DRIVER?.trim() ? readDriverEnv() : undefined,
    'rag.model': process.env.RAG_MODEL?.trim() ? readModelEnv() : undefined,
  };

  const gravadas = await getRagSettings();

  for (const key of ['rag.driver', 'rag.model'] as const) {
    const decisao = decideSeed({
      key,
      envValue: doAmbiente[key],
      dbValue: gravadas[key]?.value ?? null,
    });

    if (decisao.action === 'gravar') {
      // O ator é `ambiente`: não é conta, como o bootstrap do primeiro admin.
      await seedRagSetting(key, decisao.value, 'web-admin');
    } else if (decisao.action === 'avisar') {
      avisos.push(decisao.warning);
    }
  }

  return avisos;
}

/** Monta tudo que a tela mostra. */
export async function lerPainelRag(): Promise<RagPainel> {
  const gravadas = await getRagSettings();
  const schemaReady = await ragSchemaReady().catch(() => false);

  const driver = valor('rag.driver', gravadas, process.env.RAG_DRIVER, 'off');
  const model = valor('rag.model', gravadas, process.env.RAG_MODEL, MODELO_PADRAO);

  const indexer = lerEstado(gravadas['rag.indexer.status']?.value ?? null);

  // O espaço só existe depois do primeiro ciclo do indexador.
  let spaceUuid: string | null = null;
  if (schemaReady && driver.value === 'google') {
    spaceUuid =
      (
        await findRagSpace({
          driver: 'google',
          model: GEMINI_EMBEDDING_2.id,
          dimensions: GEMINI_EMBEDDING_2.dimensions,
          documentPrefix: GEMINI_EMBEDDING_2.documentPrefix,
          queryPrefix: GEMINI_EMBEDDING_2.queryPrefix,
        }).catch(() => null)
      )?.uuid ?? null;
  }

  const coverage = schemaReady ? await ragCoverage(spaceUuid).catch(() => null) : null;

  return {
    driver,
    model,
    drivers: ['off', 'google'],
    models: [MODELO_PADRAO],
    schemaReady,
    spaceUuid,
    coverage,
    indexer,
    keyState: estadoDaChave(indexer),
    freeTierWarning: AVISO_NIVEL_GRATUITO,
  };
}

/** Grava o que o painel mandou. Audita `rag.settings`. */
export async function gravarRag(
  actor: AuditActor,
  body: { driver?: unknown; model?: unknown },
): Promise<RagPainel> {
  const mudancas: [RagSettingKey, string][] = [];

  if (body.driver !== undefined) {
    const valor = String(body.driver);
    if (valor !== 'off' && valor !== 'google') {
      throw badRequest(`Driver inválido: "${valor}". Use "google" ou "off".`);
    }
    mudancas.push(['rag.driver', valor]);
  }

  if (body.model !== undefined) {
    const valor = String(body.model);
    if (valor !== MODELO_PADRAO) {
      throw badRequest(`Modelo inválido: "${valor}". A v1 só tem "${MODELO_PADRAO}".`);
    }
    mudancas.push(['rag.model', valor]);
  }

  if (mudancas.length === 0) {
    throw badRequest('Nada a alterar: informe "driver" ou "model".');
  }

  for (const [key, value] of mudancas) {
    await setRagSetting(key, value, 'web-admin', actor);
  }

  return lerPainelRag();
}

/**
 * Marca todo o acervo para refatiar. **Não apaga vetor nenhum**: os textos que
 * não mudarem continuam com o vetor que têm, e o ciclo seguinte não gasta
 * embedding com eles. Audita `rag.reindex`.
 */
export async function reindexarRag(actor: AuditActor): Promise<{ skills: number }> {
  if (!(await ragSchemaReady())) {
    throw conflict('A migration do RAG ainda não foi aplicada nesta instalação.');
  }
  return { skills: await markAllSkillsStale('web-admin', actor) };
}

// ------------------------------------------------------------ auxiliares ---

function valor(
  key: 'rag.driver' | 'rag.model',
  gravadas: Awaited<ReturnType<typeof getRagSettings>>,
  ambiente: string | undefined,
  padrao: string,
): RagValor {
  const linha = gravadas[key];
  const doAmbiente = ambiente?.trim() || null;

  if (linha?.value != null) {
    return {
      value: linha.value,
      origem: 'banco',
      updatedAt: linha.updatedAt,
      // O ambiente que discorda é mostrado para o operador entender o log.
      ambienteIgnorado: doAmbiente && doAmbiente !== linha.value ? doAmbiente : null,
    };
  }

  if (doAmbiente) {
    return { value: doAmbiente, origem: 'ambiente', updatedAt: null, ambienteIgnorado: null };
  }
  return { value: padrao, origem: 'padrão', updatedAt: null, ambienteIgnorado: null };
}

function lerEstado(bruto: string | null): RagEstadoIndexador | null {
  if (!bruto) return null;
  try {
    const json: unknown = JSON.parse(bruto);
    return typeof json === 'object' && json !== null ? (json as RagEstadoIndexador) : null;
  } catch {
    // O formato é do indexador; JSON quebrado não derruba a tela.
    return null;
  }
}

/**
 * Resume a chave a partir do que o indexador publicou.
 *
 * `desconhecido` é o estado honesto de quando o indexador nunca rodou: o painel
 * não recebe a chave e não tem como saber sozinho.
 */
function estadoDaChave(estado: RagEstadoIndexador | null): RagEstadoChave {
  if (estado === null) return 'desconhecido';
  if (estado.keyPresent === false) return 'ausente';

  const erro = (estado.lastError ?? '').toLowerCase();
  if (erro.includes('recusou a chave') || erro.includes('api_key_invalid')) return 'recusada';
  if (erro.includes('cota') || erro.includes('resource_exhausted') || erro.includes('limite de taxa')) {
    return 'cota-esgotada';
  }
  return estado.keyPresent ? 'presente' : 'desconhecido';
}
