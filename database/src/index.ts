export * from './client.js';
export * from './schema.js';
export * from './queries.js';
export * from './errors.js';
// `schemaDir` sai junto com o runner: o README a anuncia como parte da API, e
// quem aplica os `.sql` à mão (um teste de migration, um script de manutenção)
// não deve adivinhar o caminho do diretório.
export { runMigrations, schemaDir, type RunMigrationsOptions } from './migrate.js';
