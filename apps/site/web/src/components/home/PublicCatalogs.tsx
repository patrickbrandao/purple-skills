import { Link } from 'react-router-dom';
import { ArrowRightIcon, LayersIcon } from '../Icons.js';
import { usePublicCatalogs } from '../../usePublicCatalogs.js';
import { useReveal } from '../../useReveal.js';

/**
 * Os catálogos públicos desta instalação (`docs/12-acesso-granular.md`
 * decisão 14): grupos de skills que alguém mantém e tornou públicos.
 * Cada um tem uma página com os membros — todos os ativos, porque um
 * catálogo público expõe o que está dentro, como um servidor aberto.
 */
export function PublicCatalogs() {
  const items = usePublicCatalogs();

  // Os cartões nascem depois da busca, quando o observador da página já
  // passou: reobservar ao chegarem, como a grade de skills faz.
  useReveal([items]);

  if (!items || items.length === 0) return null;

  return (
    <section className="endpoints" id="catalogos">
      <div className="wrap">
        <div className="head reveal">
          <h2 className="display">
            Catálogos <span className="grad-text">públicos</span>
          </h2>
          <p>
            Um catálogo agrupa skills afins — de um domínio, de um time, de um projeto. Abra um para
            ver as skills dele: tornar o catálogo público publica todas as que estão ativas.
          </p>
        </div>

        <div className="endpoint-grid">
          {items.map((catalog, index) => (
            <Link
              to={`/catalogos/${catalog.slug}`}
              className={`endpoint-card catalog-card reveal d${(index % 3) + 1}`}
              key={catalog.uuid}
            >
              <div className="ep-top">
                <span className="ep-ico">
                  <LayersIcon />
                </span>
                <span>
                  <h3>{catalog.name}</h3>
                  <span className="ep-auth">
                    {catalog.slug} · {catalog.skillCount}{' '}
                    {catalog.skillCount === 1 ? 'skill' : 'skills'}
                  </span>
                </span>
              </div>

              <p>{catalog.description || 'Catálogo sem descrição.'}</p>

              <span className="catalog-open">
                Ver as skills <ArrowRightIcon />
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
