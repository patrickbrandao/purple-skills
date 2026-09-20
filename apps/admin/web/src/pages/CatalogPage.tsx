import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ExternalLink, History, Info, Library, Pencil, Server, SlidersHorizontal, Users } from 'lucide-react';
import {
  canEdit as canEditAccess,
  canManage,
  formatDateTime,
  getCatalog,
  getCatalogAccesses,
  num,
  type CatalogDetail,
  type CatalogSkill,
  type Session,
  type SessionUser,
} from '../api.js';
import { Badge, EmptyRow, McpStateBadges, Panel, Skel, Status, Tabs } from '../components/ui.js';
import { AccessBadge, AccessTab, accessSentence } from '../components/AccessPanel.js';
import { AccessLog } from '../components/AccessLog.js';
import { SkillIcon } from '../components/SkillIcon.js';
import { SURFACES } from '../components/SkillMcps.js';
import { useRegisterCommands } from '../components/commands.js';
import { useToast } from '../components/Toast.js';

export type CatalogTab = 'catalogo' | 'skills' | 'propriedades' | 'acesso' | 'auditoria';

const TABS: readonly CatalogTab[] = ['skills', 'propriedades', 'acesso', 'auditoria'];

/** A guia pelo caminho, a partir da base da ficha (`/catalogos/:slug` ou `…/editar`). */
export const catalogTabOf = (pathname: string, base: string): CatalogTab =>
  TABS.find((item) => item === pathname.slice(base.length).split('/')[1]) ?? 'catalogo';

/** O que "público" significa num catálogo, para a guia Acesso. */
export const CATALOG_PUBLIC_HINT = 'O site lista o catálogo com todos os membros ativos — inclusive skills que não são públicas.';

/**
 * A ficha do catálogo, só leitura (`docs/13-fichas-e-acessos.md`): o título
 * com os selos e os contadores, o botão Editar, e as guias — Catálogo (a
 * descrição), Skills (os membros), Propriedades (configuração e onde está
 * vinculado), Acesso (dono, visibilidade e concessões) e Auditoria (as
 * leituras de skills entregues por este catálogo, para quem administra). Nada aqui grava: toda alteração é em
 * Editar. O que a sessão pode vem em `access` (`docs/12-acesso-granular.md`
 * §3.2).
 */
