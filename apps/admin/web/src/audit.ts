import type { AuditEntry } from './api.js';

/** Rótulos da trilha, compartilhados pelo sino e pela página de auditoria. */
export const ACTION_LABEL: Record<AuditEntry['action'], string> = {
  create: 'criou',
  update: 'atualizou',
  delete: 'removeu',
  'user.create': 'criou conta',
  'user.role': 'mudou papel',
  'user.deactivate': 'desativou',
  'key.create': 'emitiu chave',
  'key.revoke': 'revogou chave',
  'mcp.create': 'criou servidor',
  'mcp.update': 'alterou servidor',
  'mcp.delete': 'removeu servidor',
  'mcp.default': 'escolheu o MCP padrão',
  'mcp.key.create': 'emitiu chave de servidor',
  'mcp.key.revoke': 'revogou chave de servidor',
  // Chaves psp_ do antigo MCP principal: nada mais as emite, a trilha ainda as mostra.
  'public.key.create': 'emitiu chave do MCP principal',
  'public.key.revoke': 'revogou chave do MCP principal',
};

/** Cor por natureza da ação: criar, alterar, remover. */
export const ACTION_TONE: Record<AuditEntry['action'], 'ok' | 'accent' | 'danger'> = {
  create: 'ok',
  update: 'accent',
  delete: 'danger',
  'user.create': 'ok',
  'user.role': 'accent',
  'user.deactivate': 'danger',
  'key.create': 'ok',
  'key.revoke': 'danger',
  'mcp.create': 'ok',
  'mcp.update': 'accent',
  'mcp.delete': 'danger',
  'mcp.default': 'accent',
  'mcp.key.create': 'ok',
  'mcp.key.revoke': 'danger',
  'public.key.create': 'ok',
  'public.key.revoke': 'danger',
};
