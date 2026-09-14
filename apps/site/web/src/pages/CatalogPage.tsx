import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchPublicCatalog, type PublicCatalogDetail } from '../api.js';
import { SkillCard } from '../components/SkillCard.js';
import { ArrowLeftIcon } from '../components/Icons.js';
import { useMeta } from '../useMeta.js';
import { useReveal } from '../useReveal.js';

/**
 * A página de um catálogo público (`docs/12-acesso-granular.md` §7): nome,
 * descrição e os membros ativos — todos, inclusive skills não marcadas
 * públicas, porque marcar o catálogo como público é publicar o que está nele.
 */
export function CatalogPage() {
  const { slug = '' } = useParams();
  const meta = useMeta();
  const [catalog, setCatalog] = useState<PublicCatalogDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setCatalog(null);
    setError(null);
    window.scrollTo({ top: 0 });

    fetchPublicCatalog(slug)
      .then((data) => active && setCatalog(data))
      .catch((err: Error) => active && setError(err.message));

    return () => {
      active = false;
    };
  }, [slug]);

  useEffect(() => {
    const name = meta?.name ?? 'Purple Skills';
    document.title = catalog ? `${catalog.name} — ${name}` : name;
  }, [catalog, meta]);

  useReveal([catalog]);

  if (error) {
    return (
      <section className="skill-page">
        <div className="wrap">
          <div className="empty" style={{ maxWidth: '30rem', margin: '40px auto' }}>
            <img className="wiz" src="/assets/images/icon-purple-right-279x400.png" alt="" />
            <h3>Catálogo não encontrado</h3>
            <p>{error}</p>
            <Link to="/#catalogos" className="btn btn-primary" style={{ marginTop: '22px' }}>
              <ArrowLeftIcon /> Voltar
            </Link>
          </div>
        </div>
      </section>
    );
  }

  if (!catalog) {
    return (
      <section className="skill-page">
        <div className="wrap">
          <p className="text-xs" style={{ color: 'var(--text-faint)' }}>
            Carregando…
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="skill-page">
      <div className="wrap">
        <Link to="/#catalogos" className="btn btn-ghost btn-sm" style={{ marginBottom: '18px' }}>
          <ArrowLeftIcon /> Catálogos
        </Link>

        <div className="head reveal" style={{ marginBottom: '22px' }}>
          <p className="eyebrow mono">{catalog.slug}</p>
          <h1 className="display">{catalog.name}</h1>
          <p>{catalog.description || `As skills do catálogo "${catalog.slug}".`}</p>
          <p className="text-xs" style={{ color: 'var(--text-faint)' }}>
            {catalog.skillCount} skill{catalog.skillCount === 1 ? '' : 's'} ativa
            {catalog.skillCount === 1 ? '' : 's'}. Cada uma tem a própria página, com download.
          </p>
        </div>

        {catalog.skills.length === 0 ? (
          <div className="empty">
            <h3>Nenhuma skill ativa neste catálogo.</h3>
            <p>Quem o mantém ainda não colocou nada aqui — ou desligou o que havia.</p>
          </div>
        ) : (
          <div className="skill-grid">
            {catalog.skills.map((skill, index) => (
              <SkillCard skill={skill} className={`reveal d${(index % 3) + 1}`} key={skill.uuid} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
