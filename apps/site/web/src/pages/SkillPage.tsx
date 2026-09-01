import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  downloadUrl,
  fetchSkill,
  fileUrl,
  formatBytes,
  formatCount,
  formatDate,
  type SkillDetail,
} from '../api.js';
import { Markdown } from '../components/Markdown.js';
import { CopyButton } from '../components/CopyButton.js';
import { ArrowLeftIcon, DownloadIcon, EyeIcon, FileIcon, PlugIcon } from '../components/Icons.js';
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
    document.title = skill ? `${skill.name} — Purple Skills` : 'Purple Skills';
  }, [skill]);

  if (error) {
    return (
      <div className="py-24 text-center">
        <h1 className="text-2xl font-semibold text-purple-100">Skill não encontrada</h1>
        <p className="mt-2 text-sm text-slate-500">{error}</p>
        <Link
          to="/"
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-purple-500"
        >
          <ArrowLeftIcon /> Voltar ao catálogo
        </Link>
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="space-y-4 py-12">
        <div className="h-9 w-2/3 animate-pulse rounded-lg bg-ink-850" />
        <div className="h-5 w-1/2 animate-pulse rounded-lg bg-ink-850" />
        <div className="h-72 animate-pulse rounded-2xl bg-ink-850/60" />
      </div>
    );
  }

  const publicUrl = `${meta?.baseUrl ?? window.location.origin}/skills/${skill.slug}`;
  const attachments = skill.files.filter((file) => file.relativePath.toLowerCase() !== 'skill.md');

  return (
    <>
      <Link
        to="/"
        className="mt-8 inline-flex items-center gap-2 text-sm text-slate-500 transition hover:text-purple-300"
      >
        <ArrowLeftIcon className="h-3.5 w-3.5" /> Catálogo
      </Link>

      <header className="mt-5 border-b border-purple-400/10 pb-8">
        <h1 className="text-3xl font-bold tracking-tight text-purple-50 sm:text-4xl">
          {skill.name}
        </h1>
        {skill.description && (
          <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-slate-400">
            {skill.description}
          </p>
        )}

        {skill.tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {skill.tags.map((tag) => (
              <Link
                key={tag}
                to={`/?tag=${encodeURIComponent(tag)}`}
                className="rounded-md bg-purple-500/12 px-2.5 py-1 text-xs font-medium text-purple-300 transition hover:bg-purple-500/25"
              >
                {tag}
              </Link>
            ))}
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <EyeIcon className="h-3.5 w-3.5" /> {formatCount(skill.viewCount)} acessos
          </span>
          <span className="inline-flex items-center gap-1.5">
            <DownloadIcon className="h-3.5 w-3.5" /> {formatCount(skill.downloadCount)} downloads
          </span>
          <span className="inline-flex items-center gap-1.5">
            <FileIcon className="h-3.5 w-3.5" /> {skill.fileCount} arquivo
            {skill.fileCount === 1 ? '' : 's'}
          </span>
          <span>Atualizada em {formatDate(skill.updatedAt)}</span>
        </div>

        <div className="mt-6 flex flex-wrap gap-2.5">
          <a
            href={downloadUrl(skill.slug)}
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-br from-purple-500 to-purple-700 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-purple-900/40 transition hover:from-purple-400 hover:to-purple-600"
          >
            <DownloadIcon /> Baixar pacote .zip
          </a>
          <CopyButton value={publicUrl} />
        </div>
      </header>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_260px]">
        <article className="min-w-0">
          <Markdown>{skill.skillMd || '_Esta skill ainda não tem conteúdo em SKILL.md._'}</Markdown>
        </article>

        <aside className="space-y-5 lg:sticky lg:top-20 lg:self-start">
          <section className="rounded-xl border border-purple-400/12 bg-ink-850/70 p-4">
            <h2 className="text-xs font-semibold tracking-wider text-slate-500 uppercase">
              Arquivos
            </h2>
            <ul className="mt-3 space-y-1">
              <li>
                <a
                  href={fileUrl(skill.slug, 'SKILL.md')}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-purple-200 transition hover:bg-ink-800"
                  download
                >
                  <FileIcon className="h-3.5 w-3.5 shrink-0 text-purple-400" />
                  <span className="truncate">SKILL.md</span>
                </a>
              </li>
              {attachments.map((file) => (
                <li key={file.relativePath}>
                  <a
                    href={fileUrl(skill.slug, file.relativePath)}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-400 transition hover:bg-ink-800 hover:text-purple-200"
                    title={`${file.relativePath} — ${formatBytes(file.sizeBytes)}`}
                    download
                  >
                    <FileIcon className="h-3.5 w-3.5 shrink-0 text-slate-600" />
                    <span className="truncate">{file.relativePath}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-slate-600">
                      {formatBytes(file.sizeBytes)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            {attachments.length === 0 && (
              <p className="mt-2 px-2 text-xs text-slate-600">Sem arquivos adicionais.</p>
            )}
          </section>

          {meta?.mcpUrl && (
            <section className="rounded-xl border border-purple-400/12 bg-ink-850/70 p-4">
              <h2 className="flex items-center gap-2 text-xs font-semibold tracking-wider text-slate-500 uppercase">
                <PlugIcon className="h-3.5 w-3.5" /> Via MCP
              </h2>
              <p className="mt-2 text-xs leading-relaxed text-slate-500">
                Conecte seu agente e peça pelo slug:
              </p>
              <code className="mt-2 block overflow-x-auto rounded-md bg-ink-950 px-2.5 py-2 font-mono text-[11px] text-purple-300">
                get_skill("{skill.slug}")
              </code>
              <CopyButton
                value={meta.mcpUrl}
                label="Copiar URL do MCP"
                className="mt-3 w-full justify-center !py-2 !text-xs"
              />
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
