import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  deleteSkill,
  formatDateTime,
  listSkills,
  setVisibility,
  type SkillSummary,
} from '../api.js';
import { Badge, Button, inputClass } from '../components/ui.js';
import { PlusIcon, TrashIcon } from '../components/Icons.js';
import { useToast } from '../components/Toast.js';

export function SkillsPage() {
  const toast = useToast();
  const [items, setItems] = useState<SkillSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (search: string) => {
      setLoading(true);
      try {
        const data = await listSkills({ q: search, limit: 100, sort: search ? undefined : 'recent' });
        setItems(data.items);
        setTotal(data.total);
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    const timer = setTimeout(() => void load(query), query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  async function toggleVisibility(skill: SkillSummary) {
    setBusy(skill.slug);
    try {
      const updated = await setVisibility(skill.slug, !skill.isPublic);
      setItems((current) =>
        current.map((item) => (item.uuid === skill.uuid ? { ...item, isPublic: updated.isPublic } : item)),
      );
      toast.success(`"${skill.name}" agora é ${updated.isPublic ? 'pública' : 'privada'}.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remove(skill: SkillSummary) {
    if (!window.confirm(`Remover a skill "${skill.name}" e todos os seus arquivos?`)) return;

    setBusy(skill.slug);
    try {
      await deleteSkill(skill.slug);
      setItems((current) => current.filter((item) => item.uuid !== skill.uuid));
      setTotal((current) => current - 1);
      toast.success(`"${skill.name}" removida.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-purple-50">Skills</h1>
          <p className="mt-1 text-sm text-slate-500">
            {loading ? 'Carregando…' : `${total} skill${total === 1 ? '' : 's'} no catálogo`}
          </p>
        </div>
        <Link
          to="/skills/new"
          className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-br from-purple-500 to-purple-700 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-purple-950/40 transition hover:from-purple-400 hover:to-purple-600"
        >
          <PlusIcon /> Nova skill
        </Link>
      </div>

      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Buscar por nome, descrição ou conteúdo…"
        className={`${inputClass} mt-5 max-w-md`}
      />

      <div className="mt-5 overflow-hidden rounded-2xl border border-purple-400/12">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-ink-850 text-left text-[11px] tracking-wider text-slate-500 uppercase">
              <th className="px-4 py-3 font-semibold">Skill</th>
              <th className="hidden px-4 py-3 font-semibold md:table-cell">Tags</th>
              <th className="px-4 py-3 font-semibold">Estado</th>
              <th className="hidden px-4 py-3 text-right font-semibold sm:table-cell">Acessos</th>
              <th className="hidden px-4 py-3 text-right font-semibold sm:table-cell">Downloads</th>
              <th className="hidden px-4 py-3 lg:table-cell">Atualizada</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-purple-400/8 bg-ink-900/40">
            {items.map((skill) => (
              <tr key={skill.uuid} className="transition hover:bg-ink-850/60">
                <td className="px-4 py-3">
                  <Link to={`/skills/${skill.slug}`} className="block">
                    <span className="block font-medium text-purple-100">{skill.name}</span>
                    <span className="block text-xs text-slate-600">{skill.slug}</span>
                  </Link>
                </td>
                <td className="hidden px-4 py-3 md:table-cell">
                  <div className="flex flex-wrap gap-1">
                    {skill.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="rounded bg-purple-500/12 px-1.5 py-0.5 text-[10px] text-purple-300"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <button
                    type="button"
                    disabled={busy === skill.slug}
                    onClick={() => toggleVisibility(skill)}
                    title="Alternar visibilidade"
                    className="transition hover:opacity-75 disabled:opacity-40"
                  >
                    <Badge isPublic={skill.isPublic} />
                  </button>
                </td>
                <td className="hidden px-4 py-3 text-right tabular-nums text-slate-400 sm:table-cell">
                  {skill.viewCount}
                </td>
                <td className="hidden px-4 py-3 text-right tabular-nums text-slate-400 sm:table-cell">
                  {skill.downloadCount}
                </td>
                <td className="hidden px-4 py-3 text-xs text-slate-600 lg:table-cell">
                  {formatDateTime(skill.updatedAt)}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    disabled={busy === skill.slug}
                    onClick={() => remove(skill)}
                    title="Remover skill"
                    className="rounded-lg p-2 text-slate-600 transition hover:bg-red-950/40 hover:text-red-400 disabled:opacity-40"
                  >
                    <TrashIcon />
                  </button>
                </td>
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-14 text-center text-sm text-slate-600">
                  Nenhuma skill encontrada.
                  <Link to="/skills/new" className="ml-1 text-purple-400 hover:text-purple-300">
                    Criar a primeira?
                  </Link>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
