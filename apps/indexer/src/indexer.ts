/**
 * O ciclo do indexador (`docs/14-rag.md` §7).
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
 * A etapa de embutir grava **lote a lote**, e o texto que o provedor recusa pelo
 * conteúdo é marcado como recusado **no banco** (`markRagTextRefused`, `025`) em
 * vez de voltar para a fila: ela é ordenada por `created_at`, então sem a marca
 * um único texto venenoso trava o acervo inteiro atrás dele e é pago de novo a
 * cada ciclo — inclusive depois de reiniciar o container.
 *
 * Mais de uma réplica pode rodar **sem corromper nada e sem pagar duas vezes**:
 * a reserva de skills usa `SKIP LOCKED`, a gravação de vetores ignora conflito e
 * a leitura da fila **reserva** o que devolve (`RESERVA_MS`), então cada texto
 * sai para um indexador só. A reserva vence sozinha, e `insertRagVectors` a baixa
 * assim que o vetor entra. Onde ela não alcança — reserva vencida no meio do
 * caminho —, o ciclo continua sabendo não *se enganar*: quem perde a corrida
 * recebe zero de `insertRagVectors` e mesmo assim sabe que a fila andou
 * (`textosProcessados`), em vez de concluir que não havia mais nada a fazer.
 *
 * Cada chamada ao provedor vai com prazo (`RAG_INDEX_TIMEOUT_MS`): sem ele um
 * provedor que aceita a conexão e nunca responde segurava a rodada pelos prazos
 * internos do `undici` multiplicados pelas tentativas, com o painel mostrando
 * dado velho sem dizer que o ciclo estava pendurado.
 */
import {
  chunkSkill,
  driverInfo,
  lotes,
  modeloPeloId,
  DRIVERS_IMPLEMENTADOS,
  type RagProviderId,
  RagAuthError,
  RagConfigError,
  RagInputTooLongError,
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
  /**
   * A fila do espaço: os textos com ocorrência e sem vetor, do mais antigo para
   * o mais novo. O banco já deixa de fora o que ele recusou e o que outro
   * indexador reservou e ainda tem no prazo.
   *
   * Com `reserveMs`, a mesma consulta **reserva** o que devolve (`025`): é o
   * que impede duas réplicas de pagarem pelo mesmo embedding. Quem perde a
   * corrida recebe só o que sobrou, e a reserva vence sozinha — indexador morto
   * não estaciona a fila. Sem `reserveMs` a leitura é pura, que é o que um
   * relatório ou um teste quer.
   */
  listPendingRagTexts: (
    spaceUuid: string,
    limit: number,
    options?: { reserveMs?: number },
  ) => Promise<RagPendingText[]>;
  insertRagVectors: (spaceUuid: string, vectors: readonly RagVectorInput[]) => Promise<number>;
  /**
   * Marca no banco o texto que o provedor recusou de forma definitiva, para ele
   * não voltar à fila nos ciclos seguintes. É ela que faz a recusa sobreviver ao
   * reinício do container: `listPendingRagTexts` passa a excluir o texto.
   *
   * Continua **opcional** para o ciclo poder ser montado sem ela (é o que o
   * teste faz); o container liga a função de `@purple-skills/db`. Sem a porta, a
   * recusa vale só enquanto este processo viver — ver `RecusasRag`.
   */
  markRagTextRefused?: (spaceUuid: string, sha256: Buffer, motivo: string) => Promise<void>;
  /**
   * Apaga textos canônicos sem ocorrência nenhuma — e, pela cascata de
   * `rag_vectors`, os vetores deles. Devolve quantos saíram.
   *
   * Editar ou apagar uma skill deixa para trás o texto antigo: `replaceSkillTexts`
   * apaga as ocorrências, e a FK de `rag_skill_texts` é sem cascata de propósito
   * (texto em uso não pode ser apagado). Sem coleta, esses textos e os vetores
   * pagos por eles ficam para sempre — a `020` chama isso de "limpeza futura".
   *
   * Continua **opcional** pelo mesmo motivo de `markRagTextRefused`: sem a
   * porta o ciclo segue igual, só não coleta nada. O ciclo a chama **depois** de
   * embutir, quando todo `replaceSkillTexts` da rodada já commitou: apagar antes
   * derrubaria a ocorrência que estava sendo gravada.
   */
  collectOrphanRagTexts?: (limit: number) => Promise<number>;
  ragCoverage: (spaceUuid: string | null) => Promise<RagCoverage>;
  setRagIndexerStatus: (status: Record<string, unknown>) => Promise<void>;
  /**
   * O driver. Um `EmbeddingDriver` fixo (ou `null`) para o teste; uma função
   * para escolher pelo id que o **banco** configurou — é assim que o container
   * monta no boot todos os drivers para os quais tem chave e deixa o painel
   * decidir qual deles roda, sem recriar container nenhum.
   */
  driver: EmbeddingDriver | null | ((id: RagProviderId) => EmbeddingDriver | null);
  /** Presença da chave, separada do driver: sem ela dá para refatiar, não embutir. */
  keyPresent: boolean | ((id: RagProviderId) => boolean);
  log: (mensagem: string) => void;
  now?: () => Date;
};

