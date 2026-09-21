import { auditRange, inicioDoDia } from './audit.js';
import type { ActivityDay } from './api.js';

/* ============================================================
   A GRADE DA TELA DE ATIVIDADE (`docs/18-atividade.md`)

   Tudo o que dá para provar sem DOM mora aqui, e não no
   componente: a grade de semanas, os rótulos de mês, o nível de
   cor de cada dia e a conversão dia→instante. É a mesma razão de
   `components/shell/routes.ts` existir separado — os testes do
   painel rodam em `environment: 'node'`, sem navegador.

   A convenção de data é UMA só, a mesma da trilha: **o dia do
   calendário de quem olha**. O passo de um dia vem de
   `inicioDoDia` (`audit.ts`) e a borda da janela, de
   `auditRange`; nada aqui constrói data por texto nem por soma de
   24 h. `new Date('AAAA-MM-DD')` é meia-noite UTC, há dia de 23 e
   de 25 horas, e o par "data crua + data com hora" já abriu uma
   janela de 27 horas na Auditoria (`tasks/044`). Reimplementar o
   passo aqui seria reabrir aquele defeito numa segunda tela.
   ============================================================ */

/** Os meses como o topo da grade os escreve — curtos, porque a coluna tem 15px. */
const MES_CURTO = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** Os dias da semana, de domingo a sábado — a ordem das 7 linhas da grade. */
export const ACTIVITY_WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/**
 * Quais linhas levam rótulo à esquerda: segunda, quarta e sexta. São as M/W/F
 * da referência — uma a cada duas linhas, que é o que cabe em 15px de altura
 * sem os nomes se encostarem.
 */
export const ACTIVITY_WEEKDAY_LABELS: readonly number[] = [1, 3, 5];

/**
 * Distância mínima, em colunas, entre dois rótulos de mês.
 *
 * Um rótulo ("set") ocupa mais que uma célula de 13px; dois a uma ou duas
 * colunas um do outro se sobrepõem. Três colunas são ~45px, folga suficiente.
 */
const MIN_COLUNAS_ENTRE_MESES = 3;

const dois = (valor: number) => String(valor).padStart(2, '0');

/** O `AAAA-MM-DD` de uma data, pelos campos **locais** — é assim que o dia de quem olha é nomeado. */
export const dayKey = (data: Date): string =>
  `${String(data.getFullYear()).padStart(4, '0')}-${dois(data.getMonth() + 1)}-${dois(data.getDate())}`;

/** Hoje, no calendário de quem olha. */
export const todayKey = (agora: Date = new Date()): string => dayKey(agora);

/**
 * O último dia de um mês, em UTC — aqui o UTC é só aritmética de calendário,
 * não fuso: nenhuma hora local entra na conta, então não há dia de 23 horas
 * para atrapalhar. `mes` pode sair de 0..11 (o `setUTCFullYear` rola o ano), e
 * o `new Date(0)` antes dele evita a armadilha de `Date.UTC`, que lê ano < 100
 * como 19xx.
 */
function ultimoDiaDoMes(ano: number, mes: number): number {
  const fim = new Date(0);
  fim.setUTCFullYear(ano, mes + 1, 0);
  return fim.getUTCDate();
}

/**
 * O mesmo dia do mês, `meses` adiante ou atrás, no calendário de quem olha.
 *
 * O dia é **aparado** para o último do mês alvo: 31 de março menos um mês é 28
 * (ou 29) de fevereiro, e não 2 ou 3 de março, que é o que a rolagem natural
 * do `Date` daria — a janela de "6 meses" pularia um dia de propriedade de
 * ninguém uma vez por ano.
 */
function somaMeses(valor: string, meses: number): string | null {
  const base = inicioDoDia(valor);
  if (!base) return null;
  const ano = base.getFullYear();
  const mes = base.getMonth() + meses;
  const alvo = new Date(0);
  alvo.setFullYear(ano, mes, Math.min(base.getDate(), ultimoDiaDoMes(ano, mes)));
  alvo.setHours(0, 0, 0, 0);
  return dayKey(alvo);
}

/**
 * O fuso IANA de quem olha, para o `tz` da consulta da série.
 *
 * Devolve `undefined` — e não um fuso inventado — quando o ambiente não o
 * resolve: aí o servidor decide, e a grade sai no padrão dele. Chutar `UTC`
 * seria pior que não dizer nada, porque calaria a divergência. O resolvedor é
 * parâmetro só para o teste poder simular o ambiente sem `Intl` completo.
 */
