/**
 * O ciclo do indexador (`tmp/RAG-GOOGLE.md` §7, futuro `docs/14`).
 *
 * Ele varre o acervo no intervalo configurado e faz duas coisas bem separadas:
 *
 *   1. **Refatiar** as skills marcadas como pendentes — não custa nada e não
 *      precisa de chave nenhuma;
 *   2. **Embutir** os textos que ainda não têm vetor no espaço ativo — isso
 *      sim chama o provedor e custa dinheiro.
 *
 * A separação é o que faz "reindexar pelo painel" ser de graça: marcar tudo
 * como pendente refaz as divisões, e os textos que não mudaram continuam com
 * o vetor que já tinham, porque o endereço deles é o hash do conteúdo.
 *
 * O ciclo **nunca derruba o processo** por causa do ambiente: sem a migration
 * aplicada ele espera, sem chave ele refatia e avisa, e com o driver `off` ele
 * só publica o estado. O `run-local.sh` roda o `migrate` depois do `up`, então
 * subir antes das tabelas é o caso normal, não um erro.
 *
 * Mais de uma réplica pode rodar: a reserva usa `SKIP LOCKED` e a gravação de
 * vetores ignora conflito.
 */
import {
  chunkSkill,
  modeloPeloId,
  RagAuthError,
  RagConfigError,
  RagRateLimitError,
  type EmbeddingDriver,
  type EmbeddingModel,
} from '@purple-skills/rag';
import type {
  RagCoverage,
  RagPendingText,
  RagSkillContent,
  RagSpace,
  RagTextInput,
  RagVectorInput,
} from '@purple-skills/db';

/** Tudo que o ciclo precisa do mundo. Injetável para o teste não subir banco. */
export type IndexerPorts = {
  ragSchemaReady: () => Promise<boolean>;
  getRagSettings: () => Promise<{ 'rag.driver'?: { value: string | null }; 'rag.model'?: { value: string | null } }>;
  resolveRagSpace: (input: {
    driver: string;
    model: string;
    dimensions: number;
    documentPrefix: string;
    queryPrefix: string;
  }) => Promise<RagSpace>;
  claimStaleSkills: (limit: number) => Promise<string[]>;
  releaseStaleSkill: (uuid: string) => Promise<void>;
  readSkillForRag: (uuid: string) => Promise<RagSkillContent | null>;
  replaceSkillTexts: (skillUuid: string, texts: readonly RagTextInput[]) => Promise<number>;
  listPendingRagTexts: (spaceUuid: string, limit: number) => Promise<RagPendingText[]>;
  insertRagVectors: (spaceUuid: string, vectors: readonly RagVectorInput[]) => Promise<number>;
  ragCoverage: (spaceUuid: string | null) => Promise<RagCoverage>;
  setRagIndexerStatus: (status: Record<string, unknown>) => Promise<void>;
  /** `null` quando o driver está `off` ou não há chave. */
  driver: EmbeddingDriver | null;
  /** Presença da chave, separada do driver: sem ela dá para refatiar, não embutir. */
  keyPresent: boolean;
  log: (mensagem: string) => void;
  now?: () => Date;
};

export type CycleOptions = {
  /** Skills reservadas por rodada. */
  skillBatch?: number;
  /** Textos embutidos por rodada. */
  textBatch?: number;
};

export type CycleResult = {
  /** O que o ciclo conseguiu fazer. */
  state: 'esperando-migration' | 'desligado' | 'sem-chave' | 'ok';
  skillsRefatiadas: number;
  textosEmbutidos: number;
  erros: number;
  /** Último erro do ciclo, para o estado publicado e o log. */
  lastError: string | null;
  /** Falso quando não adianta insistir neste ciclo (chave ou configuração). */
  continuar: boolean;
  space: RagSpace | null;
};

export const SKILL_BATCH = 50;
export const TEXT_BATCH = 64;

/**
 * Uma rodada completa. Devolve o que aconteceu em vez de lançar: quem chama
 * decide se dorme, se repete ou se sai.
 */
