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
 * A marca é permanente, e por isso só é gravada **com prova**: um 400 diz que o
 * provedor não aceitou a requisição, não que o problema é aquele texto. Antes de
 * virar recusa, todo lote recusado é conferido com o texto-sonda (`TEXTO_SONDA`);
 * se o provedor recusa também a sonda, o problema é da instalação e nada é
 * marcado.
 *
 * Mais de uma réplica pode rodar **sem corromper nada e sem pagar duas vezes**:
 * a reserva de skills usa `SKIP LOCKED`, a gravação de vetores ignora conflito e
 * a leitura da fila **reserva** o que devolve (`RESERVA_MS`), então cada texto
 * sai para um indexador só. A reserva vence sozinha, `insertRagVectors` a baixa
 * assim que o vetor entra, e o ciclo que desiste do lote — erro que não é de
 * conteúdo, parada pedida — a **devolve** (`releaseRagTextReservations`) em vez
 * de segurá-la até o prazo. Onde ela não alcança — reserva vencida no meio do
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
  ragErrorKind,
  DRIVERS_IMPLEMENTADOS,
  type RagProviderId,
  RagAuthError,
  RagConfigError,
  RagInputTooLongError,
  RagRateLimitError,
  type EmbeddingDriver,
  type EmbeddingModel,
  type RagErrorKind,
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
   * Devolve à fila os textos que este ciclo reservou e **não** resolveu: o lote
   * falhou por motivo que não é o conteúdo, ou nem chegou a ser tentado porque um
   * lote anterior dos mesmos textos falhou. Devolve quantas reservas saíram.
   *
   * Sem ela a reserva só tinha duas saídas, o vetor e o vencimento: o indexador
   * **vivo** que desistia do lote o segurava por `RESERVA_MS`, o ciclo seguinte
   * reservava os textos seguintes e falhava de novo, e com a fila inteira
   * reservada o estado publicado passava a dizer "sem erro" com o acervo sem
   * vetor (relatório 024 da auditoria de 2026-09-19).
   *
   * **Opcional**, como as outras portas da `025`: sem ela vale o vencimento.
   */
  releaseRagTextReservations?: (spaceUuid: string, hashes: readonly Buffer[]) => Promise<number>;
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
  /**
   * Pedido de parada (SIGTERM, SIGINT). O ciclo o consulta onde dá para sair sem
   * deixar nada pela metade — **entre** uma skill e outra, **entre** um lote de
   * textos e outro — e devolve à fila o que reservou e não começou. O que está
   * em curso termina.
   *
   * A reserva de skills tem prazo desde a migration `reserva-de-skills-com-prazo`,
   * então o lote largado volta sozinho; devolver é o que troca "volta quando a
   * reserva vencer" por "volta no ciclo seguinte" no caso de todo dia, que é o
   * deploy (relatório 027 da auditoria de 2026-09-19).
   */
  deveParar?: () => boolean;
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
  /**
   * A **classe** de `lastError`, publicada junto com ele. O painel resume a
   * situação da chave por ela: a mensagem é prosa para o operador, e decidir por
   * pedaço de texto fazia conta sem crédito e IP recusado aparecerem como "chave
   * aceita". `null` com `lastError` preenchido é erro que não veio do provedor —
   * refatiar, gravar — e nada diz sobre a chave.
   */
  lastErrorKind: RagErrorKind | null;
  /**
   * Falso quando não adianta insistir neste ciclo (chave ou configuração) — e
   * quando a parada foi pedida no meio dele (`deveParar`).
   */
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
 * O texto-sonda: fixo, curto e **sem conteúdo de skill**.
 *
 * Serve para uma pergunta só — "este provedor, com esta chave, esta URL e este
 * formato de requisição, aceita alguma coisa?" —, feita antes de gravar uma
 * recusa, que é permanente (`025`). Os três drivers jogam todo 400 residual em
 * `RagInputTooLongError`; um 400 que é da instalação (intermediário na
 * `RAG_<DRIVER>_BASE_URL` que não entende um campo, contrato de API que mudou,
 * erro de conta devolvido como 400) atinge **todo** texto, e sem esta pergunta o
 * acervo inteiro virava "recusado para sempre", 64 textos por ciclo, sem um erro
 * no painel (relatório 025 da auditoria de 2026-09-19).
 *
 * Vai pelo mesmo `embedDocuments` do ciclo — quem fala com o provedor continua
 * sendo só o driver —, e o vetor dele é descartado.
 */