export type CycleOptions = {
  /** Skills reservadas por rodada. */
  skillBatch?: number;
  /** Textos embutidos por rodada. */
  textBatch?: number;
  /**
   * As recusas definitivas já conhecidas. Quem roda vários ciclos no mesmo
   * processo passa **a mesma** instância. Com a marca no banco ela é só a rede
   * de segurança de quando a gravação da recusa falha; sem instância comum, um
   * ciclo redescobriria — e pagaria de novo por — o texto que não foi marcado.
   */
  recusas?: RecusasRag;
  /**
   * Prazo de **uma** chamada ao provedor, em milissegundos, tentativas e recuos
   * incluídos. O container passa `RAG_INDEX_TIMEOUT_MS`; quem não passa nada
   * fica com `TIMEOUT_EMBEDDING_MS`.
   */
  timeoutMs?: number;
  /** Órfãos coletados por rodada, quando a porta de coleta existir. */
  orphanBatch?: number;
};

export type CycleResult = {
  /** O que o ciclo conseguiu fazer. */
  state: 'esperando-migration' | 'desligado' | 'sem-chave' | 'ok';
  skillsRefatiadas: number;
  /** Vetores que **este** ciclo gravou: o que `insertRagVectors` aceitou. */
  textosEmbutidos: number;
  /**
   * Textos que voltaram do provedor e foram até a gravação — gravados ou
   * ignorados por já terem vetor.
   *
   * Não é o mesmo que `textosEmbutidos`: a gravação ignora conflito, então a
   * réplica que perde a corrida recebe zero e paga igual. É por este número que
   * o `--once` decide se a fila andou; pelo outro, ele concluiria "não há mais
   * nada a fazer" logo depois de ter pago por um lote inteiro.
   */
  textosProcessados: number;
  /**
   * Textos que o provedor recusou **neste ciclo** e que saíram da fila. Não
   * entram em `erros`: a recusa foi tratada, e contá-la como falha faria o
   * `--once` sair com 1 por causa de um texto que nunca vai passar.
   */
  textosRecusados: number;
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
 * Prazo da reserva que a leitura da fila grava (`rag_text_status`, `025`).
 *
 * Ele precisa cobrir o caminho **inteiro** de um texto — todos os lotes de
 * `embutirPendentes` até a gravação do vetor —, não uma chamada ao provedor:
 * quem chega ao vetor tem a reserva baixada pelo próprio `insertRagVectors`, e
 * o prazo só vale para quem ainda não terminou. Dez minutos com ciclo de 30
 * segundos é folgado para o lote de 64 textos e curto o bastante para um
 * indexador morto não estacionar a fila.
 *
 * Se ele vencer cedo demais, o pior caso é o de antes da reserva: duas réplicas
 * pagam pelo mesmo embedding. Não há perda de dado em nenhum dos lados.
 */
export const RESERVA_MS = 10 * 60_000;
/**
 * Prazo de uma chamada ao provedor quando ninguém passa outro — o mesmo padrão
 * que `RAG_INDEX_TIMEOUT_MS` tem no registro do `@purple-skills/rag`.
 *
 * Existe para que um ciclo montado à mão (teste, script) também não possa ficar
 * pendurado; quem sobe o container lê a variável e passa o valor dela.
 */
export const TIMEOUT_EMBEDDING_MS = 120_000;
/** Órfãos apagados por rodada: `LIMIT` para a coleta não segurar lock. */
export const ORPHAN_BATCH = 500;

/**
 * As recusas definitivas que este processo já conhece, por espaço.
 *
 * Quem tira o texto recusado da fila **de vez** é o banco: `markRagTextRefused`
 * grava a recusa e `listPendingRagTexts` deixa de devolvê-la (`025`). Esta
 * memória deixou de ser o mecanismo e ficou sendo **a rede de segurança**: a
 * gravação da marca roda dentro do tratamento de um erro e é engolida se
 * falhar, e sem esta lista o texto voltaria no ciclo seguinte para ser pago de
 * novo. Ela também cobre a janela entre a recusa e o vencimento da reserva,
 * caso a gravação tenha falhado.
 *
 * A chave é o par (espaço, texto), não o texto: outro modelo pode muito bem
 * aceitar o que o anterior recusou, e o espaço é o que identifica o par
 * driver+modelo.
 *
 * Ela **não** é o número que o painel vê: `refusedTexts` vem de `ragCoverage`,
 * que conta as linhas do banco e não se perde no reinício.
 */
export class RecusasRag {
  private readonly porEspaco = new Map<string, Set<string>>();

  tem(espacoUuid: string, sha256: Buffer): boolean {
    return this.porEspaco.get(espacoUuid)?.has(sha256.toString('hex')) ?? false;
  }

  marcar(espacoUuid: string, sha256: Buffer): void {
    const conjunto = this.porEspaco.get(espacoUuid) ?? new Set<string>();
    conjunto.add(sha256.toString('hex'));
    this.porEspaco.set(espacoUuid, conjunto);
  }
}

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
  const recusas = options.recusas ?? new RecusasRag();
  const agora = ports.now ?? (() => new Date());

  const resultado: CycleResult = {
    state: 'ok',
    skillsRefatiadas: 0,
    textosEmbutidos: 0,
    textosProcessados: 0,
    textosRecusados: 0,
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

  // O id vem do banco: pode ser um driver que este binário não conhece.
  const conhecido =
    driverConfigurado !== 'off' &&
    (DRIVERS_IMPLEMENTADOS as readonly string[]).includes(driverConfigurado);
  const idDoDriver = conhecido ? (driverConfigurado as RagProviderId) : null;

  const driver = resolver(ports.driver, idDoDriver);
  const keyPresent = resolver(ports.keyPresent, idDoDriver) ?? false;

  if (driverConfigurado !== 'off' && !conhecido) {
    const mensagem = `rag.driver="${driverConfigurado}" não é um driver conhecido`;
    ports.log(`[indexer] configuração recusada: ${mensagem}`);
    await ports.setRagIndexerStatus({
      at: agora().toISOString(),
      driver: driverConfigurado,
      keyPresent: false,
      lastError: mensagem,
      lastErrorAt: agora().toISOString(),
    });
    return { ...resultado, state: 'ok', erros: 1, lastError: mensagem, continuar: false };
  }

  if (driverConfigurado === 'off' || driver === null) {
    const cobertura = await ports.ragCoverage(null);
    await ports.setRagIndexerStatus({
      at: agora().toISOString(),
      driver: driverConfigurado,
      keyPresent,
      ...cobertura,
    });
    if (driverConfigurado === 'off') {
      ports.log('[indexer] driver desligado (rag.driver=off): nada a fazer');
      return { ...resultado, state: 'desligado' };
    }
    // Driver ligado no banco, mas sem chave: dá para refatiar, não para embutir.
  }

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
        keyPresent,
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
        } else if (pulado.reason === 'nao-e-texto') {
          // Vale linha de log: quem anexou um `.svg` precisa saber que ele não
          // entra na busca semântica — e, sobretudo, que não foi ao provedor.
          ports.log(
            `[indexer] ${skill.slug}: ${pulado.relativePath} pulado, ` +
              `${pulado.mimeType} não é texto de skill; não vai para o provedor`,
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
      keyPresent,
      ...(await ports.ragCoverage(espaco?.uuid ?? null)),
      lastError: resultado.lastError,
    });
    if (!keyPresent) {
      // O nome da variável sai do registro (`AGENTS.md`, "Regra da busca
      // semântica"): escrito à mão, ele citava o Google em toda instalação, e
      // quem rodasse com `openai` ia conferir a variável errada.
      const variavel = idDoDriver ? driverInfo(idDoDriver).apiKeyEnv : 'RAG_<DRIVER>_API_KEY';
      ports.log(
        `[indexer] sem ${variavel}: ${resultado.skillsRefatiadas} skills refatiadas, ` +
          'nenhum texto embutido',
      );
    }
    return { ...resultado, state: 'sem-chave' };
  }

  // A fila pede exatamente o tamanho do lote: quem exclui o recusado agora é o
  // banco, então inflar a janela para descartar em memória deixou de ter
  // motivo — e passaria a **reservar** textos que este ciclo não vai embutir.
  // A reserva é o que impede duas réplicas de pagarem pelo mesmo embedding; o
  // filtro em memória continua atrás dela como rede de segurança, para o caso
  // de a gravação da recusa ter falhado.
  const pendentes = (
    await ports.listPendingRagTexts(espaco.uuid, textBatch, { reserveMs: RESERVA_MS })
  ).filter((t) => !recusas.tem(espaco.uuid, t.sha256));

  if (pendentes.length > 0) {
    const embutido = await embutirPendentes({
      ports,
      driver,
      modelo,
      espacoUuid: espaco.uuid,
      pendentes,
      recusas,
      resultado,
      timeoutMs: options.timeoutMs ?? TIMEOUT_EMBEDDING_MS,
    });
    // Conta o que foi gravado mesmo quando um lote adiante falhou: era
    // justamente isso que a chamada única jogava fora.
    resultado.textosEmbutidos = embutido.gravados;
    resultado.textosProcessados = embutido.processados;
    tokens = embutido.tokens;
  }

  // 4.1 Coletar os órfãos. Só agora: todo `replaceSkillTexts` desta rodada já
  // commitou, e apagar antes derrubaria a ocorrência que estava sendo gravada.
  await coletarOrfaos(ports, options.orphanBatch ?? ORPHAN_BATCH);

  // 5. Publicar o estado. O painel não recebe a chave: só o indexador sabe se
  // ela existe e se o Google a aceitou.
  const cobertura = await ports.ragCoverage(espaco.uuid);
  await ports.setRagIndexerStatus({
    at: agora().toISOString(),
    driver: driverConfigurado,
    model: modelo.id,
    spaceUuid: espaco.uuid,
    keyPresent,
    // `refusedTexts` vem daqui, de `ragCoverage`: quantos textos deste espaço o
    // provedor recusou de vez, contados no banco. Sem este número a cobertura
    // pareceria travada sem explicação — eles nunca vão ter vetor. Era o
    // tamanho da lista em memória, que voltava a zero a cada reinício e não
    // enxergava a recusa da outra réplica.
    ...cobertura,
    lastError: resultado.lastError,
    lastErrorAt: resultado.lastError ? agora().toISOString() : null,
  });

  if (
    resultado.skillsRefatiadas > 0 ||
    resultado.textosProcessados > 0 ||
    resultado.textosRecusados > 0
  ) {
    // Texto pago cujo vetor já estava lá: é outra réplica tendo chegado antes
    // (ou o mesmo lote reprocessado). Sem esta linha o operador vê "0 textos
    // embutidos" num ciclo que gastou dinheiro e não entende o porquê.
    const duplicados = resultado.textosProcessados - resultado.textosEmbutidos;
    ports.log(
      `[indexer] espaço ${driver.id}/${modelo.id}/${modelo.dimensions}: ` +
        `${resultado.skillsRefatiadas} skills refatiadas, ` +
        `${resultado.textosEmbutidos} textos embutidos, ` +
        (duplicados > 0 ? `${duplicados} já tinham vetor, ` : '') +
        (resultado.textosRecusados > 0 ? `${resultado.textosRecusados} recusados, ` : '') +
        `${tokens.toLocaleString('pt-BR')} tokens, ${resultado.erros} erros`,
    );
  }

  return resultado;
}