export function viewerTimeZone(
  resolver: () => string | undefined = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): string | undefined {
  try {
    const fuso = resolver();
    return typeof fuso === 'string' && fuso.trim() !== '' ? fuso : undefined;
  } catch {
    // Ambiente sem `Intl.DateTimeFormat` utilizável: some com o `tz` da query.
    return undefined;
  }
}

/** As janelas que o seletor da página oferece; a primeira é a padrão. */
export const ACTIVITY_WINDOWS = [
  { key: '12m', label: '12 meses', months: 12 },
  { key: '6m', label: '6 meses', months: 6 },
  { key: '3m', label: '3 meses', months: 3 },
] as const;

export type ActivityWindowKey = (typeof ACTIVITY_WINDOWS)[number]['key'];

export const isActivityWindow = (valor: unknown): valor is ActivityWindowKey =>
  ACTIVITY_WINDOWS.some((janela) => janela.key === valor);

/**
 * A faixa da grade, em dias do calendário de quem olha.
 *
 * "12 meses" é uma janela **fechada** de um ano: começa no dia seguinte ao
 * mesmo dia do ano passado, senão a grade traria 366 dias e o 21/09 apareceria
 * duas vezes.
 */
export function activityRange(janela: ActivityWindowKey, hoje: string = todayKey()): { since: string; until: string } {
  const meses = ACTIVITY_WINDOWS.find((item) => item.key === janela)?.months ?? ACTIVITY_WINDOWS[0].months;
  const recuado = somaMeses(hoje, -meses);
  const inicio = recuado ? inicioDoDia(recuado, 1) : null;
  return { since: inicio ? dayKey(inicio) : hoje, until: hoje };
}

/**
 * Os dois dias viram os instantes que a API compara — é o `auditRange` da
 * trilha, sem cópia: a regra de borda (o `until` é o último milissegundo do
 * dia, pelo calendário) é a mesma, e ter uma só é o que mantém os números
 * desta tela fechando com os de lá.
 */
export const activityInstants = (since: string, until: string): { since?: string; until?: string } =>
  auditRange(since, until);

export type ActivityLevel = 0 | 1 | 2 | 3 | 4;

/**
 * A régua de cor do período: os totais dos dias **com** atividade, em ordem.
 *
 * Não há faixa fixa de valor absoluto, de propósito: uma instalação com 30
 * chamadas por dia e outra com 30 000 têm de render heatmaps igualmente
 * legíveis, e qualquer corte em número redondo pintaria a primeira toda de
 * nível 1 e a segunda toda de nível 4. O nível é a **posição** do dia entre os
 * dias ativos — um quartil —, o que dispensa média, desvio e divisão por
 * contagem que possa ser zero.
 */
export type ActivityScale = {
  /** Os totais positivos do período, crescentes e com repetição — a ordem é a régua. */
  ranked: number[];
  /** Todos os dias ativos têm o mesmo total (ou não há nenhum): não há o que ordenar. */
  uniforme: boolean;
};

export function activityScale(totais: readonly number[]): ActivityScale {
  const positivos = totais.filter((total) => total > 0).sort((a, b) => a - b);
  return {
    ranked: positivos,
    uniforme: positivos.length === 0 || positivos[0] === positivos[positivos.length - 1],
  };
}

/**
 * O nível de cor de um dia, de 0 (nada) a 4 (cheio): o quartil dele entre os
 * dias ativos do período.
 *
 * A posição é a **menor** que o valor ocupa (quantos dias somaram estritamente
 * menos), e não a maior: com empate, a maior jogaria para o nível 4 um valor
 * que quase todo dia repete — quarenta dias de "1 leitura" e um de mil
 * ficariam todos cheios.
 *
 * O máximo do período, porém, é garantido **antes** do quartil: pela posição
 * menor, um empate no topo não chega ao 4 sozinho. Medido na tela — nove dias
 * com total 2 e um com total 1 — o `abaixo` de quem somou 2 é 1, o quartil dá
 * `ceil(4 · 2 / 10) = 1`, e os dez dias saíam no nível 1, o `busiest` junto:
 * a rampa inteira achatada no degrau mais fraco. Pior, sem aquele único dia de
 * total 1 a escala seria uniforme e os nove sairiam no 2 — acrescentar um dia
 * MAIS FRACO apagava todos os outros. Com a garantia, quem soma o máximo está
 * sempre no alto da rampa, empatado ou não, e o resto continua por quartil.
 *
 * Sem dispersão — um dia ativo só, ou todos com o mesmo total — o período
 * inteiro cai no nível 2, o do meio. Não é o 4, que diria "pico" onde não há
 * comparação possível; e não é o 1, que numa instalação nova deixaria o único
 * dia com movimento quase indistinguível do dia vazio ao lado — a tela diria
 * "nada aconteceu" justamente quando algo aconteceu.
 */