export const TEXTO_SONDA = 'purple-skills: texto-sonda do indexador';

/**
 * As recusas que este processo conhece **e o banco não guardou**, por espaço.
 *
 * Quem tira o texto recusado da fila **de vez** é o banco: `markRagTextRefused`
 * grava a recusa e `listPendingRagTexts` deixa de devolvê-la (`025`). Esta
 * memória é só **a rede de segurança**: a gravação da marca roda dentro do
 * tratamento de um erro e é engolida se falhar (e a porta é opcional), e sem
 * esta lista o texto voltaria no ciclo seguinte para ser pago de novo.
 *
 * Por isso ela guarda **só** a recusa que não chegou ao banco. Guardando todas,
 * como fazia, ela passava por cima do reparo do painel: `clearRagRefusals` apaga
 * as linhas do banco e não alcança este processo, que reservava os textos
 * liberados, os descartava aqui e os segurava por `RESERVA_MS` a cada ciclo —
 * até alguém reiniciar o container.
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
    lastErrorKind: null,
    continuar: true,
    space: null,
  };

  // 0. A migration pode não ter rodado ainda. Esperar é o normal, não um erro.
  if (!(await ports.ragSchemaReady())) {
    ports.log('[indexer] esperando a migration do RAG: tabelas rag_* ainda não existem');
    return { ...resultado, state: 'esperando-migration' };
  }

  // 1. O banco decide o driver, não o ambiente (§5).
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
    // Recusada aqui mesmo, antes de qualquer chamada: a classe é a de um
    // `RagConfigError`, e o painel não conclui nada sobre a chave a partir dela.
    const classe: RagErrorKind = 'config';
    ports.log(`[indexer] configuração recusada: ${mensagem}`);
    await ports.setRagIndexerStatus({
      at: agora().toISOString(),
      driver: driverConfigurado,
      keyPresent: false,
      lastError: mensagem,
      lastErrorKind: classe,
      lastErrorAt: agora().toISOString(),
    });
    return {
      ...resultado,
      state: 'ok',
      erros: 1,
      lastError: mensagem,
      lastErrorKind: classe,
      continuar: false,
    };
  }

  if (driverConfigurado === 'off' || driver === null) {
    const cobertura = await ports.ragCoverage(null);
    await ports.setRagIndexerStatus({
      at: agora().toISOString(),
      driver: driverConfigurado,
      keyPresent,
      ...cobertura,
      // Sem erro até aqui, e dito com todas as letras: estado sem os campos é o
      // que um indexador antigo gravava, e o painel o lê pelo recuo por mensagem.
      ...erroPublicado(resultado, agora),
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
      // `modeloPeloId` lança `RagConfigError`; a classe sai do próprio erro.
      const classe = ragErrorKind(erro);
      ports.log(`[indexer] configuração recusada: ${mensagem}`);
      await ports.setRagIndexerStatus({
        at: agora().toISOString(),
        driver: driverConfigurado,
        keyPresent,
        lastError: mensagem,
        lastErrorKind: classe,
        lastErrorAt: agora().toISOString(),
      });
      return {
        ...resultado,
        state: 'ok',
        erros: 1,
        lastError: mensagem,
        lastErrorKind: classe,
        continuar: false,
      };
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
  //
  // A parada é consultada antes de reservar e **entre** uma skill e outra: a que
  // está em curso termina, e as reservadas que nem começaram voltam à fila agora,
  // em vez de quando a reserva delas vencer. `readSkillForRag` conta uma
  // tentativa a cada leitura, então devolver sem ler também não gasta a conta que
  // decide quando uma skill é "travada".
  if (options.deveParar?.()) return { ...resultado, continuar: false };
  const reservadas = await ports.claimStaleSkills(skillBatch);
  for (const [i, uuid] of reservadas.entries()) {
    if (options.deveParar?.()) {
      const resto = reservadas.slice(i);
      ports.log(`[indexer] parada pedida: devolvendo ${resto.length} skill(s) reservada(s) à fila`);
      await devolverSkills(ports, resto);
      return { ...resultado, continuar: false };
    }
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
      // A skill volta para pendente, e a próxima rodada tenta — **se** o banco
      // ainda responder. Quando não responde (é o caso de o erro ter sido o
      // próprio banco caindo), ela só volta quando a reserva vencer, e isso ao
      // menos aparece no log.
      await devolverSkills(ports, [uuid]);
      resultado.erros += 1;
      resultado.lastError = erro instanceof Error ? erro.message : String(erro);
      // Refatiar não fala com o provedor: este erro não tem classe, e o painel
      // não pode tirar dele conclusão nenhuma sobre a chave.
      resultado.lastErrorKind = null;
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
      ...erroPublicado(resultado, agora),
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
  // de a gravação da recusa ter falhado. O que o filtro descarta **não** é
  // devolvido, de propósito: reservado, ele ocupa a cabeça da fila num ciclo a
  // cada `RESERVA_MS`; devolvido, ocuparia em todos.
  //
  // Parada pedida: nada de reservar um lote para largá-lo em seguida.
  if (options.deveParar?.()) return { ...resultado, continuar: false };
  const reservadoEm = agora().getTime();
  const lidos = await ports.listPendingRagTexts(espaco.uuid, textBatch, {
    reserveMs: RESERVA_MS,
  });
  const pendentes = lidos.filter((t) => !recusas.tem(espaco.uuid, t.sha256));

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
      deveParar: options.deveParar,
      agora,
      reservadoEm,
    });
    // Conta o que foi gravado mesmo quando um lote adiante falhou: era
    // justamente isso que a chamada única jogava fora.
    resultado.textosEmbutidos = embutido.gravados;
    resultado.textosProcessados = embutido.processados;
    tokens = embutido.tokens;
    // Parada pedida entre dois lotes: o que nem saiu já voltou à fila. Coletar
    // órfãos e publicar estado é trabalho de quem vai continuar no ar.
    if (embutido.interrompido) {
      ports.log('[indexer] parada pedida: a etapa de embutir parou entre dois lotes');
      return { ...resultado, continuar: false };
    }
  }

  // 4.1 Coletar os órfãos. Só agora: todo `replaceSkillTexts` desta rodada já
  // commitou, e apagar antes derrubaria a ocorrência que estava sendo gravada.
  await coletarOrfaos(ports, options.orphanBatch ?? ORPHAN_BATCH);

  // 5. Publicar o estado. O painel não recebe a chave: só o indexador sabe se
  // ela existe e se o Google a aceitou.
  const cobertura = await ports.ragCoverage(espaco.uuid);
  // Fila vazia com texto sem vetor que não é recusa: está reservado — pela outra
  // réplica, ou por um indexador que morreu no meio do lote, que é o caso que a
  // devolução não alcança. Sem esta linha o ciclo "vazio" é mudo, e o operador lê
  // silêncio como "terminou".
  const foraDaFila = cobertura.pendingTexts - cobertura.refusedTexts;
  if (lidos.length === 0 && foraDaFila > 0) {
    ports.log(
      `[indexer] ${foraDaFila} textos sem vetor estão reservados e fora da fila; ` +
        `voltam em até ${RESERVA_MS / 60_000} min se ninguém os embutir antes`,
    );
  }
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
    ...erroPublicado(resultado, agora),
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
 * A recusa é permanente, então ela só é gravada **com prova** de que o problema
 * é o conteúdo. Os três drivers jogam todo 400 residual em
 * `RagInputTooLongError`, e um 400 só diz que é *aquele texto* se o provedor, com
 * a mesma chave, URL, modelo e formato, aceita outro. Por isso todo lote recusado
 * passa primeiro pelo texto-sonda: sonda aceita, segue a caça ao culpado; sonda
 * **também** recusada, o problema é da instalação — nada é marcado, o ciclo
 * registra um `RagConfigError` e encerra, e o `--once` sai com 1. A prova vem
 * **depois** do 400 e a cada lote recusado, e não de "já aceitou algo neste
 * ciclo": o 400 sistêmico pode começar no meio dele. Custa uma requisição de
 * poucos tokens por lote recusado, que em regime normal é uma vez por texto
 * venenoso — depois de marcado ele não volta.
 *
 * Erro que **não** é de conteúdo encerra a etapa: o `ClienteHttp` já tentou de
 * novo com recuo antes de chegar aqui, então insistir nos lotes seguintes só
 * queimaria requisição. A rodada seguinte retoma de onde parou: o que foi gravado
 * ficou gravado, e o que não foi — a fatia que falhou **e** os lotes que nem
 * saíram — é devolvido à fila (`devolverReservas`) em vez de ficar reservado por
 * quem já desistiu dele. O mesmo vale para a parada pedida entre dois lotes.
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
  deveParar?: (() => boolean) | undefined;
  agora: () => Date;
  /** O relógio de **antes** da leitura que reservou: a reserva vence daí a `RESERVA_MS`. */
  reservadoEm: number;
}): Promise<{ gravados: number; processados: number; tokens: number; interrompido: boolean }> {
  const { ports, driver, modelo, espacoUuid, pendentes, recusas, resultado, timeoutMs } = entrada;
  let gravados = 0;
  let processados = 0;
  let tokens = 0;
  let inicio = 0;

  // Quem já teve destino neste ciclo: vetor gravado ou recusa marcada. Quando a
  // etapa desiste, todo o resto está reservado à toa e volta para a fila.
  //
  // Menos quando a etapa durou mais que a própria reserva (provedor segurando as
  // chamadas até o prazo, lote após lote): **a reserva não tem dono**, a nossa já
  // venceu sozinha, e o que estiver reservado agora pode ser da réplica vizinha —
  // devolver baixaria a reserva dela, e as duas pagariam pelo mesmo embedding.
  const resolvidos = new Set<RagPendingText>();
  const desistir = async (interrompido: boolean) => {
    if (entrada.agora().getTime() - entrada.reservadoEm < RESERVA_MS) {
      await devolverReservas(
        ports,
        espacoUuid,
        pendentes.filter((t) => !resolvidos.has(t)),
      );
    }
    return { gravados, processados, tokens, interrompido };
  };

  /**
   * O 400 que acabou de chegar é do conteúdo? Pergunta ao provedor com o
   * texto-sonda. `false` já deixa a falha registrada — a da instalação, ou a que
   * derrubou a própria sonda — e, na dúvida, nenhuma marca permanente é gravada.
   */
  const recusaEhDoConteudo = async (recusa: Error): Promise<boolean> => {
    try {
      await driver.embedDocuments(modelo, [TEXTO_SONDA], AbortSignal.timeout(timeoutMs));
      return true;
    } catch (erro) {
      registrarFalha(
        ports,
        resultado,
        erro instanceof RagInputTooLongError
          ? new RagConfigError(
              'o provedor respondeu 400 também ao texto-sonda: o problema não é o conteúdo ' +
                'das skills, é a requisição (intermediário ou endereço em ' +
                'RAG_<DRIVER>_BASE_URL, contrato da API, conta). Nenhum texto foi marcado ' +
                `como recusado. Resposta do provedor: ${recusa.message}`,
            )
          : erro,
      );
      return false;
    }
  };

  for (const grupo of lotes(
    modelo,
    pendentes.map((t) => t.content),
  )) {
    // `lotes` nunca reordena nem descarta: a fatia é a parte da fila que virou
    // este lote, na mesma ordem. É por ela que o vetor casa com o hash certo.
    const fatia = pendentes.slice(inicio, inicio + grupo.length);
    inicio += grupo.length;

    if (entrada.deveParar?.()) return desistir(true);

    try {
      const vetores = await driver.embedDocuments(modelo, grupo, AbortSignal.timeout(timeoutMs));
      gravados += await gravarVetores(ports, espacoUuid, fatia, vetores);
      for (const pendente of fatia) resolvidos.add(pendente);
      processados += fatia.length;
      tokens += estimarTokens(fatia);
      continue;
    } catch (erro) {
      if (!(erro instanceof RagInputTooLongError)) {
        registrarFalha(ports, resultado, erro);
        return desistir(false);
      }
      // Antes de caçar o culpado, a prova de que há um: sem ela, o um a um
      // queimaria uma requisição por texto num erro que não é de texto nenhum, e
      // marcaria todos.
      if (!(await recusaEhDoConteudo(erro))) return desistir(false);
      // Lote de um texto só: o culpado já está identificado, e reenviá-lo seria
      // pagar por um erro garantido.
      if (fatia.length === 1) {
        await marcarRecusado(ports, recusas, espacoUuid, fatia[0]!, erro, resultado);
        resolvidos.add(fatia[0]!);
        continue;
      }
    }

    // Algum texto deste lote o provedor não aceita. Reenviar um por um acha
    // qual — e texto sozinho não deixa o driver dividir o lote outra vez.
    for (const [i, pendente] of fatia.entries()) {
      if (entrada.deveParar?.()) return desistir(true);
      try {
        const vetores = await driver.embedDocuments(
          modelo,
          [grupo[i]!],
          AbortSignal.timeout(timeoutMs),
        );
        gravados += await gravarVetores(ports, espacoUuid, [pendente], vetores);
        resolvidos.add(pendente);
        processados += 1;
        tokens += estimarTokens([pendente]);
      } catch (erro) {
        if (!(erro instanceof RagInputTooLongError)) {
          registrarFalha(ports, resultado, erro);
          return desistir(false);
        }
        await marcarRecusado(ports, recusas, espacoUuid, pendente, erro, resultado);
        resolvidos.add(pendente);
      }
    }
  }

  return { gravados, processados, tokens, interrompido: false };
}

