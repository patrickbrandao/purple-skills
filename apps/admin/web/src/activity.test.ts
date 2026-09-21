import { afterEach, describe, expect, it, vi } from 'vitest';
// `?raw` é do Vite (e o Vitest o entende): o **texto** do arquivo, sem avaliar
// nada. Mesma técnica de `audit.test.ts`, pelo mesmo motivo — este bundle é de
// navegador e não importa `@purple-skills/shared` em valor.
import fonteDoShared from '../../../../packages/shared/src/types.ts?raw';
import fonteDoPainel from './api.ts?raw';
// O componente entra como texto pelo mesmo motivo: ele monta JSX e não roda
// sem DOM — e o que se prova dele aqui é a LIGAÇÃO (quem chama `onSelect`).
import fonteDoHeatmap from './components/ActivityHeatmap.tsx?raw';
import { MCP_CALL_FAMILIES, type ActivityDay } from './api.js';
import { auditRange } from './audit.js';
import {
  ACTIVITY_WINDOWS,
  activityInstants,
  activityKeyTarget,
  activityLevel,
  activityRange,
  activityScale,
  activitySummary,
  buildActivityGrid,
  dayKey,
  formatActivityDay,
  isActivityWindow,
  todayKey,
  viewerTimeZone,
  type ActivityCell,
} from './activity.js';

const SHARED = 'packages/shared/src/types.ts';
const PAINEL = 'apps/admin/web/src/api.ts';

/* ============================================================
   1. O ESPELHO DA SEÇÃO "ATIVIDADE"
   `McpCallFamily` e `MCP_CALL_FAMILIES` são cópia manual do
   shared em `api.ts`. É a mesma proteção que `audit.test.ts` dá
   ao `AuditAction`: sem ela, uma família nova do protocolo
   entraria no servidor e sumiria do relatório da tela, em
   silêncio (o bloco "por família" só deixaria de somar).
   ============================================================ */

/** Os membros de `export type McpCallFamily = 'a' | 'b' …;`, na ordem do arquivo. */
function unionMcpCallFamily(fonte: string, arquivo: string): string[] {
  const linha = /^export type McpCallFamily =(.+);$/m.exec(fonte);
  if (!linha) throw new Error(`"export type McpCallFamily =" não encontrado em ${arquivo} — o formato do arquivo mudou`);
  const membros = [...linha[1].matchAll(/'([^']+)'/g)].map((achado) => achado[1]);
  if (membros.length === 0) throw new Error(`o union McpCallFamily de ${arquivo} não tem membro nenhum`);
  return membros;
}

/** Os itens de `export const MCP_CALL_FAMILIES … = […];`, na ordem do arquivo. */
function arrayMcpCallFamilies(fonte: string, arquivo: string): string[] {
  const linha = /^export const MCP_CALL_FAMILIES[^=]*=\s*\[([^\]]*)\];$/m.exec(fonte);
  if (!linha) throw new Error(`"export const MCP_CALL_FAMILIES" não encontrado em ${arquivo} — o formato do arquivo mudou`);
  return [...linha[1].matchAll(/'([^']+)'/g)].map((achado) => achado[1]);
}

