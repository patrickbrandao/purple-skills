/**
 * A busca semântica no painel (`docs/14-rag.md` §5 e §9).
 *
 * O admin é o **único** que semeia a configuração e o único que a edita. Ele
 * também é o único container que **não** recebe a chave da API: quem sabe se
 * ela existe e se o Google a aceitou é o indexador, que publica isso em
 * `rag.indexer.status`. Daí o painel ler o estado do banco em vez de tentar
 * descobrir sozinho.
 *
 * A precedência é a da §5: **o ambiente semeia, o banco decide.** No primeiro
 * boot o valor do ambiente vira linha; dali em diante quem manda é o painel, e
 * um `.env` divergente só gera aviso no log — nunca desfaz pelas costas o que
 * alguém mudou na tela.
 */
import {
  clearRagRefusals,
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
  driverInfo,
  modeloPadraoDe,
  modelosDo,
  readDriverEnv,
  readModelEnv,
  DRIVERS_IMPLEMENTADOS,
  RAG_DRIVERS,
  type RagDriverId,
  type RagErrorKind,
  type RagProviderId,
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
  /**
   * A classe de `lastError` — um `RagErrorKind` do `@purple-skills/rag` —, ou
   * `null` quando o erro não veio do provedor. **Ausente** só no que um indexador
   * anterior a este campo gravou: daí o recuo de `estadoPelaMensagem`. (O estado
   * de driver desligado também vinha sem ele; hoje todo ponto que publica manda
   * mensagem e classe juntas.) É `string` e não o tipo do pacote porque o JSON é
   * de outro container, que pode ser mais novo que este.
   */
  lastErrorKind?: string | null;
  lastErrorAt?: string | null;
};

/**
 * Como o painel resume a situação da chave (§9).
 *
 * `nao-confirmada` é o estado de "houve erro, e ele não fala da chave":
 * provedor fora do ar, prazo, configuração recusada, origem recusada, falha do
 * banco. Antes caía em `presente`, e a tela dizia "aceita pelo provedor" logo
 * acima do erro. `sem-credito` separa a conta que precisa ser paga do limite de
 * taxa, que passa sozinho.
 */
export type RagEstadoChave =
  | 'presente'
  | 'ausente'
  | 'recusada'
  | 'cota-esgotada'
  | 'sem-credito'
  | 'nao-confirmada'
  | 'desconhecido';

