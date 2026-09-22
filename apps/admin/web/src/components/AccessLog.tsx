import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Globe, KeyRound, Search, UserRound } from 'lucide-react';
import {
  atUser,
  formatDateTime,
  formatRelative,
  type AccessLogQuery,
  type SkillAccessEntry,
  type SkillAccessKind,
  type SkillAccessOrigin,
  type SkillAccessPage,
  type SkillAccessSurface,
} from '../api.js';
import { Badge, EmptyRow, Skel, useDebounced } from './ui.js';
import { SkillIcon } from './SkillIcon.js';

const PAGE = 50;

const ORIGIN_LABEL: Record<SkillAccessOrigin, string> = {
  mcp: 'MCP público',
  site: 'Site',
  'mcp-admin': 'MCP administrativo',
};

const SURFACE_LABEL: Record<SkillAccessSurface, string> = {
  tool: 'get_skill',
  resource: 'resource',
  prompt: 'prompt',
  file: 'SKILL.md',
  download: 'pacote',
  page: 'página',
  'admin-tool': 'get_skill',
};

const KIND_LABEL: Record<SkillAccessKind, string> = { view: 'leitura', download: 'download' };

/**
 * A guia "Acessos" da skill e do catálogo (`docs/13-fichas-e-acessos.md`):
 * os últimos registros de leitura, mais novos primeiro, com a barra de
 * ferramentas que filtra por quem leu — o usuário da conta (pelo mcp-admin),
 * o nome da chave `psv_` do servidor, o IP ou o cliente — e por origem. A
 * mesma tabela serve às duas fichas: no catálogo ela mostra também a skill.
 */
export function AccessLog({
  load,
  showSkill,
}: {
  load: (query: AccessLogQuery) => Promise<SkillAccessPage>;
  /** No catálogo: cada linha diz qual skill foi lida. */
  showSkill?: boolean;
}) {
  const [page, setPage] = useState<SkillAccessPage | null>(null);
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 300);
  const [origin, setOrigin] = useState<SkillAccessOrigin | ''>('');
  const [kind, setKind] = useState<SkillAccessKind | ''>('');
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Uma busca por interação: cada filtro volta à primeira página no mesmo
  // render (o `setOffset(0)` está no próprio campo) e o cleanup descarta a
  // resposta atrasada — senão a consulta antiga sobrescreve a nova e o rodapé
  // acaba descrevendo outra faixa de linhas.
  useEffect(() => {
    let active = true;
    setPage(null);
    setError(null);
    load({ q: dq, origin, kind, limit: PAGE, offset })
      .then((data) => active && setPage(data))
      .catch((err) => active && setError((err as Error).message));
    return () => {
      active = false;
    };
  }, [load, dq, origin, kind, offset]);

  const total = page?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE, total);
  const columns = showSkill ? 7 : 6;

  return (
    <div>
      <div className="mb-4 grid gap-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <label className="search-bar">
          <Search />
          <input
            className="field"
            type="search"
            value={q}
            onChange={(event) => {
              setQ(event.target.value);
              setOffset(0);
            }}
            placeholder="Usuário, chave de API, IP ou cliente…"
          />
        </label>
        <select
          className="field"
          value={origin}
          onChange={(event) => {
            setOrigin(event.target.value as SkillAccessOrigin | '');
            setOffset(0);
          }}
          aria-label="Origem"
        >
          <option value="">Todas as origens</option>
          {(Object.keys(ORIGIN_LABEL) as SkillAccessOrigin[]).map((item) => (
            <option key={item} value={item}>
              {ORIGIN_LABEL[item]}
            </option>
          ))}
        </select>
        <select
          className="field"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as SkillAccessKind | '');
            setOffset(0);
          }}
          aria-label="Tipo"
        >
          <option value="">Leituras e downloads</option>
          <option value="view">Só leituras</option>
          <option value="download">Só downloads</option>
        </select>
      </div>

      <div className="mb-3 flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        <span className="mr-auto">
          {page ? `${from}–${to} de ${total} acesso${total === 1 ? '' : 's'}` : error ? 'não foi possível carregar' : 'Carregando…'}
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
        <Skel h={240} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Quando</th>
                {showSkill && <th>Skill</th>}
                <th>Quem</th>
                <th>Origem</th>
                <th className="hidden md:table-cell">Servidor</th>
                <th className="hidden lg:table-cell">Cliente</th>
                <th className="hidden sm:table-cell">IP</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((entry) => (
                <AccessRow key={entry.id} entry={entry} showSkill={showSkill} />
              ))}
              {page.items.length === 0 && (
                <EmptyRow colSpan={columns}>{dq || origin || kind ? 'Nenhum acesso com esse filtro' : 'Nenhum acesso registrado ainda'}</EmptyRow>
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="panel-hint mt-3 mb-0">
        Cada linha é uma leitura do SKILL.md ou um download do pacote, pelo MCP público (ferramenta, resource, prompt ou
        arquivo), pelo site ou pelo MCP administrativo. Quem leu é a conta (pela chave <code>psk_</code>), a chave{' '}
        <code>psv_</code> do servidor, ou ninguém, num servidor aberto ou no site.
      </p>
    </div>
  );
}

