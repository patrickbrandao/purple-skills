/**
 * A tela de Atividade do painel (`docs/18-atividade.md`): a série que o mapa
 * de dias pinta e o relatório agregado de um deles.
 *
 * Esta camada existe por causa de uma assimetria: **o dia é o do calendário de
 * quem olha, e o banco só entende instante.** Quem converte um no outro é o
 * painel, com o mesmo `inicioDoDia`/`auditRange` que a trilha já usa
 * (`apps/admin/web/src/audit.ts`), porque só o navegador sabe o fuso de quem
 * abriu a tela. Aqui os instantes chegam prontos em `since`/`until`; o nome do
 * fuso viaja junto para duas coisas, e só duas: recortar os dias da série no
 * SQL (`AT TIME ZONE`, dentro de `listActivityDays`) e dizer, no corpo, que
 * dias a faixa consultada representa.
 *
 * A regra do que falta é uma só: **sem `since`/`until`, o relatório deriva a
 * faixa do próprio dia do caminho, no fuso informado** — do primeiro instante
 * do dia ao último milissegundo dele, inclusivo nas duas pontas, como o `<=`
 * do banco e como o `auditRange` do painel. A série não deriva nada: uma faixa
 * escolhida aqui sairia no fuso do servidor e pintaria dias que ninguém pediu,
 * e é justamente a coerência entre o dia pintado e o dia relatado que a tela
 * promete.
 *
 * Nada do que sai daqui identifica uma operação: o corpo é agregado e a menor
 * unidade é "quantas vezes" (decisão 4). Em compensação ele soma a instalação
 * inteira, o que faz das duas rotas rotas de admin (decisão 1, em `api.ts`).
 */
import { ACTIVITY_RANGE_MAX_DAYS, activityOfDay, badRequest, listActivityDays } from '@purple-skills/db';
import type { ActivityReport, ActivitySeries } from '@purple-skills/shared';
import type { AuthUser } from './auth.js';

const DIA_MS = 86_400_000;
const DIA_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Teto do que uma mensagem de erro ecoa de volta — o fuso vem de fora. */
const FUSO_MAX = 64;

/**
 * Nome de fuso começa por letra. É o que recusa deslocamento cru (`+05:45`),
 * que o `Intl` aceita desde o ES2022 e o Postgres **não** — `listActivityDays`
 * o barra de propósito, porque a convenção de sinal dele difere da do ISO em
 * algumas formas. Sem esta linha, a grade responderia 400 e o relatório do
 * mesmo dia responderia 200 com outro recorte: as duas rotas precisam falar o
 * mesmo vocabulário, e quem manda nele é a tzdata, não um deslocamento avulso.
 */
const FUSO_RE = /^[A-Za-z]/;

/** Texto não vazio da query string; repetido (array) e aninhado (objeto) valem ausente, como em `/api/audit`. */
const texto = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/**
 * Um inteiro da query string. Terceiro gêmeo do `asInt` de `api.ts` e de
 * `apps/site/src/api.ts`, e pela mesma razão: `Number(req.query.top)` cru
 * devolve `NaN` para lixo e para valor repetido, e o `clamp` do banco lê `NaN`
 * como o **mínimo** — cada lista do relatório voltaria com uma linha só
 * (relatório 086 da auditoria de 2026-09-19).
 */
function asInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Um instante da query string. Molde do `date()` de `/api/audit`: ausente é
 * `undefined` e o que não é data é 400 com o nome do campo — `new Date('hoje')`
 * é `Invalid Date`, e um `Invalid Date` chegando ao `timestamptz` é 500 do
 * driver onde o erro é de quem chamou.
 */
function instante(query: Record<string, unknown>, key: string): Date | undefined {
  const raw = texto(query[key]);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw badRequest(`"${key}" precisa ser uma data válida`);
  return parsed;
}

