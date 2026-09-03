export function Trinity() {
  return (
    <section className="trinity" id="pecas">
      <div className="head center reveal wrap">
        <h2 className="display">
          Três peças. <span className="grad-text">Nenhuma proprietária.</span>
        </h2>
        <p>
          O Purple Skills é a costura de um formato de arquivo, um protocolo e um banco. Todos os
          três são abertos — se um dia você quiser sair, leva o catálogo inteiro num .zip.
        </p>
      </div>

      <div className="wrap">
        <div className="tri-grid">
          <article className="tri-card skill reveal d1">
            <span className="kicker">O MAGO ROXO · SKILL</span>
            <h3>A Skill</h3>
            <p>
              Um <b>SKILL.md</b> com frontmatter YAML, mais os arquivos que ele referencia. Legível
              por gente e por agente, versionado, e sempre baixável inteiro.
            </p>
            <span className="chip">formato aberto · agentskills.io</span>
            <img
              className="tri-fig wiz"
              src="/assets/images/icon-purple-right-137x158.png"
              alt="O Mago Roxo — a Skill"
            />
          </article>

          <article className="tri-card mcp reveal d2">
            <span className="kicker">TRANSPORTE · MCP</span>
            <h3>O servidor MCP</h3>
            <p>
              Dois servidores sobre o SDK oficial: um público, só de leitura, e um administrativo
              com CRUD completo. Os três transportes — HTTP com sessão, stateless e SSE legado.
            </p>
            <span className="chip">público + administrativo</span>
          </article>

          <article className="tri-card catalog reveal d3">
            <span className="kicker">PERSISTÊNCIA · POSTGRES</span>
            <h3>O catálogo</h3>
            <p>
              PostgreSQL 18 com <b>tsvector</b> e índice GIN para a busca full-text. O{' '}
              <b>pgvector</b> já vem instalado, esperando a busca semântica de uma versão futura.
            </p>
            <span className="chip">ranking por acessos + downloads</span>
          </article>
        </div>
      </div>
    </section>
  );
}
