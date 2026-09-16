import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Link2, Server } from 'lucide-react';
import {
  getMcps,
  getSettings,
  setDefaultMcp,
  type InstallationSettings,
  type Session,
  type VirtualMcpSummary,
} from '../api.js';
import { Button, CopyButton, Field, Panel, Skel } from '../components/ui.js';
import { RagPanel } from '../components/RagPanel.js';
import { useToast } from '../components/Toast.js';

/**
 * Configuração da instalação: qual servidor responde em `/mcp`
 * (`docs/09-mcp-padrao-e-skills-flutuantes.md`) e o que o painel recebe do
 * ambiente. Só admin chega aqui.
 */
export function SettingsPage({ session }: { session: Session }) {
  const toast = useToast();
  const [settings, setSettings] = useState<InstallationSettings | null>(null);
  const [mcps, setMcps] = useState<VirtualMcpSummary[]>([]);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [current, list] = await Promise.all([getSettings(), getMcps()]);
      setSettings(current);
      setMcps(list.items);
      setChosen(current.defaultMcp.uuid ?? '');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    try {
      const saved = await setDefaultMcp(chosen || null);
      setSettings(saved);
      setChosen(saved.defaultMcp.uuid ?? '');
      toast.success(
        saved.defaultMcp.slug
          ? `"/mcp" agora responde pelo servidor "${saved.defaultMcp.slug}".`
          : 'Nenhum MCP padrão: "/mcp" responde 404.',
      );
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const base = session.mcpPublicUrl || 'https://<MCP_PUBLIC_URL>';

  if (!settings) {
    return (
      <div className="page">
        <Skel h={32} w={240} className="mb-6" />
        <Skel h={220} />
      </div>
    );
  }

  const current = settings.defaultMcp;
  const dirty = chosen !== (current.uuid ?? '');
  const url = `${base}/mcp`;
  const snippet = JSON.stringify(
    {
      mcpServers: {
        'purple-skills': {
          type: 'http',
          url,
          ...(current.status === 'ok' && !current.isOpen
            ? { headers: { Authorization: 'Bearer <cole aqui uma chave psv_ do MCP padrão>' } }
            : {}),
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Instalação</h1>
          <p className="sub">O que vale para a instalação inteira.</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <div className="grid content-start gap-4">
          <Panel title="MCP padrão" icon={<Server />}>
            <p className="panel-hint">
              O MCP público (<code>{url}</code>) é um servidor virtual escolhido aqui. Ele continua respondendo
              também em <code>/virtual/&lt;slug&gt;/mcp</code>, com as próprias skills, chaves e regra de acesso —
              não há nada de especial nele além de responder na raiz.
            </p>

            <Field label="Servidor que responde em /mcp">
              <select className="field" value={chosen} disabled={busy} onChange={(event) => setChosen(event.target.value)}>
                <option value="">— nenhum: /mcp responde 404 —</option>
                {mcps.map((mcp) => (
                  <option key={mcp.uuid} value={mcp.uuid}>
                    {mcp.name} (/virtual/{mcp.slug}) · {mcp.isActive ? 'ligado' : 'desligado'} ·{' '}
                    {mcp.isOpen ? 'aberto' : 'exige chave'} · {mcp.skillCount} skill{mcp.skillCount === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </Field>

            <div className="mt-3">
              {current.status === 'deleted' && (
                <p className="notice danger">O servidor escolhido foi removido: /mcp responde 404 até você escolher outro.</p>
              )}
              {current.status === 'inactive' && (
                <p className="notice danger">
                  O MCP padrão <code>{current.slug}</code> está desligado: /mcp responde 404 até religá-lo ou escolher outro.
                </p>
              )}
              {current.status === 'none' && (
                <p className="notice warn">Nenhum MCP padrão: /mcp responde 404. Os servidores continuam respondendo nos próprios endereços.</p>
              )}
              {current.status === 'ok' && (
                <p className="notice info">
                  Hoje: <Link to={`/mcps/${current.slug}`} className="link">{current.name}</Link>,{' '}
                  {current.isOpen ? 'aberto — qualquer cliente conecta sem chave' : 'exige uma chave psv_ dele'}.
                </p>
              )}
            </div>

            <div className="mt-4 flex items-center gap-3">
              <Button disabled={busy || !dirty} onClick={() => void save()}>
                Salvar
              </Button>
              {dirty && <span className="row-sub">Alteração ainda não salva.</span>}
            </div>

            {mcps.length === 0 && (
              <p className="panel-hint mt-3">
                Ainda não há servidor nenhum. <Link to="/mcps?novo=1" className="link">Crie o primeiro</Link> e volte aqui para torná-lo o padrão.
              </p>
            )}
          </Panel>

          <RagPanel />

          <Panel title="O que veio do ambiente" icon={<Link2 />}>
            <p className="panel-hint">Lido do <code>.env</code> na subida do painel; aqui é só leitura.</p>
            <dl className="kv">
              <dt>MCP_PUBLIC_URL</dt>
              <dd className="mono">{session.mcpPublicUrl || <span style={{ color: 'var(--warn)' }}>não configurada</span>}</dd>
              <dt>SITE_BASE_URL</dt>
              <dd className="mono">{session.siteBaseUrl}</dd>
              <dt>Janela de online</dt>
              <dd>
                {Math.round(session.onlineWindowMs / 1000)} s sem requisição e o cliente deixa de contar como online
                (<span className="mono">MCP_SESSION_ONLINE_WINDOW_MS</span>)
              </dd>
              <dt>Links da sidebar</dt>
              <dd className="mono">
                {[session.links.docs && 'docs', session.links.support && 'suporte', session.links.chat && 'chat'].filter(Boolean).join(', ') || 'nenhum'}{' '}
                <span style={{ color: 'var(--text-faint)' }}>(ADMIN_DOCS_URL, ADMIN_SUPPORT_URL, ADMIN_CHAT_URL)</span>
              </dd>
              <dt>Busca semântica</dt>
              <dd className="mono">
                {session.rag?.driver || 'não configurada'}
                {session.rag?.model ? ` / ${session.rag.model}` : ''}{' '}
                <span style={{ color: 'var(--text-faint)' }}>(RAG_DRIVER, RAG_MODEL)</span>
              </dd>
              <dt>Versão</dt>
              <dd className="mono">{session.version || '—'}</dd>
            </dl>
          </Panel>
        </div>

        <Panel title="Conectar ao MCP público" icon={<Server />} actions={<CopyButton text={snippet} label="Copiar" />}>
          <p className="panel-hint">
            O que o site mostra como <code>mcp.json</code> do MCP público.
            {current.status !== 'ok' && ' Enquanto não houver um padrão em pé, este endereço responde 404.'}
            {!session.mcpPublicUrl && (
              <>
                {' '}
                Defina <code>MCP_PUBLIC_URL</code> no <code>.env</code> para o endereço sair completo.
              </>
            )}
          </p>
          <div className="snippet">
            <pre>{snippet}</pre>
          </div>
        </Panel>
      </div>
    </div>
  );
}