export type RagPainel = {
  driver: RagValor;
  model: RagValor;
  /** Opções que o select oferece. */
  drivers: readonly RagDriverId[];
  /** Os modelos do driver **em uso**, que é o que o select de modelo mostra. */
  models: readonly string[];
  /**
   * Um item por driver implementado, com o rótulo e os modelos dele. O painel
   * troca o select de modelo sem ir ao servidor de novo — e sem repetir a
   * lista, que vive uma vez só no registro.
   */
  driverOptions: readonly { id: RagProviderId; label: string; models: readonly string[] }[];
  /** Falso enquanto a migration `020` não rodou. */
  schemaReady: boolean;
  /** `null` enquanto o indexador não criou o espaço. */
  spaceUuid: string | null;
  coverage: RagCoverage | null;
  indexer: RagEstadoIndexador | null;
  keyState: RagEstadoChave;
  /**
   * O aviso da §9, ou `null` quando o driver em uso não o merece.
   *
   * Ele é **do Google**: é lá que o nível gratuito usa o conteúdo enviado para
   * melhorar produtos, com revisores humanos podendo lê-lo. O painel não sabe
   * se a chave é gratuita ou paga, então com o driver `google` ele avisa
   * sempre — errar para o lado de avisar é barato, e o contrário manda
   * conteúdo de skill privada para treinamento sem ninguém ver. OpenAI e
   * Voyage não treinam sobre o tráfego da API, e repetir o aviso neles seria
   * ensinar o operador a ignorá-lo.
   */
  freeTierWarning: string | null;
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
 * do banco, e mais um quando o par driver+modelo **gravado** não combina. Não
 * lança — configuração inválida no ambiente já derrubou o boot antes, na
 * leitura.
 */
export async function semearRag(): Promise<string[]> {
  const avisos: string[] = [];

  // Valor inválido aqui derruba o boot, como manda a convenção do projeto.
  const doAmbiente: Record<RagSettingKey, string | undefined> = {
    'rag.driver': process.env.RAG_DRIVER?.trim() ? readDriverEnv() : undefined,
    'rag.model': process.env.RAG_MODEL?.trim() ? readModelEnv() : undefined,
  };

  const gravadas = await getRagSettings();

  // O driver que **vai valer** depois desta semeadura: o do banco quando o
  // banco já decidiu, o do ambiente só quando é ele quem semeia. A ordem
  // importa — com o ambiente na frente, um `.env` divergente tinha o modelo
  // conferido contra um driver que acabara de ser ignorado, e o par inválido
  // (google + text-embedding-3-large) virava linha. Lixo gravado à mão no banco
  // cai em `off`: sem driver de verdade o modelo não tem efeito nenhum.
  const driverDoBanco = gravadas['rag.driver']?.value ?? null;
  const candidato = driverDoBanco ?? doAmbiente['rag.driver'] ?? 'off';
  const driverQueVale: RagDriverId = ehDriver(candidato) ? candidato : 'off';

  // O modelo do ambiente só pode virar linha se for desse driver. `readModelEnv`
  // já o conferiu contra o driver **do ambiente**; quando os dois drivers
  // diferem, quem não combina é o banco — divergência, não valor inválido.
  const modeloDoAmbiente = doAmbiente['rag.model'];
  const modeloServe =
    modeloDoAmbiente === undefined ||
    driverQueVale === 'off' ||
    modelosDo(driverQueVale).includes(modeloDoAmbiente);

  for (const key of ['rag.driver', 'rag.model'] as const) {
    const dbValue = gravadas[key]?.value ?? null;

    // `!modeloServe` já diz que o driver em vigor é um provedor, não `off`.
    if (key === 'rag.model' && !modeloServe && dbValue === null) {
      // Semear gravaria uma combinação que o indexador recusa a cada ciclo, e a
      // busca cairia para o modo textual até alguém salvar o painel. O banco
      // fica sem linha de modelo, e o padrão do driver continua valendo.
      avisos.push(
        `[rag] RAG_MODEL=${modeloDoAmbiente} ignorada: o banco já define ` +
          `rag.driver=${driverQueVale}, que não tem esse modelo; continua valendo o ` +
          `padrão do driver (${modeloPadraoDe(driverQueVale)}) até alguém escolher o ` +
          'modelo no painel',
      );
      continue;
    }

    const decisao = decideSeed({
      key,
      envValue: doAmbiente[key],
      dbValue,
      // Modelo que não é do driver em vigor, com linha já gravada: é o `.env`
      // antigo de quem trocou tudo no painel. Conferi-lo contra o driver do
      // banco **lançaria**, e o painel deixaria de subir por um `.env` que a
      // §5 manda ignorar — a regra frouxa deixa a comparação virar o aviso.
      driver: modeloServe ? driverQueVale : 'off',
    });

    if (decisao.action === 'gravar') {
      // O ator é `ambiente`: não é conta, como o bootstrap do primeiro admin.
      await seedRagSetting(key, decisao.value, 'web-admin');
    } else if (decisao.action === 'avisar') {
      avisos.push(decisao.warning);
    }
  }

  // Quem passou pelo defeito acima antes da correção ficou com o par inválido
  // **gravado**, e semeadura nunca sobrescreve linha. Aviso, nunca conserto
  // automático: quem decide o modelo é quem opera o painel.
  const modeloDoBanco = gravadas['rag.model']?.value ?? null;
  if (
    driverDoBanco !== null &&
    ehDriver(driverDoBanco) &&
    modeloDoBanco !== null &&
    !modelosDo(driverDoBanco).includes(modeloDoBanco)
  ) {
    avisos.push(
      `[rag] rag.model=${modeloDoBanco} não é modelo de rag.driver=${driverDoBanco}: o ` +
        'indexador recusa a configuração e a busca responde só em modo textual. Escolha o ' +
        'modelo em Configurações → Busca semântica e salve',
    );
  }

  return avisos;
}

/** Monta tudo que a tela mostra. */
export async function lerPainelRag(): Promise<RagPainel> {
  const gravadas = await getRagSettings();
  const schemaReady = await ragSchemaReady().catch(() => false);

  const { driver, model, espaco } = parEmUso(gravadas);
  const emUso = ehDriver(driver.value) ? driver.value : null;

  const indexer = lerEstado(gravadas['rag.indexer.status']?.value ?? null);

  // O espaço só existe depois do primeiro ciclo do indexador, e ele é o do par
  // driver+modelo em uso: trocar qualquer um dos dois aponta para outro espaço,
  // com a cobertura dele — os vetores do anterior continuam onde estavam.
  let spaceUuid: string | null = null;
  if (schemaReady && espaco !== null) {
    spaceUuid = (await findRagSpace(espaco).catch(() => null))?.uuid ?? null;
  }

  const coverage = schemaReady ? await ragCoverage(spaceUuid).catch(() => null) : null;

  return {
    driver,
    model,
    drivers: ['off', ...DRIVERS_IMPLEMENTADOS],
    models: modelosDo(emUso ?? 'google'),
    driverOptions: RAG_DRIVERS.map((d) => ({
      id: d.id,
      label: d.label,
      models: d.models.map((m) => m.id),
    })),
    schemaReady,
    spaceUuid,
    coverage,
    indexer,
    keyState: estadoDaChave(indexer),
    freeTierWarning: emUso === 'google' ? AVISO_NIVEL_GRATUITO : null,
  };
}

/** Grava o que o painel mandou. Audita `rag.settings`. */
export async function gravarRag(
  actor: AuditActor,
  body: { driver?: unknown; model?: unknown },
): Promise<RagPainel> {
  const mudancas: [RagSettingKey, string][] = [];
  const gravadas = await getRagSettings();

  let driver: RagDriverId = (gravadas['rag.driver']?.value ?? 'off') as RagDriverId;

  if (body.driver !== undefined) {
    const valor = String(body.driver);
    if (valor !== 'off' && !ehDriver(valor)) {
      const aceitos = ['off', ...DRIVERS_IMPLEMENTADOS].map((d) => `"${d}"`).join(', ');
      throw badRequest(`Driver inválido: "${valor}". Use ${aceitos}.`);
    }
    driver = valor as RagDriverId;
    mudancas.push(['rag.driver', valor]);
  }

  if (body.model !== undefined) {
    const valor = String(body.model);
    const aceitos = modelosDo(driver);
    if (driver !== 'off' && !aceitos.includes(valor)) {
      throw badRequest(
        `Modelo inválido: "${valor}". O driver "${driver}" aceita ${aceitos.join(', ')}.`,
      );
    }
    mudancas.push(['rag.model', valor]);
  } else if (driver !== 'off' && !modelosDo(driver).includes(gravadas['rag.model']?.value ?? '')) {
    // Trocar de driver sem dizer o modelo deixaria gravado um modelo que o
    // driver novo não conhece, e o indexador recusaria a configuração. O
    // padrão do driver escolhido é a única resposta que não quebra nada.
    mudancas.push(['rag.model', modeloPadraoDe(driver)]);
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

/**
 * Desfaz as recusas do espaço **em uso**: no ciclo seguinte do indexador os
 * textos voltam à fila. É o reparo de quando a marca foi gravada por engano — um
 * 400 que era da instalação (intermediário na URL base, contrato da API, conta),
 * e não do conteúdo. O indexador hoje confere isso com o texto-sonda antes de
 * marcar; este gesto é para o que já estava marcado, e para o que ele não pega.
 *
 * **Não** é o "Reindexar", e não foi embutido nele de propósito: reindexar é de
 * graça por contrato (§9), e isto custa requisições — o que for recusa genuína é
 * recusado uma vez mais e remarcado. A recusa continua sem prazo e intocada por
 * qualquer gravação automática; o que existe aqui é um ato de administrador,
 * auditado pelo banco como `rag.reindex` com `"<n> recusas"`.
 *
 * O espaço é o do par driver+modelo que a tela mostra, o mesmo de onde sai a
 * contagem ao lado do botão. Diferente da tela, a falha ao procurá-lo **não** é
 * engolida: responder "não há espaço" com o banco fora do ar seria mentir.
 */
export async function limparRecusasRag(actor: AuditActor): Promise<{ refusals: number }> {
  if (!(await ragSchemaReady())) {
    throw conflict('A migration do RAG ainda não foi aplicada nesta instalação.');
  }
  const { espaco } = parEmUso(await getRagSettings());
  const achado = espaco === null ? null : await findRagSpace(espaco);
  if (achado === null) {
    throw conflict(
      'Não há espaço de embedding em uso: a busca semântica está desligada, ou o ' +
        'indexador ainda não rodou com o driver e o modelo escolhidos.',
    );
  }
  return { refusals: await clearRagRefusals(achado.uuid, 'web-admin', actor) };
}

// ------------------------------------------------------------ auxiliares ---

/** O valor é um driver de verdade, e não `off` nem lixo gravado à mão? */
function ehDriver(valor: string): valor is RagProviderId {
  return (DRIVERS_IMPLEMENTADOS as readonly string[]).includes(valor);
}

/**
 * O par driver+modelo **em uso**, como a tela o mostra, e a identidade do espaço
 * dele — `null` com a busca desligada, com driver que este binário não conhece ou
 * com modelo que não é do driver. Uma função só para a tela e para o reparo das
 * recusas: os dois têm de falar do mesmo espaço.
 */
function parEmUso(gravadas: Awaited<ReturnType<typeof getRagSettings>>): {
  driver: RagValor;
  model: RagValor;
  espaco: Parameters<typeof findRagSpace>[0] | null;
} {
  const driver = valor('rag.driver', gravadas, process.env.RAG_DRIVER, 'off');
  const emUso = ehDriver(driver.value) ? driver.value : null;
  const model = valor(
    'rag.model',
    gravadas,
    process.env.RAG_MODEL,
    modeloPadraoDe(emUso ?? 'google'),
    // Sem linha no banco, o `RAG_MODEL` só vale se for do driver em uso — é a
    // mesma regra da semeadura, que não o grava quando não é.
    (doAmbiente) => emUso === null || modelosDo(emUso).includes(doAmbiente),
  );

  const modelo =
    emUso === null ? undefined : driverInfo(emUso).models.find((m) => m.id === model.value);
  const espaco =
    emUso === null || modelo === undefined
      ? null
      : {
          driver: emUso,
          model: modelo.id,
          dimensions: modelo.dimensions,
          documentPrefix: modelo.documentPrefix,
          queryPrefix: modelo.queryPrefix,
        };
  return { driver, model, espaco };
}

function valor(
  key: 'rag.driver' | 'rag.model',
  gravadas: Awaited<ReturnType<typeof getRagSettings>>,
  ambiente: string | undefined,
  padrao: string,
  /** O valor do ambiente pode valer? Omitido, pode sempre. */
  ambienteServe: (doAmbiente: string) => boolean = () => true,
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

  if (doAmbiente && !ambienteServe(doAmbiente)) {
    // O indexador e a busca estão no padrão do driver: mostrar o `RAG_MODEL`
    // como valor em uso apontaria a tela para um espaço que ninguém preenche.
    return { value: padrao, origem: 'padrão', updatedAt: null, ambienteIgnorado: doAmbiente };
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
 * O que cada classe de erro diz sobre a chave. É `Record` sobre o vocabulário
 * do pacote de propósito: classe nova em `RagErrorKind` deixa de compilar aqui
 * até alguém decidir o que o painel mostra para ela.
 */
const ESTADO_POR_CLASSE: Record<RagErrorKind, RagEstadoChave> = {
  auth: 'recusada',
  quota: 'sem-credito',
  'rate-limit': 'cota-esgotada',
  // Daqui para baixo houve erro, e ele não fala da chave. Afirmar que o
  // provedor a aceitou seria inventar uma confirmação que o ciclo não deu — e
  // dizer "recusada" na origem recusada faria o operador trocar uma chave boa.
  origin: 'nao-confirmada',
  config: 'nao-confirmada',
  'input-too-long': 'nao-confirmada',
  unavailable: 'nao-confirmada',
  timeout: 'nao-confirmada',
};

/**
 * Resume a chave a partir do que o indexador publicou.
 *
 * `desconhecido` é o estado honesto de quando o indexador nunca rodou: o painel
 * não recebe a chave e não tem como saber sozinho.
 *
 * O estado sai da **classe** do erro (`lastErrorKind`), não da mensagem: a
 * mensagem é prosa para o operador, e renomeá-la não pode mudar a tela. O que
 * este resumo devolve é uma classificação — o valor da chave nunca chega aqui.
 */
function estadoDaChave(estado: RagEstadoIndexador | null): RagEstadoChave {
  if (estado === null) return 'desconhecido';
  if (estado.keyPresent === false) return 'ausente';

  // Estado sem o campo: o que um indexador anterior a `lastErrorKind` deixou
  // gravado (inclusive o de driver desligado, que não levava erro nenhum) — a
  // linha sobrevive ao deploy, e a tela não pode quebrar, nem mentir, diante dela.
  if (estado.lastErrorKind === undefined) return estadoPelaMensagem(estado);

  if (estado.lastErrorKind !== null) {
    // Classe que este painel não conhece (indexador mais novo): houve erro, e
    // não dá para dizer o que ele significa para a chave.
    return Object.hasOwn(ESTADO_POR_CLASSE, estado.lastErrorKind)
      ? ESTADO_POR_CLASSE[estado.lastErrorKind as RagErrorKind]
      : 'nao-confirmada';
  }

  // Sem classe: ou não houve erro, ou ele não veio do provedor (refatiar,
  // gravar o vetor) — e aí o ciclo não confirmou nada.
  if (!estado.keyPresent) return 'desconhecido';
  return estado.lastError ? 'nao-confirmada' : 'presente';
}

/**
 * O recuo para o estado **sem** `lastErrorKind`: com erro, só um indexador
 * antigo o grava. As três buscas por pedaço de texto são as de antes, e servem
 * porque a redação daquelas versões não muda mais; o que mudou é o fim — erro
 * que elas não reconhecem deixa de virar "chave aceita".
 */
function estadoPelaMensagem(estado: RagEstadoIndexador): RagEstadoChave {
  const erro = (estado.lastError ?? '').toLowerCase();
  if (erro === '') return estado.keyPresent ? 'presente' : 'desconhecido';
  if (erro.includes('recusou a chave') || erro.includes('api_key_invalid')) return 'recusada';
  if (erro.includes('cota') || erro.includes('resource_exhausted') || erro.includes('limite de taxa')) {
    return 'cota-esgotada';
  }
  return estado.keyPresent ? 'nao-confirmada' : 'desconhecido';
}
