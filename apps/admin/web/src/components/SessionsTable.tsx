import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Radio } from 'lucide-react';
import { formatDateTime, formatRelative, type McpSessionPage, type McpSessionSummary } from '../api.js';
import { Badge, Button, EmptyState, Skel, Status, usePolling } from './ui.js';

const PAGE = 50;

const TRANSPORT_LABEL: Record<McpSessionSummary['transport'], string> = {
  streamable: 'Streamable HTTP',
  sse: 'SSE',
  stateless: 'stateless',
};

const END_LABEL: Record<NonNullable<McpSessionSummary['endReason']>, string> = {
  closed: 'fechou',
  timeout: 'timeout',
  shutdown: 'servidor parou',
};

/**
 * A tabela de sessões do MCP público — a mesma na aba do servidor e na
 * auditoria global (com a coluna do servidor). Uma linha por cliente:
 * IP de origem, agente, transporte, credencial, início, última atividade e o
 * fim (real ou presumido pelo timeout). Atualiza sozinha enquanto a aba
 * estiver visível.
 */
export function SessionsTable({
  load,
  showMcp,
  onlineWindowMs,
  refreshKey = 0,
}: {
  load: (query: { online?: boolean; limit: number; offset: number }) => Promise<McpSessionPage>;
  showMcp?: boolean;
  onlineWindowMs: number;
  refreshKey?: number;
}) {
  const [page, setPage] = useState<McpSessionPage | null>(null);
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(async () => {
    try {
      setPage(await load({ online: onlineOnly || undefined, limit: PAGE, offset }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [load, onlineOnly, offset]);

  useEffect(() => {
    setPage(null);
    void fetchPage();
  }, [fetchPage, refreshKey]);

  usePolling(fetchPage, 15_000);

  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE, total);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="segmented">
          <button type="button" className={onlineOnly ? '' : 'active'} onClick={() => { setOnlineOnly(false); setOffset(0); }}>
            Todas
          </button>
          <button type="button" className={onlineOnly ? 'active' : ''} onClick={() => { setOnlineOnly(true); setOffset(0); }}>
            <Radio /> Online agora
          </button>
        </div>
        <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
          Online = sem fim e com requisição nos últimos {Math.round(onlineWindowMs / 1000)} s. Sessões sem id (stateless) agrupam
          as requisições de um mesmo cliente dentro dessa janela.
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          {from}–{to} de {total}
          <button type="button" className="icon-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} title="Anterior">
            <ChevronLeft />
          </button>
          <button type="button" className="icon-btn" disabled={to >= total} onClick={() => setOffset(offset + PAGE)} title="Próxima">
            <ChevronRight />
          </button>
        </span>
      </div>

      {error && <p className="notice danger mb-3">{error}</p>}

      {!page ? (
        <Skel h={240} />
      ) : page.items.length === 0 ? (
        <EmptyState
          icon={<Radio />}
          title={onlineOnly ? 'Ninguém conectado agora' : 'Nenhuma sessão registrada'}
          description={
            onlineOnly
              ? 'Assim que um cliente chamar o servidor, ele aparece aqui.'
              : 'As sessões são gravadas pelo MCP público a cada conexão; a tabela começa a encher no primeiro cliente.'
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Estado</th>
                <th>Cliente</th>
                <th>IP de origem</th>
                {showMcp && <th>Servidor</th>}
                <th>Transporte</th>
                <th>Acesso</th>
                <th>Início</th>
                <th>Última atividade</th>
                <th>Fim</th>
                <th className="num">Req.</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((session) => (
                <SessionRow key={session.id} session={session} showMcp={showMcp} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SessionRow({ session, showMcp }: { session: McpSessionSummary; showMcp?: boolean }) {
  const client = session.clientName
    ? `${session.clientName}${session.clientVersion ? ` ${session.clientVersion}` : ''}`
    : session.userAgent
      ? session.userAgent
      : '—';
  const state = session.endedAt ? 'encerrada' : session.isOnline ? 'online' : 'ociosa';

  return (
    <tr className={session.endedAt ? 'is-off' : undefined}>
      <td>
        <Status tone={state === 'online' ? 'ok' : state === 'ociosa' ? 'warn' : 'off'} pulse={state === 'online'}>
          {state}
        </Status>
      </td>
      <td>
        <span className="row-title" title={session.userAgent ?? undefined} style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {client}
        </span>
        <span className="row-sub" title={session.sessionId}>
          {session.sessionId.slice(0, 18)}
          {session.sessionId.length > 18 ? '…' : ''}
        </span>
      </td>
      <td className="mono text-xs">{session.ip}</td>
      {showMcp && (
        <td>
          {session.virtualMcpUuid ? (
            <Link to={`/mcps/${session.virtualMcpSlug}`} className="row-title">
              {session.virtualMcpSlug}
            </Link>
          ) : (
            <span className="row-title" style={{ color: 'var(--text-faint)' }}>{session.virtualMcpSlug}</span>
          )}
          <span className="row-sub">{session.mount === 'root' ? '/mcp' : `/virtual/${session.virtualMcpSlug}`}</span>
        </td>
      )}
      <td>
        <Badge mono>{TRANSPORT_LABEL[session.transport]}</Badge>
      </td>
      <td>
        {session.auth === 'open' ? (
          <Badge tone="warn">aberto</Badge>
        ) : (
          <Badge tone="outline" title={session.keyId ?? undefined}>
            chave{session.keyName ? ` · ${session.keyName}` : ''}
          </Badge>
        )}
      </td>
      <td className="whitespace-nowrap text-xs">{formatDateTime(session.startedAt)}</td>
      <td className="whitespace-nowrap text-xs" title={formatDateTime(session.lastSeenAt)}>
        {formatRelative(session.lastSeenAt)}
      </td>
      <td className="whitespace-nowrap text-xs">
        {session.endedAt ? (
          <>
            {formatDateTime(session.endedAt)}
            {session.endReason && <span className="row-sub">{END_LABEL[session.endReason]}</span>}
          </>
        ) : (
          <span style={{ color: 'var(--text-faint)' }}>—</span>
        )}
      </td>
      <td className="num mono text-xs">{session.requestCount}</td>
    </tr>
  );
}

export function SessionsRefresh({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick}>
      Atualizar
    </Button>
  );
}
