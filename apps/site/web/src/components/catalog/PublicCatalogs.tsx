import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchPublicCatalogs, type PublicCatalog } from '../../api.js';
import { ArrowRightIcon, LayersIcon } from '../Icons.js';
import { useReveal } from '../../useReveal.js';

/**
 * Os catálogos públicos desta instalação (`docs/12-acesso-granular.md`
 * decisão 14): grupos de skills que alguém mantém e marcou como públicos.
 * Cada um tem uma página com os membros — todos os ativos, porque um
 * catálogo público expõe o que está dentro, como um servidor aberto.
 */
export function PublicCatalogs() {
  const [items, setItems] = useState<PublicCatalog[] | null>(null);

  useEffect(() => {
    let active = true;
    fetchPublicCatalogs()
      .then((data) => active && setItems(data.items))
      .catch(() => active && setItems([]));
    return () => {
      active = false;
    };
  }, []);

  // Os cartões nascem depois da busca, quando o observador da página já
  // passou: reobservar ao chegarem, como a grade do catálogo faz.
  useReveal([items]);

  if (!items || items.length === 0) return null;

  return (
    <section className="endpoints" id="catalogos">
      <div className="wrap">
        <div className="head center reveal">
          <h2 className="display">
            Catálogos <span className="grad-text">públicos.</span>
          </h2>
          <p>
            Grupos de skills mantidos por alguém da casa. Um catálogo reúne o que faz sentido junto —
            um domínio, um time, um projeto.
          </p>
        </div>

        <div className="endpoint-grid">
          {items.map((catalog, index) => (
            <article className={`endpoint-card reveal d${(index % 3) + 1}`} key={catalog.uuid}>
              <div className="ep-top">
                <span className="ep-ico">
                  <LayersIcon />
                </span>
                <span>
                  <h3>{catalog.name}</h3>
                  <span className="ep-auth">
                    {catalog.skillCount} skill{catalog.skillCount === 1 ? '' : 's'} ativa
                    {catalog.skillCount === 1 ? '' : 's'}
                  </span>
                </span>
              </div>

              <p>{catalog.description || `As skills do catálogo "${catalog.slug}".`}</p>

              <div className="ep-foot">
                <Link to={`/catalogos/${catalog.slug}`} className="btn btn-ghost btn-sm">
                  Ver skills <ArrowRightIcon />
                </Link>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
