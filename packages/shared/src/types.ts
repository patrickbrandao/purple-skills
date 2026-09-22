import type { AccessLevel, EffectiveAccess, Role } from './roles.js';
import type { ProfileLink } from './profile.js';

/**
 * Um vMCP em que a skill está, visto da skill: o servidor e as três portas
 * do vínculo (`docs/09-mcp-padrao-e-skills-flutuantes.md` §4). É a única
 * forma de uma skill ser exibida — no MCP e no site.
 */
export type SkillMcpRef = {
  uuid: string;
  slug: string;
  name: string;
  isOpen: boolean;
  isActive: boolean;
  /** Responde também em `/mcp`. */
  isDefault: boolean;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
  /**
   * Vínculo direto (`virtual_mcp_skills`). Falso: a skill chega a este vMCP
   * só por catálogo (`docs/11-catalogos.md` §3) e as portas acima são a união
   * dos catálogos em `catalogs`. O vínculo direto, quando existe, sobrescreve
   * qualquer catálogo — por isso os dois nunca aparecem juntos.
   */
  direct: boolean;
  /** Os catálogos por onde a skill chega a este vMCP; vazio num vínculo direto. */
  catalogs: CatalogRef[];
};

/** O mínimo para nomear um catálogo numa referência. */
export type CatalogRef = { uuid: string; slug: string; name: string };

/** Um catálogo de que a skill participa, visto da skill. */
export type SkillCatalogRef = CatalogRef & {
  /** O catálogo está ligado. */
  isActive: boolean;
  /** A participação **desta** skill neste catálogo está ativa. */
  memberActive: boolean;
};

export type SkillSummary = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  /**
   * Ícone da skill nos cards e nos nós do canvas do painel: um emoji ou a
   * URL (http/https) de uma imagem. Nulo cai no monograma pelas iniciais
   * (`isValidSkillIcon` de `icon.ts` é a regra).
   */
  icon: string | null;
  /**
   * Desligada (`docs/11-catalogos.md` §2): some de todo vMCP e do site, por
   * vínculo direto ou por catálogo, sem perder vínculo nenhum. Só o painel e
   * o mcp-admin (visibilidade `'all'`) continuam a enxergá-la.
   */
  isActive: boolean;
  /**
   * Quem pode ler sem concessão: qualquer conta logada e o site anônimo
   * (`docs/12-acesso-granular.md` decisão 4). Não decide exposição no MCP —
   * isso continua sendo vínculo.
   */
  isPublic: boolean;
  /**
   * O dono da skill. Nulo quando ele foi removido ou quando quem criou não era
   * conta (bootstrap, token global).
   *
   * O banco sempre os devolve, em qualquer visibilidade. O `ownerUsername`
   * **sai também para o visitante anônimo** desde a decisão 11 do
   * `docs/19-username.md`: a ficha pública credita o dono, e o username é dado
   * público justamente para poder ser creditado. O que o site continua
   * projetando fora é o `ownerUserUuid` (`apps/site/src/api.ts`,
   * `skillPublica`), que é o `sub` do cookie de sessão do painel (`tasks/001`,
   * `tasks/002`).
   *
   * Aqui o `ownerUserUuid` chega ao navegador como **apelido do username** —
   * ver `ownerByUsername`, em `apps/admin/src/access.ts`.
   */
  ownerUserUuid: string | null;
  ownerUsername: string | null;
  /**
   * O dono tem perfil público? É o que decide se o `por @fulano` da ficha vira
   * **link** para `/u/<username>` ou fica no texto de hoje (`docs/20-perfil.md`
   * §7). Sem ele o site apontaria para 404 em toda conta que não abriu o perfil.
   *
   * É o **único** dado de perfil que viaja na ficha da skill: bio, foto e links
   * ficam na rota do perfil, que é onde alguém foi vê-los de propósito.
   */
  ownerHasProfile: boolean;
  /**
   * O que a conta que leu pode nesta skill (`accessLevel` de `roles.ts`,
   * mais `'view'` quando ela chega por um contêiner que a conta vê). Numa
   * leitura sem conta (site, `visibility: 'all'` sem `viewer`) é `'owner'`
   * para o painel/mcp-admin do admin e `null` para o site.
   */
  access: EffectiveAccess;
  /**
   * Em quais vMCPs a skill está — por vínculo direto **ou** por catálogo.
   * Numa leitura de visibilidade `'all'` (painel, mcp-admin) vêm todos; nas
   * demais, só os abertos e ligados — que é o que o site pode mostrar. Vazio
   * = skill flutuante, exibida em lugar nenhum.
   */
  mcps: SkillMcpRef[];
  /** Os catálogos de que participa. Só na visibilidade `'all'`; vazio nas demais. */
  catalogs: SkillCatalogRef[];
  viewCount: number;
  downloadCount: number;
  score: number;
  tags: string[];
  fileCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SkillFileMeta = {
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  isText: boolean;
};

export type SkillDetail = SkillSummary & {
  skillMd: string;
  files: SkillFileMeta[];
  /**
   * As concessões da skill (`skill_grants`). O banco sempre as devolve; o
   * app só as repassa a quem tem `manage` (`docs/12` decisão 11).
   */
  grants: Grant[];
};

// ------------------------------------------------------------- acesso ------

/**
 * Uma concessão por objeto: a conta, o nível e quem concedeu.
 *
 * A conta é o **username** (`docs/19-username.md` decisão 1), e `userUuid`
 * chega ao navegador como apelido dele — ver `grantByUsername`, em
 * `apps/admin/src/access.ts`.
 */
