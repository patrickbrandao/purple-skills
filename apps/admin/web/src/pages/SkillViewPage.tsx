import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  canDelete,
  canWrite,
  deleteSkill,
  formatDateTime,
  getSkill,
  skillDownloadUrl,
  skillPackageUrl,
  type Session,
  type SessionUser,
  type SkillDetail,
} from '../api.js';
import { Badge, Button, Panel } from '../components/ui.js';
import { FileTree } from '../components/FileTree.js';
import { SkillDoc } from '../components/SkillDoc.js';
import {
  ArrowLeftIcon,
  DownloadIcon,
  ExternalIcon,
  FileIcon,
  PencilIcon,
  TrashIcon,
} from '../components/Icons.js';
import { useToast } from '../components/Toast.js';

/**
 * Leitura da skill no painel: o SKILL.md renderizado e a árvore de arquivos,
 * como o visitante vê no site. A edição fica atrás do botão "Editar", para que
 * abrir uma skill não signifique estar prestes a mudá-la.
 */
export function SkillViewPage({ session, user }: { session: Session; user: SessionUser }) {
  const podeEscrever = canWrite(user.role);
  const podeApagar = canDelete(user.role);
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [skill, setSkill] = useState<SkillDetail | null>(null);

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
    if (!window.confirm(`Remover a skill "${skill.name}" e todos os seus arquivos?`)) return;
    try {
      await deleteSkill(skill.slug);
      toast.success('Skill removida.');
      navigate('/skills');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  if (!skill) {
    return <div className="skel-block" style={{ height: '18rem' }} />;
  }

  return (
    <>
      <div className="page-head">
        <div className="min-w-0">
          <Link to="/skills" className="back-link">
            <ArrowLeftIcon /> Skills
          </Link>
          <h1 className="display mt-1 flex flex-wrap items-center gap-3">
            <span className="truncate">{skill.name}</span>
            <Badge isPublic={skill.isPublic} />
          </h1>
          <p className="sub mono flex flex-wrap items-center gap-x-3">
            <span>{skill.slug}</span>
            <span>· {skill.viewCount} acessos</span>
            <span>· {skill.downloadCount} downloads</span>
            <span>· atualizada em {formatDateTime(skill.updatedAt)}</span>
            {skill.isPublic && (
              <a
                href={`${session.siteBaseUrl}/skills/${skill.slug}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1"
                style={{ color: 'var(--brand)' }}
              >
                <ExternalIcon className="h-3 w-3" /> ver no site
              </a>
            )}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <a href={skillDownloadUrl(skill.slug)} className="btn btn-ghost" download>
            <DownloadIcon /> .zip
          </a>
          <a href={skillPackageUrl(skill.slug)} className="btn btn-ghost" download>
            <DownloadIcon /> .skill
          </a>
          {podeApagar && (
            <Button variant="danger" onClick={removeSkill}>
              <TrashIcon /> Remover
            </Button>
          )}
          {podeEscrever && (
            <Link to={`/skills/${skill.slug}/editar`} className="btn btn-primary">
              <PencilIcon /> Editar
            </Link>
          )}
        </div>
      </div>

      {skill.description && <p className="skill-lead">{skill.description}</p>}

      {skill.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {skill.tags.map((tag) => (
            <span className="tag" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="skill-read mt-5">
        <div className="min-w-0">
          <SkillDoc
            slug={skill.slug}
            name={skill.name}
            description={skill.description}
            tags={skill.tags}
            skillMd={skill.skillMd}
          />
        </div>

        <Panel className="aside-sticky">
          <h2>
            <FileIcon /> Arquivos
          </h2>
          <FileTree slug={skill.slug} files={skill.files} />
          <p className="panel-hint mt-3">
            É esta a pasta que aparece ao descompactar o pacote. Clicar em um arquivo abre o
            conteúdo cru em outra guia.
          </p>
        </Panel>
      </div>
    </>
  );
}
