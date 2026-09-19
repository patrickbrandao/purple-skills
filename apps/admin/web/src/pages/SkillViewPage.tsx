import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  ExternalLink,
  FileText,
  FolderTree,
  History,
  Info,
  Library,
  Pencil,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
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
  type Session,
  type SessionUser,
  type SkillDetail,
  type SkillFileMeta,
} from '../api.js';
import { AccessBadge, AccessTab } from '../components/AccessPanel.js';
import { AccessLog } from '../components/AccessLog.js';
import { Badge, McpChips, Panel, Skel, Tabs, noSite } from '../components/ui.js';
import { FileTree } from '../components/FileTree.js';
import { SkillDoc } from '../components/SkillDoc.js';
import { SkillFilesView } from '../components/SkillFiles.js';
import { SkillIcon } from '../components/SkillIcon.js';
import { SkillCatalogsTab, SkillMcpsPanel } from '../components/SkillMcps.js';
import { useRegisterCommands } from '../components/commands.js';
import { useToast } from '../components/Toast.js';
import { openFileState, useOpenFileFromState, useSkillFiles } from '../useSkillFiles.js';

type Tab = 'skill' | 'arquivos' | 'catalogos' | 'propriedades' | 'acesso' | 'auditoria';

const TABS: readonly Tab[] = ['arquivos', 'catalogos', 'propriedades', 'acesso', 'auditoria'];

/**
 * A ficha da skill, só leitura (`docs/13-fichas-e-acessos.md`): o título com
 * os contadores e os botões (ver no site, .zip, .skill, Editar) e as guias —
 * Skill (a descrição, o SKILL.md renderizado e cru, a árvore de arquivos),
 * Arquivos (a árvore e o arquivo escolhido, com as cores da linguagem),
 * Catálogos (de quais participa), Propriedades (metadados e onde está
 * publicada), Acesso (dono, visibilidade e concessões) e Auditoria (os
 * últimos registros de leitura, para quem administra). Nada aqui grava: toda
 * alteração é em Editar.
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

  const tail = location.pathname.slice(`/skills/${slug}`.length).split('/')[1] ?? '';
  const tab: Tab = TABS.find((item) => item === tail) ?? 'skill';

  // Fora de um data router, `navigate` muda a cada troca de caminho: se o
  // `load` dependesse dele, cada troca de guia buscaria a skill de novo e
  // fecharia o arquivo aberto em Arquivos.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const load = useCallback(async () => {
    try {
      setSkill(await getSkill(slug));
    } catch (err) {
      toast.error((err as Error).message);
      navigateRef.current('/skills');
    }
  }, [slug, toast]);

  useEffect(() => {
    setSkill(null);
    void load();
  }, [load]);

  /** "Recarregar a árvore" troca só a lista de arquivos. */
  const onFiles = useCallback((update: (files: SkillFileMeta[]) => SkillFileMeta[]) => {
    setSkill((current) => {
      if (!current) return current;
      const files = update(current.files);
      return files === current.files ? current : { ...current, files, fileCount: files.length };
    });
  }, []);

  // O estado da guia Arquivos mora na página: ir a outra guia e voltar mantém o arquivo aberto.
  const files = useSkillFiles({ skill, canWrite: false, onFiles, onReloadAll: load, formDirty: false });
  useOpenFileFromState(files, skill?.uuid);

  useEffect(() => {
    getMcps()
      .then((data) => setEditsSomeMcp(data.items.some((mcp) => canEdit(mcp.access))))
      .catch(() => setEditsSomeMcp(false));
  }, []);

  const loadAccesses = useCallback(
    (query: Parameters<typeof getSkillAccesses>[1]) => getSkillAccesses(slug, query),
    [slug],
  );

  // Editar abre a mesma guia (a Auditoria não existe lá) e, em Arquivos, o mesmo arquivo.
  const editPath = `/skills/${skill?.slug ?? slug}/editar${tab === 'skill' || tab === 'auditoria' ? '' : `/${tab}`}`;
  const editState = tab === 'arquivos' ? openFileState(files) : undefined;

  useRegisterCommands(
    skill
      ? [
          ...(podeEditar
            ? [{ id: 'skill-edit', label: `Editar "${skill.name}"`, group: 'Recurso' as const, icon: <Pencil />, shortcut: 'e', run: () => navigate(editPath, { state: editState }) }]
            : []),
          { id: 'skill-zip', label: 'Baixar .zip', group: 'Recurso', icon: <Download />, run: () => {
              window.open(skillDownloadUrl(skill.slug), '_self');
            },
          },
          ...(tab !== 'arquivos'
            ? [{ id: 'files-tab', label: 'Arquivos da skill', group: 'Ir para' as const, icon: <FolderTree />, keywords: ['arvore', 'ler arquivo', 'código'], run: () => navigate(`/skills/${skill.slug}/arquivos`) }]
            : []),
        ]
      : [],
    [skill?.slug, podeEditar, editPath, editState?.openFile, tab],
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
    <div className={`page wide${tab === 'arquivos' ? ' workbench' : ''}`}>
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
            <Link to={editPath} state={editState} className="btn btn-primary">
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
          { key: 'arquivos', label: 'Arquivos', icon: <FolderTree />, to: `${base}/arquivos`, count: skill.files.length },
          { key: 'catalogos', label: 'Catálogos', icon: <Library />, to: `${base}/catalogos`, count: skill.catalogs.length },
          { key: 'propriedades', label: 'Propriedades', icon: <SlidersHorizontal />, to: `${base}/propriedades` },
          { key: 'acesso', label: 'Acesso', icon: <Users />, to: `${base}/acesso` },
          // IPs, clientes e nomes de chave: só quem administra a skill.
          ...(podeAdministrar ? [{ key: 'auditoria', label: 'Auditoria', icon: <History />, to: `${base}/auditoria` }] : []),
        ]}
      />

      <Routes>
        <Route
          index
          element={
            <SkillTab
              skill={skill}
              filesPath={`${base}/arquivos`}
              onOpenFile={(path) => {
                files.open(path);
                navigate(`${base}/arquivos`);
              }}
            />
          }
        />
        <Route path="arquivos" element={<SkillFilesView ws={files} skill={skill} />} />
        <Route path="catalogos" element={<SkillCatalogsTab skill={skill} user={user} />} />
        <Route path="propriedades" element={<PropertiesTab skill={skill} />} />
        <Route
          path="acesso"
          element={
            <AccessTab
              kind="skill"
              object={skill}
              user={user}
              mode="read"
              publicHint="Não a publica em servidor nenhum: onde ela aparece continua sendo o vínculo."
            />
          }
        />
        {podeAdministrar && <Route path="auditoria" element={<AccessLog load={loadAccesses} />} />}
        {/* A guia se chamava Acessos: um link antigo vai para a Auditoria. */}
        <Route path="acessos" element={<Navigate to={`${base}/auditoria`} replace />} />
        <Route path="*" element={<Navigate to={base} replace />} />
      </Routes>
    </div>
  );
}

