import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Download, ExternalLink, FileText, Pencil, Trash2 } from 'lucide-react';
import {
  canEdit,
  canOwn,
  deleteSkill,
  formatDateTime,
  getSkill,
  num,
  skillDownloadUrl,
  skillPackageUrl,
  updateSkill,
  type Session,
  type SessionUser,
  type SkillDetail,
} from '../api.js';
import { AccessBadge, AccessPanel } from '../components/AccessPanel.js';
import { Badge, Button, McpChips, Panel, Skel, noSite, useConfirm } from '../components/ui.js';
import { FileTree } from '../components/FileTree.js';
import { SkillDoc } from '../components/SkillDoc.js';
import { SkillIcon } from '../components/SkillIcon.js';
import { SkillCatalogsPanel, SkillMcpsPanel } from '../components/SkillMcps.js';
import { useRegisterCommands } from '../components/commands.js';
import { useToast } from '../components/Toast.js';

/**
 * Leitura da skill no painel: o SKILL.md renderizado e a árvore de arquivos,
 * como o visitante vê no site. A edição fica atrás de "Editar"; onde a skill
 * está publicada se decide aqui mesmo, no painel "Publicada em".
 */
export function SkillViewPage({ session, user }: { session: Session; user: SessionUser }) {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();

  const [skill, setSkill] = useState<SkillDetail | null>(null);
  // O que a sessão pode nesta skill vem da própria resposta (`access`).
  const podeEscrever = skill ? canEdit(skill.access) : false;
  const podeApagar = skill ? canOwn(skill.access) : false;

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

  async function removeSkill() {
    if (!skill) return;
    const ok = await confirm({
      title: `Remover a skill "${skill.name}"?`,
      description: 'Todos os arquivos dela e os vínculos com servidores somem. Não dá para desfazer.',
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteSkill(skill.slug);
      toast.success('Skill removida.');
      navigate('/skills');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  useRegisterCommands(
    skill
      ? [
          ...(podeEscrever
            ? [{ id: 'skill-edit', label: `Editar "${skill.name}"`, group: 'Recurso' as const, icon: <Pencil />, shortcut: 'e', run: () => navigate(`/skills/${skill.slug}/editar`) }]
            : []),
          { id: 'skill-zip', label: 'Baixar .zip', group: 'Recurso', icon: <Download />, run: () => {
              window.open(skillDownloadUrl(skill.slug), '_self');
            },
          },
          ...(podeApagar ? [{ id: 'skill-delete', label: `Remover "${skill.name}"`, group: 'Perigo' as const, icon: <Trash2 />, danger: true, run: removeSkill }] : []),
        ]
      : [],
    [skill?.slug, podeEscrever, podeApagar],
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
          {podeApagar && (
            <Button variant="danger" onClick={() => void removeSkill()}>
              <Trash2 /> Remover
            </Button>
          )}
          {podeEscrever && (
            <Link to={`/skills/${skill.slug}/editar`} className="btn btn-primary">
              <Pencil /> Editar
            </Link>
          )}
        </div>
      </div>

      {skill.description && <p className="skill-lead">{skill.description}</p>}

      {skill.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {skill.tags.map((tag) => (
            <Badge key={tag} tone="outline">{tag}</Badge>
          ))}
        </div>
      )}

      {!skill.isActive && (
        <div className="alert warn mt-4">
          <AlertTriangle />
          <span>
            Esta skill está <strong>desligada</strong>: não aparece em servidor nenhum nem no site, nem pelos catálogos de que
            participa. Os vínculos ficam guardados; religue-a em Editar.
          </span>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <SkillMcpsPanel skill={skill} onChanged={setSkill} />
        <div className="grid content-start gap-4">
          <SkillCatalogsPanel skill={skill} />
          <AccessPanel
            kind="skill"
            object={skill}
            user={user}
            onPatch={(body) => updateSkill(skill.slug, body)}
            onChanged={setSkill}
            publicHint="Não a publica em servidor nenhum: onde ela aparece continua sendo o vínculo."
          />
        </div>
      </div>

      <div className="skill-read mt-4">
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
    </div>
  );
}
