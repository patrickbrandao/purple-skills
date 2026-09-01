import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchTags, searchSkills, type SearchResult } from '../api.js';
import { SkillCard } from '../components/SkillCard.js';
import { SearchIcon } from '../components/Icons.js';
import { useMeta } from '../useMeta.js';

const PAGE_SIZE = 24;

const SORTS = [
  { value: 'score', label: 'Mais acessadas' },
  { value: 'recent', label: 'Recentes' },
  { value: 'name', label: 'Nome' },
] as const;

export function HomePage() {
  const meta = useMeta();
  const [params, setParams] = useSearchParams();

  const q = params.get('q') ?? '';
  const tag = params.get('tag') ?? '';
  const sort = params.get('sort') ?? 'score';
  const page = Math.max(1, Number(params.get('page') ?? '1'));

  const [input, setInput] = useState(q);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [tags, setTags] = useState<{ name: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    setInput(q);
  }, [q]);

  useEffect(() => {
    fetchTags()
      .then((data) => setTags(data.items))
      .catch(() => void 0);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    searchSkills({ q, tag, sort, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
      .then((data) => active && setResult(data))
      .catch((err: Error) => active && setError(err.message))
      .finally(() => active && setLoading(false));

    return () => {
      active = false;
    };
  }, [q, tag, sort, page]);

  // Busca com debounce, sem empilhar entradas no histórico do navegador.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const timer = setTimeout(() => {
      if (input === q) return;
      update({ q: input || null, page: null });
    }, 300);
    return () => clearTimeout(timer);
  }, [input]);

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  }

  const totalPages = useMemo(
    () => (result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1),
    [result],
  );

  return (
    <>
      <section className="pt-14 pb-10 text-center sm:pt-20">
        <h1 className="mx-auto max-w-3xl bg-gradient-to-br from-purple-50 via-purple-200 to-purple-400 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
          {meta?.tagline ?? 'Catálogo aberto de skills para agentes de IA'}
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-slate-400">
          Busque, leia e baixe skills prontas — ou conecte seu agente ao servidor MCP e deixe
          que ele encontre a skill certa sozinho.
        </p>

        <div className="relative mx-auto mt-8 max-w-xl">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-4 h-[18px] w-[18px] -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Buscar skills por nome, descrição ou conteúdo…"
            aria-label="Buscar skills"
            className="w-full rounded-xl border border-purple-400/15 bg-ink-850 py-3.5 pr-4 pl-11 text-[15px] text-purple-50 placeholder-slate-500 shadow-lg shadow-purple-950/30 outline-none transition focus:border-purple-500/60 focus:ring-2 focus:ring-purple-500/20"
          />
        </div>

        {tags.length > 0 && (
          <div className="mx-auto mt-6 flex max-w-4xl flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => update({ tag: null, page: null })}
              className={chip(!tag)}
            >
              todas
            </button>
            {tags.slice(0, 14).map((item) => (
              <button
                key={item.name}
                type="button"
                onClick={() => update({ tag: item.name === tag ? null : item.name, page: null })}
                className={chip(item.name === tag)}
              >
                {item.name}
                <span className="ml-1.5 text-[10px] opacity-60">{item.count}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between gap-4">
          <p className="text-sm text-slate-500">
            {loading
              ? 'Carregando…'
              : result
                ? `${result.total} skill${result.total === 1 ? '' : 's'}${q ? ` para “${q}”` : ''}`
                : ''}
          </p>

          <div className="flex items-center gap-1 rounded-lg border border-purple-400/12 bg-ink-850 p-0.5">
            {SORTS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => update({ sort: option.value, page: null })}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                  sort === option.value
                    ? 'bg-purple-600 text-white'
                    : 'text-slate-400 hover:text-purple-200'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-950/30 p-4 text-sm text-red-300">
            {error}
          </div>
        )}

        {loading && !result && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={index}
                className="h-44 animate-pulse rounded-2xl border border-purple-400/8 bg-ink-850/60"
              />
            ))}
          </div>
        )}

        {result && result.items.length === 0 && !loading && (
          <div className="rounded-2xl border border-purple-400/12 bg-ink-850/60 py-16 text-center">
            <p className="text-base text-purple-100">Nenhuma skill encontrada.</p>
            <p className="mt-1.5 text-sm text-slate-500">
              Tente outros termos ou remova o filtro de tag.
            </p>
          </div>
        )}

        {result && result.items.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {result.items.map((skill) => (
              <SkillCard key={skill.uuid} skill={skill} />
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div className="mt-10 flex items-center justify-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => update({ page: String(page - 1) })}
              className={pageButton(page <= 1)}
            >
              Anterior
            </button>
            <span className="px-3 text-sm text-slate-500">
              {page} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => update({ page: String(page + 1) })}
              className={pageButton(page >= totalPages)}
            >
              Próxima
            </button>
          </div>
        )}
      </section>
    </>
  );
}

const chip = (active: boolean) =>
  `rounded-full border px-3 py-1 text-xs font-medium transition ${
    active
      ? 'border-purple-500 bg-purple-600 text-white'
      : 'border-purple-400/15 bg-ink-850 text-slate-400 hover:border-purple-400/40 hover:text-purple-200'
  }`;

const pageButton = (disabled: boolean) =>
  `rounded-lg border border-purple-400/15 bg-ink-850 px-4 py-2 text-sm transition ${
    disabled
      ? 'cursor-not-allowed opacity-40'
      : 'text-purple-100 hover:border-purple-400/40 hover:bg-ink-800'
  }`;
