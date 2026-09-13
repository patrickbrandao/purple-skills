import { Link } from 'react-router-dom';
import { ExternalLink, Globe, Radio, Server, Trash2, X } from 'lucide-react';
import { num, type OnlineCount, type VirtualMcpDetail, type VirtualMcpSkill } from '../../api.js';
import { Badge, Button, McpStateBadges } from '../ui.js';
import { SkillIcon } from '../SkillIcon.js';
import { PORTS, PORT_LABEL, flagsToPorts, type Port } from './types.js';

export type Selection = { kind: 'server' } | { kind: 'internet' } | { kind: 'skill'; slug: string } | null;

/**
 * A gaveta à direita do palco: o detalhe do que está selecionado, sem tirar o
 * canvas da tela. O nó continua onde está; o viewport é que se desloca.
 */
export function NodeDrawer({
  selection,
  detail,
  online,
  onlineWindowMs,
  busySlug,
  canEdit,
  onClose,
  onTogglePort,
  onRemoveSkill,
  onOpenSessions,
}: {
  selection: Selection;
  detail: VirtualMcpDetail;
  online: OnlineCount | null;
  onlineWindowMs: number;
  busySlug: string | null;
  canEdit: boolean;
  onClose: () => void;
  onTogglePort: (skill: VirtualMcpSkill, port: Port, on: boolean) => void;
  onRemoveSkill: (skill: VirtualMcpSkill) => void;
  onOpenSessions: () => void;
}) {
  if (!selection) return null;

  if (selection.kind === 'skill') {
    const skill = detail.skills.find((item) => item.slug === selection.slug);
    if (!skill) return null;
    const ports = flagsToPorts(skill);
    return (
      <aside className="drawer" aria-label={skill.name}>
        <div className="dh">
          <SkillIcon icon={skill.icon} name={skill.name} slug={skill.slug} size="sm" />
          <span className="t">{skill.name}</span>
          <button type="button" className="icon-btn" onClick={onClose} title="Fechar (Esc)">
            <X />
          </button>
        </div>
        <div className="db">
          <p className="mono text-xs" style={{ color: 'var(--text-faint)' }}>
            {skill.slug}
          </p>
          <p className="mt-2 text-[13px]" style={{ color: 'var(--text-dim)' }}>
            {skill.description || 'Sem descrição.'}
          </p>

          <div className="sec">
            <p className="eyebrow">Portas neste servidor</p>
            <div className="grid gap-2">
              {PORTS.map((port) => (
                <label key={port} className="check well">
                  <input
                    type="checkbox"
                    checked={ports.includes(port)}
                    disabled={!canEdit || busySlug === skill.slug}
                    onChange={(event) => onTogglePort(skill, port, event.target.checked)}
                  />
                  {PORT_LABEL[port]}
                </label>
              ))}
            </div>
            <p className="hint">Desmarcar a última porta tira a skill do servidor.</p>
          </div>

          <div className="sec">
            <p className="eyebrow">Uso por este servidor</p>
            <dl className="kv">
              <dt>Acessos</dt>
              <dd>{num(skill.viewCount)}</dd>
              <dt>Downloads</dt>
              <dd>{num(skill.downloadCount)}</dd>
              <dt>Posição</dt>
              <dd className="mono">{skill.position ? `${skill.position.x}, ${skill.position.y}` : 'automática'}</dd>
            </dl>
          </div>

          <div className="sec flex flex-wrap gap-2">
            <Link to={`/skills/${skill.slug}`} className="btn btn-ghost btn-sm">
              <ExternalLink /> Abrir skill
            </Link>
            {canEdit && (
              <Button variant="danger" size="sm" disabled={busySlug === skill.slug} onClick={() => onRemoveSkill(skill)}>
                <Trash2 /> Tirar do servidor
              </Button>
            )}
          </div>
        </div>
      </aside>
    );
  }

  if (selection.kind === 'internet') {
    return (
      <aside className="drawer" aria-label="Internet">
        <div className="dh">
          <Globe size={18} style={{ color: online && online.total > 0 ? 'var(--ok)' : 'var(--text-muted)' }} />
          <span className="t">Clientes conectados</span>
          <button type="button" className="icon-btn" onClick={onClose} title="Fechar (Esc)">
            <X />
          </button>
        </div>
        <div className="db">
          <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
            Quem chamou este servidor nos últimos {Math.round(onlineWindowMs / 1000)} segundos, por transporte. Sessões com id
            contam enquanto estiverem abertas e ativas; no stateless cada cliente (IP, agente e credencial) conta uma vez.
          </p>
          <div className="sec">
            <dl className="kv">
              <dt>Online agora</dt>
              <dd>
                <strong>{online?.total ?? '—'}</strong>
              </dd>
              <dt>Streamable HTTP</dt>
              <dd>{online?.byTransport.streamable ?? '—'}</dd>
              <dt>SSE</dt>
              <dd>{online?.byTransport.sse ?? '—'}</dd>
              <dt>Stateless</dt>
              <dd>{online?.byTransport.stateless ?? '—'}</dd>
            </dl>
          </div>
          <div className="sec">
            <Button variant="ghost" size="sm" onClick={onOpenSessions}>
              <Radio /> Ver todas as sessões
            </Button>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="drawer" aria-label={detail.name}>
      <div className="dh">
        <Server size={18} style={{ color: 'var(--accent-soft)' }} />
        <span className="t">{detail.name}</span>
        <button type="button" className="icon-btn" onClick={onClose} title="Fechar (Esc)">
          <X />
        </button>
      </div>
      <div className="db">
        <div className="flex flex-wrap gap-1.5">
          <McpStateBadges mcp={detail} />
        </div>
        <p className="mt-3 text-[13px]" style={{ color: 'var(--text-dim)' }}>
          {detail.description || 'Sem descrição — ela vai para as instruções do servidor, é como o agente sabe do que ele trata.'}
        </p>
        <div className="sec">
          <p className="eyebrow">Portas</p>
          <dl className="kv">
            <dt>Tools</dt>
            <dd>{detail.toolCount} skill{detail.toolCount === 1 ? '' : 's'}</dd>
            <dt>Resources</dt>
            <dd>{detail.resourceCount}</dd>
            <dt>Prompts</dt>
            <dd>{detail.promptCount}</dd>
            <dt>Chaves ativas</dt>
            <dd>{detail.activeKeyCount}</dd>
            <dt>Dono</dt>
            <dd>{detail.ownerEmail ?? <Badge tone="outline">sem dono (só admin)</Badge>}</dd>
          </dl>
        </div>
        <div className="sec flex flex-wrap gap-2">
          <Link to={`/mcps/${detail.slug}/configuracoes`} className="btn btn-ghost btn-sm">
            Configurações
          </Link>
          <Link to={`/mcps/${detail.slug}/chaves`} className="btn btn-ghost btn-sm">
            Chaves
          </Link>
          <Link to={`/mcps/${detail.slug}/sessoes`} className="btn btn-ghost btn-sm">
            Sessões
          </Link>
        </div>
      </div>
    </aside>
  );
}