/**
 * Teto de formatadores guardados ao mesmo tempo.
 *
 * O mapa **não** é limitado pelos ~600 nomes da base IANA, como já se supôs
 * aqui: guardado pela grafia crua, `America/Sao_Paulo`, `america/sao_paulo`,
 * `AMERICA/SAO_PAULO` e `aMeRiCa/sAo_PaUlO` viram quatro entradas para um fuso
 * só, e um cliente autenticado que varie a caixa a cada requisição faz o mapa
 * crescer sem teto no processo do painel — a rota é de admin, mas admin também
 * erra e script também repete. A caixa baixa na chave (em `formatador`) fecha
 * esse caminho; o teto fecha o resto, e é o mesmo remédio do
 * `MAX_STATELESS_ENTRIES` de `apps/mcp-public/src/sessions.ts`, contra o mesmo
 * tipo de crescimento por texto de terceiro.
 *
 * 64 é folga larga para o que existe: um painel vê os fusos de quem o abre, e
 * são poucos. Atingido, a entrada **mais antiga por inserção** sai (o `Map`
 * itera na ordem em que entrou) — não é LRU e não precisa ser: o preço de
 * descartar errado é remontar um `Intl.DateTimeFormat`, nunca uma resposta
 * errada.
 *
 * Exportado para o teste medir o teto sem repetir o número aqui — mudar o valor
 * muda a medida junto, como `ACTIVITY_RANGE_MAX_DAYS` faz com a saturação.
 */
export const FUSOS_MAX = 64;

/**
 * Um formatador por fuso, guardado por processo: montar um `Intl.DateTimeFormat`
 * custa bem mais que formatar com ele, e derivar um dia formata até seis vezes.
 * Lixo não chega aqui, porque `fusoDe` o recusa antes de haver entrada — o que
 * chega, e o que `FUSOS_MAX` contém, é o mesmo fuso escrito de muitas formas.
 */
const formatadores = new Map<string, Intl.DateTimeFormat>();

function formatador(tz: string): Intl.DateTimeFormat {
  // A chave é a caixa baixa, e o `timeZone` do formatador é a grafia que veio:
  // `Intl` e `AT TIME ZONE` casam o nome sem olhar a caixa, então as duas
  // grafias dão o mesmo recorte e uma entrada só basta. Baixar a caixa não junta
  // fusos diferentes — a base IANA não tem dois nomes que difiram só nela.
  const chave = tz.toLowerCase();
  const pronto = formatadores.get(chave);
  if (pronto) return pronto;
  // `hourCycle: 'h23'` e não `hour12: false`: com ICU antigo o segundo devolve
  // "24" na meia-noite, e 24 h somadas ao campo dariam o dia seguinte.
  const novo = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  // O descarte vem antes da inserção, e só quando o mapa está cheio: assim o
  // tamanho nunca passa de `FUSOS_MAX`, nem por uma entrada.
  if (formatadores.size >= FUSOS_MAX) {
    const antiga = formatadores.keys().next().value;
    if (antiga !== undefined) formatadores.delete(antiga);
  }
  formatadores.set(chave, novo);
  return novo;
}

/**
 * O fuso pedido, conferido **aqui** antes de virar `Intl` ou SQL. Ausente é `'UTC'`.
 *
 * São dois portões, de duas tzdatas diferentes, e nenhum substitui o outro: a
 * do Postgres é quem recorta os dias da série, e `listActivityDays` a confere
 * contra o `pg_timezone_names`; a do Node é quem converte o dia do relatório em
 * instantes e formata a faixa de volta — e `activityOfDay` nem recebe fuso, de
 * modo que ninguém conferiria este. Sem o portão daqui, um `?tz=Marte/Olympus`
 * no relatório estouraria `RangeError` dentro do `Intl` e sairia como 500, que é
 * exatamente o que esta camada existe para evitar.
 *
 * A mensagem é diferente da do banco ("desconhecido") de propósito: as duas
 * saem no mesmo campo, e é o texto que diz qual das duas tzdatas recusou.
 *
 * **O que sai daqui é a grafia que o cliente mandou**, aparada — não a canônica
 * que o `Intl` resolveria. É ela que vai ao SQL (`AT TIME ZONE`, que ignora a
 * caixa) e ao `timezone` do corpo. A canônica seria tentadora para embelezar o
 * eco, mas `resolvedOptions().timeZone` também troca apelido por nome primário
 * (`Asia/Calcutta` → `Asia/Kolkata`) e faz isso de um jeito que depende da
 * versão do ICU: o corpo passaria a variar com o Node que roda a imagem, e o
 * banco receberia um nome que quem perguntou não escreveu — quem canoniza é a
 * tzdata, não esta camada. A caixa baixa fica só na chave do cache de
 * formatadores, que ninguém lê de fora.
 */
