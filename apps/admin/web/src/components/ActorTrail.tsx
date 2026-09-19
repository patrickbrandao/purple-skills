import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDateTime, formatRelative, getAudit, type AuditPage } from '../api.js';
import { ACTION_LABEL, ACTION_TONE } from '../audit.js';
import { Badge, EmptyRow, Skel } from './ui.js';

const PAGE = 50;

/**
 * A guia "Atividade" da ficha de uma conta (`docs/13-fichas-e-acessos.md`
 * §3.4): a trilha de auditoria filtrada pelo ator — o que esta pessoa fez,
 * pelo painel ou pelo mcp-admin com uma chave `psk_`. É a mesma consulta da
 * página de Auditoria, com o ator fixo e sem os outros filtros.
 */
export function ActorTrail({ actor }: { actor: string }) {
  const [page, setPage] = useState<AuditPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Uma busca por interação: o cleanup descarta a resposta atrasada — senão a
  // consulta antiga sobrescreve a nova e o rodapé acaba descrevendo outra faixa
  // de linhas, ou a trilha da conta anterior, ao trocar de página ou de ficha.
  useEffect(() => {
    let active = true;
    setPage(null);
    setError(null);
    getAudit({ actor, limit: PAGE, offset })
      .then((data) => active && setPage(data))
      .catch((err) => active && setError((err as Error).message));
    return () => {
      active = false;
    };
  }, [actor, offset]);

  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE, total);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        <span className="mr-auto">{page ? `${from}–${to} de ${total} evento${total === 1 ? '' : 's'}` : 'Carregando…'}</span>
        <button type="button" className="icon-btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} title="Anterior">
          <ChevronLeft />
        </button>
        <button type="button" className="icon-btn" disabled={to >= total} onClick={() => setOffset(offset + PAGE)} title="Próxima">
          <ChevronRight />
        </button>
      </div>

      {error && <p className="notice danger mb-3">{error}</p>}

      {!page ? (
        <Skel h={240} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Quando</th>
                <th>Ação</th>
                <th>Alvo</th>
                <th className="hidden sm:table-cell">Origem</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((entry) => (
                <tr key={entry.id}>
                  <td className="whitespace-nowrap">
                    <span className="row-title text-xs">{formatRelative(entry.createdAt)}</span>
                    <span className="row-sub">{formatDateTime(entry.createdAt)}</span>
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
                  <td className="hidden sm:table-cell">
                    <Badge mono tone="outline">
                      {entry.source}
                    </Badge>
                  </td>
                </tr>
              ))}
              {page.items.length === 0 && <EmptyRow colSpan={4}>Nenhum evento desta conta ainda</EmptyRow>}
            </tbody>
          </table>
        </div>
      )}

      <p className="panel-hint mt-3 mb-0">
        O que esta conta fez no acervo, pelo painel ou pelo MCP administrativo: a mesma trilha da Auditoria, filtrada
        pelo e-mail. Leituras não entram aqui — estão em Acessos.
      </p>
    </div>
  );
}