describe('espelho da seção "atividade" no painel', () => {
  const doShared = unionMcpCallFamily(fonteDoShared, SHARED);
  const doPainel = unionMcpCallFamily(fonteDoPainel, PAINEL);

  it('encontra o union do shared — guarda da guarda', () => {
    // Um leitor que parasse de casar faria os testes abaixo comparar listas
    // vazias e passar sem verificar nada.
    expect(doShared.length).toBeGreaterThan(3);
    expect(doShared).toContain('tools');
    expect(doShared).toContain('other');
    expect(new Set(doShared).size, 'família repetida no shared').toBe(doShared.length);
  });

  it('o union do painel tem exatamente as famílias do shared, na mesma ordem', () => {
    // Em texto, e não em lista: a mensagem de falha mostra todos os nomes.
    expect(doShared.filter((familia) => !doPainel.includes(familia)).join(', '), `famílias do shared sem espelho em ${PAINEL}`).toBe('');
    expect(doPainel.filter((familia) => !doShared.includes(familia)).join(', '), 'famílias que só existem no painel').toBe('');
    expect(doPainel).toEqual(doShared);
  });

  it('MCP_CALL_FAMILIES repete o union, item a item, nos dois arquivos', () => {
    // O TypeScript garante que cada item é do union, não que o array está
    // completo: a família que falta aqui some do bloco "por família".
    expect(arrayMcpCallFamilies(fonteDoShared, SHARED)).toEqual(doShared);
    expect(arrayMcpCallFamilies(fonteDoPainel, PAINEL)).toEqual(doPainel);
    expect([...MCP_CALL_FAMILIES]).toEqual(doPainel);
  });

  it('os quatro tipos do relatório existem dos dois lados', () => {
    for (const nome of ['ActivityDay', 'ActivitySeries', 'ActivitySlice', 'ActivityReport']) {
      expect(fonteDoShared, `${nome} no shared`).toContain(`export type ${nome} = `);
      expect(fonteDoPainel, `${nome} no painel`).toContain(`export type ${nome} = `);
    }
  });

  it('recusa arquivo sem a seção em vez de devolver lista vazia', () => {
    expect(() => unionMcpCallFamily('export type Outro = 1;', 'x.ts')).toThrow(/não encontrado/);
    expect(() => arrayMcpCallFamilies('const X = [];', 'x.ts')).toThrow(/não encontrado/);
  });
});

/* ============================================================
   2. DATAS
   O dia é o do calendário de quem olha. Tudo aqui roda em pelo
   menos dois fusos: o defeito que estes testes previnem
   (`tasks/044`) só aparece fora do UTC.
   ============================================================ */

describe('dayKey e todayKey', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('lê os campos locais, e não o texto ISO em UTC', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    // 20/09 às 21:00 em São Paulo já é 21/09 em UTC: o dia de quem olha é o 20.
    expect(dayKey(new Date(Date.UTC(2026, 8, 21, 0, 30)))).toBe('2026-09-20');
    expect(todayKey(new Date(Date.UTC(2026, 8, 21, 0, 30)))).toBe('2026-09-20');
    vi.stubEnv('TZ', 'Asia/Tokyo');
    // 21/09 às 09:30 em Tóquio; em UTC ainda é dia 21 — os dois concordam aqui.
    expect(dayKey(new Date(Date.UTC(2026, 8, 21, 0, 30)))).toBe('2026-09-21');
    // 20/09 às 23:30 UTC já é 21/09 em Tóquio.
    expect(dayKey(new Date(Date.UTC(2026, 8, 20, 23, 30)))).toBe('2026-09-21');
  });

  it('preenche mês e dia com dois dígitos', () => {
    vi.stubEnv('TZ', 'UTC');
    expect(dayKey(new Date(Date.UTC(2026, 0, 2, 12)))).toBe('2026-01-02');
  });
});

describe('activityRange (a faixa padrão)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('12 meses é uma janela fechada de um ano, não um ano e um dia', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    expect(activityRange('12m', '2026-09-21')).toEqual({ since: '2025-09-22', until: '2026-09-21' });
    // 365 dias na grade: 22/09/2025 a 21/09/2026.
    expect(buildActivityGrid({ ...activityRange('12m', '2026-09-21'), days: [] }).days.length).toBe(365);
  });

  it('6 e 3 meses, e a virada de ano', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    expect(activityRange('6m', '2026-09-21')).toEqual({ since: '2026-03-22', until: '2026-09-21' });
    expect(activityRange('3m', '2026-02-10')).toEqual({ since: '2025-11-11', until: '2026-02-10' });
    expect(activityRange('12m', '2026-01-01')).toEqual({ since: '2025-01-02', until: '2026-01-01' });
  });

  it('apara o dia do mês em vez de transbordar para o mês seguinte', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    // 31/03 menos um mês não é 03/03: é 28/02 (ou 29, em bissexto) — e a faixa
    // começa no dia seguinte.
    expect(activityRange('3m', '2026-05-31').since).toBe('2026-03-01');
    expect(activityRange('12m', '2028-02-29')).toEqual({ since: '2027-03-01', until: '2028-02-29' });
  });

  it('o mesmo dia dá a mesma faixa em qualquer fuso — é calendário, não instante', () => {
    const emCadaFuso = ['UTC', 'America/Sao_Paulo', 'Asia/Kolkata', 'Pacific/Kiritimati'].map((fuso) => {
      vi.stubEnv('TZ', fuso);
      return activityRange('12m', '2026-09-21');
    });
    expect(new Set(emCadaFuso.map((faixa) => `${faixa.since}..${faixa.until}`)).size).toBe(1);
  });

  it('a janela desconhecida cai na primeira (12 meses), e isActivityWindow a reconhece', () => {
    vi.stubEnv('TZ', 'UTC');
    expect(activityRange('nada' as never, '2026-09-21')).toEqual(activityRange('12m', '2026-09-21'));
    expect(ACTIVITY_WINDOWS[0].key).toBe('12m');
    expect(isActivityWindow('6m')).toBe(true);
    expect(isActivityWindow('7m')).toBe(false);
    expect(isActivityWindow(null)).toBe(false);
  });
});

