import { useState } from 'react';
import type { SkillSummary } from '../../api.js';
import { Button, Modal } from '../ui.js';
import { SkillIcon } from '../SkillIcon.js';
import { PORTS, PORT_LABEL, type Port } from './types.js';

const PORT_HINT: Record<Port, string> = {
  tools: 'Aparece em search_skills / get_skill e tem download.',
  resources: 'Lida como resource em skill://<slug>.',
  prompts: 'Oferecida como prompt (slash-command) pelo slug.',
};

/**
 * Ao acrescentar uma skill ao servidor, a pessoa escolhe por quais portas ela
 * entra — Tools vem marcada, porque é a porta que o agente descobre sozinho.
 * Um nó só existe com ao menos uma aresta, então zero portas não passa.
 */
export function AddSkillDialog({
  skill,
  serverName,
  busy,
  onConfirm,
  onClose,
}: {
  skill: SkillSummary | null;
  serverName: string;
  busy: boolean;
  onConfirm: (ports: Port[]) => void;
  onClose: () => void;
}) {
  const [ports, setPorts] = useState<Port[]>(['tools']);

  return (
    <Modal open={skill !== null} title={skill ? `Adicionar "${skill.name}"` : ''} onClose={onClose}>
      {skill && (
        <>
          <p className="d">
            A skill entra em <strong>{serverName}</strong> pelas portas marcadas. Cada porta vira uma aresta no canvas; tirar a última
            aresta remove a skill do servidor.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <SkillIcon icon={skill.icon} name={skill.name} slug={skill.slug} />
            <span className="min-w-0">
              <span className="row-title">{skill.name}</span>
              <span className="row-sub">{skill.slug}</span>
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
                    <span className="stage-legend">
                      <i className={port} />
                    </span>
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
