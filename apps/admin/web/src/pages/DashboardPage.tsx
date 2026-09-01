import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDateTime, getAudit, getStats, listSkills, type AuditEntry, type SkillSummary, type Stats } from '../api.js';
import { Badge, Card } from '../components/ui.js';
import { HistoryIcon, PlusIcon } from '../components/Icons.js';

const ACTION_LABEL: Record<AuditEntry['action'], string> = {
  create: 'criou',
  update: 'atualizou',
  delete: 'removeu',
};

export function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [top, setTop] = useState<SkillSummary[]>([]);

  useEffect(() => {
    getStats().then(setStats).catch(() => void 0);
    getAudit().then((data) => setAudit(data.items.slice(0, 12))).catch(() => void 0);
    listSkills({ limit: 6, sort: 'score' }).then((data) => setTop(data.items)).catch(() => void 0);
  }, []);

  const cards = [
    { label: 'Skills', value: stats?.totalSkills, hint: `${stats?.publicSkills ?? 0} públicas` },
    { label: 'Arquivos', value: stats?.totalFiles, hint: `${stats?.totalTags ?? 0} tags` },
    { label: 'Acessos', value: stats?.totalViews, hint: 'SKILL.md visualizado' },
    { label: 'Downloads', value: stats?.totalDownloads, hint: 'pacotes .zip' },
  ];

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-purple-50">Visão geral</h1>
          <p className="mt-1 text-sm text-slate-500">Estado do catálogo e atividade recente.</p>
        </div>
        <Link
          to="/skills/new"
          className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-br from-purple-500 to-purple-700 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-purple-950/40 transition hover:from-purple-400 hover:to-purple-600"
        >
          <PlusIcon /> Nova skill
        </Link>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <Card key={card.label}>
            <p className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
              {card.label}
            </p>
            <p className="mt-2 text-3xl font-bold text-purple-100 tabular-nums">
              {card.value ?? '—'}
            </p>
            <p className="mt-1 text-xs text-slate-600">{card.hint}</p>
          </Card>
        ))}
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <Card>
          <h2 className="text-sm font-semibold text-purple-100">Mais acessadas</h2>
          <ul className="mt-3 divide-y divide-purple-400/8">
            {top.map((skill) => (
              <li key={skill.uuid}>
                <Link
                  to={`/skills/${skill.slug}`}
                  className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 transition hover:bg-ink-800"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-purple-100">{skill.name}</span>
                    <span className="block truncate text-xs text-slate-600">{skill.slug}</span>
                  </span>
                  <Badge isPublic={skill.isPublic} />
                  <span className="w-16 text-right text-xs tabular-nums text-slate-500">
                    {skill.score} pts
                  </span>
                </Link>
              </li>
            ))}
            {top.length === 0 && (
              <li className="py-6 text-center text-sm text-slate-600">Nenhuma skill ainda.</li>
            )}
          </ul>
        </Card>

        <Card>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-purple-100">
            <HistoryIcon className="h-4 w-4 text-slate-500" /> Auditoria
          </h2>
          <ul className="mt-3 space-y-1.5">
            {audit.map((entry) => (
              <li key={entry.id} className="flex items-baseline gap-2 text-xs">
                <span className="w-24 shrink-0 tabular-nums text-slate-600">
                  {formatDateTime(entry.createdAt)}
                </span>
                <span
                  className={`shrink-0 font-medium ${
                    entry.action === 'delete'
                      ? 'text-red-400'
                      : entry.action === 'create'
                        ? 'text-emerald-400'
                        : 'text-purple-300'
                  }`}
                >
                  {ACTION_LABEL[entry.action]}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-400">
                  {entry.skillSlug ?? '—'}
                  {entry.filePath && <span className="text-slate-600"> / {entry.filePath}</span>}
                </span>
                <span className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-slate-500">
                  {entry.source}
                </span>
              </li>
            ))}
            {audit.length === 0 && (
              <li className="py-6 text-center text-sm text-slate-600">Sem atividade registrada.</li>
            )}
          </ul>
        </Card>
      </div>
    </>
  );
}