export function activityLevel(total: number, escala: ActivityScale): ActivityLevel {
  if (total <= 0) return 0;
  if (escala.uniforme) return 2;
  // `uniforme` falso garante ao menos dois totais distintos, então o último do
  // `ranked` existe e é maior que o primeiro.
  if (total >= escala.ranked[escala.ranked.length - 1]) return 4;
  const abaixo = escala.ranked.filter((valor) => valor < total).length;
  const quartil = Math.ceil((4 * (abaixo + 1)) / escala.ranked.length);
  return Math.min(4, Math.max(1, quartil)) as ActivityLevel;
}

/** Uma célula da grade: um dia dentro da faixa. */
export type ActivityCell = {
  day: string;
  /** 0 = domingo, 6 = sábado — a linha em que a célula cai. */
  weekday: number;
  total: number;
  level: ActivityLevel;
  /** As quatro parcelas do total, para o `title` da célula. */
  counts: { sessions: number; calls: number; reads: number; events: number };
};

/** Uma coluna: sempre 7 posições, de domingo a sábado. `null` é dia fora da faixa. */
export type ActivityWeek = { key: string; days: (ActivityCell | null)[] };

export type ActivityMonthLabel = { key: string; label: string; column: number };

export type ActivityGrid = {
  since: string;
  until: string;
  weeks: ActivityWeek[];
  months: ActivityMonthLabel[];
  /** Só os dias da faixa, em ordem crescente — é por esta lista que o teclado anda. */
  days: ActivityCell[];
  activeDays: number;
  busiest: ActivityCell | null;
};

const VAZIA = (since: string, until: string): ActivityGrid => ({
  since,
  until,
  weeks: [],
  months: [],
  days: [],
  activeDays: 0,
  busiest: null,
});

/**
 * Monta a grade do heatmap: uma coluna por semana, de domingo a sábado, como
 * no GitHub.
 *
 * A primeira e a última coluna são **parciais** (a faixa raramente começa num
 * domingo), e as posições de fora ficam `null`: a grade não inventa o dia
 * anterior ao período nem o dia que ainda não chegou. A série só traz dia com
 * movimento — aqui, ao contrário de `Stats`, faltar é zero, e é o que preenche
 * o resto.
 */
export function buildActivityGrid({
  since,
  until,
  days,
}: {
  since: string;
  until: string;
  days: readonly ActivityDay[];
}): ActivityGrid {
  const primeiro = inicioDoDia(since);
  const ultimo = inicioDoDia(until);
  if (!primeiro || !ultimo || since > until) return VAZIA(since, until);

  // A série pode, em tese, trazer dia fora da faixa pedida (o servidor arredonda
  // a janela); o que não está na faixa não entra na grade nem na escala de cor.
  const naFaixa = days.filter((dia) => dia.day >= since && dia.day <= until);
  const porDia = new Map(naFaixa.map((dia) => [dia.day, dia]));
  const escala = activityScale(naFaixa.map((dia) => dia.total));

  const weeks: ActivityWeek[] = [];
  const lista: ActivityCell[] = [];
  let coluna: (ActivityCell | null)[] = [];

  // Começa no domingo da semana de `since` e para no domingo seguinte ao de
  // `until`: assim a última semana sai inteira, com `null` no que passa do fim.
  for (let passo = -primeiro.getDay(); ; passo += 1) {
    const data = inicioDoDia(since, passo)!;
    const chave = dayKey(data);
    if (data.getDay() === 0) {
      if (chave > until) break;
      coluna = [];
      weeks.push({ key: chave, days: coluna });
    }
    if (chave < since || chave > until) {
      coluna.push(null);
      continue;
    }
    const linha = porDia.get(chave);
    const total = linha?.total ?? 0;
    const celula: ActivityCell = {
      day: chave,
      weekday: data.getDay(),
      total,
      level: activityLevel(total, escala),
      counts: {
        sessions: linha?.sessions ?? 0,
        calls: linha?.calls ?? 0,
        reads: linha?.reads ?? 0,
        events: linha?.events ?? 0,
      },
    };
    coluna.push(celula);
    lista.push(celula);
  }

  return {
    since,
    until,
    weeks,
    months: monthLabels(weeks),
    days: lista,
    activeDays: lista.filter((celula) => celula.total > 0).length,
    busiest: lista.reduce<ActivityCell | null>(
      (maior, celula) => (celula.total > 0 && (!maior || celula.total > maior.total) ? celula : maior),
      null,
    ),
  };
}

