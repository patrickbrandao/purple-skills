import type { Edge, Node } from '@xyflow/react';
import type { LinkFlags } from '../../api.js';

/** As três portas do servidor, na ordem em que aparecem no nó. */
export type Port = 'tools' | 'resources' | 'prompts';
export const PORTS: Port[] = ['tools', 'resources', 'prompts'];

export const PORT_LABEL: Record<Port, string> = { tools: 'Tools', resources: 'Resources', prompts: 'Prompts' };
export const PORT_FLAG: Record<Port, keyof LinkFlags> = { tools: 'asSkill', resources: 'asResource', prompts: 'asPrompt' };
export const PORT_HANDLE: Record<Port, string> = { tools: 'port-tools', resources: 'port-resources', prompts: 'port-prompts' };

export const portOfHandle = (handle: string | null | undefined): Port | null =>
  (PORTS.find((port) => PORT_HANDLE[port] === handle) ?? null);

export const flagsToPorts = (flags: LinkFlags): Port[] => PORTS.filter((port) => flags[PORT_FLAG[port]]);

export const portsToFlags = (ports: readonly Port[]): LinkFlags => ({
  asSkill: ports.includes('tools'),
  asResource: ports.includes('resources'),
  asPrompt: ports.includes('prompts'),
});

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

export type InternetNodeData = {
  online: number;
};

export type ServerNode = Node<ServerNodeData, 'server'>;
export type SkillNode = Node<SkillNodeData, 'skill'>;
export type InternetNode = Node<InternetNodeData, 'internet'>;
export type CanvasNode = ServerNode | SkillNode | InternetNode;

export type PortEdgeData = { port: Port; slug: string; saving: boolean };
export type TrafficEdgeData = { online: number };
export type PortEdge = Edge<PortEdgeData, 'port'>;
export type TrafficEdge = Edge<TrafficEdgeData, 'traffic'>;
export type CanvasEdge = PortEdge | TrafficEdge;

export const SERVER_ID = 'server';
export const INTERNET_ID = 'internet';
export const skillNodeId = (slug: string) => `skill:${slug}`;
export const slugOfNodeId = (id: string): string | null => (id.startsWith('skill:') ? id.slice(6) : null);
export const portEdgeId = (port: Port, slug: string) => `edge:${port}:${slug}`;
