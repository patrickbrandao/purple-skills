import { useState } from 'react';
import { Globe, Library } from 'lucide-react';
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
 * Identidade do item escolhido, para o `key` que remonta o diálogo a cada
 * abertura: sem remontar, as portas marcadas na vez anterior voltariam
 * marcadas. O tipo entra na chave porque uma skill e um catálogo podem ter o
 * mesmo slug.
 */
export const pickedKey = (picked: Picked | null): string =>
  picked === null ? 'none' : `${picked.kind}:${picked.kind === 'skill' ? picked.skill.slug : picked.catalog.slug}`;

/**
 * O aviso de exposição, num servidor **aberto** (`docs/12-acesso-granular.md`
 * decisão 15): vincular aqui é publicar. É **inline e sem confirmação** — a
 * confirmação (`confirm_open`) foi revogada no PR2 do `09` e o `docs/08` §3.3
 * marca isso; o aviso informa, não impede (`docs/12` §10).
 *
 * Uma skill já pública não ganha aviso: por ela, nada muda de política. No
 * catálogo o aviso é qualitativo — o painel não recebe quantas das skills dele
 * são privadas (falta `private_skill_count` no resumo do vMCP, pedido ao dba
 * em `tasks/021`), e um número errado seria pior que nenhum.
 */
function OpenExposure({ picked }: { picked: Picked }) {
  if (picked.kind === 'skill' && picked.skill.isPublic) return null;
  return (
    <p className="alert warn mt-4">
      <Globe />
      <span className="min-w-0">
        Este servidor é <strong>aberto</strong>:{' '}
        {picked.kind === 'skill' ? (
          <>
            esta skill é <strong>privada</strong> e, a partir deste vínculo, qualquer cliente a lê sem chave por aqui — e o site
            passa a listá-la.
          </>
        ) : (
          <>
            as skills que o catálogo entrega — <strong>inclusive as privadas</strong> — passam a ser lidas sem chave por aqui, e o
            site passa a listá-las.
          </>
        )}{' '}
        No painel, quem vê o quê não muda.
      </span>
    </p>
  );
}

/**
 * Ao acrescentar uma skill (ou um catálogo) ao servidor, a pessoa escolhe por
 * quais portas entra — Tools vem marcada, porque é a porta que o agente
 * descobre sozinho. Um nó só existe com ao menos uma aresta, então zero
 * portas não passa. No catálogo, a escolha vale para todos os membros.
 */
export function AddSkillDialog({
  picked,
  serverName,
  serverIsOpen,
  busy,
  onConfirm,
  onClose,
}: {
  picked: Picked | null;
  serverName: string;
  /** Servidor aberto: o vínculo publica o que entra — ver `OpenExposure`. */
  serverIsOpen: boolean;
  busy: boolean;
  onConfirm: (ports: Port[]) => void;
  onClose: () => void;
}) {
  // Estado da abertura: o ponto de uso remonta o diálogo por item (`pickedKey`),
  // então este padrão vale para toda abertura, não só para a primeira.
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
          {serverIsOpen && <OpenExposure picked={picked} />}
          <div className="mt-4 grid gap-2">
            {PORTS.map((port) => (
              <label key={port} className="well flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={ports.includes(port)}
                  disabled={busy}
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