function fusoDe(value: unknown): string {
  const tz = texto(value) ?? 'UTC';
  const recusa = (): Error => badRequest(`Fuso horário inválido: ${tz.slice(0, FUSO_MAX)}`);
  if (!FUSO_RE.test(tz)) throw recusa();
  try {
    formatador(tz);
  } catch {
    throw recusa();
  }
  return tz;
}

type Campos = { ano: number; mes: number; dia: number; hora: number; minuto: number; segundo: number };

/** Os campos do relógio de um fuso naquele instante. */
function camposEm(tz: string, quando: Date): Campos {
  const partes = formatador(tz).formatToParts(quando);
  const num = (type: Intl.DateTimeFormatPartTypes): number => Number(partes.find((parte) => parte.type === type)?.value);
  return {
    ano: num('year'),
    mes: num('month'),
    dia: num('day'),
    hora: num('hour'),
    minuto: num('minute'),
    segundo: num('second'),
  };
}

const dois = (valor: number): string => String(valor).padStart(2, '0');

/** O dia de calendário em que um instante cai, no fuso dado, em `AAAA-MM-DD`. */
function diaEm(tz: string, quando: Date): string {
  const campos = camposEm(tz, quando);
  return `${String(campos.ano).padStart(4, '0')}-${dois(campos.mes)}-${dois(campos.dia)}`;
}

/**
 * O `AAAA-MM-DD` do caminho, se ele existir no calendário.
 *
 * `setUTCFullYear`, e não `Date.UTC(ano, …)`, pelo mesmo motivo do
 * `inicioDoDia` do painel: ano com menos de três dígitos é lido como 19xx. A
 * leitura de volta é o que pega `2026-02-31`, que o construtor aceita em
 * silêncio como 3 de março.
 */
function diaDoCalendario(value: string): { ano: number; mes: number; dia: number } | null {
  if (!DIA_RE.test(value)) return null;
  const ano = Number(value.slice(0, 4));
  const mes = Number(value.slice(5, 7));
  const dia = Number(value.slice(8, 10));
  const quando = new Date(0);
  quando.setUTCFullYear(ano, mes - 1, dia);
  quando.setUTCHours(0, 0, 0, 0);
  if (quando.getUTCFullYear() !== ano || quando.getUTCMonth() !== mes - 1 || quando.getUTCDate() !== dia) return null;
  return { ano, mes, dia };
}

/** A meia-noite do dia lida como se fosse UTC — o palpite de onde o dia começa. */
function palpiteDe(campos: { ano: number; mes: number; dia: number }, dias: number): number {
  const quando = new Date(0);
  quando.setUTCFullYear(campos.ano, campos.mes - 1, campos.dia + dias);
  quando.setUTCHours(0, 0, 0, 0);
  return quando.getTime();
}

/** Quanto o relógio do fuso adianta o UTC naquele instante, em ms. */
function deslocamento(tz: string, quando: number): number {
  const c = camposEm(tz, new Date(quando));
  return Date.UTC(c.ano, c.mes - 1, c.dia, c.hora, c.minuto, c.segundo) - Math.floor(quando / 1000) * 1000;
}

/**
 * O primeiro instante do dia no fuso dado, andando `dias` no calendário — o
 * gêmeo, deste lado, do `inicioDoDia` do painel, que trabalha no fuso do
 * navegador e por isso resolve tudo com `setHours`.
 *
 * Aqui o fuso é argumento, e o `Intl` só sabe ir de instante para relógio; a
 * volta é por tentativa. Do palpite saem dois candidatos, um por deslocamento
 * medido (o do próprio palpite e o do primeiro candidato) — num dia comum eles
 * são o mesmo instante. Na virada do horário de verão diferem, e vale o menor
 * **entre os que caem no dia pedido**: onde a meia-noite não existe (o relógio
 * pula de 23:59 para 01:00) o dia começa no salto; onde ela acontece duas vezes,
 * vale a primeira. É a escolha que o `Date` do JS faz, e é o que mantém o
 * servidor e o painel de acordo em vez de discordarem por uma hora.
 *
 * Fuso que engoliu o dia inteiro (aconteceu em `Pacific/Apia`, em 2011) não tem
 * candidato: fica o palpite, a faixa sai vazia — que é o que de fato houve.
 */