/** Quem leu, no formato que a coluna mostra: conta, chave do servidor, aberto ou anônimo. */
function Who({ entry }: { entry: SkillAccessEntry }) {
  if (entry.auth === 'user') {
    return (
      <>
        <span className="row-title flex items-center gap-1.5">
          <UserRound style={{ width: 13, height: 13, color: 'var(--text-faint)' }} />
          {atUser(entry.userUsername, 'conta removida')}
        </span>
        {entry.apiKeyName && <span className="row-sub">chave psk · {entry.apiKeyName}</span>}
      </>
    );
  }
  if (entry.auth === 'key') {
    return (
      <>
        <span className="row-title flex items-center gap-1.5">
          <KeyRound style={{ width: 13, height: 13, color: 'var(--text-faint)' }} />
          {entry.keyName ?? 'chave removida'}
        </span>
        <span className="row-sub">chave psv do servidor</span>
      </>
    );
  }
  if (entry.auth === 'open') {
    return (
      <>
        <span className="row-title flex items-center gap-1.5">
          <Globe style={{ width: 13, height: 13, color: 'var(--text-faint)' }} />
          sem credencial
        </span>
        <span className="row-sub">servidor aberto</span>
      </>
    );
  }
  return (
    <>
      <span className="row-title flex items-center gap-1.5">
        <Globe style={{ width: 13, height: 13, color: 'var(--text-faint)' }} />
        anônimo
      </span>
      <span className="row-sub">visitante do site</span>
    </>
  );
}

function AccessRow({ entry, showSkill }: { entry: SkillAccessEntry; showSkill?: boolean }) {
  const client = entry.clientName
    ? `${entry.clientName}${entry.clientVersion ? ` ${entry.clientVersion}` : ''}`
    : entry.userAgent ?? '—';

  return (
    <tr>
      <td className="whitespace-nowrap">
        <span className="row-title text-xs">{formatRelative(entry.createdAt)}</span>
        <span className="row-sub">{formatDateTime(entry.createdAt)}</span>
      </td>
      {showSkill && (
        <td>
          {entry.skillUuid ? (
            <Link to={`/skills/${entry.skillSlug}`} className="flex items-center gap-2 no-underline">
              <SkillIcon icon={null} name={entry.skillName} slug={entry.skillSlug} size="sm" />
              <span className="min-w-0">
                <span className="row-title">{entry.skillName}</span>
                <span className="row-sub">{entry.skillSlug}</span>
              </span>
            </Link>
          ) : (
            <span>
              <span className="row-title" style={{ color: 'var(--text-faint)' }}>{entry.skillName}</span>
              <span className="row-sub">{entry.skillSlug} · removida</span>
            </span>
          )}
        </td>
      )}
      <td>
        <Who entry={entry} />
      </td>
      <td>
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge tone={entry.kind === 'download' ? 'info' : 'outline'}>{KIND_LABEL[entry.kind]}</Badge>
          <Badge mono title={ORIGIN_LABEL[entry.origin]}>
            {SURFACE_LABEL[entry.surface]}
          </Badge>
        </span>
        <span className="row-sub">{ORIGIN_LABEL[entry.origin]}</span>
      </td>
      <td className="hidden md:table-cell">
        {entry.virtualMcpSlug ? (
          <>
            {entry.virtualMcpUuid ? (
              <Link to={`/mcps/${entry.virtualMcpSlug}`} className="row-title">
                {entry.virtualMcpName ?? entry.virtualMcpSlug}
              </Link>
            ) : (
              <span className="row-title" style={{ color: 'var(--text-faint)' }}>
                {entry.virtualMcpName ?? entry.virtualMcpSlug} · removido
              </span>
            )}
            <span className="row-sub">
              /virtual/{entry.virtualMcpSlug}
              {entry.catalogs.length > 0 && (
                <>
                  {' · via '}
                  {entry.catalogs.map((catalog, index) => (
                    <span key={`${catalog.slug}-${index}`}>
                      {index > 0 && ', '}
                      {catalog.uuid ? (
                        <Link to={`/catalogs/${catalog.slug}`} className="link">
                          {catalog.name}
                        </Link>
                      ) : (
                        catalog.name
                      )}
                    </span>
                  ))}
                </>
              )}
            </span>
          </>
        ) : (
          <span style={{ color: 'var(--text-faint)' }}>—</span>
        )}
      </td>
      <td className="hidden lg:table-cell">
        <span className="row-title text-xs" title={entry.userAgent ?? undefined} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
          {client}
        </span>
        {entry.sessionId && (
          <span className="row-sub" title={entry.sessionId}>
            {entry.sessionId.slice(0, 18)}
            {entry.sessionId.length > 18 ? '…' : ''}
          </span>
        )}
      </td>
      <td className="mono text-xs hidden sm:table-cell">{entry.ip ?? '—'}</td>
    </tr>
  );
}
