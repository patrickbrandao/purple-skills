import { Link } from 'react-router-dom';
import { formatCount, type SkillSummary } from '../api.js';
import { DownloadIcon, EyeIcon, FileIcon } from './Icons.js';

export function SkillCard({ skill }: { skill: SkillSummary }) {
  return (
    <Link
      to={`/skills/${skill.slug}`}
      className="group flex h-full flex-col rounded-2xl border border-purple-400/12 bg-ink-850/80 p-5 transition duration-200 hover:-translate-y-0.5 hover:border-purple-400/45 hover:bg-ink-800 hover:shadow-lg hover:shadow-purple-900/30"
    >
      <h3 className="text-base font-semibold text-purple-50 transition group-hover:text-purple-200">
        {skill.name}
      </h3>

      <p className="mt-2 line-clamp-3 flex-1 text-sm leading-relaxed text-slate-400">
        {skill.description || 'Sem descrição.'}
      </p>

      {skill.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {skill.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="rounded-md bg-purple-500/12 px-2 py-0.5 text-[11px] font-medium text-purple-300"
            >
              {tag}
            </span>
          ))}
          {skill.tags.length > 4 && (
            <span className="px-1 text-[11px] text-slate-500">+{skill.tags.length - 4}</span>
          )}
        </div>
      )}

      <div className="mt-4 flex items-center gap-4 border-t border-purple-400/10 pt-3 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1.5" title="Acessos">
          <EyeIcon className="h-3.5 w-3.5" />
          {formatCount(skill.viewCount)}
        </span>
        <span className="inline-flex items-center gap-1.5" title="Downloads">
          <DownloadIcon className="h-3.5 w-3.5" />
          {formatCount(skill.downloadCount)}
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5" title="Arquivos">
          <FileIcon className="h-3.5 w-3.5" />
          {skill.fileCount}
        </span>
      </div>
    </Link>
  );
}
