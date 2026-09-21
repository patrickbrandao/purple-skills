import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { BookOpenCheck, CalendarDays, Info, ListChecks, Plug, Radio } from 'lucide-react';
import {
  MCP_CALL_FAMILIES,
  getActivity,
  getActivityDay,
  num,
  plural,
  type ActivityReport,
  type ActivitySeries,
  type ActivitySlice,
  type AuditAction,
  type McpCallFamily,
} from '../api.js';
import { ACTION_LABEL } from '../audit.js';
import {
  ACTIVITY_WINDOWS,
  activityInstants,
  activityRange,
  buildActivityGrid,
  formatActivityDay,
  isActivityWindow,
  viewerTimeZone,
  type ActivityWindowKey,
} from '../activity.js';
import { ActivityHeatmap } from '../components/ActivityHeatmap.js';
import { EmptyState, Panel, Skel, useStored } from '../components/ui.js';

/* ============================================================
   ATIVIDADE (`docs/18-atividade.md`) — só admin, como a Auditoria.

   A grade de dias e, ao clicar num deles, o relatório daquele dia
   logo abaixo. Tudo agregado: a menor unidade é "quantas vezes".
   Quem precisa do evento a evento tem a trilha, as sessões e a
   guia de acessos da skill — e é por isso que nenhum bloco daqui
   tem link para uma operação.

   O dia é o do calendário de quem olha. A tela converte o dia em
   instantes com a mesma função da trilha (`activityInstants` →
   `auditRange`) e manda o fuso IANA junto só na série, porque é
   nela que o SQL agrupa por dia (`tasks/044`).
   ============================================================ */

/** As três primeiras famílias são as portas do canvas; as outras pegam emprestado o que já significa aquilo. */
const FAMILY_TONE: Record<McpCallFamily, string> = {
  tools: 'var(--port-tools)',
  resources: 'var(--port-resources)',
  prompts: 'var(--port-prompts)',
  // O mesmo teal do hexágono de skill na colmeia do card de servidor.
  skills: 'var(--hex-skill)',
  // Abrir e manter a conversa não é consumo de conteúdo: cor de informação.
  session: 'var(--info)',
  other: 'var(--text-faint)',
};

const FAMILY_LABEL: Record<McpCallFamily, string> = {
  tools: 'tools',
  resources: 'resources',
  prompts: 'prompts',
  skills: 'skills',
  session: 'sessão',
  other: 'outras',
};

/* Os rótulos de chave que o banco não nomeia. Cada mapa espelha um union já
   copiado em `api.ts`; chave sem rótulo cai na própria chave, para um valor
   novo do servidor aparecer na tela em vez de sumir. */
const TRANSPORT_LABEL: Record<string, string> = {
  streamable: 'Streamable HTTP',
  sse: 'SSE',
  stateless: 'stateless',
};

const SESSION_AUTH_LABEL: Record<string, string> = {
  open: 'servidor aberto',
  key: 'chave do servidor',
};

const END_LABEL: Record<string, string> = {
  closed: 'fechou',
  timeout: 'timeout',
  shutdown: 'servidor parou',
};

const SURFACE_LABEL: Record<string, string> = {
  tool: 'get_skill',
  resource: 'resource',
  prompt: 'prompt',
  file: 'SKILL.md',
  download: 'pacote',
  page: 'página',
  'admin-tool': 'get_skill (admin)',
};

const ORIGIN_LABEL: Record<string, string> = {
  mcp: 'MCP público',
  site: 'Site',
  'mcp-admin': 'MCP administrativo',
};

const READ_AUTH_LABEL: Record<string, string> = {
  open: 'servidor aberto',
  key: 'chave do servidor',
  user: 'conta do painel',
  anonymous: 'anônimo (site)',
};

const SOURCE_LABEL: Record<string, string> = {
  'web-admin': 'painel',
  'mcp-admin': 'MCP administrativo',
};

/** O nome de uma fatia: o que o banco mandou quando mandou; senão, o rótulo local da chave. */
const nomeDaFatia = (mapa: Record<string, string> = {}) => (fatia: ActivitySlice) =>
  fatia.label ?? mapa[fatia.key] ?? fatia.key;

const familiaDe = (chave: string | null): McpCallFamily | null =>
  chave !== null && MCP_CALL_FAMILIES.includes(chave as McpCallFamily) ? (chave as McpCallFamily) : null;

/**
 * O nome e a cor de uma família. Chave que o union não conhece aparece **como
 * veio**, e não traduzida em "outras": `other` é uma família de verdade que o
 * servidor sabe emitir, e confundir as duas esconderia justamente o caso que a
 * tela existe para mostrar — uma família nova do protocolo chegando aqui antes
 * de o painel saber dela.
 */
