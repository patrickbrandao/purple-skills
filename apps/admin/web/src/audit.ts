import type { AuditEntry } from './api.js';

/**
 * Rótulos da trilha, compartilhados pelo sino e pela página de auditoria.
 *
 * Ação nova entra em quatro lugares, na ordem do `AuditAction` do shared: o
 * union e o `AUDIT_ACTIONS` de `api.ts`, e os dois mapas daqui. O `Record` só
 * confere com o union **deste** bundle, que é cópia manual — quem confere com o
 * shared é o `audit.test.ts`. Sem rótulo, o selo da trilha sai vazio e a frase
 * do sino fica sem verbo (`tasks/043`).
 */
export const ACTION_LABEL: Record<AuditEntry['action'], string> = {
  create: 'criou',
  update: 'atualizou',
  delete: 'removeu',
  'user.create': 'criou conta',
  'user.role': 'mudou papel',
  'user.deactivate': 'desativou',
  'user.activate': 'reativou',
  // A senha de **outra** conta, trocada pelo admin ou por um link de
  // redefinição (`tasks/030`); a troca pelo próprio dono não entra na trilha.
  'user.password': 'redefiniu senha',
  // Uma identidade do provedor passou a abrir uma conta que já existia; o ator
  // é `oidc:<issuer>` e o alvo traz o `subject` (`tasks/003`).
  'user.link': 'vinculou SSO à conta',
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
  // Busca semântica: o alvo é `chave=valor` em `rag.settings` (a semeadura do
  // boot grava com o ator `ambiente`) e a quantidade de skills em `rag.reindex`.
  'rag.settings': 'alterou a busca semântica',
  'rag.reindex': 'mandou reindexar',
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
  // Religa login, concessões e chaves `psk_` de uma vez.
  'user.activate': 'accent',
  // `danger`: trocar a senha de outra conta é assumi-la — derruba as sessões
  // dela e fecha os links de redefinição vivos.
  'user.password': 'danger',
  // Mesmo peso de `user.password`: uma credencial nova passa a abrir a conta.
  'user.link': 'danger',
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
  // `accent`: as duas alteram a instalação e não apagam nada — reindexar só
  // marca o acervo para refatiar (`docs/14-rag.md` §9).
  'rag.settings': 'accent',
  'rag.reindex': 'accent',
  'public.key.create': 'ok',
  'public.key.revoke': 'danger',
};

const DIA = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * O primeiro instante do dia `AAAA-MM-DD` **no fuso de quem olha**, andando
 * `dias` no calendário. Pelos campos de data, e não por texto nem por soma de
 * 24 h: `new Date('AAAA-MM-DD')` é meia-noite UTC, há dia de 23 e de 25 horas,
 * e onde o horário de verão começa à meia-noite o dia começa à 01:00.
 */
function inicioDoDia(valor: string, dias = 0): Date | null {
  const partes = DIA.exec(valor);
  if (!partes) return null;
  const inicio = new Date(0);
  // `setFullYear`, e não `new Date(ano, mês, dia)`, que lê ano < 100 como 19xx.
  inicio.setFullYear(Number(partes[1]), Number(partes[2]) - 1, Number(partes[3]) + dias);
  inicio.setHours(0, 0, 0, 0);
  return inicio;
}

/**
 * O período da trilha: dos dois `<input type="date">` para os instantes que
 * `GET /api/audit` recebe. A convenção é uma só — **dia do calendário de quem
 * olha**, o mesmo fuso em que a coluna "Quando" mostra cada evento
 * (`formatDateTime`). O servidor não conhece o fuso do navegador: ele compara
 * instantes (`created_at >= since AND created_at <= until`), então é aqui que
 * o dia vira instante. Antes, "Desde" saía em UTC e "Até" em hora local, e a
 * janela vinha deslocada pelo offset (`tasks/044`).
 *
 * "Até" vai como o **último milissegundo do dia**, que é o começo do dia
 * seguinte menos 1 ms: o `<=` do servidor é inclusivo, então mandar a própria
 * meia-noite seguinte traria o evento carimbado nela, que já é do outro dia —
 * e `23:59:59` cortava o segundo final. Pelo calendário, e não lendo o texto
 * `…T23:59:59.999`: no dia de 25 horas esse horário acontece duas vezes, o ES
 * fica com a primeira e a última hora do dia sumiria. Sobra, por desenho, o
 * que a coluna guarda além do milissegundo (até 999 µs no fim do último dia);
 * fechar isso pede `<` no servidor. Valor que não é um dia (`''`, campo pela
 * metade) fica sem borda.
 */
export function auditRange(since: string, until: string): { since?: string; until?: string } {
  const depois = inicioDoDia(until, 1);
  return {
    since: inicioDoDia(since)?.toISOString(),
    until: depois ? new Date(depois.getTime() - 1).toISOString() : undefined,
  };
}