export type Grant = {
  userUuid: string;
  username: string;
  name: string;
  role: Role;
  /** A conta está ativa? Desativada mantém a linha, inerte (`docs/12` §2). */
  isActive: boolean;
  level: AccessLevel;
  grantedByUserUuid: string | null;
  grantedByUsername: string | null;
  createdAt: string;
};

/**
 * Resultado da busca de contas para compartilhar (`GET /api/users/lookup`).
 *
 * A conta é identificada pelo **username**, o mesmo identificador que as rotas
 * de concessão usam na URL (`docs/19-username.md` decisão 9). O `uuid` da conta
 * **não sai** daqui: ele é o `sub` do cookie de sessão (`admin/src/auth.ts`), e
 * a busca é aberta a qualquer conta logada (decisão 13 do `docs/12`) —
 * entregá-lo daria a um membro o sujeito exato do crachá que ele quer forjar
 * (`tasks/025`, `tasks/001`).
 *
 * **O e-mail não está nesta lista, e não é só omissão de saída:** a busca
 * também deixou de *casar* por e-mail (`docs/19` decisão 10). Devolver só o
 * username mas continuar casando por endereço deixaria qualquer conta logada
 * descobrir a qual username um e-mail corresponde, digitando o endereço — a
 * sondagem anula o sigilo mesmo sem o campo aparecer.
 *
 * O campo `uuid` sobrevive como **apelido do username**, e só porque o painel
 * ainda o lê (`admin/web/src/components/AccessPanel.tsx`): sai daqui, do
 * `withoutUuid` do admin e da projeção de `lookupUsers` quando o painel passar
 * a usar `username`.
 */
export type UserLookup = { username: string; name: string; role: Role; uuid: string };

/** O filtro das listas do painel: meus, compartilhados comigo, públicos. */
export type AccessScope = 'mine' | 'shared' | 'public';

export const ACCESS_SCOPES: readonly AccessScope[] = ['mine', 'shared', 'public'];

export function isAccessScope(value: unknown): value is AccessScope {
  return typeof value === 'string' && (ACCESS_SCOPES as readonly string[]).includes(value);
}

export type SearchResult = {
  items: SkillSummary[];
  total: number;
  limit: number;
  offset: number;
  /**
   * Como a busca foi resolvida (`docs/14-rag.md` §8.3).
   *
   * `hybrid` é a fusão da perna textual com a vetorial; `text` é a busca de
   * sempre. Cair para `text` não é erro — é o que acontece com o driver
   * desligado, sem chave, sem a migration do RAG aplicada, ou quando o
   * provedor demora mais que `RAG_QUERY_TIMEOUT_MS`. O cliente recebe o campo
   * para saber o que leu, não para escolher o modo.
   */
  mode: 'text' | 'hybrid';
};

/** Tipos compartilhados entre a API REST, o frontend e os servidores MCP. */

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  // Eventos de conta (`docs/05-accounts-and-roles.md` §2.8). Login e falha de
  // login ficam de fora: quem os trata é o rate limiting, e auditá-los mudaria
  // a ordem de grandeza do log.
  | 'user.create'
  | 'user.role'
  | 'user.deactivate'
  // O par de `user.deactivate`: reativar devolve o login, as concessões e as
  // chaves `psk_` da conta de uma vez.
  | 'user.activate'
  // Senha de uma conta trocada por quem não é ela: a redefinição pelo admin e o
  // link de e-mail consumido (`docs/05-accounts-and-roles.md` §2.6).
  // `target_label` é o username da conta afetada e o ator diz por qual caminho
  // foi — o username de quem administra, ou `link-de-redefinicao`. A linha
  // implica que **toda sessão daquela conta caiu** (`token_version`) e que o
  // próximo acesso exige nova senha; ela nunca leva a senha, o hash nem o token.
  | 'user.password'
  // Uma identidade OIDC passou a abrir uma conta local que já existia
  // (`docs/05-accounts-and-roles.md` §2.4). Uma vez por conta — não é login. O
  // ator é o caminho (`oidc:<issuer>`); `target_label` leva o username da conta
  // e o `subject` que a assumiu.
  | 'user.link'
  // O username de uma conta trocado por um admin (`docs/19-username.md`
  // decisão 5). `target_label` é `<antigo> -> <novo>`, a mesma forma que a
  // clonagem usa (`031`). A linha é o que mantém legível a trilha anterior à
  // troca: o rótulo congelado lá continua dizendo `<antigo>`, e é aqui que se
  // descobre quem ele virou. O username antigo **não volta a circular**
  // (decisão 6), então a trilha nunca aponta para outra pessoa.
  | 'user.username'
  // Um admin **limpou** o perfil público de uma conta: bio, site, links e foto
  // saem, e o `is_public` desliga (`docs/20-perfil.md` decisão 6). É moderação,
  // e o único caminho pelo qual alguém que não é o dono mexe no perfil — o
  // admin nunca escreve texto no lugar de outra pessoa. A edição do **próprio**
  // perfil não entra na trilha, pelo mesmo critério que mantém o login fora
  // dela: mudaria a ordem de grandeza do log.
  | 'user.profile'
  | 'key.create'
  | 'key.revoke'
  // Eventos de MCP virtual (`docs/08-mcp-virtual.md` §6). `target_label` é o
  // slug do servidor; nas chaves, o nome da chave.
  | 'mcp.create'
  | 'mcp.update'
  | 'mcp.delete'
  // A troca do vMCP padrão (`docs/09-mcp-padrao-e-skills-flutuantes.md`);
  // `target_label` é o slug novo, ou "nenhum".
  | 'mcp.default'
  | 'mcp.key.create'
  | 'mcp.key.revoke'
  // Eventos de catálogo (`docs/11-catalogos.md` §7). `target_label` é o slug
  // do catálogo; mudar a lista de skills dele é `catalog.update`, e vincular
  // um catálogo a um vMCP é `mcp.update` no servidor, como com skill.
  | 'catalog.create'
  | 'catalog.update'
  | 'catalog.delete'
  // Concessões (`docs/12-acesso-granular.md` §8). `target_label` é
  // `username:nível` ao conceder e o username ao revogar; em catálogo e vMCP o
  // slug vem antes, separado por espaço. Transferir o dono é `update`.
  | 'skill.share'
  | 'skill.unshare'
  | 'catalog.share'
  | 'catalog.unshare'
  | 'mcp.share'
  | 'mcp.unshare'
  // Clonagem (`docs/16-clonagem.md`). A linha fica no objeto **novo** e o
  // `target_label` é `<slug de origem> -> <slug da cópia>`, a mesma gramática
  // de `quarantine.promote`. A cópia nasce fechada (nunca `is_public` nem
  // `is_open`) e o clone de vMCP não leva chave, então nenhum evento de
  // exposição ou de chave acompanha esta linha.
  | 'skill.clone'
  | 'catalog.clone'
  | 'mcp.clone'
  // Busca semântica (`docs/14-rag.md` §9).
  // `rag.settings` leva `chave=valor`; `rag.reindex` leva a quantidade de
  // skills marcadas. O estado do indexador **não** é auditado: ele é
  // regravado a cada ciclo e inundaria a trilha.
  | 'rag.settings'
  | 'rag.reindex'
  // Quarentena (`docs/15-quarentena.md`). `target_label` é o nome do envio;
  // em `quarantine.promote` é `<nome> -> <slug>`, o slug com que a skill
  // nasceu em produção. Editar um arquivo do envio é `quarantine.update`.
  | 'quarantine.create'
  | 'quarantine.update'
  | 'quarantine.delete'
  | 'quarantine.promote'
  // Quem pode aprovar um envio (`quarantine.approvers`); `target_label` leva
  // `chave=valor`, como `rag.settings`.
  | 'quarantine.settings'
  // Chaves `psp_` do antigo MCP principal. Nada mais as produz desde o `011`;
  // ficam no tipo porque a trilha ainda carrega linhas com elas.
  | 'public.key.create'
  | 'public.key.revoke';

