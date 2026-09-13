import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Bell, History, Info } from 'lucide-react';
import {
  canManageUsers,
  formatRelative,
  getAudit,
  getSettings,
  getStats,
  getUsers,
  type AuditEntry,
  type Session,
  type SessionUser,
} from '../../api.js';
import { EmptyState, useClickOutside, useStored } from '../ui.js';
import { ACTION_LABEL } from '../../audit.js';

type Warning = { id: string; text: string; to: string; tone: 'warn' | 'info' };

const SEEN_KEY = 'purple-skills-admin:audit-seen';

/**
 * O sino: avisos calculados da instalação (o que está faltando ou pendente,
 * cada um com o link para a tela que resolve) e, para admin, os últimos
 * eventos da trilha — os mais novos que a última abertura contam como não
 * lidos. Nada disso é tabela nova: é o que as telas já sabem, reunido.
 */
export function Notifications({ session, user }: { session: Session; user: SessionUser }) {
  const admin = canManageUsers(user.role);
  const [open, setOpen] = useState(false);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [seenAt, setSeenAt] = useStored<string>(SEEN_KEY, '');
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close, open);

  const load = useCallback(async () => {
    const next: Warning[] = [];
    if (user.legacy) {
      next.push({
        id: 'legacy',
        text: 'Você entrou com a ADMIN_PASSWORD e a auditoria não sabe quem é você. Saia e crie o primeiro administrador.',
        to: '/account',
        tone: 'warn',
      });
    }
    const [stats, settings, users, trail] = await Promise.all([
      getStats().catch(() => null),
      admin ? getSettings().catch(() => null) : null,
      admin && !user.legacy ? getUsers().catch(() => null) : null,
      admin ? getAudit({ limit: 10 }).catch(() => null) : null,
    ]);
    if (settings) {
      const status = settings.defaultMcp.status;
      if (status === 'none') {
        next.push({ id: 'default-none', text: 'Nenhum MCP padrão: /mcp responde 404 até você escolher um servidor.', to: '/configuracoes', tone: 'warn' });
      } else if (status === 'deleted') {
        next.push({ id: 'default-deleted', text: 'O MCP padrão foi removido: /mcp responde 404 até escolher outro.', to: '/configuracoes', tone: 'warn' });
      } else if (status === 'inactive') {
        next.push({ id: 'default-off', text: `O MCP padrão "${settings.defaultMcp.slug}" está desligado: /mcp responde 404.`, to: `/mcps/${settings.defaultMcp.slug}`, tone: 'warn' });
      }
    }
    if (stats && stats.unlinkedSkills > 0) {
      next.push({
        id: 'unlinked',
        text: `${stats.unlinkedSkills} skill${stats.unlinkedSkills === 1 ? '' : 's'} sem vínculo: não aparece${stats.unlinkedSkills === 1 ? '' : 'm'} em servidor nenhum.`,
        to: '/skills?filtro=sem-vinculo',
        tone: 'info',
      });
    }
    if (users) {
      const temp = users.items.filter((u) => u.isActive && u.mustChangePassword).length;
      if (temp > 0) {
        next.push({ id: 'temp-pw', text: `${temp} conta${temp === 1 ? '' : 's'} ainda com senha temporária.`, to: '/users', tone: 'info' });
      }
    }
    if (!session.mcpPublicUrl) {
      next.push({ id: 'public-url', text: 'MCP_PUBLIC_URL não está configurada: os endereços de conexão saem incompletos.', to: '/configuracoes', tone: 'info' });
    }
    setWarnings(next);
    if (trail) setAudit(trail.items);
  }, [admin, session.mcpPublicUrl, user.legacy]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const unread = useMemo(
    () => audit.filter((entry) => !seenAt || entry.createdAt > seenAt).length,
    [audit, seenAt],
  );
  const count = warnings.length + unread;

  function toggle() {
    setOpen((o) => {
      // Abrir marca a trilha como vista; os avisos continuam até serem resolvidos.
      if (!o && audit[0]) setSeenAt(audit[0].createdAt);
      return !o;
    });
  }

  return (
    <div ref={ref} className="menu-anchor">
      <button type="button" className="icon-btn bell-btn" onClick={toggle} aria-expanded={open} title="Avisos e atividade">
        <Bell />
        {count > 0 && <span className="n">{count > 99 ? '99+' : count}</span>}
      </button>
      {open && (
        <div className="notif" role="dialog" aria-label="Avisos">
          <div className="nh">
            <span>Avisos</span>
            <span className="text-xs font-normal" style={{ color: 'var(--text-faint)' }}>
              {warnings.length} pendente{warnings.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="nb">
            {warnings.length === 0 && audit.length === 0 && (
              <EmptyState icon={<Bell />} title="Tudo em ordem" description="Nenhum aviso e nenhuma atividade recente." />
            )}
            {warnings.map((warning) => (
              <Link key={warning.id} to={warning.to} className="ni" onClick={close}>
                {warning.tone === 'warn' ? <AlertTriangle className="ic" /> : <Info className="ic info" />}
                <span>{warning.text}</span>
              </Link>
            ))}
            {audit.length > 0 && <div className="grp">Atividade recente</div>}
            {audit.map((entry) => (
              <Link
                key={entry.id}
                to={entry.skillSlug ? `/skills/${entry.skillSlug}` : '/auditoria'}
                className={`ni${!seenAt || entry.createdAt > seenAt ? ' unread' : ''}`}
                onClick={close}
              >
                <History className="ic audit" />
                <span>
                  <strong>{entry.actorLabel ?? '—'}</strong> {ACTION_LABEL[entry.action]}{' '}
                  <span className="mono">{entry.skillSlug ?? entry.targetLabel ?? ''}</span>
                  <span className="w">{formatRelative(entry.createdAt)}</span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
