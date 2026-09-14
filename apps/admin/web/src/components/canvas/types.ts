import type { Edge, Node } from '@xyflow/react';
import type { LinkFlags } from '../../api.js';

/** As três portas do servidor, na ordem em que aparecem no nó. */
export type Port = 'tools' | 'resources' | 'prompts';
export const PORTS: Port[] = ['tools', 'resources', 'prompts'];

export const PORT_LABEL: Record<Port, string> = { tools: 'Tools', resources: 'Resources', prompts: 'Prompts' };
export const PORT_FLAG: Record<Port, keyof LinkFlags> = { tools: 'asSkill', resources: 'asResource', prompts: 'asPrompt' };
export const PORT_HANDLE: Record<Port, string> = { tools: 'port-tools', resources: 'port-resources', prompts: 'port-prompts' };

/** Os três handles de destino da skill (e do catálogo), um por porta, na mesma ordem do servidor. */
export const SKILL_HANDLE: Record<Port, string> = { tools: 'in-tools', resources: 'in-resources', prompts: 'in-prompts' };

export const portOfHandle = (handle: string | null | undefined): Port | null =>
  (PORTS.find((port) => PORT_HANDLE[port] === handle) ?? null);

export const portOfSkillHandle = (handle: string | null | undefined): Port | null =>
  (PORTS.find((port) => SKILL_HANDLE[port] === handle) ?? null);

export const flagsToPorts = (flags: LinkFlags): Port[] => PORTS.filter((port) => flags[PORT_FLAG[port]]);

export const portsToFlags = (ports: readonly Port[]): LinkFlags => ({
  asSkill: ports.includes('tools'),
  asResource: ports.includes('resources'),
  asPrompt: ports.includes('prompts'),
});

/**
 * O que uma aresta de porta liga ao servidor: uma skill ou um catálogo
 * (`docs/11-catalogos.md` §5). Os dois têm os mesmos três handles e os mesmos
 * gestos; só o que o `PUT` grava muda.
 */
export type TargetKind = 'skill' | 'catalog';
export type Target = { kind: TargetKind; slug: string };

export const sameTarget = (a: Target, b: Target) => a.kind === b.kind && a.slug === b.slug;

export type ServerNodeData = {
  name: string;
  slug: string;
  isActive: boolean;
  isOpen: boolean;
  isDefault: boolean;
  counts: Record<Port, number>;
};

export type SkillNodeData = {
  slug: string;
  name: string;
  icon: string | null;
  ports: Port[];
  /** Há uma chamada em andamento para esta skill. */
  busy: boolean;
};

export type CatalogNodeData = {
  slug: string;
  name: string;
  /** O catálogo em si está ligado. */
  isActive: boolean;
  ports: Port[];
  /** Membros ativos sem nó próprio neste servidor — o número do nó. */
  activeSkillCount: number;
  skillCount: number;
  busy: boolean;
};

export type InternetNodeData = {
  online: number;
};

export type ServerNode = Node<ServerNodeData, 'server'>;
export type SkillNode = Node<SkillNodeData, 'skill'>;
export type CatalogNode = Node<CatalogNodeData, 'catalog'>;
export type InternetNode = Node<InternetNodeData, 'internet'>;
export type CanvasNode = ServerNode | SkillNode | CatalogNode | InternetNode;

export type PortEdgeData = { port: Port; target: Target; saving: boolean };
export type TrafficEdgeData = { online: number };
export type PortEdge = Edge<PortEdgeData, 'port'>;
export type TrafficEdge = Edge<TrafficEdgeData, 'traffic'>;
export type CanvasEdge = PortEdge | TrafficEdge;

export const SERVER_ID = 'server';
export const INTERNET_ID = 'internet';
export const skillNodeId = (slug: string) => `skill:${slug}`;
export const catalogNodeId = (slug: string) => `catalog:${slug}`;
export const nodeIdOf = (target: Target) => (target.kind === 'skill' ? skillNodeId(target.slug) : catalogNodeId(target.slug));

/** A skill ou o catálogo por trás de um id de nó; nulo para o servidor e a Internet. */
export const targetOfNodeId = (id: string): Target | null => {
  if (id.startsWith('skill:')) return { kind: 'skill', slug: id.slice(6) };
  if (id.startsWith('catalog:')) return { kind: 'catalog', slug: id.slice(8) };
  return null;
};

export const slugOfNodeId = (id: string): string | null => (id.startsWith('skill:') ? id.slice(6) : null);
export const portEdgeId = (port: Port, target: Target) => `edge:${target.kind}:${port}:${target.slug}`;