describe('activityInstants', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('é o auditRange da trilha, sem cópia — a borda é a mesma nos dois', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    expect(activityInstants('2026-09-19', '2026-09-19')).toEqual(auditRange('2026-09-19', '2026-09-19'));
    expect(activityInstants('2026-09-19', '2026-09-19')).toEqual({
      since: '2026-09-19T03:00:00.000Z',
      until: '2026-09-20T02:59:59.999Z',
    });
  });

  it('a leste de Greenwich a janela do mesmo dia é outra — e é a certa', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    expect(activityInstants('2026-09-19', '2026-09-19')).toEqual({
      since: '2026-09-18T15:00:00.000Z',
      until: '2026-09-19T14:59:59.999Z',
    });
  });
});

describe('viewerTimeZone', () => {
  it('devolve o fuso IANA quando o ambiente o resolve', () => {
    expect(viewerTimeZone(() => 'America/Sao_Paulo')).toBe('America/Sao_Paulo');
  });

  it('cala o `tz` em vez de inventar UTC quando o ambiente não resolve', () => {
    expect(viewerTimeZone(() => undefined)).toBeUndefined();
    expect(viewerTimeZone(() => '')).toBeUndefined();
    expect(viewerTimeZone(() => '   ')).toBeUndefined();
    expect(
      viewerTimeZone(() => {
        throw new Error('sem Intl');
      }),
    ).toBeUndefined();
  });

  it('o padrão usa o Intl do ambiente e não explode', () => {
    const fuso = viewerTimeZone();
    expect(fuso === undefined || fuso.length > 0).toBe(true);
  });
});

/* ============================================================
   3. NÍVEIS DE COR
   Quantis do próprio período, nunca faixa fixa de valor
   absoluto: um servidor de 30 chamadas por dia e um de 30 000
   têm de render heatmaps igualmente legíveis.
   ============================================================ */

