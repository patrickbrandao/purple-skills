import { useCallback, useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { ChevronLeft, ChevronRight, History, Radio, Search } from 'lucide-react';
import {
  AUDIT_ACTIONS,
  formatDateTime,
  getAudit,
  getMcps,
  getSessions,
  type AuditAction,
  type AuditPage as AuditPageData,
  type Session,
  type VirtualMcpSummary,
} from '../api.js';
import { ACTION_LABEL, ACTION_TONE } from '../audit.js';
import { SessionsTable } from '../components/SessionsTable.js';
import { Badge, EmptyRow, Field, Skel, Tabs, useDebounced } from '../components/ui.js';

const PAGE = 50;

/**
 * Auditoria, só admin: a trilha de quem fez o quê (com filtros e paginação)
 * e a contabilidade de sessões do MCP público, filtrável por servidor.
 */
export function AuditPage({ session }: { session: Session }) {
  const location = useLocation();
  const tab = location.pathname.endsWith('/sessoes') ? 'sessoes' : 'trilha';

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <h1>Auditoria</h1>
          <p className="sub">Quem fez o quê no catálogo, e quem está conectado aos servidores MCP.</p>
        </div>
      </div>

      <Tabs
        value={tab}
        items={[
          { key: 'trilha', label: 'Trilha', icon: <History />, to: '/auditoria' },
          { key: 'sessoes', label: 'Sessões MCP', icon: <Radio />, to: '/auditoria/sessoes' },
        ]}
      />

      <Routes>
        <Route index element={<Trail />} />
        <Route path="sessoes" element={<Sessions session={session} />} />
      </Routes>
    </div>
  );
}

function Trail() {
  const [page, setPage] = useState<AuditPageData | null>(null);
  const [action, setAction] = useState<AuditAction | ''>('');
  const [actor, setActor] = useState('');
  const [q, setQ] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const dq = useDebounced(q, 300);
  const dactor = useDebounced(actor, 300);

  const load = useCallback(async () => {
    try {
      setPage(
        await getAudit({
          limit: PAGE,
          offset,
          action: action || undefined,
          actor: dactor.trim() || undefined,
          q: dq.trim() || undefined,
          since: since ? new Date(since).toISOString() : undefined,
          until: until ? new Date(`${until}T23:59:59`).toISOString() : undefined,
        }),
      );
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [offset, action, dactor, dq, since, until]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setOffset(0);
  }, [action, dactor, dq, since, until]);

  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE, total);

  return (
    <>
      <div className="mb-4 grid gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
        <label className="search-bar">
          <Search />
          <input className="field" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Skill, alvo ou arquivo…" />
        </label>
        <input className="field" value={actor} onChange={(e) => setActor(e.target.value)} placeholder="Ator (e-mail, token-global…)" />
        <select className="field" value={action} onChange={(e) => setAction(e.target.value as AuditAction | '')}>
          <option value="">Todas as ações</option>
          {AUDIT_ACTIONS.map((item) => (
            <option key={item} value={item}>
              {ACTION_LABEL[item]} ({item})
            </option>
          ))}
        </select>
        <Field label="" className="!block">
          <input className="field" type="date" value={since} onChange={(e) => setSince(e.target.value)} title="Desde" />
        </Field>
        <Field label="" className="!block">
          <input className="field" type="date" value={until} onChange={(e) => setUntil(e.target.value)} title="Até" />
        </Field>
      </div>

      <div className="mb-3 flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        <span className="mr-auto">
          {page ? `${from}–${to} de ${total} evento${total === 1 ? '' : 's'}` : 'Carregando…'}
        </span>
        <button type="button" className="icon-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} title="Anterior">
          <ChevronLeft />
        </button>
        <button type="button" className="icon-btn" disabled={to >= total} onClick={() => setOffset(offset + PAGE)} title="Próxima">
          <ChevronRight />
        </button>
      </div>

      {error && <p className="notice danger mb-3">{error}</p>}

      {!page ? (
        <Skel h={320} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Quando</th>
                <th>Quem</th>
                <th>Ação</th>
                <th>Alvo</th>
                <th>Origem</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((entry) => (
                <tr key={entry.id}>
                  <td className="whitespace-nowrap mono text-xs">{formatDateTime(entry.createdAt)}</td>
                  <td>
                    <span className="row-title text-[13px]">{entry.actorLabel ?? '—'}</span>
                  </td>
                  <td>
                    <Badge tone={ACTION_TONE[entry.action]}>{ACTION_LABEL[entry.action]}</Badge>
                  </td>
                  <td>
                    {entry.skillSlug ? (
                      <Link to={`/skills/${entry.skillSlug}`} className="row-title mono text-xs">
                        {entry.skillSlug}
                        {entry.filePath && <span style={{ color: 'var(--text-faint)' }}> / {entry.filePath}</span>}
                      </Link>
                    ) : (
                      <span className="mono text-xs">{entry.targetLabel ?? '—'}</span>
                    )}
                  </td>
                  <td>
                    <Badge mono tone="outline">
                      {entry.source}
                    </Badge>
                  </td>
                </tr>
              ))}
              {page.items.length === 0 && (
                <EmptyRow colSpan={5}>{action || actor || q || since || until ? 'Nenhum evento com esses filtros' : 'Nenhum evento ainda'}</EmptyRow>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Sessions({ session }: { session: Session }) {
  const [mcps, setMcps] = useState<VirtualMcpSummary[]>([]);
  const [mcp, setMcp] = useState('');

  useEffect(() => {
    getMcps()
      .then((data) => setMcps(data.items))
      .catch(() => setMcps([]));
  }, []);

  const load = useCallback(
    (query: { online?: boolean; limit: number; offset: number }) => getSessions({ ...query, mcp: mcp || undefined }),
    [mcp],
  );

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <select className="field" style={{ width: 'auto', minWidth: 240 }} value={mcp} onChange={(e) => setMcp(e.target.value)}>
          <option value="">Todos os servidores</option>
          {mcps.map((item) => (
            <option key={item.uuid} value={item.slug}>
              {item.name} (/{item.slug})
              {item.onlineSessions > 0 ? ` · ${item.onlineSessions} online` : ''}
            </option>
          ))}
        </select>
      </div>
      <SessionsTable load={load} showMcp onlineWindowMs={session.onlineWindowMs} />
    </>
  );
}
