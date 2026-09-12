import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  canCreateVirtualMcp,
  canManageUsers,
  createMcp,
  formatDateTime,
  getMcps,
  type SessionUser,
  type VirtualMcpSummary,
} from '../api.js';
import { Button, Field, Panel } from '../components/ui.js';
import { PlusIcon, ServerIcon } from '../components/Icons.js';
import { useToast } from '../components/Toast.js';
import { useNavigate } from 'react-router-dom';

/**
 * MCPs virtuais: recortes do catálogo com endereço, chaves e dono próprios
 * (`docs/08-mcp-virtual.md`). Admin vê todos; os demais, só os seus. Um deles
 * pode ser o **padrão** — o que responde em `/mcp` — escolhido em
 * Configurações (`docs/09-mcp-padrao-e-skills-flutuantes.md`).
 */
export function McpsPage({ user }: { user: SessionUser }) {
  const toast = useToast();
  const navigate = useNavigate();
  const podeCriar = canCreateVirtualMcp(user.role);
  const [items, setItems] = useState<VirtualMcpSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await getMcps()).items);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const created = await createMcp({
        name,
        slug: slug.trim() || undefined,
        description: description.trim() || undefined,
      });
      toast.success(`MCP virtual "${created.name}" criado. Agora escolha as skills.`);
      navigate(`/mcps/${created.slug}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="display">MCPs virtuais</h1>
          <p className="sub">
            {loading
              ? 'Carregando…'
              : user.role === 'admin'
                ? `${items.length} servidor${items.length === 1 ? '' : 'es'} — você vê todos, como administrador`
                : `${items.length} servidor${items.length === 1 ? '' : 'es'} seu${items.length === 1 ? '' : 's'}`}
          </p>
        </div>
      </div>

      <div className={`grid gap-5 ${podeCriar ? 'lg:grid-cols-[1fr_340px]' : ''}`}>
        <Panel title="Servidores" icon={<ServerIcon />}>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Servidor</th>
                  <th>Estado</th>
                  <th className="num hidden sm:table-cell">Skills</th>
                  <th className="num hidden sm:table-cell">Chaves</th>
                  <th className="hidden md:table-cell">Dono</th>
                  <th className="hidden lg:table-cell">Atualizado</th>
                </tr>
              </thead>
              <tbody>
                {items.map((mcp) => (
                  <tr key={mcp.uuid} className={mcp.isActive ? undefined : 'is-off'}>
                    <td>
                      <Link to={`/mcps/${mcp.slug}`} className="block">
                        <span className="row-title">{mcp.name}</span>
                        <span className="row-sub break-all">/virtual/{mcp.slug}/mcp</span>
                      </Link>
                    </td>
                    <td>
                      <div className="flex flex-wrap items-center gap-1.5 whitespace-nowrap">
                        <span className={`badge ${mcp.isActive ? 'public' : 'private'}`}>
                          <span className="dot" />
                          {mcp.isActive ? 'ligado' : 'desligado'}
                        </span>
                        {mcp.isDefault && (
                          <span className="badge surface" title="Responde também em /mcp, o MCP público desta instalação">
                            padrão
                          </span>
                        )}
                        {mcp.isOpen && (
                          <span
                            className={`badge surface ${mcp.privateSkillCount > 0 ? 'off' : ''}`}
                            title={
                              mcp.privateSkillCount > 0
                                ? `Aberto com ${mcp.privateSkillCount} skill(s) privada(s) legível(is) sem chave`
                                : 'Sem chave: qualquer cliente conecta'
                            }
                          >
                            aberto
                          </span>
                        )}
                      </div>
                    </td>
                    <td
                      className="num hidden whitespace-nowrap sm:table-cell"
                      title={
                        mcp.privateSkillCount > 0
                          ? `${mcp.privateSkillCount} delas privada(s)`
                          : undefined
                      }
                    >
                      {mcp.skillCount}
                      {mcp.privateSkillCount > 0 && (
                        // `.row-sub` é `display: block` (é a segunda linha de
                        // uma célula); aqui ela é o resto da mesma linha.
                        <span className="row-sub !mt-0 inline"> · {mcp.privateSkillCount} priv.</span>
                      )}
                    </td>
                    <td className="num hidden sm:table-cell">{mcp.activeKeyCount}</td>
                    <td className="hidden md:table-cell">
                      <span className="row-sub">{mcp.ownerEmail ?? 'sem dono (só admin)'}</span>
                    </td>
                    <td className="hidden lg:table-cell">
                      <span className="row-sub whitespace-nowrap">{formatDateTime(mcp.updatedAt)}</span>
                    </td>
                  </tr>
                ))}
                {!loading && items.length === 0 && (
                  <tr>
                    <td colSpan={6}>
                      <p className="list-empty">
                        {podeCriar
                          ? 'Nenhum MCP virtual ainda. Crie o primeiro ao lado.'
                          : 'Nenhum MCP virtual é seu. Um administrador pode transferir um para você.'}
                      </p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        {podeCriar && (
          <Panel title="Novo MCP virtual" icon={<PlusIcon />}>
            <form onSubmit={submit} className="grid gap-4">
              <Field label="Nome">
                <input
                  className="field"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Ex.: Time de dados"
                />
              </Field>
              <Field label="Slug" hint="Vira o endereço: /virtual/<slug>/mcp. Gerado do nome se ficar vazio.">
                <input
                  className="field mono"
                  value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                  placeholder="time-de-dados"
                />
              </Field>
              <Field label="Descrição" hint="Vai para as instruções do servidor: é como o agente sabe do que este MCP trata.">
                <textarea
                  className="field"
                  rows={3}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Skills do projeto X, para quem trabalha no repositório Y."
                />
              </Field>
              <Button type="submit" disabled={busy || !name.trim()}>
                Criar
              </Button>
              <p className="panel-hint">
                O servidor nasce ligado, sem skills e exigindo chave. Você é o dono: só você e os
                administradores mexem nele.
              </p>
            </form>
          </Panel>
        )}
      </div>

      {canManageUsers(user.role) && (
        <p className="panel-hint mt-5">
          Qual destes responde em <code>/mcp</code>, o MCP público da instalação, é escolhido em{' '}
          <Link to="/configuracoes">Configurações</Link>.
        </p>
      )}
    </>
  );
}
