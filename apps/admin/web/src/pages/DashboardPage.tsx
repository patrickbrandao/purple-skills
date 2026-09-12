import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  canManageUsers,
  canWrite,
  formatDateTime,
  getAudit,
  getStats,
  listSkills,
  type AuditEntry,
  type SessionUser,
  type SkillSummary,
  type Stats,
} from '../api.js';
import { Badge, Panel, PublicationBadges } from '../components/ui.js';
import { HistoryIcon, PlusIcon, TrendIcon } from '../components/Icons.js';

const ACTION_LABEL: Record<AuditEntry['action'], string> = {
  create: 'criou',
  update: 'atualizou',
  delete: 'removeu',
  'user.create': 'criou conta',
  'user.role': 'mudou papel',
  'user.deactivate': 'desativou',
  'key.create': 'emitiu chave',
  'key.revoke': 'revogou chave',
  'mcp.create': 'criou MCP virtual',
  'mcp.update': 'alterou MCP virtual',
  'mcp.delete': 'removeu MCP virtual',
  'mcp.default': 'escolheu o MCP padrão',
  'mcp.key.create': 'emitiu chave de MCP',
  'mcp.key.revoke': 'revogou chave de MCP',
  // Chaves psp_ do antigo MCP principal: nada mais as emite, a trilha ainda as mostra.
  'public.key.create': 'emitiu chave do MCP principal',
  'public.key.revoke': 'revogou chave do MCP principal',
};

/** Eventos de conta não têm skill: o alvo é a própria pessoa ou a chave. */
const ACTION_CLASS: Record<AuditEntry['action'], string> = {
  create: 'create',
  update: 'update',
  delete: 'delete',
  'user.create': 'create',
  'user.role': 'update',
  'user.deactivate': 'delete',
  'key.create': 'create',
  'key.revoke': 'delete',
  'mcp.create': 'create',
  'mcp.update': 'update',
  'mcp.delete': 'delete',
  'mcp.default': 'update',
  'mcp.key.create': 'create',
  'mcp.key.revoke': 'delete',
  'public.key.create': 'create',
  'public.key.revoke': 'delete',
};

export function DashboardPage({ user }: { user: SessionUser }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [top, setTop] = useState<SkillSummary[]>([]);

  // A trilha expõe e-mail de quem agiu e de quem sofreu a ação: `/api/audit` é
  // restrita a admin, então nem pedimos nem mostramos o painel para os demais.
  const showAudit = canManageUsers(user.role);

  useEffect(() => {
    getStats().then(setStats).catch(() => void 0);
    if (showAudit) {
      getAudit()
        .then((data) => setAudit(data.items.slice(0, 12)))
        .catch(() => void 0);
    }
    listSkills({ limit: 6, sort: 'score' })
      .then((data) => setTop(data.items))
      .catch(() => void 0);
  }, [showAudit]);

  // Milhar separado: 28410 acessos é bem menos legível que 28.410.
  const num = (value: number | undefined) =>
    value === undefined ? '—' : value.toLocaleString('pt-BR');

  const cards = [
    { k: 'Skills', v: num(stats?.totalSkills), h: `${stats?.publicSkills ?? 0} públicas` },
    { k: 'Arquivos', v: num(stats?.totalFiles), h: `${stats?.totalTags ?? 0} tags` },
    { k: 'Acessos', v: num(stats?.totalViews), h: 'SKILL.md visualizado' },
    { k: 'Downloads', v: num(stats?.totalDownloads), h: 'pacotes .zip' },
    { k: 'Contas', v: num(stats?.totalUsers), h: `${stats?.activeUsers ?? 0} ativas` },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="display">Visão geral</h1>
          <p className="sub">Estado do catálogo e atividade recente.</p>
        </div>
        {canWrite(user.role) && (
          <Link to="/skills/new" className="btn btn-primary">
            <PlusIcon /> Nova skill
          </Link>
        )}
      </div>

      <div className="stat-grid">
        {cards.map((card) => (
          <div className="stat-card" key={card.k}>
            <p className="k">{card.k}</p>
            <p className="v">{card.v}</p>
            <p className="h">{card.h}</p>
          </div>
        ))}
      </div>

      <div className={`mt-5 grid gap-5 ${showAudit ? 'lg:grid-cols-2' : ''}`}>
        <Panel title="Mais acessadas" icon={<TrendIcon />}>
          <div className="rank-list">
            {top.map((skill) => (
              <Link to={`/skills/${skill.slug}`} key={skill.uuid}>
                <span className="min-w-0 flex-1">
                  <span className="row-title">{skill.name}</span>
                  <span className="row-sub">{skill.slug}</span>
                </span>
                <Badge isPublic={skill.isPublic} />
                <PublicationBadges skill={skill} />
                <span className="pts">{skill.score} pts</span>
              </Link>
            ))}
            {top.length === 0 && <p className="list-empty">Nenhuma skill ainda.</p>}
          </div>
        </Panel>

        {showAudit && (
          <Panel title="Auditoria" icon={<HistoryIcon />}>
            <div className="audit-list">
              {audit.map((entry) => (
                <div className="audit-row" key={entry.id}>
                  <span className="when">{formatDateTime(entry.createdAt)}</span>
                  <span className="who" title={entry.actorLabel ?? 'ator desconhecido'}>
                    {entry.actorLabel ?? '—'}
                  </span>
                  <span className={`act ${ACTION_CLASS[entry.action]}`}>
                    {ACTION_LABEL[entry.action]}
                  </span>
                  <span className="what">
                    {entry.skillSlug ?? entry.targetLabel ?? '—'}
                    {entry.filePath && ` / ${entry.filePath}`}
                  </span>
                  <span className="src">{entry.source}</span>
                </div>
              ))}
              {audit.length === 0 && <p className="list-empty">Sem atividade registrada.</p>}
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}
