import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Link2, Plug, Server } from 'lucide-react';
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
 * Configuração da instalação, uma tela por assunto (o submenu
 * "Configurações" da sidebar): o MCP padrão
 * (`docs/09-mcp-padrao-e-skills-flutuantes.md`), a busca semântica, o que o
 * painel recebe do ambiente e o `mcp.json` do MCP público. Só admin chega aqui.
 */

/** As telas de configuração, na ordem do submenu. */
export const SETTINGS_SECTIONS = [
  { path: 'mcp-padrao', label: 'MCP padrão' },
  { path: 'busca-semantica', label: 'Busca semântica' },
  { path: 'ambiente', label: 'Ambiente' },
  { path: 'conectar', label: 'Conectar ao MCP público' },
] as const;

function SettingsHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        <p className="sub">{sub}</p>
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="page">
      <Skel h={32} w={240} className="mb-6" />
      <Skel h={220} />
    </div>
  );
}

/** Uma coluna só, na largura de leitura: cada tela tem um painel. */
function Column({ children }: { children: ReactNode }) {
  return <div className="grid max-w-[760px] content-start gap-4">{children}</div>;
}

function useInstallationSettings() {
  const toast = useToast();
  const [settings, setSettings] = useState<InstallationSettings | null>(null);

  const load = useCallback(async () => {
    try {
      setSettings(await getSettings());
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return [settings, setSettings] as const;
}

function publicMcpUrl(session: Session): string {
  return `${session.mcpPublicUrl || 'https://<MCP_PUBLIC_URL>'}/mcp`;
}

export function DefaultMcpSettingsPage({ session }: { session: Session }) {
  const toast = useToast();
  const [settings, setSettings] = useInstallationSettings();
  const [mcps, setMcps] = useState<VirtualMcpSummary[]>([]);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getMcps()
      .then((list) => setMcps(list.items))
      .catch((err: Error) => toast.error(err.message));
  }, [toast]);

  const savedUuid = settings?.defaultMcp.uuid ?? '';
  useEffect(() => {
    setChosen(savedUuid);
  }, [savedUuid]);

  async function save() {
    setBusy(true);
    try {
      const saved = await setDefaultMcp(chosen || null);
      setSettings(saved);
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

  if (!settings) return <Loading />;

  const current = settings.defaultMcp;
  const dirty = chosen !== savedUuid;
  const url = publicMcpUrl(session);

  return (
    <div className="page">
      <SettingsHead title="MCP padrão" sub="O servidor virtual que responde na raiz do MCP público." />
      <Column>
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
      </Column>
    </div>
  );
}

export function RagSettingsPage() {
  return (
    <div className="page">
      <SettingsHead title="Busca semântica" sub="O provedor de embeddings e o estado do índice." />
      <Column>
        <RagPanel />
      </Column>
    </div>
  );
}

export function EnvironmentSettingsPage({ session }: { session: Session }) {
  return (
    <div className="page">
      <SettingsHead title="Ambiente" sub="O que o painel recebeu do .env na subida." />
      <Column>
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
      </Column>
    </div>
  );
}

export function ConnectSettingsPage({ session }: { session: Session }) {
  const [settings] = useInstallationSettings();

  if (!settings) return <Loading />;

  const current = settings.defaultMcp;
  const snippet = JSON.stringify(
    {
      mcpServers: {
        'purple-skills': {
          type: 'http',
          url: publicMcpUrl(session),
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
      <SettingsHead title="Conectar ao MCP público" sub="O mcp.json que um cliente usa para falar com esta instalação." />
      <Column>
        <Panel title="Conectar ao MCP público" icon={<Plug />} actions={<CopyButton text={snippet} label="Copiar" />}>
          <p className="panel-hint">
            O que o site mostra como <code>mcp.json</code> do MCP público.
            {current.status !== 'ok' && (
              <>
                {' '}Enquanto não houver um <Link to="/configuracoes/mcp-padrao" className="link">padrão</Link> em pé, este endereço responde 404.
              </>
            )}
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
      </Column>
    </div>
  );
}