export type AuditSource = 'web-admin' | 'mcp-admin';

/**
 * Quem executou a ação.
 *
 * `userUuid` é nulo quando o ator não é uma conta: o `MCP_ADMIN_TOKEN`
 * (`token-global`) e o bootstrap do primeiro admin. `label` é sempre
 * preenchido e é o que o painel mostra.
 */
export type AuditActor = {
  userUuid: string | null;
  label: string;
};

export const TOKEN_ACTOR: AuditActor = { userUuid: null, label: 'token-global' };
export const BOOTSTRAP_ACTOR: AuditActor = { userUuid: null, label: 'bootstrap' };

export type AuditEntry = {
  id: string;
  skillUuid: string | null;
  skillSlug: string | null;
  filePath: string | null;
  action: AuditAction;
  source: AuditSource;
  actorUserUuid: string | null;
  actorLabel: string | null;
  /** Alvo de um evento de conta (username, nome da chave). */
  targetLabel: string | null;
  createdAt: string;
};

// ------------------------------------------------------------- contas ------

/**
 * A conta como as rotas de **admin** a devolvem (`/api/users*`) e como a
 * própria sessão se vê (`GET /api/session`).
 *
 * É o único tipo que ainda carrega `email`, e é de propósito: pela decisão 8 do
 * `docs/19-username.md` o endereço só aparece para a própria conta e para
 * admin. Em toda outra superfície a conta é o `username` — dono, ACL, guia
 * Acessos, busca de contas, trilha e ficha pública do site.
 */
