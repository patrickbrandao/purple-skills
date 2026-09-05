# Purple Skills

As instruções deste repositório estão em [`AGENTS.md`](AGENTS.md) — leia antes de
mexer em qualquer coisa.

O ponto que mais dá errado quando ignorado: **o banco de dados é do agente dba e
mora inteiro em `database/`**. Nenhum outro agente escreve SQL, migration ou
container de banco; o acesso é sempre pelo pacote `@purple-skills/db`, conforme
[`database/README.md`](database/README.md).
