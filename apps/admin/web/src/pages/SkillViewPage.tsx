import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Download, ExternalLink, FileText, History, Info, Pencil, SlidersHorizontal } from 'lucide-react';
import {
  canEdit,
  canManage,
  formatDateTime,
  getMcps,
  getSkill,
  getSkillAccesses,
  num,
  skillDownloadUrl,
  skillPackageUrl,
  updateSkill,
  type Session,
  type SessionUser,
  type SkillDetail,
} from '../api.js';
import { AccessBadge, AccessPanel } from '../components/AccessPanel.js';
import { AccessLog } from '../components/AccessLog.js';
import { Badge, McpChips, Panel, Skel, Tabs, noSite } from '../components/ui.js';
import { FileTree } from '../components/FileTree.js';
import { SkillDoc } from '../components/SkillDoc.js';
import { SkillIcon } from '../components/SkillIcon.js';
import { SkillCatalogsPanel, SkillMcpsPanel } from '../components/SkillMcps.js';
import { useRegisterCommands } from '../components/commands.js';
import { useToast } from '../components/Toast.js';

type Tab = 'skill' | 'propriedades' | 'acessos';

/**
 * A ficha da skill, só leitura (`docs/13-fichas-e-acessos.md`): o título com
 * os contadores e os botões (ver no site, .zip, .skill, Editar) e três guias
 * — Skill (a descrição, o SKILL.md renderizado e cru, a árvore de arquivos),
 * Propriedades (metadados, onde está publicada, catálogos e acesso) e Acessos
 * (os últimos registros de leitura, para quem administra). Nada aqui grava:
 * toda alteração é em Editar.
 */
export function SkillViewPage({ session, user }: { session: Session; user: SessionUser }) {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const [skill, setSkill] = useState<SkillDetail | null>(null);
  // Quem edita a skill entra em Editar; quem só administra um servidor
  // também, para publicá-la lá (vincular exige só `view` na skill —
  // `docs/12-acesso-granular.md` §3.4).
  const [editsSomeMcp, setEditsSomeMcp] = useState(false);
  const podeEscrever = skill ? canEdit(skill.access) : false;
  const podeAdministrar = skill ? canManage(skill.access) : false;
  const podeEditar = podeEscrever || editsSomeMcp;

  const tab: Tab = location.pathname.endsWith('/propriedades')
    ? 'propriedades'
    : location.pathname.endsWith('/acessos')
      ? 'acessos'
      : 'skill';

  const load = useCallback(async () => {
    try {
      setSkill(await getSkill(slug));
    } catch (err) {
      toast.error((err as Error).message);
      navigate('/skills');
    }
  }, [slug, toast, navigate]);

  useEffect(() => {
    setSkill(null);
    void load();
  }, [load]);

  useEffect(() => {
    getMcps()
      .then((data) => setEditsSomeMcp(data.items.some((mcp) => canEdit(mcp.access))))
      .catch(() => setEditsSomeMcp(false));
  }, []);

  const loadAccesses = useCallback(
    (query: Parameters<typeof getSkillAccesses>[1]) => getSkillAccesses(slug, query),
    [slug],
  );

  useRegisterCommands(
    skill
      ? [
          ...(podeEditar
            ? [{ id: 'skill-edit', label: `Editar "${skill.name}"`, group: 'Recurso' as const, icon: <Pencil />, shortcut: 'e', run: () => navigate(`/skills/${skill.slug}/editar`) }]
            : []),
          { id: 'skill-zip', label: 'Baixar .zip', group: 'Recurso', icon: <Download />, run: () => {
              window.open(skillDownloadUrl(skill.slug), '_self');
            },
          },
        ]
      : [],
    [skill?.slug, podeEditar],
  );

  if (!skill) {
    return (
      <div className="page">
        <Skel h={20} w={120} className="mb-3" />
        <Skel h={40} w={360} className="mb-6" />
        <Skel h={320} />
      </div>
    );
  }

  const base = `/skills/${skill.slug}`;

  return (
    <div className="page wide">
      <div className="page-head">
        <div className="min-w-0">
          <Link to="/skills" className="back-link">
            <ArrowLeft /> Skills
          </Link>
          <div className="flex items-center gap-3">
            <SkillIcon icon={skill.icon} name={skill.name} slug={skill.slug} size="lg" />
            <div className="min-w-0">
              <h1 className="truncate">{skill.name}</h1>
              <p className="sub mono flex flex-wrap items-center gap-x-3">
                <span>{skill.slug}</span>
                <span>· {num(skill.viewCount)} acessos</span>
                <span>· {num(skill.downloadCount)} downloads</span>
                <span>· criada em {formatDateTime(skill.createdAt)}</span>
                <span>· atualizada em {formatDateTime(skill.updatedAt)}</span>
              </p>
            </div>
          </div>
        </div>

        <div className="page-actions">
          <AccessBadge object={skill} user={user} />
          <McpChips skill={skill} />
          {noSite(skill) && (
            <a href={`${session.siteBaseUrl}/skills/${skill.slug}`} target="_blank" rel="noreferrer" className="btn btn-quiet btn-sm">
              <ExternalLink /> ver no site
            </a>
          )}
          <a href={skillDownloadUrl(skill.slug)} className="btn btn-ghost" download>
            <Download /> .zip
          </a>
          <a href={skillPackageUrl(skill.slug)} className="btn btn-ghost" download>
            <Download /> .skill
          </a>
          {podeEditar && (
            <Link to={`${base}/editar`} className="btn btn-primary">
              <Pencil /> Editar
            </Link>
          )}
        </div>
      </div>

      {!skill.isActive && (
        <div className="alert warn mb-4">
          <AlertTriangle />
          <span>
            Esta skill está <strong>desligada</strong>: não aparece em servidor nenhum nem no site, nem pelos catálogos de que
            participa. Os vínculos ficam guardados; religue-a em Editar → Propriedades.
          </span>
        </div>
      )}

      <Tabs
        value={tab}
        items={[
          { key: 'skill', label: 'Skill', icon: <FileText />, to: base },
          { key: 'propriedades', label: 'Propriedades', icon: <SlidersHorizontal />, to: `${base}/propriedades` },
          // IPs, clientes e nomes de chave: só quem administra a skill.
          ...(podeAdministrar ? [{ key: 'acessos', label: 'Acessos', icon: <History />, to: `${base}/acessos` }] : []),
        ]}
      />

      <Routes>
        <Route index element={<SkillTab skill={skill} />} />
        <Route
          path="propriedades"
          element={<PropertiesTab skill={skill} user={user} onChanged={setSkill} />}
        />
        {podeAdministrar && <Route path="acessos" element={<AccessLog load={loadAccesses} />} />}
      </Routes>
    </div>
  );
}