function inicioDoDia(tz: string, campos: { ano: number; mes: number; dia: number }, dias = 0): Date {
  const palpite = palpiteDe(campos, dias);
  const alvo = diaEm('UTC', new Date(palpite));
  const primeiro = palpite - deslocamento(tz, palpite);
  const segundo = palpite - deslocamento(tz, primeiro);
  const candidatos = [primeiro, segundo].filter((quando) => diaEm(tz, new Date(quando)) === alvo);
  return new Date(candidatos.length ? Math.min(...candidatos) : palpite);
}

/**
 * A faixa que o banco vai mesmo ler. `listActivityDays` satura em
 * `ACTIVITY_RANGE_MAX_DAYS` **sem erro** — quem pede dez anos recebe os últimos
 * 400 dias —, e o corpo da série diz qual faixa foi consultada: repetir a conta
 * aqui é o que impede o `since` do corpo de prometer um dia que não foi lido. A
 * constante vem do banco de propósito; mudar o teto lá muda esta conta junto.
 */
function saturada(since: Date, until: Date): { since: Date; until: Date } {
  const teto = ACTIVITY_RANGE_MAX_DAYS * DIA_MS;
  if (until.getTime() - since.getTime() <= teto) return { since, until };
  return { since: new Date(until.getTime() - teto), until };
}

/**
 * A série do mapa de dias. `_user` fica na assinatura porque é a forma de toda
 * camada de app daqui, mas não recorta nada: na v1 a tela é da instalação
 * inteira e quem a fecha é o `requireAdmin` da rota (decisão 1).
 *
 * `since`/`until` são obrigatórios e chegam como instante. A mensagem de falta
 * é daqui, e não a do banco, porque o corpo devolve a faixa consultada: sem os
 * dois não há o que responder, nem antes nem depois da consulta.
 */
export async function series(_user: AuthUser, query: Record<string, unknown>): Promise<ActivitySeries> {
  const timezone = fusoDe(query.tz);
  const since = instante(query, 'since');
  const until = instante(query, 'until');
  if (!since || !until) {
    throw badRequest('Informe "since" e "until": a faixa é o calendário de quem olha, e o servidor não o adivinha');
  }
  const faixa = saturada(since, until);
  // A consulta primeiro: faixa invertida e fuso que o Postgres não conhece são
  // 400 dele, e formatar antes esconderia o erro atrás de um corpo plausível.
  const days = await listActivityDays({ ...faixa, timezone });
  return { days, since: diaEm(timezone, faixa.since), until: diaEm(timezone, faixa.until), timezone };
}

/**
 * O relatório de um dia. `day` e `timezone` são preenchidos aqui — o banco não
 * os reinventa, porque quem sabe que dia foi pedido é quem perguntou.
 *
 * `top` só viaja quando veio um inteiro: ausente e lixo ficam de fora para que
 * o padrão (e o teto) continuem sendo os do banco. Repetir o número aqui o
 * deixaria mentir no dia em que ele mudasse lá.
 */
export async function report(_user: AuthUser, day: string, query: Record<string, unknown>): Promise<ActivityReport> {
  const timezone = fusoDe(query.tz);
  const campos = diaDoCalendario(day);
  if (!campos) throw badRequest(`"${day}" precisa ser um dia no formato AAAA-MM-DD`);

  // O último milissegundo do dia, e não a meia-noite seguinte: o banco compara
  // com `<=`, então a borda de cima entraria no dia de trás (`auditRange`).
  const since = instante(query, 'since') ?? inicioDoDia(timezone, campos);
  const until = instante(query, 'until') ?? new Date(inicioDoDia(timezone, campos, 1).getTime() - 1);
  const top = asInt(query.top, Number.NaN);

  const corpo = await activityOfDay({ since, until, ...(Number.isNaN(top) ? {} : { top }) });
  return { day, timezone, ...corpo };
}