/**
 * Devolve à fila o que o ciclo reservou e não resolveu.
 *
 * Roda dentro do tratamento de outro erro (ou do encerramento): falhar aqui não
 * pode escondê-lo, e a reserva vence sozinha de qualquer jeito — o prazo continua
 * sendo a rede de segurança. Mas a falha vai para o log.
 *
 * Devolve **já**, inclusive no limite de taxa: adiar a volta destes textos não
 * pouparia o provedor — o ciclo seguinte reservaria os textos seguintes e bateria
 * nele do mesmo jeito — e, com a fila toda adiada, o estado publicado voltaria a
 * dizer "sem erro" com o acervo sem vetor. Quem espera o `Retry-After` é o
 * `ClienteHttp`, dentro do prazo da chamada.
 */
async function devolverReservas(
  ports: IndexerPorts,
  espacoUuid: string,
  textos: readonly RagPendingText[],
): Promise<void> {
  if (!ports.releaseRagTextReservations || textos.length === 0) return;
  try {
    const devolvidos = await ports.releaseRagTextReservations(
      espacoUuid,
      textos.map((t) => t.sha256),
    );
    if (devolvidos > 0) {
      ports.log(`[indexer] ${devolvidos} textos devolvidos à fila: voltam no ciclo seguinte`);
    }
  } catch (falha) {
    ports.log(
      `[indexer] não deu para devolver os textos à fila ` +
        `(${falha instanceof Error ? falha.message : String(falha)}); ` +
        `eles voltam sozinhos em até ${RESERVA_MS / 60_000} min`,
    );
  }
}