/**
 * A descrição na largura da guia e, abaixo, o SKILL.md com a árvore ao lado.
 * A árvore só navega: escolher um arquivo o abre na guia Arquivos.
 */
function SkillTab({ skill, filesPath, onOpenFile }: { skill: SkillDetail; filesPath: string; onOpenFile: (path: string) => void }) {
  return (
    <>
      <DescriptionBox description={skill.description} tags={skill.tags} />

      <div className="skill-read">
        <div className="min-w-0">
          <SkillDoc slug={skill.slug} name={skill.name} description={skill.description} tags={skill.tags} skillMd={skill.skillMd} />
        </div>

        <Panel
          className="aside-sticky"
          title="Arquivos"
          icon={<FolderTree />}
          actions={
            <Link to={filesPath} className="link-action">
              Abrir a guia
            </Link>
          }
        >
          <FileTree slug={skill.slug} files={skill.files} onPick={onOpenFile} />
          <p className="panel-hint mt-3 mb-0">
            É esta a pasta que aparece ao descompactar o pacote. Clique num arquivo para lê-lo na guia{' '}
            <Link to={filesPath} className="link">
              Arquivos
            </Link>
            , com as cores da linguagem.
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

/** Metadados e onde a skill está publicada — tudo em leitura. */
function PropertiesTab({ skill }: { skill: SkillDetail }) {
  return (
    <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
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
          <dt>Visibilidade</dt>
          <dd>{skill.isPublic ? 'pública' : 'privada'} · dono: {skill.ownerEmail ?? 'nenhum (só administradores)'}</dd>
          <dt>Catálogos</dt>
          <dd>{num(skill.catalogs.length)}</dd>
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

      <SkillMcpsPanel skill={skill} />
    </div>
  );
}