export type UserSummary = {
  uuid: string;
  username: string;
  email: string;
  name: string;
  /**
   * Quando a foto mudou, ou `null` quando não há foto (`docs/20-perfil.md`).
   *
   * Está aqui, e não só no perfil, porque o avatar aparece em **toda** lista e
   * ficha do painel: sem o carimbo junto da conta, cada linha de lista faria
   * uma requisição só para descobrir que não existe imagem. É um carimbo, não
   * os bytes — eles moram em `user_avatars` e só a rota que serve a imagem os
   * lê.
   */
  avatarUpdatedAt: string | null;
  role: Role;
  isActive: boolean;
  /** `false` numa conta que só entra por OIDC. */
  hasPassword: boolean;
  mustChangePassword: boolean;
  oidcIssuer: string | null;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// ------------------------------------------------------------- perfil ------

/**
 * O perfil como a **própria conta** o vê e edita (`docs/20-perfil.md`).
 *
 * `name` mora em `users` e não na tabela de perfil — é o nome de exibição que
 * já existia (decisão 1); o que mudou foi quem pode escrevê-lo. Os demais
 * campos são a linha de `user_profiles`, que **nasce no primeiro salvamento**:
 * quem nunca abriu a tela não tem linha, e a leitura devolve este objeto
 * vazio e privado em vez de nulo.
 *
 * **Não há e-mail aqui, e é isso que permite a funcionalidade existir**
 * (`docs/19-username.md` decisão 8).
 */
export type UserProfile = {
  username: string;
  name: string;
  /** Texto puro; `''` é "sem bio" (`docs/20` §3.1). */
  bio: string;
  websiteUrl: string | null;
  links: ProfileLink[];
  /** Opt-in, desligado por padrão: decide o que sai para o **anônimo**. */
  isPublic: boolean;
  hasAvatar: boolean;
  /**
   * Quando a foto mudou pela última vez, para a URL do avatar levar um
   * cache-buster. Nulo quando não há foto. Os **bytes** nunca vêm por aqui:
   * eles moram em `user_avatars` e só a rota que serve a imagem os lê.
   */
  avatarUpdatedAt: string | null;
};

/**
 * O perfil como o **site anônimo** o vê. Só existe quando `isPublic` e a conta
 * está ativa; nos demais casos a rota responde 404, sem distinguir os motivos
 * (`docs/20` §7).
 *
 * As duas listas trazem o que **já era público** — estar no perfil não torna
 * nada visível (decisão 7).
 */
export type PublicProfile = {
  username: string;
  name: string;
  bio: string;
  websiteUrl: string | null;
  links: ProfileLink[];
  hasAvatar: boolean;
  avatarUpdatedAt: string | null;
  skills: SkillSummary[];
  catalogs: PublicCatalog[];
};

export type ApiKeySummary = {
  id: string;
  userUuid: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

// ------------------------------------------------------- MCP virtual ------

/**
 * As três superfícies de um MCP virtual, decididas **por vínculo** — e não
 * pelas flags da skill, que valem só para o MCP principal
 * (`docs/08-mcp-virtual.md` §3.2).
 */
export type VirtualSurface = 'skill' | 'prompt' | 'resource';

export type VirtualMcpSummary = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  /** Desligado: tudo sob `/virtual/<slug>` responde 404, as chaves ficam. */
  isActive: boolean;
  /** Aberto: sem chave. Com skill privada dentro, é publicação de fato. */
  isOpen: boolean;
  /** Nulo quando o dono foi removido ou quando quem criou foi a sessão de bootstrap. */
  ownerUserUuid: string | null;
  ownerUsername: string | null;
  /** O que a conta que leu pode neste vMCP; `'view'` inclui ler as skills dentro. */
  access: EffectiveAccess;
  skillCount: number;
  /** Quantas skills saem por cada porta — os contadores do card no painel. */
  toolCount: number;
  promptCount: number;
  resourceCount: number;
  activeKeyCount: number;
  /** É o vMCP que responde em `/mcp` (`settings.default_virtual_mcp`). */
  isDefault: boolean;
  /**
   * Clientes online agora: sessões sem fim e com atividade dentro da janela
   * (`MCP_SESSION_ONLINE_WINDOW_MS`) que o chamador informou. Zero quando a
   * listagem foi feita sem janela.
   */
  onlineSessions: number;
  /**
   * Até `VIRTUAL_MCP_PREVIEW_SIZE` skills com vínculo direto, por nome, para a
   * colmeia do card: slug, nome e ícone. `skillCount` continua contando tudo.
   */
  preview: VirtualMcpPreviewSkill[];
  /** Catálogos vinculados (`virtual_mcp_catalogs`), ligados ou não. */
  catalogCount: number;
  /** Até `VIRTUAL_MCP_PREVIEW_SIZE` catálogos vinculados, por nome, para a colmeia do card. */
  previewCatalogs: VirtualMcpPreviewCatalog[];
  createdAt: string;
  updatedAt: string;
};

export type VirtualMcpPreviewSkill = { slug: string; name: string; icon: string | null };
export type VirtualMcpPreviewCatalog = { slug: string; name: string; isActive: boolean };

/**
 * Quantas skills e quantos catálogos a miniatura de um vMCP carrega: a colmeia
 * do card tem 19 células (1 + 6 + 12) e um hexágono "+N" para o resto.
 */
export const VIRTUAL_MCP_PREVIEW_SIZE = 19;

/** Um ponto do canvas do painel, em pixels do React Flow. */
export type CanvasPoint = { x: number; y: number };

/**
 * Posições dos nós fixos do canvas de um vMCP: o próprio servidor e o globo da
 * Internet. As posições das skills vivem no vínculo (`VirtualMcpSkill.position`).
 * Ausente = auto-layout.
 */
export type VirtualMcpLayout = { server?: CanvasPoint; internet?: CanvasPoint };

/** Uma skill vista de dentro do MCP virtual: as flags e os contadores são do vínculo. */
export type VirtualMcpSkill = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
  viewCount: number;
  downloadCount: number;
  /** Posição do nó no canvas do painel; nula até alguém arrastar. */
  position: CanvasPoint | null;
};

export type VirtualMcpDetail = VirtualMcpSummary & {
  skills: VirtualMcpSkill[];
  catalogs: VirtualMcpCatalog[];
  layout: VirtualMcpLayout;
  /** As concessões (`virtual_mcp_grants`); o app só as repassa a quem tem `manage`. */
  grants: Grant[];
};

/**
 * Um catálogo visto de dentro do MCP virtual — o nó do canvas
 * (`docs/11-catalogos.md` §5). As portas são do vínculo
 * (`virtual_mcp_catalogs`) e valem para todo membro do catálogo.
 */
export type VirtualMcpCatalog = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  /** O catálogo em si está ligado; desligado, não contribui nada. */
  isActive: boolean;
  ownerUserUuid: string | null;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
  /** Membros, contando inativos. */
  skillCount: number;
  /**
   * O número do nó: membros com participação ativa e skill ativa que **não**
   * têm vínculo direto com este vMCP — os que já são nó próprio no canvas
   * não contam duas vezes.
   */
  activeSkillCount: number;
  /** Posição do nó no canvas do painel; nula até alguém arrastar. */
  position: CanvasPoint | null;
};

/** Entrada de `setVirtualMcpCatalogs`: as três portas, obrigatórias como nas skills. */
export type VirtualMcpCatalogInput = {
  slug: string;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
};

