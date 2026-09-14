import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Globe, Library, Server } from 'lucide-react';
import { Badge } from '../ui.js';
import { SkillIcon } from '../SkillIcon.js';
import {
  PORTS,
  PORT_HANDLE,
  PORT_LABEL,
  SKILL_HANDLE,
  type CatalogNode,
  type InternetNode,
  type ServerNode,
  type SkillNode,
} from './types.js';

/*
 * Os quatro tipos de nó do palco. `memo` é obrigatório: sem ele, arrastar um
 * nó re-renderiza todos os outros. Nenhum nó faz fetch — tudo chega por
 * `data`, montado no nível do palco.
 */

function ServerNodeImpl({ data, selected }: NodeProps<ServerNode>) {
  return (
    <div className={`node-server${selected ? ' selected' : ''}${data.isActive ? '' : ' off'}`}>
      <Handle type="target" position={Position.Left} id="in" className="in-handle" isConnectable={false} />
      <div className="hd">
        <span className="ic">
          <Server />
        </span>
        <span className="min-w-0 flex-1">
          <span className="nm block">{data.name}</span>
          <span className="sl block">/virtual/{data.slug}/mcp</span>
        </span>
      </div>
      <div className="st">
        {data.isDefault && <Badge tone="accent">padrão · /mcp</Badge>}
        {data.isOpen ? <Badge tone="warn">aberto</Badge> : <Badge tone="outline">chave</Badge>}
        {!data.isActive && <Badge tone="danger">desligado</Badge>}
      </div>
      <div className="ports">
        {PORTS.map((port) => (
          <div key={port} className={`port ${port}`}>
            <span className="pd" />
            <span className="pl">{PORT_LABEL[port]}</span>
            <span className="pc">{data.counts[port]}</span>
            <Handle type="source" position={Position.Right} id={PORT_HANDLE[port]} />
          </div>
        ))}
      </div>
    </div>
  );
}

function SkillNodeImpl({ data, selected }: NodeProps<SkillNode>) {
  return (
    <div className={`node-skill${selected ? ' selected' : ''}`} title={data.name}>
      {/* Um handle por porta, na ordem das portas do servidor: cheio quando a porta está ligada. */}
      {PORTS.map((port) => (
        <Handle
          key={port}
          type="target"
          position={Position.Left}
          id={SKILL_HANDLE[port]}
          className={`${port}${data.ports.includes(port) ? ' on' : ''}`}
          title={PORT_LABEL[port]}
        />
      ))}
      <SkillIcon icon={data.icon} name={data.name} slug={data.slug} />
      <span className="tx">
        <span className="nm block">{data.name}</span>
        <span className="sl block">{data.slug}</span>
      </span>
      {data.busy && <span className="busy" aria-label="salvando" />}
    </div>
  );
}

/**
 * Um catálogo é um nó só (`docs/11-catalogos.md` §5): os mesmos três handles
 * da skill e, em destaque, quantas skills ativas ele entrega a este servidor
 * — sem contar as que já são nó próprio.
 */
function CatalogNodeImpl({ data, selected }: NodeProps<CatalogNode>) {
  const empty = data.activeSkillCount === 0;
  return (
    <div className={`node-skill node-catalog${selected ? ' selected' : ''}${data.isActive ? '' : ' off'}`} title={data.name}>
      {PORTS.map((port) => (
        <Handle
          key={port}
          type="target"
          position={Position.Left}
          id={SKILL_HANDLE[port]}
          className={`${port}${data.ports.includes(port) ? ' on' : ''}`}
          title={PORT_LABEL[port]}
        />
      ))}
      <span className="ic">
        <Library />
      </span>
      <span className="tx">
        <span className="nm block">{data.name}</span>
        <span className="sl block">
          catálogo · {data.slug}
          {!data.isActive && ' · desligado'}
        </span>
      </span>
      <span className={`cnt${empty ? ' zero' : ''}`} title={`${data.activeSkillCount} skill(s) ativa(s) de ${data.skillCount} no catálogo`}>
        <b>{data.activeSkillCount}</b>
        <small>{data.activeSkillCount === 1 ? 'skill' : 'skills'}</small>
      </span>
      {data.busy && <span className="busy" aria-label="salvando" />}
    </div>
  );
}

function InternetNodeImpl({ data, selected }: NodeProps<InternetNode>) {
  return (
    <div className={`node-internet${data.online > 0 ? ' live' : ''}${selected ? ' selected' : ''}`}>
      <div className="globe">
        <Globe />
        <Handle type="source" position={Position.Right} id="out" isConnectable={false} />
      </div>
      <span className="lb">Internet</span>
    </div>
  );
}

export const ServerNodeView = memo(ServerNodeImpl);
export const SkillNodeView = memo(SkillNodeImpl);
export const CatalogNodeView = memo(CatalogNodeImpl);
export const InternetNodeView = memo(InternetNodeImpl);

/** Declarados fora de qualquer componente: dentro, remontariam todos os nós a cada render. */
export const nodeTypes = {
  server: ServerNodeView,
  skill: SkillNodeView,
  catalog: CatalogNodeView,
  internet: InternetNodeView,
};