describe('activityScale e activityLevel', () => {
  it('dia sem nada é sempre nível 0, com qualquer escala', () => {
    expect(activityLevel(0, activityScale([1, 2, 3]))).toBe(0);
    expect(activityLevel(0, activityScale([]))).toBe(0);
    expect(activityLevel(-1, activityScale([1, 2, 3]))).toBe(0);
  });

  it('série vazia não divide por zero nem inventa níveis', () => {
    const escala = activityScale([]);
    expect(escala).toEqual({ ranked: [], uniforme: true });
    expect(activityLevel(0, escala)).toBe(0);
    // O caminho que dividiria por `ranked.length` nem é alcançado.
    expect(activityLevel(99, escala)).toBe(2);
  });

  it('só zeros: a escala é a da série vazia', () => {
    expect(activityScale([0, 0, 0])).toEqual({ ranked: [], uniforme: true });
  });

  it('todos os dias com o mesmo total ficam no nível do meio — nem tudo 4, nem tudo invisível', () => {
    const escala = activityScale([7, 7, 7, 7]);
    expect(escala.uniforme).toBe(true);
    for (const total of [7, 7, 7, 7]) expect(activityLevel(total, escala)).toBe(2);
    // O caso que a tela nova sente primeiro: uma instalação com um dia só.
    const unico = activityScale([42]);
    expect(activityLevel(42, unico)).toBe(2);
    expect(activityLevel(0, unico)).toBe(0);
  });

  it('com dispersão, os quatro níveis são usados e o maior dia fica no 4', () => {
    const totais = [1, 2, 3, 4, 5, 6, 7, 8];
    const escala = activityScale(totais);
    expect(escala.uniforme).toBe(false);
    expect(escala.ranked).toEqual(totais);
    expect(totais.map((total) => activityLevel(total, escala))).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('o dia de maior total é sempre o nível 4, mesmo com dois dias ativos', () => {
    const escala = activityScale([10, 200]);
    expect([activityLevel(10, escala), activityLevel(200, escala)]).toEqual([2, 4]);
    const tres = activityScale([5, 10, 200]);
    expect([5, 10, 200].map((total) => activityLevel(total, tres))).toEqual([2, 3, 4]);
  });

  it('o empate NO TOPO fica no 4 — um dia fraco não achata a rampa inteira', () => {
    // O "sempre" do teste acima só era exercitado sem empate no máximo, e era
    // por aí que o defeito passava: nove dias de 2 e um de 1 saíam TODOS no
    // nível 1 (o quartil da posição menor dá ceil(4·2/10) = 1), `busiest`
    // incluído — e sem o dia de 1 a escala seria uniforme e os nove iriam ao 2,
    // isto é, acrescentar um dia mais fraco apagava os outros.
    const escala = activityScale([1, ...Array<number>(9).fill(2)]);
    expect(escala.uniforme).toBe(false);
    expect(activityLevel(1, escala)).toBe(1);
    expect(activityLevel(2, escala)).toBe(4);
    const poucos = activityScale([1, 5, 5, 5, 5, 5, 5, 5]);
    expect([1, 5, 5, 5, 5, 5, 5, 5].map((total) => activityLevel(total, poucos))).toEqual([1, 4, 4, 4, 4, 4, 4, 4]);
    // E sem o dia fraco não há o que comparar: os nove caem no nível do meio.
    const sem = activityScale(Array<number>(9).fill(2));
    expect(activityLevel(2, sem)).toBe(2);
  });

  it('o empate que se repete fica embaixo — a posição é a menor, não a maior', () => {
    // Quarenta dias de "1" e um de mil: pela posição maior, os quarenta iriam
    // para o nível 4 junto com o pico e a grade ficaria toda cheia.
    const muitos = [...Array<number>(40).fill(1), 1000];
    const escala = activityScale(muitos);
    expect(activityLevel(1, escala)).toBe(1);
    expect(activityLevel(1000, escala)).toBe(4);
    expect(new Set(muitos.map((total) => activityLevel(total, escala)))).toEqual(new Set([1, 4]));
  });

  it('a escala é relativa: a mesma forma em escalas de grandeza diferentes', () => {
    const pequeno = [1, 2, 3, 4, 5, 6, 7, 8];
    const grande = pequeno.map((total) => total * 10_000);
    const nivel = (totais: number[]) => {
      const escala = activityScale(totais);
      return totais.map((total) => activityLevel(total, escala));
    };
    expect(nivel(grande)).toEqual(nivel(pequeno));
  });

  it('os zeros não deslocam a régua dos dias ativos', () => {
    // Trinta dias parados não podem empurrar todo dia ativo para o nível 4.
    const ativos = [1, 2, 3, 4, 5, 6, 7, 8];
    const escala = activityScale([...Array<number>(30).fill(0), ...ativos]);
    expect(escala.ranked).toEqual(ativos);
    expect(ativos.map((total) => activityLevel(total, escala))).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });
});

/* ============================================================
   4. A GRADE
   ============================================================ */

const dia = (day: string, total: number): ActivityDay => ({
  day,
  sessions: total,
  calls: total,
  reads: 0,
  events: 0,
  total,
});

/** As células não nulas de uma coluna, em ordem. */
const preenchidas = (coluna: (ActivityCell | null)[]) => coluna.filter((celula): celula is ActivityCell => celula !== null);

describe('buildActivityGrid', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('a primeira e a última semana são parciais, e o que está fora da faixa fica nulo', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    // 29/08/2026 é sábado; 01/09/2026, terça.
    const grade = buildActivityGrid({ since: '2026-08-29', until: '2026-09-01', days: [] });
    expect(grade.weeks.length).toBe(2);
    // Toda coluna tem sempre 7 posições, de domingo a sábado.
    for (const semana of grade.weeks) expect(semana.days.length).toBe(7);
    // Primeira coluna: só o sábado.
    expect(grade.weeks[0].days.map((celula) => celula?.day ?? null)).toEqual([null, null, null, null, null, null, '2026-08-29']);
    // Última: domingo a terça, e o resto ainda não chegou.
    expect(grade.weeks[1].days.map((celula) => celula?.day ?? null)).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      null,
      null,
      null,
      null,
    ]);
    expect(grade.days.map((celula) => celula.day)).toEqual(['2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01']);
    // A chave da coluna é o domingo dela, mesmo quando ele está fora da faixa.
    expect(grade.weeks.map((semana) => semana.key)).toEqual(['2026-08-23', '2026-08-30']);
  });

  it('a faixa que começa num domingo não tem buraco nenhum na primeira coluna', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    const grade = buildActivityGrid({ since: '2026-08-30', until: '2026-09-05', days: [] });
    expect(grade.weeks.length).toBe(1);
    expect(preenchidas(grade.weeks[0].days).length).toBe(7);
  });

  it('dia sem linha na série é zero, e o que a série traz vira total e nível', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    const grade = buildActivityGrid({
      since: '2026-09-01',
      until: '2026-09-07',
      days: [dia('2026-09-02', 10), dia('2026-09-05', 200)],
    });
    const porDia = new Map(grade.days.map((celula) => [celula.day, celula]));
    expect(porDia.get('2026-09-01')!.total).toBe(0);
    expect(porDia.get('2026-09-01')!.level).toBe(0);
    expect(porDia.get('2026-09-02')!.total).toBe(10);
    expect(porDia.get('2026-09-02')!.counts).toEqual({ sessions: 10, calls: 10, reads: 0, events: 0 });
    expect(porDia.get('2026-09-05')!.level).toBe(4);
    expect(grade.activeDays).toBe(2);
    expect(grade.busiest?.day).toBe('2026-09-05');
  });

  it('série vazia: grade cheia de zeros, nenhum dia ativo e nenhum pico', () => {
    vi.stubEnv('TZ', 'UTC');
    const grade = buildActivityGrid({ since: '2026-09-01', until: '2026-09-30', days: [] });
    expect(grade.days.length).toBe(30);
    expect(grade.days.every((celula) => celula.level === 0 && celula.total === 0)).toBe(true);
    expect(grade.activeDays).toBe(0);
    expect(grade.busiest).toBeNull();
    expect(activitySummary(grade)).toContain('0 de 30 dias com atividade');
  });

  it('todos os dias com o mesmo total: ninguém no nível 4', () => {
    vi.stubEnv('TZ', 'UTC');
    const dias = ['2026-09-01', '2026-09-02', '2026-09-03'].map((day) => dia(day, 5));
    const grade = buildActivityGrid({ since: '2026-09-01', until: '2026-09-03', days: dias });
    expect(grade.days.map((celula) => celula.level)).toEqual([2, 2, 2]);
    expect(grade.activeDays).toBe(3);
  });

  it('linha da série fora da faixa não entra na grade nem mexe na escala', () => {
    vi.stubEnv('TZ', 'UTC');
    const grade = buildActivityGrid({
      since: '2026-09-01',
      until: '2026-09-03',
      days: [dia('2026-08-31', 10_000), dia('2026-09-02', 5)],
    });
    expect(grade.days.map((celula) => celula.day)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    // Sem o intruso, o 02 é o único ativo: escala uniforme, nível do meio.
    expect(grade.days[1].level).toBe(2);
    expect(grade.busiest?.total).toBe(5);
  });

  it('faixa invertida ou dia inválido devolvem grade vazia em vez de laço infinito', () => {
    vi.stubEnv('TZ', 'UTC');
    expect(buildActivityGrid({ since: '2026-09-10', until: '2026-09-01', days: [] }).weeks).toEqual([]);
    expect(buildActivityGrid({ since: '', until: '2026-09-01', days: [] }).days).toEqual([]);
    expect(buildActivityGrid({ since: '2026-09-01', until: '19/09/2026', days: [] }).days).toEqual([]);
  });

  it('a virada de ano não perde nem repete dia', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    const grade = buildActivityGrid({ since: '2026-12-28', until: '2027-01-03', days: [] });
    expect(grade.days.map((celula) => celula.day)).toEqual([
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
      '2027-01-03',
    ]);
    expect(new Set(grade.days.map((celula) => celula.day)).size).toBe(7);
  });

  it('ano bissexto: 29 de fevereiro está na grade, e só nele', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    const bissexto = buildActivityGrid({ since: '2028-02-01', until: '2028-03-31', days: [] });
    expect(bissexto.days.length).toBe(29 + 31);
    expect(bissexto.days.map((celula) => celula.day)).toContain('2028-02-29');
    const comum = buildActivityGrid({ since: '2026-02-01', until: '2026-03-31', days: [] });
    expect(comum.days.length).toBe(28 + 31);
    expect(comum.days.map((celula) => celula.day)).not.toContain('2026-02-29');
  });

  it('dia de 23 e de 25 horas não some nem duplica (horário de verão em São Paulo)', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    // 04/11/2018: o verão começou à meia-noite, o dia teve 23 horas.
    const inicio = buildActivityGrid({ since: '2018-11-01', until: '2018-11-07', days: [] });
    expect(inicio.days.map((celula) => celula.day)).toContain('2018-11-04');
    expect(inicio.days.length).toBe(7);
    // 16/02/2019: o verão acabou à meia-noite, o dia teve 25 horas.
    const fim = buildActivityGrid({ since: '2019-02-13', until: '2019-02-19', days: [] });
    expect(fim.days.map((celula) => celula.day)).toContain('2019-02-16');
    expect(fim.days.length).toBe(7);
  });

  it.each(['UTC', 'America/Sao_Paulo', 'Asia/Tokyo', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'])(
    'em %s a grade é a mesma: o dia é calendário, e o fuso só muda os instantes',
    (fuso) => {
      vi.stubEnv('TZ', fuso);
      const grade = buildActivityGrid({ since: '2026-09-01', until: '2026-09-30', days: [dia('2026-09-19', 3)] });
      expect(grade.days.map((celula) => celula.day).join(',')).toContain('2026-09-19');
      expect(grade.days.length).toBe(30);
      // O dia 19/09/2026 é sábado em todo lugar: a linha dele é a 6.
      expect(grade.days.find((celula) => celula.day === '2026-09-19')!.weekday).toBe(6);
      expect(grade.weeks.every((semana) => semana.days.length === 7)).toBe(true);
    },
  );

  it('um ano inteiro cabe em 53 colunas no máximo', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    const faixa = activityRange('12m', '2026-09-21');
    const grade = buildActivityGrid({ ...faixa, days: [] });
    expect(grade.weeks.length).toBeGreaterThanOrEqual(52);
    expect(grade.weeks.length).toBeLessThanOrEqual(54);
    expect(grade.weeks.flatMap((semana) => preenchidas(semana.days)).length).toBe(365);
  });
});

