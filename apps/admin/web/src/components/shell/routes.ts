/*
 * Endereços que as rotas (`App.tsx`), a trilha, a sidebar e os botões precisam
 * combinar entre si. Sem React, para o teste rodar em node.
 */

/**
 * Onde se cria — e se importa — uma skill.
 *
 * Fica FORA de `/skills/…` de propósito: tudo ali embaixo é de
 * `/skills/:slug/*`, e uma rota estática irmã ganha do parâmetro no ranking do
 * react-router, em **qualquer** ordem de declaração. Era `/skills/new`, e a
 * skill de slug `new` — o nome "New", ou `name: new` no `SKILL.md` de um .zip
 * importado — abria o formulário em vez da ficha, em todo link do painel
 * (`tasks/087`). Catálogos e servidores nunca tiveram o problema porque criam
 * por `?new=1`, sem rota própria.
 */
export const NEW_SKILL_PATH = '/new-skill';

/** O mesmo formulário, já na importação de pacote (`NewSkillPage` lê o `mode`). */
export const IMPORT_SKILL_PATH = `${NEW_SKILL_PATH}?mode=zip`;

/**
 * A importação já apontada para a quarentena (`docs/15-quarentena.md`). Mesma
 * tela: importar é o **único** caminho para a quarentena, e o destino é uma
 * escolha de quem importa, não uma tela à parte.
 */
export const QUARANTINE_IMPORT_PATH = `${IMPORT_SKILL_PATH}&destination=quarantine`;

/** A tela é a de criação? Para a trilha e a sidebar; a barra no fim não conta, como no roteador. */
export const isNewSkillPath = (pathname: string): boolean => pathname.replace(/\/+$/, '') === NEW_SKILL_PATH;

/** A ficha só leitura e a de edição: as donas de tudo sob `/skills/`. */
export const SKILL_VIEW_ROUTE = '/skills/:slug/*';
export const SKILL_EDIT_ROUTE = '/skills/:slug/edit/*';

/**
 * `/skills/new` exato — o endereço antigo do formulário, que continua em
 * favoritos e em links de fora. Hoje ele é a ficha da skill de slug `new`; só
 * quando ela não existe é que volta a levar ao formulário. As guias
 * (`/skills/new/properties`) nunca foram do formulário e não entram. Sem
 * diferenciar maiúsculas, como o roteador casava a rota estática antiga.
 */
export const isLegacyNewSkillPath = (slug: string | undefined, rest: string | undefined): boolean =>
  slug?.toLowerCase() === 'new' && !rest;

/** Para onde o endereço antigo leva sem a skill `new`: o formulário, com o `?mode=zip` que veio. */
export const legacyNewSkillTarget = (search: string): string => `${NEW_SKILL_PATH}${search}`;
