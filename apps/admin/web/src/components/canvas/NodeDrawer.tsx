import { Link } from 'react-router-dom';
import { ExternalLink, Globe, Library, Radio, Server, Trash2, X } from 'lucide-react';
import { num, type OnlineCount, type VirtualMcpDetail } from '../../api.js';
import { Badge, Button, McpStateBadges } from '../ui.js';
import { SkillIcon } from '../SkillIcon.js';
import { effectivePorts, hasPending, type Pending } from './pending.js';
import { PORTS, PORT_LABEL, type Port, type Target } from './types.js';

export type Selection = { kind: 'server' } | { kind: 'internet' } | Target | null;

/**
 * A gaveta à direita do palco: o detalhe do que está selecionado, sem tirar o
 * canvas da tela. O nó continua onde está; o viewport é que se desloca.
 */
export function NodeDrawer({
  selection,
  detail,
  online,
  onlineWindowMs,
  pending,
  canEdit,
  onClose,
  onTogglePort,
  onRemove,
  onOpenSessions,
}: {
  selection: Selection;
  detail: VirtualMcpDetail;
  online: OnlineCount | null;
  onlineWindowMs: number;
  /** As escritas em andamento no palco: decidem o "ocupado" e o que as caixas mostram. */
  pending: readonly Pending[];
  canEdit: boolean;
  onClose: () => void;
  onTogglePort: (target: Target, port: Port, on: boolean) => void;
  onRemove: (target: Target) => void;
  onOpenSessions: () => void;
}) {
  if (!selection) return null;

  const closeButton = (
    <button type="button" className="icon-btn" onClick={onClose} title="Fechar (Esc)">
      <X />
    </button>
  );

  const busy = (target: Target) => hasPending(pending, target);

  const portBoxes = (target: Target, flags: { asSkill: boolean; asPrompt: boolean; asResource: boolean }, hint: string) => {
    // As mesmas portas que as arestas desenham: a caixa clicada fica como foi
    // deixada enquanto grava, em vez de voltar sozinha até o detalhe chegar —
    // o que fazia o clique parecer que não pegou e pedia um segundo.
    const ports = effectivePorts(flags, pending, target);
    return (
      <div className="sec">
        <p className="eyebrow">Portas neste servidor</p>
        <div className="grid gap-2">
          {PORTS.map((port) => (
            <label key={port} className="check well">
              <input
                type="checkbox"
                checked={ports.includes(port)}
                disabled={!canEdit || busy(target)}
                onChange={(event) => onTogglePort(target, port, event.target.checked)}
              />
              {PORT_LABEL[port]}
            </label>
          ))}
        </div>
        <p className="hint">{hint}</p>
      </div>
    );
  };

  if (selection.kind === 'skill') {
    const skill = detail.skills.find((item) => item.slug === selection.slug);
    if (!skill) return null;
    return (
      <aside className="drawer" aria-label={skill.name}>
        <div className="dh">
          <SkillIcon icon={skill.icon} name={skill.name} slug={skill.slug} size="sm" />
          <span className="t">{skill.name}</span>
          {closeButton}
        </div>
        <div className="db">
          <p className="mono text-xs" style={{ color: 'var(--text-faint)' }}>
            {skill.slug}
          </p>
          <p className="mt-2 text-[13px]" style={{ color: 'var(--text-dim)' }}>
            {skill.description || 'Sem descrição.'}
          </p>

          {portBoxes(selection, skill, 'Desmarcar a última porta tira a skill do servidor.')}

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
              <Button variant="danger" size="sm" disabled={busy(selection)} onClick={() => onRemove(selection)}>
                <Trash2 /> Tirar do servidor
              </Button>
            )}
          </div>
        </div>
      </aside>
    );
  }

  if (selection.kind === 'catalog') {
    const catalog = detail.catalogs.find((item) => item.slug === selection.slug);
    if (!catalog) return null;
    // Membros que já são nó próprio aqui seguem o vínculo direto, não o catálogo.
    const overridden = catalog.skillCount - catalog.activeSkillCount;
    return (
      <aside className="drawer" aria-label={catalog.name}>
        <div className="dh">
          <Library size={18} style={{ color: 'var(--accent-soft)' }} />
          <span className="t">{catalog.name}</span>
          {closeButton}
        </div>
        <div className="db">
          <p className="mono text-xs" style={{ color: 'var(--text-faint)' }}>
            catálogo · {catalog.slug}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {!catalog.isActive && (
              <Badge tone="danger" title="Desligado na página do catálogo: não entrega nada até religar">
                desligado
              </Badge>
            )}
            {catalog.isActive && catalog.activeSkillCount === 0 && <Badge tone="outline">nenhuma skill ativa</Badge>}
          </div>
          <p className="mt-2 text-[13px]" style={{ color: 'var(--text-dim)' }}>
            {catalog.description || 'Sem descrição.'}
          </p>

          {portBoxes(selection, catalog, 'As portas valem para todas as skills do catálogo. Desmarcar a última tira o catálogo do servidor.')}

          <div className="sec">
            <p className="eyebrow">O que entra por aqui</p>
            <dl className="kv">
              <dt>Skills ativas</dt>
              <dd>
                <strong>{catalog.activeSkillCount}</strong>
              </dd>
              <dt>Membros</dt>
              <dd>{catalog.skillCount}</dd>
              <dt>Posição</dt>
              <dd className="mono">{catalog.position ? `${catalog.position.x}, ${catalog.position.y}` : 'automática'}</dd>
            </dl>
            {overridden > 0 && (
              <p className="hint">
                {overridden} membro{overridden === 1 ? '' : 's'} não conta{overridden === 1 ? '' : 'm'} aqui: participação desativada, skill
                desligada ou vínculo direto com este servidor (que prevalece sobre o catálogo).
              </p>
            )}
          </div>

          <div className="sec flex flex-wrap gap-2">
            <Link to={`/catalogs/${catalog.slug}`} className="btn btn-ghost btn-sm">
              <ExternalLink /> Abrir catálogo
            </Link>
            {canEdit && (
              <Button variant="danger" size="sm" disabled={busy(selection)} onClick={() => onRemove(selection)}>
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
          {closeButton}
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

  const catalogSkills = detail.catalogs.reduce((sum, catalog) => sum + (catalog.isActive ? catalog.activeSkillCount : 0), 0);

  return (
    <aside className="drawer" aria-label={detail.name}>
      <div className="dh">
        <Server size={18} style={{ color: 'var(--accent-soft)' }} />
        <span className="t">{detail.name}</span>
        {closeButton}
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
            <dt>Catálogos</dt>
            <dd>
              {detail.catalogs.length}
              {catalogSkills > 0 && ` (+${catalogSkills} skill${catalogSkills === 1 ? '' : 's'})`}
            </dd>
            <dt>Chaves ativas</dt>
            <dd>{detail.activeKeyCount}</dd>
            <dt>Dono</dt>
            <dd>
              {detail.ownerUsername ? (
                `@${detail.ownerUsername}`
              ) : (
                <Badge tone="outline">sem dono (só admin)</Badge>
              )}
            </dd>
          </dl>
        </div>
        <div className="sec flex flex-wrap gap-2">
          <Link to={`/mcps/${detail.slug}/settings`} className="btn btn-ghost btn-sm">
            Configurações
          </Link>
          <Link to={`/mcps/${detail.slug}/keys`} className="btn btn-ghost btn-sm">
            Chaves
          </Link>
          <Link to={`/mcps/${detail.slug}/sessions`} className="btn btn-ghost btn-sm">
            Sessões
          </Link>
        </div>
      </div>
    </aside>
  );
}