describe('rótulos de mês', () => {
  afterEach(() => vi.unstubAllEnvs());

  const rotulos = (since: string, until: string) =>
    buildActivityGrid({ since, until, days: [] }).months.map((mes) => `${mes.label}@${mes.column}`);

  it('cada mês é rotulado na primeira coluna que o contém', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    // 02/08/2026 é domingo: a coluna 0 é agosto inteiro.
    expect(rotulos('2026-08-02', '2026-10-31')).toEqual(['ago@0', 'set@5', 'out@9']);
  });

  it('o mês com um dia só na primeira coluna cede a vez ao seguinte', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    // 29/08/2026 é sábado: agosto teria o rótulo na coluna 0 e setembro na 2 —
    // os dois se sobrepõem, e quem sai é o agosto de um dia.
    expect(rotulos('2026-08-29', '2026-10-31')).toEqual(['set@2', 'out@6']);
  });

  it('nunca há dois rótulos a menos de três colunas um do outro', () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    const meses = buildActivityGrid({ ...activityRange('12m', '2026-09-21'), days: [] }).months;
    // Um ano dá 12 ou 13 meses; o de um dia só na ponta pode não caber.
    expect(meses.length).toBeGreaterThanOrEqual(11);
    for (let i = 1; i < meses.length; i += 1) {
      expect(meses[i].column - meses[i - 1].column, `${meses[i - 1].label} → ${meses[i].label}`).toBeGreaterThanOrEqual(3);
    }
    // E nenhuma coluna fica fora da grade.
    const colunas = buildActivityGrid({ ...activityRange('12m', '2026-09-21'), days: [] }).weeks.length;
    expect(meses.every((mes) => mes.column >= 0 && mes.column < colunas)).toBe(true);
  });

  it('a virada de ano rotula janeiro, e a chave distingue os dois dezembros', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    expect(rotulos('2026-12-01', '2027-01-31')).toEqual(['dez@0', 'jan@5']);
    const doisAnos = buildActivityGrid({ since: '2025-12-01', until: '2027-01-31', days: [] }).months;
    const dezembros = doisAnos.filter((mes) => mes.label === 'dez');
    expect(dezembros.map((mes) => mes.key)).toEqual(['2025-12', '2026-12']);
  });

  it('grade vazia não tem rótulo nenhum', () => {
    vi.stubEnv('TZ', 'UTC');
    expect(buildActivityGrid({ since: '2026-09-10', until: '2026-09-01', days: [] }).months).toEqual([]);
  });
});

