import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  downloadUrl,
  fetchSkill,
  formatCount,
  formatDate,
  type SkillDetail,
} from '../api.js';
import { Markdown } from '../components/Markdown.js';
import { CopyButton } from '../components/CopyButton.js';
import { FileTree } from '../components/FileTree.js';
import {
  ArrowLeftIcon,
  DownloadIcon,
  EyeIcon,
  FileIcon,
  PlugIcon,
  TagIcon,
} from '../components/Icons.js';
import { useMeta } from '../useMeta.js';

export function SkillPage() {
  const { slug = '' } = useParams();
  const meta = useMeta();
  const [skill, setSkill] = useState<SkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSkill(null);
    setError(null);
    window.scrollTo({ top: 0 });

    fetchSkill(slug)
      .then((data) => active && setSkill(data))
      .catch((err: Error) => active && setError(err.message));

    return () => {
      active = false;
    };
  }, [slug]);

  useEffect(() => {
    const name = meta?.name ?? 'Purple Skills';
    document.title = skill ? `${skill.name} — ${name}` : name;
  }, [skill, meta]);

  if (error) {
    return (
      <section className="skill-page">
        <div className="wrap">
          <div className="empty" style={{ maxWidth: '30rem', margin: '40px auto' }}>
            <img className="wiz" src="/assets/images/icon-purple-right-137x158.png" alt="" />
            <h3>Skill não encontrada</h3>
            <p>{error}</p>
            <Link to="/#catalogo" className="btn btn-primary" style={{ marginTop: '22px' }}>
              <ArrowLeftIcon /> Voltar ao catálogo
            </Link>
          </div>
        </div>
      </section>
    );
  }

  if (!skill) {
    return (
      <section className="skill-page">
        <div className="wrap" style={{ display: 'grid', gap: '16px' }}>
          <div className="skel" style={{ height: '2.6rem', maxWidth: '28rem' }} />
          <div className="skel" style={{ height: '1.2rem', maxWidth: '40rem' }} />
          <div className="skel" style={{ height: '22rem' }} />
        </div>
      </section>
    );
  }

  const publicUrl = `${meta?.baseUrl ?? window.location.origin}/skills/${skill.slug}`;

  return (
    <section className="skill-page">
      <div className="wrap">
        <Link to="/#catalogo" className="back-link">
          <ArrowLeftIcon /> Catálogo
        </Link>

        <header className="skill-head">
          <h1 className="display">{skill.name}</h1>
          {skill.description && <p className="lead">{skill.description}</p>}

          {skill.tags.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {skill.tags.map((tag) => (
                <Link key={tag} to={`/?tag=${encodeURIComponent(tag)}#catalogo`} className="tag">
                  <TagIcon className="h-3 w-3" />
                  {tag}
                </Link>
              ))}
            </div>
          )}

          <div className="skill-meta">
            <span>
              <EyeIcon /> {formatCount(skill.viewCount)} acessos
            </span>
            <span>
              <DownloadIcon /> {formatCount(skill.downloadCount)} downloads
            </span>
            <span>
              <FileIcon /> {skill.fileCount} arquivo{skill.fileCount === 1 ? '' : 's'}
            </span>
            <span>atualizada em {formatDate(skill.updatedAt)}</span>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <a href={downloadUrl(skill.slug)} className="btn btn-primary">
              <DownloadIcon /> Baixar pacote .zip
            </a>
            <CopyButton value={publicUrl} />
          </div>
        </header>

        <div className="skill-body">
          <article className="min-w-0">
            <Markdown>
              {skill.skillMd || '_Esta skill ainda não tem conteúdo em SKILL.md._'}
            </Markdown>
          </article>

          <aside className="skill-aside">
            <section className="aside-card">
              <h2>
                <FileIcon /> Arquivos
              </h2>
              <FileTree slug={skill.slug} files={skill.files} />
              <p className="ft-hint">
                É esta a pasta que aparece ao descompactar o .zip.
              </p>
            </section>

            {meta?.mcpUrl && (
              <section className="aside-card">
                <h2>
                  <PlugIcon /> Via MCP
                </h2>
                <p className="mt-2 text-xs" style={{ color: 'var(--text-faint)' }}>
                  Conecte seu agente e peça pelo slug:
                </p>
                <div className="code-card" style={{ marginTop: '10px' }}>
                  <div className="code-body" style={{ padding: '12px 14px', fontSize: '.76rem' }}>
                    <span className="k">get_skill</span>
                    {'('}
                    <span className="s">"{skill.slug}"</span>
                    {')'}
                  </div>
                </div>
                <CopyButton
                  value={meta.mcpUrl}
                  label="Copiar URL do MCP"
                  className="btn btn-ghost btn-sm mt-3 w-full"
                />
              </section>
            )}
          </aside>
        </div>
      </div>
    </section>
  );
}