export async function runCycle(
  ports: IndexerPorts,
  options: CycleOptions = {},
): Promise<CycleResult> {
  const skillBatch = options.skillBatch ?? SKILL_BATCH;
  const textBatch = options.textBatch ?? TEXT_BATCH;
  const agora = ports.now ?? (() => new Date());

  const resultado: CycleResult = {
    state: 'ok',
    skillsRefatiadas: 0,
    textosEmbutidos: 0,
    erros: 0,
    lastError: null,
    continuar: true,
    space: null,
  };

  // 0. A migration pode não ter rodado ainda. Esperar é o normal, não um erro.
  if (!(await ports.ragSchemaReady())) {
    ports.log('[indexer] esperando a migration do RAG: tabelas rag_* ainda não existem');
    return { ...resultado, state: 'esperando-migration' };
  }

  // 1. O banco decide o driver, não o ambiente (§4.1).
  const settings = await ports.getRagSettings();
  const driverConfigurado = settings['rag.driver']?.value ?? 'off';
  const modeloConfigurado = settings['rag.model']?.value ?? null;

  if (driverConfigurado === 'off' || ports.driver === null) {
    const cobertura = await ports.ragCoverage(null);
    await ports.setRagIndexerStatus({
      at: agora().toISOString(),
      driver: driverConfigurado,
      keyPresent: ports.keyPresent,
      ...cobertura,
    });
    if (driverConfigurado === 'off') {
      ports.log('[indexer] driver desligado (rag.driver=off): nada a fazer');
      return { ...resultado, state: 'desligado' };
    }
    // Driver ligado no banco, mas sem chave: dá para refatiar, não para embutir.
  }

  const driver = ports.driver;
  let modelo: EmbeddingModel | null = null;
  if (driver !== null) {
    try {
      modelo = modeloPeloId(driver, modeloConfigurado ?? driver.models[0]!.id);
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      ports.log(`[indexer] configuração recusada: ${mensagem}`);
      await ports.setRagIndexerStatus({
        at: agora().toISOString(),
        driver: driverConfigurado,
        keyPresent: ports.keyPresent,
        lastError: mensagem,
        lastErrorAt: agora().toISOString(),
      });
      return { ...resultado, state: 'ok', erros: 1, lastError: mensagem, continuar: false };
    }
  }

  // Sem driver não há espaço: refatiar não depende dele, embutir sim.
  let espaco: RagSpace | null = null;
  if (driver !== null && modelo !== null) {
    // 2. O espaço leva os prefixos do modelo: trocá-los cria outro espaço.
    espaco = await ports.resolveRagSpace({
      driver: driver.id,
      model: modelo.id,
      dimensions: modelo.dimensions,
      documentPrefix: modelo.documentPrefix,
      queryPrefix: modelo.queryPrefix,
    });
    resultado.space = espaco;
  }

  // 3. Refatiar. Não custa nada e não precisa de chave.
  const reservadas = await ports.claimStaleSkills(skillBatch);
  for (const uuid of reservadas) {
    try {
      const skill = await ports.readSkillForRag(uuid);
      // Sumiu entre a reserva e a leitura: caso normal, não erro.
      if (skill === null) continue;

      const referencia = modelo ?? driver?.models[0] ?? MODELO_DE_REFERENCIA;
      const { occurrences, skipped } = chunkSkill(
        {
          name: skill.name,
          description: skill.description,
          tags: skill.tags,
          files: skill.files.map((f) => ({
            id: f.id,
            relativePath: f.relativePath,
            textContent: f.content,
          })),
        },
        referencia,
      );

      for (const pulado of skipped) {
        if (pulado.reason === 'grande-demais') {
          ports.log(
            `[indexer] ${skill.slug}: ${pulado.relativePath} pulado, ` +
              `${pulado.bytes} bytes acima do teto`,
          );
        }
      }

      await ports.replaceSkillTexts(
        uuid,
        occurrences.map((o) => ({
          source: o.source,
          content: o.content,
          relativePath: o.relativePath,
          part: o.part,
          fileId: o.fileId,
        })),
      );
      resultado.skillsRefatiadas += 1;
    } catch (erro) {
      // A skill volta para pendente: nada se perde, a próxima rodada tenta.
      await ports.releaseStaleSkill(uuid).catch(() => {});
      resultado.erros += 1;
      resultado.lastError = erro instanceof Error ? erro.message : String(erro);
      ports.log(`[indexer] falha ao refatiar ${uuid}: ${resultado.lastError}`);
    }
  }

  // 4. Embutir. Daqui para baixo custa dinheiro.
  let tokens = 0;
  if (driver === null || modelo === null || espaco === null) {
    await ports.setRagIndexerStatus({
      at: agora().toISOString(),
      driver: driverConfigurado,
      keyPresent: ports.keyPresent,
      ...(await ports.ragCoverage(espaco?.uuid ?? null)),
      lastError: resultado.lastError,
    });
    if (!ports.keyPresent) {
      ports.log(
        `[indexer] sem RAG_GOOGLE_API_KEY: ${resultado.skillsRefatiadas} skills refatiadas, ` +
          'nenhum texto embutido',
      );
      return { ...resultado, state: 'sem-chave' };
    }
    return { ...resultado, state: 'sem-chave' };
  }

  const pendentes = await ports.listPendingRagTexts(espaco.uuid, textBatch);
  if (pendentes.length > 0) {
    try {
      const vetores = await driver.embedDocuments(
        modelo,
        pendentes.map((t) => t.content),
      );
      const gravados = await ports.insertRagVectors(
        espaco.uuid,
        vetores.map((embedding, i) => ({ sha256: pendentes[i]!.sha256, embedding })),
      );
      resultado.textosEmbutidos = gravados;
      tokens = pendentes.reduce((acc, t) => acc + Math.ceil(t.content.length / 4), 0);
    } catch (erro) {
      resultado.erros += 1;
      resultado.lastError = erro instanceof Error ? erro.message : String(erro);

      // Chave recusada ou configuração errada: insistir neste ciclo só queima
      // requisição. A cota esgotada zera à meia-noite do horário do Pacífico.
      if (
        erro instanceof RagAuthError ||
        erro instanceof RagConfigError ||
        erro instanceof RagRateLimitError
      ) {
        resultado.continuar = false;
      }
      ports.log(`[indexer] falha ao embutir: ${resultado.lastError}`);
    }
  }

  // 5. Publicar o estado. O painel não recebe a chave: só o indexador sabe se
  // ela existe e se o Google a aceitou.
  const cobertura = await ports.ragCoverage(espaco.uuid);
  await ports.setRagIndexerStatus({
    at: agora().toISOString(),
    driver: driverConfigurado,
    model: modelo.id,
    spaceUuid: espaco.uuid,
    keyPresent: ports.keyPresent,
    ...cobertura,
    lastError: resultado.lastError,
    lastErrorAt: resultado.lastError ? agora().toISOString() : null,
  });

  if (resultado.skillsRefatiadas > 0 || resultado.textosEmbutidos > 0) {
    ports.log(
      `[indexer] espaço ${driver.id}/${modelo.id}/${modelo.dimensions}: ` +
        `${resultado.skillsRefatiadas} skills refatiadas, ` +
        `${resultado.textosEmbutidos} textos embutidos, ` +
        `${tokens.toLocaleString('pt-BR')} tokens, ${resultado.erros} erros`,
    );
  }

  return resultado;
}

