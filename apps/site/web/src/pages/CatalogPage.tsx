import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchPublicCatalog, type PublicCatalogDetail } from '../api.js';
import { SkillCard } from '../components/SkillCard.js';
import { ArrowLeftIcon, LayersIcon } from '../components/Icons.js';
import { useMeta } from '../useMeta.js';
import { useReveal } from '../useReveal.js';

/**
 * A página de um catálogo público (`docs/12-acesso-granular.md` §7): nome,
 * descrição e os membros ativos — todos, inclusive skills não marcadas
 * públicas, porque tornar o catálogo público é publicar o que está nele.
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
            <p>
              {error === 'Catálogo não encontrado'
                ? 'Ele pode não existir, ser privado ou estar desligado — só os públicos aparecem aqui.'
                : error}
            </p>
            <Link to="/#catalogos" className="btn btn-primary" style={{ marginTop: '18px' }}>
              <ArrowLeftIcon /> Voltar aos catálogos
            </Link>
          </div>
        </div>
      </section>
    );
  }

  if (!catalog) {
    return (
      <section className="skill-page">
        <div className="wrap" style={{ display: 'grid', gap: '16px' }}>
          <div className="skel" style={{ height: '2.2rem', maxWidth: '24rem' }} />
          <div className="skel" style={{ height: '1.2rem', maxWidth: '40rem' }} />
          <div className="skel" style={{ height: '11rem' }} />
        </div>
      </section>
    );
  }

  const count = catalog.skillCount;

  return (
    <section className="skill-page">
      <div className="wrap">
        <Link to="/#catalogos" className="back-link">
          <ArrowLeftIcon /> Catálogos
        </Link>

        <header className="skill-head">
          <span className="public-pill">
            <LayersIcon /> Catálogo público
          </span>
          <h1 className="display">{catalog.name}</h1>
          {catalog.description && <p className="lead">{catalog.description}</p>}

          <div className="skill-meta">
            <span>{catalog.slug}</span>
            <span>
              {count} {count === 1 ? 'skill ativa' : 'skills ativas'}
            </span>
          </div>
          <p className="skill-head-note">
            Tornar um catálogo público publica todas as skills ativas dele. Cada uma tem a própria
            página, com download.
          </p>
        </header>

        <h2 className="section-label">Skills deste catálogo</h2>

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