export function CatalogPage({ session, user }: { session: Session; user: SessionUser }) {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [detail, setDetail] = useState<CatalogDetail | null>(null);

  const tab = catalogTabOf(location.pathname, `/catalogos/${slug}`);

  // Fora de um data router, `navigate` muda a cada troca de caminho: se a carga
  // dependesse dele, cada troca de guia buscaria o catálogo de novo e piscaria
  // o esqueleto da ficha inteira.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Uma carga por catálogo. O cleanup descarta a resposta atrasada: trocando de
  // catálogo com a ficha montada, a do anterior podia chegar por último.
  useEffect(() => {
    let active = true;
    setDetail(null);
    getCatalog(slug)
      .then((fresh) => active && setDetail(fresh))
      .catch((err) => {
        if (!active) return;
        toast.error((err as Error).message);
        navigateRef.current('/catalogos');
      });
    return () => {
      active = false;
    };
  }, [slug, toast]);

  const canEdit = detail ? canEditAccess(detail.access) : false;
  const manages = detail ? canManage(detail.access) : false;

  const loadAccesses = useCallback(
    (query: Parameters<typeof getCatalogAccesses>[1]) => getCatalogAccesses(slug, query),
    [slug],
  );

  useRegisterCommands(
    detail && canEdit
      ? [{ id: 'catalog-edit', label: `Editar "${detail.name}"`, group: 'Recurso', icon: <Pencil />, shortcut: 'e', run: () => navigate(`/catalogos/${detail.slug}/editar`) }]
      : [],
    [detail?.slug, canEdit],
  );

  if (!detail) {
    return (
      <div className="page">
        <Skel h={20} w={120} className="mb-3" />
        <Skel h={40} w={360} className="mb-6" />
        <Skel h={320} />
      </div>
    );
  }

  const base = `/catalogos/${detail.slug}`;
  const inactiveSkills = detail.skills.filter((skill) => !skill.skillIsActive).length;

  return (
    <div className="page wide">
      <div className="page-head">
        <div className="min-w-0">
          <Link to="/catalogos" className="back-link">
            <ArrowLeft /> Catálogos
          </Link>
          <div className="flex items-center gap-2">
            <h1 className="truncate">{detail.name}</h1>
            <CatalogBadges catalog={detail} user={user} />
          </div>
          <CatalogSubline catalog={detail} user={user} />
        </div>
        <div className="page-actions">
          {detail.isPublic && (
            <a href={`${session.siteBaseUrl}/catalogos/${detail.slug}`} target="_blank" rel="noreferrer" className="btn btn-quiet btn-sm">
              <ExternalLink /> ver no site
            </a>
          )}
          {canEdit && (
            <Link to={`${base}/editar`} className="btn btn-primary">
              <Pencil /> Editar
            </Link>
          )}
        </div>
      </div>

      <CatalogAlerts catalog={detail} inactiveSkills={inactiveSkills} />

      <Tabs
        value={tab}
        items={[
          { key: 'catalogo', label: 'Catálogo', icon: <Info />, to: base },
          { key: 'skills', label: 'Skills', icon: <Library />, to: `${base}/skills`, count: detail.skillCount },
          { key: 'propriedades', label: 'Propriedades', icon: <SlidersHorizontal />, to: `${base}/propriedades` },
          { key: 'acesso', label: 'Acesso', icon: <Users />, to: `${base}/acesso` },
          ...(manages ? [{ key: 'auditoria', label: 'Auditoria', icon: <History />, to: `${base}/auditoria` }] : []),
        ]}
      />

      <Routes>
        <Route index element={<CatalogDescription description={detail.description} />} />
        <Route path="skills" element={<MembersTable catalog={detail} />} />
        <Route path="propriedades" element={<PropertiesTab catalog={detail} />} />
        <Route path="acesso" element={<AccessTab kind="catalog" object={detail} user={user} mode="read" publicHint={CATALOG_PUBLIC_HINT} />} />
        {manages && <Route path="auditoria" element={<AccessLog load={loadAccesses} showSkill />} />}
        {/* A guia se chamava Acessos: um link antigo vai para a Auditoria. */}
        <Route path="acessos" element={<Navigate to={`${base}/auditoria`} replace />} />
        <Route path="*" element={<Navigate to={base} replace />} />
      </Routes>
    </div>
  );
}

// ---------------------------------------------------- pedaços partilhados ---

/** Os selos do título: desligado, público, e a origem do acesso da sessão. */
export function CatalogBadges({ catalog, user }: { catalog: CatalogDetail; user: SessionUser }) {
  return (
    <>
      {!catalog.isActive && (
        <Badge tone="danger" title="Desligado: não contribui para nenhum servidor até religar">
          desligado
        </Badge>
      )}
      {catalog.isPublic && (
        <Badge tone="outline" title="Público: qualquer conta e o site leem, com todos os membros">
          público
        </Badge>
      )}
      <AccessBadge object={catalog} user={user} publicLabel="público" />
    </>
  );
}

/** A linha sob o título: slug, contadores, dono e datas. */
export function CatalogSubline({ catalog, user }: { catalog: CatalogDetail; user: SessionUser }) {
  return (
    <p className="sub mono flex flex-wrap items-center gap-x-3">
      <span>{catalog.slug}</span>
      <span>
        · {catalog.activeSkillCount} de {catalog.skillCount} skill{catalog.skillCount === 1 ? '' : 's'} ativa{catalog.activeSkillCount === 1 ? '' : 's'}
      </span>
      <span>· {catalog.mcpCount} servidor{catalog.mcpCount === 1 ? '' : 'es'}</span>
      <span>· {num(catalog.viewCount)} acessos</span>
      <span>· {num(catalog.downloadCount)} downloads</span>
      <span>· dono: {catalog.ownerEmail ?? 'nenhum (só admin)'}</span>
      <span>· criado em {formatDateTime(catalog.createdAt)}</span>
      <span>· atualizado em {formatDateTime(catalog.updatedAt)}</span>
      {user.role !== 'admin' && <span>· {accessSentence(catalog.access)}</span>}
    </p>
  );
}