/**
 * Embute os pendentes **lote a lote**, gravando cada lote assim que ele volta.
 *
 * Duas coisas que a chamada única para todos os pendentes não fazia:
 *
 *   * **guarda o que já foi pago.** O driver dividia em lotes por dentro, e um
 *     lote que falhasse levava com ele os vetores de todos os anteriores da
 *     mesma chamada — trabalho pago e jogado fora em todo ciclo;
 *   * **não repete o que foi recusado.** Recusa de conteúdo
 *     (`RagInputTooLongError`) é definitiva: o lote volta um texto por vez para
 *     achar o culpado, e o culpado sai da fila em vez de voltar para sempre.
 *
 * Erro que **não** é de conteúdo encerra a etapa: o `ClienteHttp` já tentou de
 * novo com recuo antes de chegar aqui, então insistir nos lotes seguintes só
 * queimaria requisição. A rodada seguinte retoma de onde parou, porque o que foi
 * gravado ficou gravado.
 *
 * Cada chamada leva o **seu** prazo: `AbortSignal.timeout` por lote, e não um
 * para a etapa inteira, senão o último lote herdaria o tempo que os anteriores
 * gastaram. O `http.ts` trata o prazo estourado como prazo de quem chamou —
 * `RagTimeoutError`, sem tentativa nova.
 *
 * Devolve `processados` além de `gravados`: a gravação ignora conflito, então a
 * réplica que perde a corrida recebe zero e pagou igual. Quem decide se a fila
 * andou precisa do primeiro número, não do segundo.
 */
