import { useMeta } from '../../useMeta.js';
import { usePublicCatalogs } from '../../usePublicCatalogs.js';
import { useSkillsSummary } from '../../useSkillsSummary.js';
import { GlobeIcon } from '../Icons.js';

const plural = (n: number, um: string, varios: string) => (n === 1 ? um : varios);

/**
 * Chamada curta da home.
 *
 * Não explica o projeto — quem quer saber o que é o Purple Skills vai para a
 * homepage. Aqui só o nome da instalação, o aviso de que tudo o que aparece
 * foi tornado público, o que há e por onde começar.
 */
export function Masthead() {
  const meta = useMeta();
  const summary = useSkillsSummary();
  const catalogs = usePublicCatalogs();

  return (
    <header className="masthead" id="top">
      <div className="wrap masthead-grid">
        <div className="masthead-copy">
          <span className="public-pill">
            <GlobeIcon /> Visão pública
          </span>
          <h1 className="display">
            {meta?.name ?? 'Purple Skills'}
            <br />
            <span className="grad-text">Sua biblioteca de habilidades</span>
          </h1>
          <p className="sub">
            {meta?.tagline ?? 'Skills abertas para agentes de IA'}. Aqui estão as skills e os
            catálogos que esta instalação tornou públicos: leia o SKILL.md, baixe o pacote ou conecte
            seu agente ao MCP para ele fazer isso sozinho.
          </p>
          <p className="masthead-note">
            Itens privados não aparecem aqui — ficam no painel, para quem tem acesso.
          </p>

          <div className="masthead-cta">
            <a href="#skills" className="btn btn-primary">
              Explorar skills →
            </a>
            {catalogs && catalogs.length > 0 && (
              <a href="#catalogs" className="btn btn-ghost">
                Ver catálogos
              </a>
            )}
            <a href="#get-started" className="btn btn-ghost">
              Conectar um agente
            </a>
          </div>

          <div className="masthead-facts">
            <span>
              <b>{summary?.total ?? '—'}</b>
              {plural(summary?.total ?? 0, 'skill pública', 'skills públicas')}
            </span>
            <span>
              <b>{catalogs?.length ?? '—'}</b>
              {plural(catalogs?.length ?? 0, 'catálogo público', 'catálogos públicos')}
            </span>
            <span>
              <b>{summary?.tags.length ?? '—'}</b>
              {plural(summary?.tags.length ?? 0, 'tag', 'tags')}
            </span>
          </div>
        </div>

        <img
          className="masthead-fig wiz"
          src="/assets/images/wizard-10_512.png"
          alt="O Mago Roxo, mascote do Purple Skills"
          width={340}
          height={340}
        />
      </div>
    </header>
  );
}