/** Entrada de `setVirtualMcpSkills`: a escolha das três superfícies é obrigatória. */
export type VirtualMcpSkillInput = {
  slug: string;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
};

/**
 * Vínculo visto do lado da skill (`createSkill({ mcps })`, `link_skill`):
 * o vMCP alvo e as três portas, obrigatórias como em `VirtualMcpSkillInput`.
 */
export type SkillLinkInput = {
  virtualMcpUuid: string;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
};

/** Um vMCP aberto e ligado, como o site o lista: sem dono, sem chaves. */
export type PublicVirtualMcp = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  skillCount: number;
  /** Responde também em `/mcp`. */
  isDefault: boolean;
};

/**
 * A configuração da instalação, como o painel a vê
 * (`docs/09-mcp-padrao-e-skills-flutuantes.md`). Por ora, só o vMCP padrão:
 * qual responde em `/mcp`, ou por que nenhum responde.
 */
export type InstallationSettings = {
  defaultMcp:
    | { status: 'ok'; uuid: string; slug: string; name: string; isOpen: boolean }
    | { status: 'inactive'; uuid: string; slug: string; name: null; isOpen: null }
    | { status: 'none' | 'deleted'; uuid: null; slug: null; name: null; isOpen: null };
};

export type VirtualMcpKeySummary = {
  id: string;
  virtualMcpUuid: string;
  name: string;
  prefix: string;
  createdByUserUuid: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

/** Uma página da trilha de auditoria, como o painel a lista. */
export type AuditPage = { items: AuditEntry[]; total: number; limit: number; offset: number };

// ---------------------------------------------------------- catálogos ------

/**
 * Um catálogo: um grupo de skills com dono (`docs/11-catalogos.md`). Vinculado
 * a um vMCP, entrega todos os membros ativos de uma vez, pelas portas do
 * vínculo; uma skill pode estar em vários catálogos.
 */
export type CatalogSummary = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  /** Desligado: deixa de contribuir para todo vMCP vinculado; membros e vínculos ficam. */
  isActive: boolean;
  /** Nulo quando o dono foi removido ou quando quem criou foi a sessão de bootstrap. */
  ownerUserUuid: string | null;
  ownerUsername: string | null;
  /** Legível por qualquer conta e pelo site; expõe os membros (`docs/12` decisões 4 e 5). */
  isPublic: boolean;
  /** O que a conta que leu pode neste catálogo; `'view'` inclui ler os membros. */
  access: EffectiveAccess;
  /** Membros, contando participações desativadas e skills desligadas. */
  skillCount: number;
  /** Membros com participação ativa **e** skill ativa — o que um vMCP vinculado recebe. */
  activeSkillCount: number;
  /** vMCPs em que o catálogo está vinculado. */
  mcpCount: number;
  /** Contadores do catálogo: acessos a skills que chegaram ao vMCP por ele. */
  viewCount: number;
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
};

/** Uma skill vista de dentro do catálogo. */
export type CatalogSkill = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  /** A participação neste catálogo: desativada, a skill fica e não é entregue. */
  isActive: boolean;
  /** A skill em si (`skills.is_active`) — falso é o alerta na lista. */
  skillIsActive: boolean;
  addedAt: string;
};

/** Um vMCP em que o catálogo está, visto do catálogo: as portas são do vínculo. */
export type CatalogMcpRef = {
  uuid: string;
  slug: string;
  name: string;
  isOpen: boolean;
  isActive: boolean;
  isDefault: boolean;
  ownerUserUuid: string | null;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
};

export type CatalogDetail = CatalogSummary & {
  skills: CatalogSkill[];
  mcps: CatalogMcpRef[];
  /** As concessões (`catalog_grants`); o app só as repassa a quem tem `manage`. */
  grants: Grant[];
};

/**
 * Um catálogo público e ligado, como o site o lista: **com o dono pelo
 * username**, sem concessões.
 *
 * O dono entrou pela decisão 11 do `docs/19-username.md` — a ficha pública
 * credita quem mantém o catálogo, como a da skill. Continua sem `ownerUserUuid`:
 * o uuid é o `sub` do cookie de sessão do painel e não tem uso aqui. `null` é
 * catálogo sem dono, e a página não credita ninguém.
 */
export type PublicCatalog = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  ownerUsername: string | null;
  /** O dono tem perfil público? Decide se o crédito vira link (`docs/20` §7). */
  ownerHasProfile: boolean;
  /** Membros com participação ativa e skill ativa. */
  skillCount: number;
};

/** A página do catálogo no site: os membros ativos, todos (`docs/12` decisão 5). */
export type PublicCatalogDetail = PublicCatalog & {
  skills: SkillSummary[];
};

/** Entrada de `setCatalogSkills`: `isActive` omitido é "ativa" para quem entra e "não mexe" para quem fica. */
export type CatalogSkillInput = {
  slug: string;
  isActive?: boolean;
};

// ------------------------------------------------------- sessões MCP ------

/**
 * Contabilidade de sessões do MCP público (`docs/10-admin-canvas-e-sessoes.md`).
 *
 * Uma linha por cliente conectado a um vMCP. Nos transportes com sessão
 * (Streamable HTTP e SSE) a linha nasce no `initialize` e termina quando o
 * cliente fecha, o TTL vence ou o servidor para. No stateless não há sessão:
 * a linha agrupa as requisições de um mesmo cliente (IP, agente e credencial)
 * enquanto elas chegam dentro da janela de "online".
 */