/** Os avisos de estado, acima das guias, nas duas fichas. */
export function CatalogAlerts({ catalog, inactiveSkills }: { catalog: CatalogDetail; inactiveSkills: number }) {
  return (
    <>
      {!catalog.isActive && (
        <div className="alert warn mb-4">
          <AlertTriangle />
          <span>
            Este catálogo está <strong>desligado</strong>: nenhum servidor recebe as skills dele até religar. Os membros e os
            vínculos ficam guardados.
          </span>
        </div>
      )}
      {inactiveSkills > 0 && (
        <div className="alert warn mb-4">
          <AlertTriangle />
          <span>
            {inactiveSkills === 1 ? 'Uma skill deste catálogo está desligada' : `${inactiveSkills} skills deste catálogo estão desligadas`}: elas não
            são entregues em servidor nenhum até serem religadas na página da skill.
          </span>
        </div>
      )}
    </>
  );
}

/** A guia Catálogo: a descrição na largura da guia. */
function CatalogDescription({ description }: { description: string }) {
  return (
    <Panel className="desc-box" title="Descrição" icon={<Info />}>
      <p className={`desc-text${description ? '' : ' empty'}`}>
        {description || 'Sem descrição. Para quem administra: do que este grupo de skills trata.'}
      </p>
    </Panel>
  );
}

/** A linha de estado de um membro: entregue, desativada no catálogo ou skill desligada. */
export function MemberState({ skill, catalogActive }: { skill: CatalogSkill; catalogActive: boolean }) {
  const entregue = skill.isActive && skill.skillIsActive && catalogActive;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {!skill.skillIsActive && (
        <Badge tone="danger" title="A skill está desligada na própria ficha: não sai por servidor nenhum">
          <AlertTriangle style={{ width: 11, height: 11 }} /> skill desligada
        </Badge>
      )}
      {!skill.isActive && (
        <Badge tone="outline" title="Participação desativada neste catálogo: fica, mas não é entregue">
          desativada
        </Badge>
      )}
      {entregue && <Status tone="ok">entregue</Status>}
    </div>
  );
}

/**
 * A última linha de uma lista que o servidor recortou pelo que a conta vê: os
 * contadores do catálogo (`mcpCount`, `skillCount`) são globais de propósito — é
 * o número da confirmação de exclusão —, então a ficha pode anunciar 3
 * servidores e listar 1. A diferença é dita, em vez de parecer um erro de conta
 * (relatório 010 da auditoria de 2026-09-19).
 */
export function hiddenRowLabel(total: number, listed: number, one: string, many: string): string | null {
  const hidden = total - listed;
  if (hidden <= 0) return null;
  const what = hidden === 1 ? `1 ${one}` : `${hidden} ${many}`;
  return `${listed > 0 ? 'e mais ' : ''}${what} que você não vê`;
}

