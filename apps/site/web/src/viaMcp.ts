import type { SkillMcpRef } from './api.js';

type Portas = Pick<SkillMcpRef, 'asSkill' | 'asPrompt' | 'asResource'>;

/**
 * O que a seção "Via MCP" da página da skill pode ensinar, a partir dos
 * servidores abertos em que ela está (`mcps` já vem só com os abertos e ligados).
 *
 * - `sem-servidor`: nenhum vMCP aberto a publica — a skill chegou ao site por
 *   ser pública ou por catálogo público, e a página oferece só o download
 *   (`docs/12-acesso-granular.md` §7);
 * - `ferramenta`: ao menos um a publica pela porta `skill`, a única que
 *   `get_skill` enxerga. `emTodos` diz se vale para qualquer um dos listados;
 * - `outras-portas`: só prompt e/ou resource, que têm outra forma de chamada;
 * - `sem-porta`: vinculada, mas com as três portas desligadas.
 */
export type ViaMcp =
  | { caso: 'sem-servidor' }
  | { caso: 'ferramenta'; emTodos: boolean }
  | { caso: 'outras-portas'; prompt: boolean; resource: boolean }
  | { caso: 'sem-porta' };

/**
 * Só a porta `skill` põe a skill nas ferramentas do mcp-public: o recorte de
 * `createHandlers` é `surface: 'skill'` (`apps/mcp-public/src/tools.ts`), e sem
 * ela `get_skill("<slug>")` responde "Skill não encontrada". Prompt e resource
 * são portas independentes — a skill pode viver só nelas.
 */
export function viaMcp(mcps: readonly Portas[]): ViaMcp {
  if (mcps.length === 0) return { caso: 'sem-servidor' };
  if (mcps.some((mcp) => mcp.asSkill)) {
    return { caso: 'ferramenta', emTodos: mcps.every((mcp) => mcp.asSkill) };
  }

  const prompt = mcps.some((mcp) => mcp.asPrompt);
  const resource = mcps.some((mcp) => mcp.asResource);
  return prompt || resource ? { caso: 'outras-portas', prompt, resource } : { caso: 'sem-porta' };
}

/**
 * A frase da seção, com `total` servidores abertos listados logo abaixo dela.
 * Só a do caso `ferramenta` termina em dois-pontos: é a única seguida do cartão
 * `get_skill("<slug>")`.
 */
export function fraseViaMcp(via: ViaMcp, total: number, slug: string): string {
  if (via.caso === 'sem-servidor') {
    return 'Em nenhum servidor MCP aberto: esta skill é pública, mas só chega ao agente pelo download acima.';
  }

  const publicada = `Publicada em ${total} servidor${total === 1 ? '' : 'es'} aberto${total === 1 ? '' : 's'}`;
  if (via.caso === 'ferramenta') {
    return via.emTodos
      ? `${publicada}. Conecte seu agente a um deles e peça pelo slug:`
      : `${publicada}. Conecte seu agente a um dos que têm a porta skill e peça pelo slug:`;
  }
  if (via.caso === 'sem-porta') {
    return `${publicada}, mas com as três portas desligadas: por ora só chega ao agente pelo download acima.`;
  }

  const saidas = [
    via.prompt && 'como prompt, com o próprio slug',
    via.resource && `como resource, em skill://${slug}`,
  ].filter(Boolean);
  return `${publicada}, sem a porta skill: get_skill não a encontra. Ela sai ${saidas.join(', e ')}.`;
}