export type McpSessionTransport = 'streamable' | 'sse' | 'stateless';
/** Por onde o cliente chegou: a raiz (`/mcp`) ou `/virtual/<slug>`. */
export type McpSessionMount = 'root' | 'virtual';
export type McpSessionAuth = 'open' | 'key';
export type McpSessionEndReason = 'closed' | 'timeout' | 'shutdown';

export type McpSessionSummary = {
  id: string;
  /** `mcp-session-id`, o `sessionId` do SSE ou a chave sintética do stateless. */
  sessionId: string;
  transport: McpSessionTransport;
  mount: McpSessionMount;
  /** Nulo quando o vMCP foi apagado depois; o slug fica como histórico. */
  virtualMcpUuid: string | null;
  virtualMcpSlug: string;
  auth: McpSessionAuth;
  keyId: string | null;
  keyName: string | null;
  /** IP de origem já resolvido pelo `trust proxy` (X-Forwarded-For quando confiável). */
  ip: string;
  userAgent: string | null;
  /** `clientInfo` do `initialize`, quando o cliente o enviou. */
  clientName: string | null;
  clientVersion: string | null;
  startedAt: string;
  lastSeenAt: string;
  /** Fim real (fechou) ou presumido pelo timeout. */
  endedAt: string | null;
  endReason: McpSessionEndReason | null;
  requestCount: number;
  /** Sem fim e com atividade dentro da janela informada na consulta. */
  isOnline: boolean;
};

export type McpSessionPage = {
  items: McpSessionSummary[];
  total: number;
  limit: number;
  offset: number;
};

// ---------------------------------------------------- acessos por skill ------

/**
 * Registro por leitura de uma skill (`docs/13-fichas-e-acessos.md`): uma
 * linha por `get_skill`, resource, prompt, SKILL.md ou pacote servido pelo
 * MCP público, pelo site ou pelo mcp-admin. É o que a guia "Acessos" da
 * skill e do catálogo listam; os contadores `view_count`/`download_count`
 * continuam existindo e são somados na mesma escrita.
 */
export type SkillAccessKind = 'view' | 'download';
/**
 * Por onde a leitura foi feita: `tool` (get_skill), `resource`
 * (resources/read), `prompt` (prompts/get), `file` (o SKILL.md avulso),
 * `download` (o pacote .zip/.skill), `page` (o detalhe no site) e
 * `admin-tool` (o get_skill do mcp-admin).
 */
export type SkillAccessSurface = 'tool' | 'resource' | 'prompt' | 'file' | 'download' | 'page' | 'admin-tool';
export type SkillAccessOrigin = 'mcp' | 'site' | 'mcp-admin';
/**
 * Quem leu: `open` (vMCP aberto, sem credencial), `key` (chave `psv_` do
 * vMCP), `user` (conta do painel, pela chave `psk_` do mcp-admin) ou
 * `anonymous` (o site).
 */
export type SkillAccessAuth = 'open' | 'key' | 'user' | 'anonymous';

/** O que cada superfície informa ao gravar; o banco resolve o caminho por catálogo e soma os contadores. */
export type SkillAccessInput = {
  skillUuid: string;
  kind: SkillAccessKind;
  surface: SkillAccessSurface;
  origin: SkillAccessOrigin;
  auth: SkillAccessAuth;
  /** O vMCP por onde a skill foi lida (MCP público); ausente no site e no mcp-admin. */
  virtualMcpUuid?: string;
  /** A chave `psv_` do vMCP, quando `auth = 'key'`. */
  keyId?: string;
  /** A chave `psk_` e a conta, quando `auth = 'user'`. */
  apiKeyId?: string;
  userUuid?: string;
  /** `mcp-session-id`, o `sessionId` do SSE ou a chave sintética do stateless. */
  sessionId?: string;
  ip?: string;
  userAgent?: string;
  /** `clientInfo` do `initialize`, quando o servidor MCP o conhece. */
  clientName?: string;
  clientVersion?: string;
};

export type SkillAccessEntry = {
  id: string;
  /** Nulo quando a skill foi apagada depois; o slug fica como histórico. */
  skillUuid: string | null;
  skillSlug: string;
  skillName: string;
  kind: SkillAccessKind;
  surface: SkillAccessSurface;
  origin: SkillAccessOrigin;
  auth: SkillAccessAuth;
  /** Nulo fora do MCP público ou quando o vMCP foi apagado; o slug fica. */
  virtualMcpUuid: string | null;
  virtualMcpSlug: string | null;
  virtualMcpName: string | null;
  /** Os catálogos por onde a skill chegou ao vMCP nesta leitura; vazio no vínculo direto, no site e no mcp-admin. */
  catalogs: { uuid: string | null; slug: string; name: string }[];
  keyId: string | null;
  keyName: string | null;
  apiKeyId: string | null;
  apiKeyName: string | null;
  userUuid: string | null;
  userUsername: string | null;
  sessionId: string | null;
  ip: string | null;
  userAgent: string | null;
  clientName: string | null;
  clientVersion: string | null;
  createdAt: string;
};

export type SkillAccessPage = {
  items: SkillAccessEntry[];
  total: number;
  limit: number;
  offset: number;
};

/** Links externos da sidebar do painel; nulos somem da tela. */
export type AdminLinks = { docs: string | null; support: string | null; chat: string | null };

/** A marca do painel: o nome e o ícone da sidebar, do login e da aba do navegador. */
export type AdminBrand = { name: string; iconUrl: string };

// --------------------------------------------------------- atividade ------