async function embutirPendentes(entrada: {
  ports: IndexerPorts;
  driver: EmbeddingDriver;
  modelo: EmbeddingModel;
  espacoUuid: string;
  pendentes: readonly RagPendingText[];
  recusas: RecusasRag;
  resultado: CycleResult;
  timeoutMs: number;
}): Promise<{ gravados: number; processados: number; tokens: number }> {
  const { ports, driver, modelo, espacoUuid, pendentes, recusas, resultado, timeoutMs } = entrada;
  let gravados = 0;
  let processados = 0;
  let tokens = 0;
  let inicio = 0;

  for (const grupo of lotes(
    modelo,
    pendentes.map((t) => t.content),
  )) {
    // `lotes` nunca reordena nem descarta: a fatia é a parte da fila que virou
    // este lote, na mesma ordem. É por ela que o vetor casa com o hash certo.
    const fatia = pendentes.slice(inicio, inicio + grupo.length);
    inicio += grupo.length;

    try {
      const vetores = await driver.embedDocuments(modelo, grupo, AbortSignal.timeout(timeoutMs));
      gravados += await gravarVetores(ports, espacoUuid, fatia, vetores);
      processados += fatia.length;
      tokens += estimarTokens(fatia);
      continue;
    } catch (erro) {
      if (!(erro instanceof RagInputTooLongError)) {
        registrarFalha(ports, resultado, erro);
        return { gravados, processados, tokens };
      }
      // Lote de um texto só: o culpado já está identificado, e reenviá-lo seria
      // pagar por um erro garantido.
      if (fatia.length === 1) {
        await marcarRecusado(ports, recusas, espacoUuid, fatia[0]!, erro, resultado);
        continue;
      }
    }

    // Algum texto deste lote o provedor não aceita. Reenviar um por um acha
    // qual — e texto sozinho não deixa o driver dividir o lote outra vez.
    for (const [i, pendente] of fatia.entries()) {
      try {
        const vetores = await driver.embedDocuments(
          modelo,
          [grupo[i]!],
          AbortSignal.timeout(timeoutMs),
        );
        gravados += await gravarVetores(ports, espacoUuid, [pendente], vetores);
        processados += 1;
        tokens += estimarTokens([pendente]);
      } catch (erro) {
        if (!(erro instanceof RagInputTooLongError)) {
          registrarFalha(ports, resultado, erro);
          return { gravados, processados, tokens };
        }
        await marcarRecusado(ports, recusas, espacoUuid, pendente, erro, resultado);
      }
    }
  }

  return { gravados, processados, tokens };
}