/** A guia Skills em leitura: os membros e o estado de cada um. */
function MembersTable({ catalog }: { catalog: CatalogDetail }) {
  // Quem chega só pelo "público" não recebe o membro privado de participação desativada.
  const hidden = hiddenRowLabel(catalog.skillCount, catalog.skills.length, 'skill', 'skills');
  return (
    <Panel title="Skills" icon={<Library />}>
      <p className="panel-hint">
        Toda skill entregue entra em cada servidor vinculado, pelas portas do vínculo. Adicionar, remover e desativar a
        participação é em Editar → Skills.
      </p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Skill</th>
              <th className="hidden md:table-cell">Estado</th>
              <th className="hidden lg:table-cell">Adicionada</th>
            </tr>
          </thead>
          <tbody>
            {catalog.skills.map((skill) => (
              <tr key={skill.uuid} className={skill.isActive ? undefined : 'is-off'}>
                <td>
                  <Link to={`/skills/${skill.slug}`} className="flex items-center gap-3 no-underline">
                    <SkillIcon icon={skill.icon} name={skill.name} slug={skill.slug} size="sm" />
                    <span className="min-w-0">
                      <span className="row-title">{skill.name}</span>
                      <span className="row-sub">{skill.slug}</span>
                    </span>
                  </Link>
                </td>
                <td className="hidden md:table-cell">
                  <MemberState skill={skill} catalogActive={catalog.isActive} />
                </td>
                <td className="hidden lg:table-cell">
                  <span className="row-sub whitespace-nowrap">{formatDateTime(skill.addedAt)}</span>
                </td>
              </tr>
            ))}
            {catalog.skills.length === 0 && !hidden && <EmptyRow colSpan={3}>Nenhuma skill ainda</EmptyRow>}
            {hidden && <EmptyRow colSpan={3}>{hidden}</EmptyRow>}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** "Vinculado em": os servidores que recebem o catálogo, com as portas. Leitura nas duas fichas. */
export function LinkedMcpsPanel({ catalog }: { catalog: CatalogDetail }) {
  // A lista vem só com os servidores que a conta vê (aberto e ligado, dela ou
  // concedido a ela): o fechado de terceiros não é nomeado aqui, como não é na
  // ficha da skill. O que sobra do contador é dito na última linha.
  const hidden = hiddenRowLabel(catalog.mcpCount, catalog.mcps.length, 'servidor', 'servidores');
  return (
    <Panel title="Vinculado em" icon={<Server />}>
      <p className="panel-hint">
        Os servidores que recebem este catálogo. O vínculo é feito no canvas do servidor, por quem o edita e vê este catálogo.
      </p>
      <div className="table-wrap">
        <table className="data">
          <tbody>
            {catalog.mcps.map((mcp) => (
              <tr key={mcp.uuid} className={mcp.isActive ? undefined : 'is-off'}>
                <td>
                  <Link to={`/mcps/${mcp.slug}`} className="row-title">
                    {mcp.name}
                  </Link>
                  <span className="row-sub flex flex-wrap items-center gap-1.5">
                    /virtual/{mcp.slug}
                    <McpStateBadges mcp={mcp} />
                  </span>
                </td>
                <td className="num">
                  <span className="flex justify-end gap-1">
                    {SURFACES.filter((surface) => mcp[surface.key]).map((surface) => (
                      <Badge key={surface.key} tone="outline">
                        {surface.label}
                      </Badge>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
            {catalog.mcps.length === 0 && !hidden && <EmptyRow colSpan={2}>Em nenhum servidor ainda</EmptyRow>}
            {hidden && <EmptyRow colSpan={2}>{hidden}</EmptyRow>}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** Configuração e vínculos — tudo em leitura. */
function PropertiesTab({ catalog }: { catalog: CatalogDetail }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Panel title="Propriedades" icon={<SlidersHorizontal />}>
        <dl className="kv props-kv">
          <dt>Nome</dt>
          <dd>{catalog.name}</dd>
          <dt>Slug</dt>
          <dd className="mono">{catalog.slug}</dd>
          <dt>Estado</dt>
          <dd>
            {catalog.isActive ? (
              <Badge tone="ok">ligado</Badge>
            ) : (
              <Badge tone="danger" title="Nenhum servidor recebe as skills dele">
                desligado
              </Badge>
            )}
          </dd>
          <dt>Membros</dt>
          <dd>
            {catalog.activeSkillCount} entregue{catalog.activeSkillCount === 1 ? '' : 's'} de {catalog.skillCount}
          </dd>
          <dt>Servidores</dt>
          <dd>{catalog.mcpCount}</dd>
          <dt>Visibilidade</dt>
          <dd>
            {catalog.isPublic ? 'público' : 'privado'} · dono: {catalog.ownerEmail ?? 'nenhum (só administradores)'}
          </dd>
          <dt>Acessos</dt>
          <dd>
            {num(catalog.viewCount)} leitura{catalog.viewCount === 1 ? '' : 's'} · {num(catalog.downloadCount)} download{catalog.downloadCount === 1 ? '' : 's'} — somados quando a skill chegou ao servidor por este catálogo
          </dd>
          <dt>Criado em</dt>
          <dd>{formatDateTime(catalog.createdAt)}</dd>
          <dt>Atualizado em</dt>
          <dd>{formatDateTime(catalog.updatedAt)}</dd>
        </dl>
      </Panel>
      <LinkedMcpsPanel catalog={catalog} />
    </div>
  );
}