const nomeDaFamilia = (chave: string | null): string => {
  const familia = familiaDe(chave);
  return familia ? FAMILY_LABEL[familia] : (chave ?? '—');
};
const corDaFamilia = (chave: string | null): string => {
  const familia = familiaDe(chave);
  return familia ? FAMILY_TONE[familia] : FAMILY_TONE.other;
};

/**
 * Um número em destaque com a sua palavra embaixo.
 *
 * O `tone` é opcional e só as famílias o usam: vira um quadradinho da cor
 * delas ao lado da palavra, a chave de legenda das barras que vêm logo abaixo
 * (`Métodos mais chamados` pinta cada método pela família). A cor nunca é a
 * informação sozinha — o nome está escrito ao lado.
 */
function Stat({ value, label, title, tone }: { value: number; label: string; title?: string; tone?: string }) {
  return (
    <div className="act-stat" title={title}>
      <div className="v">{num(value)}</div>
      <div className="k">
        {tone !== undefined && <i className="act-key" style={{ '--act-tone': tone } as CSSProperties} aria-hidden />}
        {label}
      </div>
    </div>
  );
}

/**
 * Os tiles de família do painel "Chamadas": uma família por tile, na ordem do
 * union, com zero no dia em que ela não apareceu.
 *
 * A cauda são as famílias que o servidor mandou e este painel não conhece,
 * com o nome cru. Elas apareciam no bloco de barras "Por família", que saiu
 * daqui porque repetia — nos mesmos seis números e na mesma ordem — os tiles
 * logo acima; nenhum outro painel da tela diz a mesma coisa duas vezes (em
 * Clientes, Leituras e Catálogo os tiles são escalares e as barras, recortes).
 * Sem esta cauda, tirar o bloco esconderia justamente o caso que a tela existe
 * para mostrar: uma família nova do protocolo chegando ao servidor antes de o
 * painel saber dela.
 */
export function callFamilyTiles(byFamily: readonly ActivitySlice[]): {
  key: string;
  label: string;
  tone: string;
  count: number;
}[] {
  const conhecidas = MCP_CALL_FAMILIES.map((familia) => ({
    key: familia,
    label: FAMILY_LABEL[familia],
    tone: FAMILY_TONE[familia],
    count: byFamily.find((fatia) => fatia.key === familia)?.count ?? 0,
  }));
  const desconhecidas = byFamily
    .filter((fatia) => familiaDe(fatia.key) === null)
    .map((fatia) => ({
      key: fatia.key,
      label: nomeDaFamilia(fatia.key),
      tone: corDaFamilia(fatia.key),
      count: fatia.count,
    }));
  return [...conhecidas, ...desconhecidas];
}

/**
 * Um recorte do total, em linhas com barra.
 *
 * A barra é **proporção dentro do bloco** — a maior fatia ocupa a linha
 * inteira —, e não escala absoluta: cada bloco responde "de que é feito este
 * total", nunca "este dia é grande". Quem compara dias é o heatmap.
 */
