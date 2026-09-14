import { useState } from 'react';
import { Library } from 'lucide-react';
import type { CatalogSummary, SkillSummary } from '../../api.js';
import { Button, Modal } from '../ui.js';
import { SkillIcon } from '../SkillIcon.js';
import { PORTS, PORT_LABEL, type Port } from './types.js';

const PORT_HINT: Record<Port, string> = {
  tools: 'Aparece em search_skills / get_skill e tem download.',
  resources: 'Lida como resource em skill://<slug>.',
  prompts: 'Oferecida como prompt (slash-command) pelo slug.',
};

/** O que está sendo acrescentado ao servidor: uma skill ou um catálogo inteiro. */
export type Picked = { kind: 'skill'; skill: SkillSummary } | { kind: 'catalog'; catalog: CatalogSummary };

/**
 * Ao acrescentar uma skill (ou um catálogo) ao servidor, a pessoa escolhe por
 * quais portas entra — Tools vem marcada, porque é a porta que o agente
 * descobre sozinho. Um nó só existe com ao menos uma aresta, então zero
 * portas não passa. No catálogo, a escolha vale para todos os membros.
 */
export function AddSkillDialog({
  picked,
  serverName,
  busy,
  onConfirm,
  onClose,
}: {
  picked: Picked | null;
  serverName: string;
  busy: boolean;
  onConfirm: (ports: Port[]) => void;
  onClose: () => void;
}) {
  const [ports, setPorts] = useState<Port[]>(['tools']);
  const name = picked ? (picked.kind === 'skill' ? picked.skill.name : picked.catalog.name) : '';

  return (
    <Modal open={picked !== null} title={picked ? `Adicionar "${name}"` : ''} onClose={onClose}>
      {picked && (
        <>
          <p className="d">
            {picked.kind === 'skill' ? (
              <>
                A skill entra em <strong>{serverName}</strong> pelas portas marcadas. Cada porta vira uma aresta no canvas; tirar a
                última aresta remove a skill do servidor.
              </>
            ) : (
              <>
                Todas as skills ativas do catálogo entram em <strong>{serverName}</strong> pelas portas marcadas — uma escolha só
                para o grupo inteiro. Uma skill que também tiver vínculo direto com este servidor segue o vínculo direto, não o
                catálogo.
              </>
            )}
          </p>
          <div className="mt-4 flex items-center gap-3">
            {picked.kind === 'skill' ? (
              <SkillIcon icon={picked.skill.icon} name={picked.skill.name} slug={picked.skill.slug} />
            ) : (
              <span className="skill-icon" style={{ color: 'var(--accent-soft)' }}>
                <Library />
              </span>
            )}
            <span className="min-w-0">
              <span className="row-title">{name}</span>
              <span className="row-sub">
                {picked.kind === 'skill'
                  ? picked.skill.slug
                  : `${picked.catalog.slug} · ${picked.catalog.activeSkillCount} skill${picked.catalog.activeSkillCount === 1 ? '' : 's'} ativa${picked.catalog.activeSkillCount === 1 ? '' : 's'}`}
              </span>
            </span>
          </div>
          <div className="mt-4 grid gap-2">
            {PORTS.map((port) => (
              <label key={port} className="well flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={ports.includes(port)}
                  onChange={(event) =>
                    setPorts((current) => (event.target.checked ? [...current, port] : current.filter((item) => item !== port)))
                  }
                />
                <span>
                  <span className="flex items-center gap-2 text-[13px] font-medium">
                    {PORT_LABEL[port]}
                  </span>
                  <span className="hint">{PORT_HINT[port]}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="actions">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={() => onConfirm(ports)} disabled={busy || ports.length === 0}>
              {busy ? 'Adicionando…' : 'Adicionar ao servidor'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