/**
 * Os rótulos de mês do topo, com a coluna em que cada um começa.
 *
 * O mês é rotulado na **primeira coluna que o contém** — a do primeiro dia
 * dele que está na grade —, como no GitHub. Dois rótulos nunca ficam a menos
 * de `MIN_COLUNAS_ENTRE_MESES` um do outro, porque se sobreporiam; na disputa,
 * quem chega depois cede a vez. A coluna 0 é a exceção: a semana dela é
 * parcial e o mês pode ter um dia só na grade, então é ela que cede — rotular
 * "ago" num sábado solto e engolir "set", que ocupa cinco colunas, deixaria a
 * grade sem referência por mais de um mês.
 */
function monthLabels(weeks: readonly ActivityWeek[]): ActivityMonthLabel[] {
  const candidatos: ActivityMonthLabel[] = [];
  let anterior: string | null = null;
  weeks.forEach((semana, coluna) => {
    const primeira = semana.days.find((celula): celula is ActivityCell => celula !== null);
    if (!primeira) return;
    const anoMes = primeira.day.slice(0, 7);
    if (anoMes === anterior) return;
    anterior = anoMes;
    candidatos.push({ key: anoMes, label: MES_CURTO[Number(anoMes.slice(5, 7)) - 1] ?? anoMes, column: coluna });
  });

  const rotulos: ActivityMonthLabel[] = [];
  candidatos.forEach((candidato, indice) => {
    const proximo = candidatos[indice + 1];
    if (indice === 0) {
      if (proximo && proximo.column - candidato.column < MIN_COLUNAS_ENTRE_MESES) return;
    } else {
      const ultimo = rotulos[rotulos.length - 1];
      if (ultimo && candidato.column - ultimo.column < MIN_COLUNAS_ENTRE_MESES) return;
    }
    rotulos.push(candidato);
  });
  return rotulos;
}

/**
 * Quantas células cada seta anda: para o lado é uma semana (a coluna vizinha,
 * na mesma linha); para cima e para baixo, um dia.
 */
const PASSO_DA_TECLA: Record<string, number | undefined> = {
  ArrowLeft: -7,
  ArrowRight: 7,
  ArrowUp: -1,
  ArrowDown: 1,
};

/**
 * O dia que uma tecla alcança a partir de `atual` — ou `null` quando a tecla
 * não anda pela grade (`Enter`, espaço, letra, `Tab`).
 *
 * É só o **alvo do foco**: a tecla que anda nunca abre o relatório. Quem abre
 * é o clique (e o `Enter`/espaço que o botão traduz em clique sozinho). O
 * porquê está em `ActivityHeatmap`, junto do *roving tabindex*.
 *
 * O passo é aparado nas pontas: no primeiro e no último dia da faixa a seta
 * fica onde está, em vez de dar a volta — a grade é um calendário, e saltar de
 * janeiro para dezembro embaralharia a noção de "para trás".
 */
export function activityKeyTarget(days: readonly ActivityCell[], atual: string, tecla: string): string | null {
  if (days.length === 0) return null;
  if (tecla === 'Home') return days[0].day;
  if (tecla === 'End') return days[days.length - 1].day;
  const passo = PASSO_DA_TECLA[tecla];
  if (passo === undefined) return null;
  const indice = days.findIndex((celula) => celula.day === atual);
  if (indice === -1) return null;
  return days[Math.min(days.length - 1, Math.max(0, indice + passo))].day;
}

/** O dia por extenso, como o `title` da célula o escreve: `sáb, 19/09/2026`. */
export function formatActivityDay(day: string): string {
  const data = inicioDoDia(day);
  if (!data) return day;
  return `${ACTIVITY_WEEKDAYS[data.getDay()]}, ${dois(data.getDate())}/${dois(data.getMonth() + 1)}/${data.getFullYear()}`;
}

/** O resumo que o leitor de tela ouve no lugar da grade inteira. */
export function activitySummary(grade: ActivityGrid): string {
  if (grade.days.length === 0) return 'Grade de atividade vazia.';
  const dias = `${grade.activeDays} de ${grade.days.length} dia${grade.days.length === 1 ? '' : 's'} com atividade`;
  return `Atividade de ${formatActivityDay(grade.since)} a ${formatActivityDay(grade.until)}: ${dias}.`;
}