describe('textos da grade', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('formatActivityDay traz o dia da semana e a data de quem olha', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    expect(formatActivityDay('2026-09-19')).toBe('sáb, 19/09/2026');
    expect(formatActivityDay('2026-01-05')).toBe('seg, 05/01/2026');
    // Valor que não é um dia volta como veio, em vez de virar "Invalid Date".
    expect(formatActivityDay('19/09/2026')).toBe('19/09/2026');
  });

  it('activitySummary descreve a faixa e a contagem', () => {
    vi.stubEnv('TZ', 'America/Sao_Paulo');
    const grade = buildActivityGrid({
      since: '2026-09-01',
      until: '2026-09-07',
      days: [dia('2026-09-02', 10), dia('2026-09-05', 2)],
    });
    expect(activitySummary(grade)).toBe('Atividade de ter, 01/09/2026 a seg, 07/09/2026: 2 de 7 dias com atividade.');
    expect(activitySummary(buildActivityGrid({ since: '', until: '', days: [] }))).toBe('Grade de atividade vazia.');
  });
});

/* ============================================================
   5. O CURSOR DO TECLADO
   A seta anda pela grade; quem abre o relatório é o clique (e o
   `Enter`/espaço que o botão traduz em clique). Separar as duas
   coisas é o que impede uma tecla segurada virar dezenas de
   `GET /api/activity/<dia>`, cada uma com sete agregados no banco.
   ============================================================ */

