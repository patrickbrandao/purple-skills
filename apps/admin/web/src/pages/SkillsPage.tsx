import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  deleteSkill,
  formatDateTime,
  listSkills,
  setVisibility,
  type SkillSummary,
} from '../api.js';
import { PlusIcon, SearchIcon, TrashIcon } from '../components/Icons.js';
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
        const data = await listSkills({
          q: search,
          limit: 100,
          sort: search ? undefined : 'recent',
        });
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
        current.map((item) =>
          item.uuid === skill.uuid ? { ...item, isPublic: updated.isPublic } : item,
        ),
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
      <div className="page-head">
        <div>
          <h1 className="display">Skills</h1>
          <p className="sub">
            {loading ? 'Carregando…' : `${total} skill${total === 1 ? '' : 's'} no catálogo`}
          </p>
        </div>
        <Link to="/skills/new" className="btn btn-primary">
          <PlusIcon /> Nova skill
        </Link>
      </div>

      <label className="search-bar mb-5 block max-w-md">
        <SearchIcon />
        <span className="sr-only">Buscar skills</span>
        <input
          type="search"
          className="field"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar por nome, descrição ou conteúdo…"
        />
      </label>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Skill</th>
              <th className="hidden md:table-cell">Tags</th>
              <th>Estado</th>
              <th className="num hidden sm:table-cell">Acessos</th>
              <th className="num hidden sm:table-cell">Downloads</th>
              <th className="hidden lg:table-cell">Atualizada</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((skill) => (
              <tr key={skill.uuid}>
                <td>
                  <Link to={`/skills/${skill.slug}`} className="block">
                    <span className="row-title">{skill.name}</span>
                    <span className="row-sub">{skill.slug}</span>
                  </Link>
                </td>
                <td className="hidden md:table-cell">
                  <div className="flex flex-wrap gap-1.5">
                    {skill.tags.slice(0, 3).map((tag) => (
                      <span className="tag" key={tag}>
                        {tag}
                      </span>
                    ))}
                  </div>
                </td>
                <td>
                  <button
                    type="button"
                    disabled={busy === skill.slug}
                    onClick={() => toggleVisibility(skill)}
                    title="Alternar visibilidade"
                    className={`badge ${skill.isPublic ? 'public' : 'private'}`}
                  >
                    <span className="dot" />
                    {skill.isPublic ? 'pública' : 'privada'}
                  </button>
                </td>
                <td className="num hidden sm:table-cell">{skill.viewCount}</td>
                <td className="num hidden sm:table-cell">{skill.downloadCount}</td>
                <td className="hidden lg:table-cell">
                  <span className="row-sub">{formatDateTime(skill.updatedAt)}</span>
                </td>
                <td className="num">
                  <button
                    type="button"
                    className="row-action"
                    disabled={busy === skill.slug}
                    onClick={() => remove(skill)}
                    title="Remover skill"
                  >
                    <TrashIcon />
                  </button>
                </td>
              </tr>
            ))}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <p className="list-empty">
                    Nenhuma skill encontrada.{' '}
                    <Link to="/skills/new" style={{ color: 'var(--brand)' }}>
                      Criar a primeira?
                    </Link>
                  </p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
