import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { searchSkills, type SearchResult } from '../../api.js';
import { useSkillsSummary } from '../../useSkillsSummary.js';
import { useReveal } from '../../useReveal.js';
import { SkillCard } from '../SkillCard.js';
import { SearchIcon } from '../Icons.js';

const PAGE_SIZE = 12;

const SORTS = [
  { value: 'score', label: 'Mais acessadas' },
  { value: 'recent', label: 'Recentes' },
  { value: 'name', label: 'Nome' },
] as const;

/**
 * As skills públicas: as marcadas como públicas e as que estão em um catálogo
 * público ou em um servidor MCP aberto (a visibilidade `'open'` do banco,
 * `docs/12-acesso-granular.md` §7). Busca, ordem, tags e paginação.
 */
export function PublicSkills() {
  const [params, setParams] = useSearchParams();
  const summary = useSkillsSummary();

  const q = params.get('q') ?? '';
  const tag = params.get('tag') ?? '';
  const sort = params.get('sort') ?? 'score';
  const page = Math.max(1, Number(params.get('page') ?? '1'));

  const [input, setInput] = useState(q);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const firstRender = useRef(true);

  useEffect(() => setInput(q), [q]);

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

  // Busca com atraso, sem empilhar entradas no histórico do navegador.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const timer = setTimeout(() => {
      if (input !== q) update({ q: input || null, page: null });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  useReveal([result]);

  function update(changes: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    setParams(next, { replace: true });
  }

  function goToPage(target: number) {
    update({ page: target > 1 ? String(target) : null });
    document.getElementById('skills')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const totalPages = useMemo(
    () => (result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1),
    [result],
  );

  return (
    <section className="skills-sec" id="skills">
      <div className="wrap">
        <div className="head reveal">
          <h2 className="display">
            Skills <span className="grad-text">públicas</span>
          </h2>
          <p>
            As marcadas como públicas e as que estão em um catálogo público ou em um servidor MCP
            aberto. Leia o SKILL.md, abra os arquivos auxiliares ou baixe o pacote .zip.
          </p>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3 reveal d1">
          <label className="search-bar min-w-0 flex-1" style={{ minWidth: '260px' }}>
            <SearchIcon />
            <span className="sr-only">Buscar skills</span>
            <input
              type="search"
              className="field"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Buscar skills por nome, descrição ou conteúdo do SKILL.md…"
              aria-label="Buscar skills"
            />
          </label>

          <div className="segmented">
            {SORTS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={sort === option.value ? 'active' : ''}
                onClick={() => update({ sort: option.value, page: null })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {summary && summary.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 reveal d2">
            <button
              type="button"
              className={`tag${tag ? '' : ' active'}`}
              onClick={() => update({ tag: null, page: null })}
            >
              todas
            </button>
            {summary.tags.slice(0, 16).map((item) => (
              <button
                key={item.name}
                type="button"
                className={`tag${item.name === tag ? ' active' : ''}`}
                onClick={() => update({ tag: item.name === tag ? null : item.name, page: null })}
              >
                {item.name}
                <span style={{ opacity: 0.6, fontSize: '.66rem' }}>{item.count}</span>
              </button>
            ))}
          </div>
        )}

        <p className="mt-4 text-sm" style={{ color: 'var(--text-faint)' }}>
          {loading
            ? 'Buscando skills…'
            : result
              ? `${result.total} ${result.total === 1 ? 'skill pública' : 'skills públicas'}${
                  q ? ` para “${q}”` : ''
                }${tag ? ` na tag ${tag}` : ''}`
              : ''}
        </p>

        {error && (
          <div
            className="mt-4 rounded-2xl p-4 text-sm"
            style={{
              border: '1px solid color-mix(in srgb, var(--ember) 35%, transparent)',
              background: 'color-mix(in srgb, var(--ember) 10%, transparent)',
              color: 'var(--ember)',
            }}
          >
            {error}
          </div>
        )}

        {loading && !result && (
          <div className="skill-grid">
            {Array.from({ length: 6 }).map((_, index) => (
              <div className="skel" style={{ height: '11rem' }} key={index} />
            ))}
          </div>
        )}

        {result && result.items.length === 0 && !loading && (
          <div className="empty mt-4">
            <img className="wiz" src="/assets/images/icon-purple-left-156x224.png" alt="" />
            <h3>Nenhuma skill pública encontrada.</h3>
            <p>Tente outros termos, ou limpe o filtro de tag.</p>
          </div>
        )}

        {result && result.items.length > 0 && (
          <div className="skill-grid">
            {result.items.map((skill, index) => (
              <SkillCard
                key={skill.uuid}
                skill={skill}
                className={`reveal d${(index % 3) + 1}`}
              />
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div className="pager">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={page <= 1}
              onClick={() => goToPage(page - 1)}
            >
              ← Anterior
            </button>
            <span className="mono">
              {page} / {totalPages}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={page >= totalPages}
              onClick={() => goToPage(page + 1)}
            >
              Próxima →
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