/**
 * Devolve skills reservadas à fila de refatiar.
 *
 * Não lança, pelo mesmo motivo de `devolverReservas`. A skill que não volta por
 * aqui volta quando a reserva dela vencer (migration `reserva-de-skills-com-prazo`)
 * — nada se perde, mas o log deve a verdade a quem espera vê-la na rodada
 * seguinte. **Era** `.catch(() => {})`, ao lado de um comentário que dizia "nada
 * se perde" quando a devolução tinha acabado de falhar.
 */
async function devolverSkills(ports: IndexerPorts, uuids: readonly string[]): Promise<void> {
  for (const uuid of uuids) {
    try {
      await ports.releaseStaleSkill(uuid);
    } catch (falha) {
      ports.log(
        `[indexer] não deu para devolver a skill ${uuid} à fila ` +
          `(${falha instanceof Error ? falha.message : String(falha)}): ` +
          'ela volta sozinha quando a reserva vencer',
      );
    }
  }
}

/**
 * Os três campos do erro no estado publicado, **sempre juntos**.
 *
 * O painel resume a chave pela classe e mostra a mensagem logo abaixo: classe de
 * um erro com mensagem de outro — ou mensagem sem classe, que ele lê como estado
 * de indexador antigo — faria a tela se desmentir. Todo ponto que publica estado
 * passa por aqui ou escreve os três à mão.
 */
