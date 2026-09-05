import { DatabaseIcon, ListIcon, SearchIcon, ShieldIcon } from '../Icons.js';

const CARDS = [
  {
    Icon: ListIcon,
    title: 'Skills, não prompts soltos',
    text: 'Empacote a capacidade inteira — instruções, referências e scripts — em um artefato que o agente lê sozinho. Resolva uma vez, invoque sempre.',
  },
  {
    Icon: SearchIcon,
    title: 'Busca que entende a tarefa',
    text: 'Full-text nativo do Postgres sobre nome, descrição e o corpo do SKILL.md. O agente procura pelo problema que tem, não pela palavra exata.',
  },
  {
    Icon: ShieldIcon,
    title: 'Painel e MCP administrativo',
    text: 'Crie, edite, importe .zip e alterne visibilidade pelo painel — ou deixe o próprio agente fazer isso pelas doze ferramentas do MCP admin, com auditoria.',
  },
  {
    Icon: DatabaseIcon,
    title: 'Seu servidor, seus dados',
    text: 'Cinco containers, um Postgres e um docker compose. Licença MIT, sem telemetria, sem conta em nuvem nenhuma. Skills privadas ficam privadas.',
  },
];

export function Features() {
  return (
    <section className="solution" id="recursos">
      <div className="wrap">
        <div className="head reveal">
          <h2 className="display">
            O fim do prompt descartável. <span className="grad-text">Diga olá às skills.</span>
          </h2>
          <p>
            Uma skill é a mesma coisa que aquele prompt que você refinou por semanas — só que
            versionada, buscável e visível para todos os seus agentes de uma vez.
          </p>
        </div>

        <div className="sol-grid">
          {CARDS.map(({ Icon, title, text }, index) => (
            <article className={`sol-card reveal d${index + 1}`} key={title}>
              <div className="sol-icon">
                <Icon />
              </div>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