/** A descrição na largura da guia e, abaixo, o SKILL.md com a árvore ao lado. */
function SkillTab({ skill }: { skill: SkillDetail }) {
  return (
    <>
      <DescriptionBox description={skill.description} tags={skill.tags} />

      <div className="skill-read">
        <div className="min-w-0">
          <SkillDoc slug={skill.slug} name={skill.name} description={skill.description} tags={skill.tags} skillMd={skill.skillMd} />
        </div>

        <Panel className="aside-sticky" title="Arquivos" icon={<FileText />}>
          <FileTree slug={skill.slug} files={skill.files} />
          <p className="panel-hint mt-3 mb-0">
            É esta a pasta que aparece ao descompactar o pacote. Clicar em um arquivo abre o conteúdo cru em outra guia.
          </p>
        </Panel>
      </div>
    </>
  );
}

/** A caixa da descrição, a mesma nas duas fichas: em leitura mostra o texto; em edição, o campo. */
export function DescriptionBox({
  description,
  tags,
  children,
}: {
  description: string;
  tags?: readonly string[];
  /** O campo de edição, no lugar do texto. */
  children?: ReactNode;
}) {
  return (
    <Panel className="desc-box" title="Descrição" icon={<Info />}>
      {children ?? (
        <p className={`desc-text${description ? '' : ' empty'}`}>{description || 'Sem descrição. É por ela que o agente decide acionar a skill.'}</p>
      )}
      {tags && tags.length > 0 && (
        <div className="desc-tags">
          {tags.map((tag) => (
            <Badge key={tag} tone="outline">
              {tag}
            </Badge>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Metadados, publicação, catálogos e acesso — tudo em leitura. */
function PropertiesTab({ skill, user, onChanged }: { skill: SkillDetail; user: SessionUser; onChanged: (detail: SkillDetail) => void }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
      <div className="grid content-start gap-4">
        <Panel title="Propriedades" icon={<SlidersHorizontal />}>
          <dl className="kv props-kv">
            <dt>Nome</dt>
            <dd>{skill.name}</dd>
            <dt>Slug</dt>
            <dd className="mono">{skill.slug}</dd>
            <dt>Ícone</dt>
            <dd className="flex items-center gap-2">
              <SkillIcon icon={skill.icon} name={skill.name} slug={skill.slug} size="sm" />
              {/* Um emoji já está no ladrilho; só a URL de imagem vale a pena repetir em texto. */}
              <span className="mono text-xs" style={{ color: 'var(--text-muted)' }}>
                {skill.icon === null ? 'monograma pelas iniciais' : /^https?:/i.test(skill.icon) ? skill.icon : 'emoji'}
              </span>
            </dd>
            <dt>Tags</dt>
            <dd>
              {skill.tags.length > 0 ? (
                <span className="flex flex-wrap gap-1.5">
                  {skill.tags.map((tag) => (
                    <Badge key={tag} tone="outline">
                      {tag}
                    </Badge>
                  ))}
                </span>
              ) : (
                <span style={{ color: 'var(--text-faint)' }}>nenhuma</span>
              )}
            </dd>
            <dt>Estado</dt>
            <dd>
              {skill.isActive ? (
                <Badge tone="ok">ligada</Badge>
              ) : (
                <Badge tone="danger" title="Não é entregue por servidor nenhum nem aparece no site">
                  desligada
                </Badge>
              )}
            </dd>
            <dt>Arquivos</dt>
            <dd>{num(skill.fileCount)}</dd>
            <dt>Acessos</dt>
            <dd>
              {num(skill.viewCount)} leitura{skill.viewCount === 1 ? '' : 's'} · {num(skill.downloadCount)} download{skill.downloadCount === 1 ? '' : 's'} · pontuação {num(skill.score)}
            </dd>
            <dt>Criada em</dt>
            <dd>{formatDateTime(skill.createdAt)}</dd>
            <dt>Atualizada em</dt>
            <dd>{formatDateTime(skill.updatedAt)}</dd>
          </dl>
        </Panel>

        <SkillMcpsPanel skill={skill} onChanged={onChanged} readOnly />
      </div>

      <div className="grid content-start gap-4">
        <SkillCatalogsPanel skill={skill} />
        <AccessPanel
          kind="skill"
          object={skill}
          user={user}
          onPatch={(body) => updateSkill(skill.slug, body)}
          onChanged={onChanged}
          publicHint="Não a publica em servidor nenhum: onde ela aparece continua sendo o vínculo."
          readOnly
        />
      </div>
    </div>
  );
}