/**
 * Apaga os textos que não têm mais ocorrência nenhuma, e com eles os vetores
 * que a cascata leva.
 *
 * Falha na coleta **não** é erro do ciclo: o acervo continua correto, só maior
 * do que precisa. Contá-la faria o `--once` sair com 1 por causa de uma
 * faxina — e faria a reindexação manual parecer ter dado errado.
 */
async function coletarOrfaos(ports: IndexerPorts, limite: number): Promise<void> {
  if (!ports.collectOrphanRagTexts) return;
  try {
    const apagados = await ports.collectOrphanRagTexts(limite);
    if (apagados > 0) {
      ports.log(`[indexer] ${apagados} textos órfãos coletados, com os vetores deles`);
    }
  } catch (erro) {
    ports.log(
      `[indexer] não deu para coletar os textos órfãos: ` +
        `${erro instanceof Error ? erro.message : String(erro)}`,
    );
  }
}

/** Grava os vetores de um lote, casados com os textos pela ordem. */
async function gravarVetores(
  ports: IndexerPorts,
  espacoUuid: string,
  fatia: readonly RagPendingText[],
  vetores: readonly number[][],
): Promise<number> {
  // O driver promete um vetor por texto, na ordem. Gravar uma lista de outro
  // tamanho casaria vetor com o hash de outro texto, e o estrago só apareceria
  // como busca ruim, meses depois.
  if (vetores.length !== fatia.length) {
    throw new Error(`o driver devolveu ${vetores.length} vetores para ${fatia.length} textos`);
  }
  return ports.insertRagVectors(
    espacoUuid,
    fatia.map((pendente, i) => ({ sha256: pendente.sha256, embedding: vetores[i]! })),
  );
}