function erroPublicado(
  resultado: CycleResult,
  agora: () => Date,
): { lastError: string | null; lastErrorKind: RagErrorKind | null; lastErrorAt: string | null } {
  return {
    lastError: resultado.lastError,
    lastErrorKind: resultado.lastErrorKind,
    lastErrorAt: resultado.lastError ? agora().toISOString() : null,
  };
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
  // A mensagem é para o operador; a classe é para o painel. `null` quando o erro
  // não é do pacote do RAG — falha ao gravar o vetor, por exemplo.
  resultado.lastErrorKind = ragErrorKind(erro);

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
 * Tira o texto da fila de vez — é o que a §7 promete. Quem chama já tem a prova
 * de que o problema é o conteúdo (o texto-sonda foi aceito depois do 400).
 *
 * A marca vai para o banco (`rag_text_status`), que é o que a faz sobreviver ao
 * reinício do container e valer para todas as réplicas. A lista em memória é a
 * rede de segurança, e por isso só entra nela a recusa que o banco **não**
 * guardou — a porta não existe, ou a gravação falhou: o texto segue fora da fila
 * enquanto o processo viver, e o log diz que a gravação não passou. Engolir a
 * falha é de propósito, porque isto roda dentro do tratamento de outro erro e um
 * segundo erro aqui esconderia o primeiro. A recusa que o banco guardou não fica
 * na memória: quem a desfaz é o reparo do painel (`clearRagRefusals`), e este
 * processo tem de enxergar o texto de volta na fila.
 */
async function marcarRecusado(
  ports: IndexerPorts,
  recusas: RecusasRag,
  espacoUuid: string,
  pendente: RagPendingText,
  erro: Error,
  resultado: CycleResult,
): Promise<void> {
  resultado.textosRecusados += 1;

  // O hash curto é o que permite achar o texto no banco sem despejar no log
  // conteúdo de skill privada.
  const hash = pendente.sha256.toString('hex').slice(0, 12);
  ports.log(
    `[indexer] texto ${hash} (${pendente.content.length} caracteres) recusado pelo provedor; ` +
      `não será tentado de novo: ${erro.message}`,
  );

  let noBanco = false;
  if (ports.markRagTextRefused) {
    try {
      await ports.markRagTextRefused(espacoUuid, pendente.sha256, erro.message);
      noBanco = true;
    } catch (falha) {
      ports.log(
        `[indexer] não deu para marcar o texto ${hash} como recusado no banco: ` +
          `${falha instanceof Error ? falha.message : String(falha)}`,
      );
    }
  }
  if (!noBanco) recusas.marcar(espacoUuid, pendente.sha256);
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
    lastErrorKind: null,
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
    // Parada pedida com a rodada já terminada: não começa outra. Quem chama sabe
    // que houve sinal, e é ele quem decide o código de saída.
    if (options.deveParar?.()) break;
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