/**
 * Modelo usado só para dividir quando não há driver nenhum.
 *
 * A divisão não depende do provedor — ela é do projeto. O que o modelo dá aqui
 * é o teto de caracteres por parte, e refatiar sem chave é justamente o que
 * permite preparar o acervo antes de ligar a busca.
 */
const MODELO_DE_REFERENCIA: EmbeddingModel = {
  id: 'sem-driver',
  dimensions: 0,
  documentPrefix: '',
  queryPrefix: '',
  maxInputTokens: 8192,
  maxBatch: 100,
  maxBatchChars: 60_000,
  maxPartChars: 6000,
};

/**
 * O modo único: repete as etapas 3 e 4 até não haver mais pendência, e sai.
 *
 * Devolve o código de saída — 0 quando terminou sem erro, 1 quando houve
 * erro. É o que o teste de aceite do PR 3 confere contra o servidor falso.
 */
export async function runOnce(
  ports: IndexerPorts,
  options: CycleOptions & { maxRodadas?: number } = {},
): Promise<{ exitCode: number; rodadas: number; result: CycleResult }> {
  const maxRodadas = options.maxRodadas ?? 100;
  let rodadas = 0;
  let ultimo: CycleResult = {
    state: 'ok',
    skillsRefatiadas: 0,
    textosEmbutidos: 0,
    erros: 0,
    lastError: null,
    continuar: true,
    space: null,
  };
  let erros = 0;

  while (rodadas < maxRodadas) {
    ultimo = await runCycle(ports, options);
    rodadas += 1;
    erros += ultimo.erros;

    // Sem a migration ou desligado, o modo único não tem o que esperar.
    if (ultimo.state !== 'ok' && ultimo.state !== 'sem-chave') break;
    if (!ultimo.continuar) break;
    // Terminou quando uma rodada não achou mais nada para fazer.
    if (ultimo.skillsRefatiadas === 0 && ultimo.textosEmbutidos === 0) break;
  }

  return { exitCode: erros > 0 ? 1 : 0, rodadas, result: ultimo };
}