describe('activityKeyTarget', () => {
  // 01/08/2026 é sábado e 30/09/2026, quarta — a faixa tem ponta dos dois lados.
  const dias = buildActivityGrid({ since: '2026-08-01', until: '2026-09-30', days: [] }).days;

  it('a faixa do teste é a esperada — guarda da guarda', () => {
    expect(dias[0]?.day).toBe('2026-08-01');
    expect(dias[dias.length - 1]?.day).toBe('2026-09-30');
  });

  it('cima e baixo andam um dia; os lados, uma semana', () => {
    expect(activityKeyTarget(dias, '2026-09-10', 'ArrowDown')).toBe('2026-09-11');
    expect(activityKeyTarget(dias, '2026-09-10', 'ArrowUp')).toBe('2026-09-09');
    expect(activityKeyTarget(dias, '2026-09-10', 'ArrowRight')).toBe('2026-09-17');
    expect(activityKeyTarget(dias, '2026-09-10', 'ArrowLeft')).toBe('2026-09-03');
  });

  it('nas pontas o cursor fica onde está — a grade não dá a volta', () => {
    expect(activityKeyTarget(dias, '2026-08-01', 'ArrowUp')).toBe('2026-08-01');
    expect(activityKeyTarget(dias, '2026-08-01', 'ArrowLeft')).toBe('2026-08-01');
    expect(activityKeyTarget(dias, '2026-09-30', 'ArrowDown')).toBe('2026-09-30');
    // A semana seguinte passa do fim: para no último dia, não em outubro.
    expect(activityKeyTarget(dias, '2026-09-28', 'ArrowRight')).toBe('2026-09-30');
  });

  it('Home e End vão às pontas da faixa', () => {
    expect(activityKeyTarget(dias, '2026-09-10', 'Home')).toBe('2026-08-01');
    expect(activityKeyTarget(dias, '2026-09-10', 'End')).toBe('2026-09-30');
  });

  it('a tecla que ABRE o dia não anda — senão ela também moveria o cursor', () => {
    // `Enter` e espaço viram clique no próprio botão: se aparecessem aqui, o
    // `preventDefault` do componente engoliria a ativação nativa.
    for (const tecla of ['Enter', ' ', 'Spacebar', 'Tab', 'Escape', 'a', 'PageDown'])
      expect(activityKeyTarget(dias, '2026-09-10', tecla), `"${tecla}" não devia andar`).toBeNull();
  });

  it('grade vazia, ou dia que não está nela, não movem nada', () => {
    expect(activityKeyTarget([], '2026-09-10', 'ArrowDown')).toBeNull();
    expect(activityKeyTarget([], '2026-09-10', 'Home')).toBeNull();
    // Trocar a janela do seletor encolhe a faixa: o dia de antes pode ter saído.
    expect(activityKeyTarget(dias, '2026-12-25', 'ArrowDown')).toBeNull();
  });
});

