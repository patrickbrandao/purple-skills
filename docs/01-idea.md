
Quero criar um software open-source, que rode em docker (container), ele será uma versão simples, bonita e pontual.

Esse software possuirá duas interfaces web:
* principal: site onde as skills marcadas como publicas poderão ser visualizadas e baixadas pelos visitantes;
* administracao: pagina onde o administrador com sua senha poderá administrar as skills e suas propriedades;

O software possuirá um servidor MCP que permitirá que os agentes localizem skills exatamente igual o site context7.

O software deverá exportar imagens docker separadas:
1: Site, Tailwind CSS, NodeJS com Express;
2: Administracao, Tailwind CSS, NodeJS com Express;
3: Servidor MCP publico, com SDK MCP typescript, suporte a todas as versoes do protocolo MCP (SSE, Streamable HTTP, stateless), usado para encontrar e baixar skills;
4: Servidor MCP administrativo, com SDK MCP typescript, suporte a todas as versoes do protocolo MCP (SSE, Streamable HTTP, stateless), usado para administrar as skills (adicionar, remover, alterar de publico para privado, editar nome e descricao, definir novo conteudo).


Usar imagens externas para:
1: Banco de dados SQL - Postgres 18 com pgvector, usar imagem pgvector/pgvector:pg18-trixie;

Acesso administrativo:
- Painel web: Requer senha definida em variavel de ambiente ou lida de um arquivo (caminho do arquivo tambem definido em variavel de ambiente);
- MCP administrativo: usado pelo administrador atravez de uma chave de autorizacao Bearer definida em variavel de ambiente ou lida de um arquivo (caminho do arquivo tambem definido em variavel de ambiente);

Experiencia do visitante vindo da Internet:
- Acessar site principal contendo a lista de skills ordenadas pela melhor avaliação;
- Abrir skill e visualizar seu conteudo, SKILL.md apresentado com visualizador de markdown renderizado no frontend;
- Baixar skill, seja em formato de pacote ou arquivos avulsos (SKILL.md ou demais arquivos anexados no diretorio principal da skill ou em sub-diretorios);
- Copiar link da skill;

Busca vetorial: deixar para implementacoes futuras, usar apenas recursos de busca de strings mais adequada do PostgreSQL 18.

Contadores: Toda skill deve possuir contador de acessos feitos pela web e pela URL de download. Acesso direto a arquivos adicionais da skill não devem contar acessos (somente SKILL.md conta acesso, ou o download do pacote fechado).