/**
 * A tela de Atividade do painel (`docs/18-atividade.md`): a grade de dias e o
 * relatório agregado de um deles.
 *
 * Ela junta três fontes que já existiam e nunca tinham sido lidas por dia —
 * `mcp_sessions` (quem se conectou), `skill_accesses` (o que foi lido) e
 * `audit_log` (o que mudou no catálogo) — mais a contagem de chamadas por
 * método, que nasceu com esta tela. **Tudo agregado**: nenhum corpo daqui
 * carrega IP, conta, `session_id` nem qualquer identificador de uma operação
 * individual. Quem precisa do evento a evento tem a trilha (`/api/audit`), as
 * sessões (`/api/sessions`) e a guia de acessos da skill.
 */

/**
 * O passo em que as chamadas MCP são acumuladas antes de ir ao banco: 15
 * minutos.
 *
 * É o maior balde que ainda permite recortar o dia em **qualquer** fuso: todo
 * deslocamento da base IANA é múltiplo de 15 minutos (o +05:45 do Nepal é o
 * caso extremo). Com balde de uma hora, um relatório em Katmandu somaria 45
 * minutos do dia vizinho; com balde diário, o fuso teria de ser congelado na
 * gravação e o número nunca fecharia com o das outras três fontes, que são
 * instantes exatos.
 */
export const MCP_CALL_BUCKET_MS = 900_000;

/**
 * A família de uma chamada, que é como o painel a agrupa — e como o canvas já
 * nomeia as portas de um vMCP (`--port-tools`, `--port-resources`,
 * `--port-prompts`).
 *
 * `skills` são os três métodos da extensão SEP-2640 (`skills/list`,
 * `skills/get`, `resources/directory/read`), que o `docs/17` trouxe;
 * `session` é o que abre e mantém a conversa (`initialize`, `ping`,
 * `notifications/*`) e não é consumo de conteúdo; `other` recolhe o que um
 * cliente mandar fora disso, para que um método novo do protocolo apareça na
 * conta em vez de sumir.
 */
export type McpCallFamily = 'tools' | 'resources' | 'prompts' | 'skills' | 'session' | 'other';

export const MCP_CALL_FAMILIES: readonly McpCallFamily[] = ['tools', 'resources', 'prompts', 'skills', 'session', 'other'];

/**
 * A que família pertence um método JSON-RPC.
 *
 * Pelo prefixo, e não por uma lista fechada: o protocolo ganha método novo
 * (foi o que a SEP-2640 fez), e um `tools/algo` que ainda não existe é mais
 * honesto dentro de `tools` do que dentro de `other`. `resources/directory/read`
 * é a exceção que a extensão criou — ele lê a árvore de uma skill, então conta
 * como `skills`, não como `resources`.
 */
export function mcpCallFamily(method: string): McpCallFamily {
  if (method === 'resources/directory/read' || method.startsWith('skills/')) return 'skills';
  if (method.startsWith('tools/')) return 'tools';
  if (method.startsWith('resources/')) return 'resources';
  if (method.startsWith('prompts/')) return 'prompts';
  if (method === 'initialize' || method === 'ping' || method.startsWith('notifications/') || method.startsWith('completion/')) {
    return 'session';
  }
  return 'other';
}

/** Um balde de chamadas fechado pelo rastreador do MCP público, pronto para somar no banco. */
export type McpCallBucketInput = {
  /** O início do balde de `MCP_CALL_BUCKET_MS`, em ISO; quem o calcula é quem atendeu a chamada. */
  bucket: string;
  /** Nulo nunca aqui: sem vMCP resolvido não há contabilidade (é o mesmo `scopeOf` das sessões). */
  virtualMcpUuid: string;
  virtualMcpSlug: string;
  transport: McpSessionTransport;
  /** O método JSON-RPC cru, como o cliente o mandou (já validado como texto curto). */
  method: string;
  calls: number;
};

/** Um dia da grade. Dia sem linha é dia sem atividade — aqui, ao contrário de `Stats`, faltar É zero. */
export type ActivityDay = {
  /** `AAAA-MM-DD` no fuso pedido na consulta. */
  day: string;
  /** Sessões abertas no dia (uma por cliente conectado a um vMCP). */
  sessions: number;
  /** Mensagens JSON-RPC recebidas pelo MCP público. */
  calls: number;
  /** Leituras de skill por qualquer superfície, inclusive o site e o mcp-admin. */
  reads: number;
  /** Eventos da trilha de auditoria (o que mudou no catálogo). */
  events: number;
  /** A soma das quatro — é ela que dá a cor da célula. */
  total: number;
};

/** A série que o heatmap desenha. */
export type ActivitySeries = {
  /** Só os dias com alguma atividade, em ordem crescente; o painel completa a grade com zeros. */
  days: ActivityDay[];
  /** A faixa efetivamente consultada, `AAAA-MM-DD` no fuso abaixo. */
  since: string;
  until: string;
  /** O fuso IANA em que os dias foram recortados — o do navegador, quando o painel o informa. */
  timezone: string;
};

/** Uma fatia nomeada de um total. `label` sai do banco quando o nome vale mais que a chave (um vMCP, uma skill). */
export type ActivitySlice = { key: string; label: string | null; count: number };

/**
 * O relatório de um dia. Tudo somado: a menor unidade é "quantas vezes", nunca
 * "quem" ou "qual operação".
 */