/** A estimativa por caractere: a conta real só o provedor sabe fazer. */
function estimarTokens(textos: readonly RagPendingText[]): number {
  return textos.reduce((acc, t) => acc + Math.ceil(t.content.length / 4), 0);
}

/** Conta o erro, guarda a mensagem e decide se ainda vale insistir no ciclo. */
function registrarFalha(ports: IndexerPorts, resultado: CycleResult, erro: unknown): void {
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

/**
 * Tira o texto da fila de vez — é o que a §7 promete.
 *
 * A marca vai para o banco (`rag_text_status`), que é o que a faz sobreviver ao
 * reinício do container e valer para todas as réplicas; a lista em memória fica
 * como rede de segurança. Falhar ao marcar **não** invalida a recusa deste
 * processo: o texto segue fora da fila enquanto ele viver, e o log diz que a
 * gravação não passou — engolir a falha é de propósito, porque isto roda dentro
 * do tratamento de outro erro e um segundo erro aqui esconderia o primeiro.
 */
async function marcarRecusado(
  ports: IndexerPorts,
  recusas: RecusasRag,
  espacoUuid: string,
  pendente: RagPendingText,
  erro: Error,
  resultado: CycleResult,
): Promise<void> {
  recusas.marcar(espacoUuid, pendente.sha256);
  resultado.textosRecusados += 1;

  // O hash curto é o que permite achar o texto no banco sem despejar no log
  // conteúdo de skill privada.
  const hash = pendente.sha256.toString('hex').slice(0, 12);
  ports.log(
    `[indexer] texto ${hash} (${pendente.content.length} caracteres) recusado pelo provedor; ` +
      `não será tentado de novo: ${erro.message}`,
  );

  try {
    await ports.markRagTextRefused?.(espacoUuid, pendente.sha256, erro.message);
  } catch (falha) {
    ports.log(
      `[indexer] não deu para marcar o texto ${hash} como recusado no banco: ` +
        `${falha instanceof Error ? falha.message : String(falha)}`,
    );
  }
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
  // Uma memória de recusas para a execução inteira: quando a marca no banco não
  // passa, é ela que impede a rodada seguinte de redescobrir — pagando de novo —
  // o mesmo texto recusado.
  const recusas = options.recusas ?? new RecusasRag();
  let rodadas = 0;
  let ultimo: CycleResult = {
    state: 'ok',
    skillsRefatiadas: 0,
    textosEmbutidos: 0,
    textosProcessados: 0,
    textosRecusados: 0,
    erros: 0,
    lastError: null,
    continuar: true,
    space: null,
  };
  let erros = 0;

  while (rodadas < maxRodadas) {
    ultimo = await runCycle(ports, { ...options, recusas });
    rodadas += 1;
    erros += ultimo.erros;

    // Sem a migration ou desligado, o modo único não tem o que esperar.
    if (ultimo.state !== 'ok' && ultimo.state !== 'sem-chave') break;
    if (!ultimo.continuar) break;
    // Terminou quando uma rodada não achou mais nada para fazer. Recusar também
    // é andar: a fila encurtou, e a rodada seguinte alcança quem estava atrás.
    //
    // O critério é o que foi **processado**, não o que foi gravado: a gravação
    // ignora conflito, então a réplica que chega depois (reserva vencida no meio
    // do caminho, lote reprocessado) recebe zero de `insertRagVectors`. Pelo
    // número de gravados, ela sairia dizendo "não há mais nada a fazer" logo
    // depois de ter pago por um lote inteiro — com a fila ainda cheia.
    if (
      ultimo.skillsRefatiadas === 0 &&
      ultimo.textosProcessados === 0 &&
      ultimo.textosRecusados === 0
    ) {
      break;
    }
  }

  return { exitCode: erros > 0 ? 1 : 0, rodadas, result: ultimo };
}

/**
 * Resolve uma porta que pode ser fixa ou depender do driver configurado.
 *
 * O teste passa o valor pronto; o container passa a função, porque só descobre
 * qual driver vale depois de ler o banco.
 */
function resolver<T>(
  porta: T | ((id: RagProviderId) => T),
  id: RagProviderId | null,
): T | null {
  if (typeof porta !== 'function') return porta;
  if (id === null) return null;
  return (porta as (id: RagProviderId) => T)(id);
}