function Slices({
  title,
  items,
  label = nomeDaFatia(),
  tone,
  hint,
  empty = 'nada neste dia',
}: {
  title: string;
  items: ActivitySlice[];
  label?: (fatia: ActivitySlice) => string;
  tone?: (fatia: ActivitySlice) => string;
  hint?: (fatia: ActivitySlice) => string | undefined;
  empty?: string;
}) {
  const maior = items.reduce((maximo, fatia) => Math.max(maximo, fatia.count), 0);
  return (
    <div className="act-block">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="act-none">{empty}</p>
      ) : (
        items.map((fatia) => {
          const nome = label(fatia);
          return (
            <div className="act-slice" key={fatia.key}>
              <span className="nm" title={hint?.(fatia) ?? (nome === fatia.key ? undefined : fatia.key)}>
                {nome}
              </span>
              <span className="n">{num(fatia.count)}</span>
              <span className="act-bar" style={{ '--act-tone': tone?.(fatia) ?? 'var(--accent)' } as CSSProperties}>
                {/* Piso de 3%: a fatia de uma vez ao lado de uma de mil continua visível. */}
                <i style={{ width: `${maior > 0 ? Math.max(3, Math.round((fatia.count / maior) * 100)) : 0}%` }} />
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

/** Atividade: o heatmap do período e o relatório do dia escolhido. */
export function ActivityPage() {
  const [janela, setJanela] = useStored<ActivityWindowKey>('purple-skills-admin:activity-window', ACTIVITY_WINDOWS[0].key);
  const [serie, setSerie] = useState<ActivitySeries | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [dia, setDia] = useState<string | null>(null);
  const [relatorio, setRelatorio] = useState<ActivityReport | null>(null);
  const [erroDoDia, setErroDoDia] = useState<string | null>(null);

  // `useStored` devolve o que estiver no localStorage: uma janela de uma versão
  // anterior (ou editada à mão) não pode virar uma faixa inválida.
  const escolhida = isActivityWindow(janela) ? janela : ACTIVITY_WINDOWS[0].key;
  // O "hoje" é lido uma vez por escolha de janela: recalcular a cada render
  // faria a faixa mudar de identidade e a busca reiniciar sem parar.
  const faixa = useMemo(() => activityRange(escolhida), [escolhida]);

  useEffect(() => {
    let active = true;
    setSerie(null);
    setErro(null);
    setDia(null);
    const { since, until } = activityInstants(faixa.since, faixa.until);
    getActivity({ since, until, timezone: viewerTimeZone() })
      .then((data) => active && setSerie(data))
      .catch((err) => active && setErro((err as Error).message));
    return () => {
      active = false;
    };
  }, [faixa]);

  useEffect(() => {
    if (!dia) {
      setRelatorio(null);
      setErroDoDia(null);
      return;
    }
    let active = true;
    setRelatorio(null);
    setErroDoDia(null);
    // A janela do dia vai em instantes; o dia no caminho é rótulo.
    const { since, until } = activityInstants(dia, dia);
    // O fuso vai junto só para o corpo ecoar o de quem olha; o recorte é o par
    // de instantes acima, o mesmo que a célula da grade representa.
    getActivityDay(dia, { since, until, timezone: viewerTimeZone() })
      .then((data) => active && setRelatorio(data))
      .catch((err) => active && setErroDoDia((err as Error).message));
    return () => {
      active = false;
    };
  }, [dia]);

  // A grade sai da faixa **local**, e não da que a série devolveu: é o mesmo
  // par de dias que a busca do dia clicado vai converter em instantes, e ter
  // uma origem só é o que impede a célula e o relatório falarem de dias
  // diferentes. Dia que a série trouxer fora da faixa é descartado lá dentro.
  const grade = useMemo(
    () => buildActivityGrid({ since: faixa.since, until: faixa.until, days: serie?.days ?? [] }),
    [faixa, serie],
  );

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1 className="flex items-center gap-2">
            Atividade
            <span
              title="Conta sessões do MCP público, chamadas JSON-RPC, leituras de skill e eventos da trilha. Tudo somado por dia: nenhum número aqui identifica cliente, conta ou operação."
            >
              <Info className="act-info" />
            </span>
          </h1>
          {/* Diz o `Enter` porque na grade a seta só move o cursor: sem a
              frase, quem navega por teclado andaria pelo ano sem ver o
              relatório mudar e não saberia o que falta apertar. */}
          <p className="sub">
            O movimento da instalação, dia a dia. Clique num dia — ou chegue nele com as setas e tecle Enter — para ver o
            relatório dele.
          </p>
        </div>
        <div className="page-actions">
          <select
            className="field"
            style={{ width: 'auto' }}
            value={escolhida}
            onChange={(event) => setJanela(event.target.value as ActivityWindowKey)}
            title="Período da grade"
          >
            {ACTIVITY_WINDOWS.map((item) => (
              <option key={item.key} value={item.key}>
                Últimos {item.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {erro && <p className="notice danger mb-3">{erro}</p>}

      <Panel className="mb-5">
        {!serie && !erro ? (
          <Skel h={180} />
        ) : (
          <>
            <p className="act-days">
              <b>{num(grade.activeDays)}</b>
              {grade.activeDays === 1 ? 'dia com atividade' : 'dias com atividade'}
              <span>
                {' '}
                · {formatActivityDay(grade.since)} a {formatActivityDay(grade.until)}
                {serie?.timezone ? ` · fuso ${serie.timezone}` : ''}
              </span>
            </p>
            <ActivityHeatmap grid={grade} selected={dia} onSelect={setDia} />
          </>
        )}
      </Panel>

      {!dia ? (
        <EmptyState
          icon={<CalendarDays />}
          title="Escolha um dia na grade"
          description="O relatório do dia aparece aqui: quem se conectou, o que foi chamado, o que foi lido e o que mudou no catálogo — sempre somado, nunca operação a operação."
        />
      ) : erroDoDia ? (
        <p className="notice danger">{erroDoDia}</p>
      ) : !relatorio ? (
        <Skel h={340} />
      ) : (
        <DayReport report={relatorio} />
      )}
    </div>
  );
}

function DayReport({ report }: { report: ActivityReport }) {
  const { clients, calls, reads, catalog } = report;
  const parado = clients.sessions === 0 && calls.total === 0 && reads.total === 0 && catalog.total === 0;

  return (
    <section aria-label={`Relatório de ${formatActivityDay(report.day)}`}>
      <div className="mb-4">
        <h2 className="text-h2">{formatActivityDay(report.day)}</h2>
        <p className="sub" style={{ color: 'var(--text-muted)' }}>
          {plural(clients.sessions, 'sessão', 'sessões')} · {plural(calls.total, 'chamada', 'chamadas')} ·{' '}
          {plural(reads.total, 'leitura', 'leituras')} · {plural(catalog.total, 'evento na trilha', 'eventos na trilha')}
        </p>
      </div>

      {parado && <p className="notice info mb-4">Nenhum movimento neste dia.</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Clientes" icon={<Radio />}>
          <div className="act-stats">
            <Stat value={clients.sessions} label="sessões abertas" />
            <Stat
              value={clients.distinct}
              label="identidades"
              title="Sessões distintas por trás das conexões; no stateless, a identidade já é IP + agente + credencial + servidor"
            />
            <Stat value={clients.agents} label="agentes" title="Nomes de agente declarados no initialize" />
            <Stat value={clients.ended} label="encerradas" />
          </div>
          <Slices title="Por transporte" items={clients.byTransport} label={nomeDaFatia(TRANSPORT_LABEL)} />
          <Slices title="Por autenticação" items={clients.byAuth} label={nomeDaFatia(SESSION_AUTH_LABEL)} />
          <Slices title="Motivo de encerramento" items={clients.byEndReason} label={nomeDaFatia(END_LABEL)} empty="nenhuma sessão encerrada neste dia" />
          <Slices title="Agentes mais vistos" items={clients.topAgents} empty="nenhum agente se identificou" />
        </Panel>

        <Panel title="Chamadas" icon={<Plug />}>
          <div className="act-stats">
            <Stat value={calls.total} label="chamadas" title="Mensagens JSON-RPC recebidas pelo MCP público" />
            {callFamilyTiles(calls.byFamily).map((familia) => (
              <Stat key={familia.key} value={familia.count} label={familia.label} tone={familia.tone} />
            ))}
          </div>
          <Slices
            title="Métodos mais chamados"
            items={calls.topMethods}
            // A chave é o método cru; o `label` que vem do banco é a família dele.
            label={(fatia) => fatia.key}
            tone={(fatia) => corDaFamilia(fatia.label)}
            hint={(fatia) => (fatia.label ? `família ${nomeDaFamilia(fatia.label)}` : undefined)}
          />
          <Slices title="Por transporte" items={calls.byTransport} label={nomeDaFatia(TRANSPORT_LABEL)} />
          <Slices title="Por servidor" items={calls.byServer} hint={(fatia) => `/${fatia.key}`} />
        </Panel>

        <Panel title="Leituras" icon={<BookOpenCheck />}>
          <div className="act-stats">
            <Stat value={reads.total} label="leituras" />
            <Stat value={reads.downloads} label="downloads" title="Leituras que foram entrega de pacote" />
            <Stat value={reads.skills} label="skills distintas" />
          </div>
          <Slices title="Por superfície" items={reads.bySurface} label={nomeDaFatia(SURFACE_LABEL)} />
          <Slices title="Por origem" items={reads.byOrigin} label={nomeDaFatia(ORIGIN_LABEL)} />
          <Slices title="Por autenticação" items={reads.byAuth} label={nomeDaFatia(READ_AUTH_LABEL)} />
          <Slices title="Skills mais lidas" items={reads.topSkills} hint={(fatia) => fatia.key} />
        </Panel>

        <Panel title="Catálogo" icon={<ListChecks />}>
          <div className="act-stats">
            <Stat value={catalog.total} label="eventos" />
            <Stat value={catalog.actors} label="atores" title="Contas, tokens e o ambiente, contados sem identificar" />
          </div>
          <Slices
            title="Por ação"
            items={catalog.byAction}
            // O mesmo mapa da trilha: dois rótulos para a mesma ação seriam
            // duas telas dizendo coisas diferentes do mesmo evento.
            label={(fatia) => ACTION_LABEL[fatia.key as AuditAction] ?? fatia.key}
            hint={(fatia) => fatia.key}
            empty="nada mudou no catálogo neste dia"
          />
          <Slices title="Por origem" items={catalog.bySource} label={nomeDaFatia(SOURCE_LABEL)} />
        </Panel>
      </div>
    </section>
  );
}
