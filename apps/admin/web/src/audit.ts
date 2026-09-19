import type { AuditEntry } from './api.js';

/** Rótulos da trilha, compartilhados pelo sino e pela página de auditoria. */
export const ACTION_LABEL: Record<AuditEntry['action'], string> = {
  create: 'criou',
  update: 'atualizou',
  delete: 'removeu',
  'user.create': 'criou conta',
  'user.role': 'mudou papel',
  'user.deactivate': 'desativou',
  // A senha de **outra** conta, trocada pelo admin ou por um link de
  // redefinição (`tasks/030`); a troca pelo próprio dono não entra na trilha.
  'user.password': 'redefiniu senha',
  'key.create': 'emitiu chave',
  'key.revoke': 'revogou chave',
  'mcp.create': 'criou servidor',
  'mcp.update': 'alterou servidor',
  'mcp.delete': 'removeu servidor',
  'mcp.default': 'escolheu o MCP padrão',
  'mcp.key.create': 'emitiu chave de servidor',
  'mcp.key.revoke': 'revogou chave de servidor',
  'catalog.create': 'criou catálogo',
  'catalog.update': 'alterou catálogo',
  'catalog.delete': 'removeu catálogo',
  'skill.share': 'compartilhou skill',
  'skill.unshare': 'revogou acesso à skill',
  'catalog.share': 'compartilhou catálogo',
  'catalog.unshare': 'revogou acesso ao catálogo',
  'mcp.share': 'compartilhou servidor',
  'mcp.unshare': 'revogou acesso ao servidor',
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
  // `danger`: trocar a senha de outra conta é assumi-la — derruba as sessões
  // dela e fecha os links de redefinição vivos.
  'user.password': 'danger',
  'key.create': 'ok',
  'key.revoke': 'danger',
  'mcp.create': 'ok',
  'mcp.update': 'accent',
  'mcp.delete': 'danger',
  'mcp.default': 'accent',
  'mcp.key.create': 'ok',
  'mcp.key.revoke': 'danger',
  'catalog.create': 'ok',
  'catalog.update': 'accent',
  'catalog.delete': 'danger',
  'skill.share': 'ok',
  'skill.unshare': 'danger',
  'catalog.share': 'ok',
  'catalog.unshare': 'danger',
  'mcp.share': 'ok',
  'mcp.unshare': 'danger',
  'public.key.create': 'ok',
  'public.key.revoke': 'danger',
};