/**
 * O corpo de uma função `const nome = (…) => { … };` do fonte, pelo fecho na
 * coluna 2 (a indentação de um `const` dentro de um componente).
 */
function corpoDaFuncao(fonte: string, nome: string, arquivo: string): string {
  const inicio = fonte.indexOf(`const ${nome} = `);
  if (inicio === -1) throw new Error(`"const ${nome} =" não encontrado em ${arquivo} — o formato do arquivo mudou`);
  const fim = fonte.indexOf('\n  };', inicio);
  if (fim === -1) throw new Error(`o fim de "${nome}" não foi encontrado em ${arquivo} — o formato do arquivo mudou`);
  return fonte.slice(inicio, fim);
}

describe('o heatmap separa foco de seleção', () => {
  /* Sem DOM não dá para simular a tecla; o que dá para provar aqui é a ligação
     do componente, que é onde o defeito estava: a seta chamava `onSelect` (o
     `setDia` da página) antes de mover o foco, e segurar ArrowDown por dois
     segundos disparava uma busca do relatório por repetição de tecla. */
  const HEATMAP = 'apps/admin/web/src/components/ActivityHeatmap.tsx';

  it('andar com a seta só move o foco — não seleciona', () => {
    const aoTeclar = corpoDaFuncao(fonteDoHeatmap, 'aoTeclar', HEATMAP);
    expect(aoTeclar, 'o corpo de `aoTeclar` não foi reconhecido').toContain('activityKeyTarget(');
    expect(aoTeclar).toContain('focar(');
    expect(/onSelect|escolher/.test(aoTeclar), `a tecla voltou a selecionar em ${HEATMAP}`).toBe(false);
  });

  it('mover o foco não seleciona nem no caminho de baixo', () => {
    const focar = corpoDaFuncao(fonteDoHeatmap, 'focar', HEATMAP);
    expect(focar, 'o corpo de `focar` não foi reconhecido').toContain('.focus()');
    expect(/onSelect/.test(focar), `\`focar\` voltou a selecionar em ${HEATMAP}`).toBe(false);
  });

  it('quem abre o dia é o clique, e só ele', () => {
    expect(fonteDoHeatmap).toMatch(/onClick=\{\(\) => escolher\(/);
    expect(corpoDaFuncao(fonteDoHeatmap, 'escolher', HEATMAP)).toContain('onSelect(');
    // Uma chamada só no arquivo inteiro: a de `escolher`.
    expect([...fonteDoHeatmap.matchAll(/onSelect\(/g)].length, `mais de um caminho chama onSelect em ${HEATMAP}`).toBe(1);
  });
});