export type ActivityReport = {
  day: string;
  timezone: string;
  /** Quem se conectou ao MCP público. */
  clients: {
    /** Sessões abertas no dia. */
    sessions: number;
    /** Identidades distintas por trás delas (o `session_id`, que no stateless já é IP+agente+credencial+vMCP). */
    distinct: number;
    /** Nomes de agente distintos declarados no `initialize` (`clientInfo.name`). */
    agents: number;
    /** Sessões encerradas no dia, por motivo. */
    ended: number;
    byTransport: ActivitySlice[];
    byAuth: ActivitySlice[];
    byEndReason: ActivitySlice[];
    /** Os agentes mais vistos, por nome declarado — sem versão, sem IP. */
    topAgents: ActivitySlice[];
  };
  /** O que foi chamado no MCP público. */
  calls: {
    total: number;
    byFamily: ActivitySlice[];
    /** Os métodos mais chamados, com a família de cada um no `label`. */
    topMethods: ActivitySlice[];
    byTransport: ActivitySlice[];
    /** Os servidores mais chamados; `key` é o slug e `label`, o nome. */
    byServer: ActivitySlice[];
  };
  /** O que foi lido do acervo. */
  reads: {
    total: number;
    /** Quantas leituras foram entrega de pacote (`kind = 'download'`). */
    downloads: number;
    /** Skills distintas lidas no dia. */
    skills: number;
    bySurface: ActivitySlice[];
    byOrigin: ActivitySlice[];
    byAuth: ActivitySlice[];
    /** As skills mais lidas; `key` é o slug e `label`, o nome. */
    topSkills: ActivitySlice[];
  };
  /** O que mudou no catálogo, pela trilha. */
  catalog: {
    total: number;
    /** Atores distintos (contas, tokens e o `ambiente`), contados sem identificar. */
    actors: number;
    /** Por ação da trilha; `key` é o `AuditAction`. */
    byAction: ActivitySlice[];
    /** Por origem do evento: `web-admin` ou `mcp-admin`. */
    bySource: ActivitySlice[];
  };
};

// ---------------------------------------------------------- quarentena -----

/**
 * Um envio esperando aprovação (`docs/15-quarentena.md`).
 *
 * A quarentena é deliberadamente pobre: não tem slug, tag, ícone, vínculo com
 * vMCP nem catálogo, não entra na busca e não é fatiada pelo RAG. O que existe
 * é uma pasta de arquivos com dono, e quem aprova a transforma numa skill de
 * verdade. Por isso **não** há colisão de nome: dois envios do mesmo pacote
 * convivem, e é o `uuid` que os distingue.
 */
export type QuarantineSummary = {
  uuid: string;
  /** Lido do `name:` do SKILL.md, ou do nome do arquivo enviado. Só rótulo. */
  name: string;
  /** Lida do `description:` do SKILL.md; vazia quando ele não traz uma. */
  description: string;
  /** O arquivo que originou o envio (`pacote.zip`), informativo. */
  sourceFilename: string | null;
  /** Nulo quando o dono foi removido: o envio fica órfão, só do admin. */
  ownerUserUuid: string | null;
  ownerUsername: string | null;
  fileCount: number;
  /** A soma dos bytes gravados, como eles chegaram. */
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type QuarantineDetail = QuarantineSummary & {
  files: SkillFileMeta[];
};

/**
 * O envio **como o painel o recebe**: a ficha mais o que a sessão pode fazer
 * com ela.
 *
 * `canPromote` não é dado do banco — é a política da instalação
 * (`quarantine.approvers`) aplicada a quem pediu. Ele mora aqui, e não solto
 * nas duas pontas, porque é o contrato que decide se o botão "Aprovar"
 * aparece: declarado em separado de cada lado, um lado pode mudar sem o outro
 * perceber. A decisão que **vale** continua sendo a da rota de promover.
 */
export type QuarantineSheet = QuarantineDetail & {
  canPromote: boolean;
};

export type QuarantinePage = {
  items: QuarantineSummary[];
  total: number;
  limit: number;
  offset: number;
};

// -------------------------------------------------- importação de bundle ---

/**
 * Uma skill trazida por um **bundle** — um pacote com várias skills, cada uma
 * no diretório onde está o seu `SKILL.md` (`docs/15-quarentena.md`, §10).
 *
 * O que sai daqui é o retrato do que foi gravado, não do que veio no pacote:
 * `uuid` é o endereço do envio no painel, e `path` é de onde ele saiu — os dois
 * juntos são o que deixa alguém conferir a fila contra o `.zip` que enviou.
 */
export type BundleImported = {
  uuid: string;
  /** Lido do `name:` do SKILL.md; na falta dele, o nome do diretório. */
  name: string;
  /** O diretório dentro do pacote (`skills/brainstorming`); vazio na raiz. */
  path: string;
  fileCount: number;
};

/**
 * Uma skill que o bundle trazia e que **não** entrou na fila, com o motivo.
 *
 * Ela existe para que uma skill recusada não vire silêncio: o pacote de 40
 * skills entra inteiro menos a que passou do teto, e quem importou lê aqui qual
 * foi e por quê, em vez de contar a fila e descobrir que falta uma.
 */
export type BundleSkipped = {
  path: string;
  /** `too_many_files`: o diretório passou do teto de arquivos por skill. */
  reason: 'too_many_files';
  fileCount: number;
};

/**
 * O resultado de importar um pacote com **duas ou mais** skills.
 *
 * O bundle vai sempre para a quarentena: cada skill vira um envio, e nenhuma
 * chega ao acervo sem passar pela aprovação (decisão 1 do `docs/15`). O campo
 * `bundle` existe para discriminar este corpo do da importação de uma skill
 * só, que continua respondendo `QuarantineDetail` — a mesma rota, dois
 * formatos, e quem lê decide por `'bundle' in body`.
 */
export type QuarantineBundleResult = {
  bundle: true;
  /** O nome do arquivo enviado (`superpowers-main.zip`). */
  sourceFilename: string;
  imported: BundleImported[];
  skipped: BundleSkipped[];
};

/** O corpo de `POST /api/skills/import` com `destination: 'quarantine'`. */
export type QuarantineImportResult = QuarantineDetail | QuarantineBundleResult;
