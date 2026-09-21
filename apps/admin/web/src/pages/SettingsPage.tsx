import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Link2, Plug, Server, ShieldQuestion } from 'lucide-react';
import {
  QUARANTINE_APPROVERS_LABEL,
  getMcps,
  getQuarantineSettings,
  getSettings,
  setDefaultMcp,
  setQuarantineSettings,
  type QuarantineApprovers,
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
 * (`docs/09-mcp-padrao-e-skills-flutuantes.md`) com o `mcp.json` do MCP público,
 * a busca semântica, a quarentena e o que o painel recebe do ambiente. Só admin chega aqui.
 */

/** As telas de configuração, na ordem do submenu. */
export const SETTINGS_SECTIONS = [
  { path: 'default-mcp', label: 'MCP padrão' },
  { path: 'semantic-search', label: 'Busca semântica' },
  { path: 'quarantine', label: 'Quarentena' },
  { path: 'environment', label: 'Ambiente' },
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
              Ainda não há servidor nenhum. <Link to="/mcps?new=1" className="link">Crie o primeiro</Link> e volte aqui para torná-lo o padrão.
            </p>
          )}
        </Panel>

        <Panel title="Conectar ao MCP público" icon={<Plug />} actions={<CopyButton text={snippet} label="Copiar" />}>
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

/**
 * Quem aprova um envio da quarentena (`docs/15-quarentena.md`).
 *
 * Submeter continua exigindo o papel de criar, e o dono continua sendo quem
 * submeteu; o que esta tela decide é só **promover**. Admin aprova nas três
 * opções — a escolha é sobre quem mais.
 */
export function QuarantineSettingsPage() {
  const toast = useToast();
  const [approvers, setApprovers] = useState<QuarantineApprovers | null>(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    let active = true;
    getQuarantineSettings()
      .then((data) => {
        if (active) setApprovers(data.approvers);
      })
      .catch((err) => {
        if (active) toast.error((err as Error).message);
      });
    return () => {
      active = false;
    };
  }, [toast]);

  async function escolher(value: QuarantineApprovers) {
    if (value === approvers) return;
    const anterior = approvers;
    setApprovers(value);
    setSalvando(true);
    try {
      const data = await setQuarantineSettings(value);
      setApprovers(data.approvers);
      toast.success(`Agora quem aprova é: ${QUARANTINE_APPROVERS_LABEL[data.approvers]}.`);
    } catch (err) {
      setApprovers(anterior);
      toast.error((err as Error).message);
    } finally {
      setSalvando(false);
    }
  }

  if (approvers === null) return <Loading />;

  return (
    <div className="page">
      <SettingsHead title="Quarentena" sub="Quem aprova um pacote importado e o transforma em skill." />
      <Column>
        <Panel title="Quem aprova" icon={<ShieldQuestion />}>
          <p className="panel-hint">
            Um envio na quarentena não é publicado, não é indexado e não aparece no site. Aprovar é o ato que cria a
            skill no acervo — com quem aprovou como dono, e ainda sem servidor nem catálogo.
          </p>
          <div className="destinos">
            {(Object.keys(QUARANTINE_APPROVERS_LABEL) as QuarantineApprovers[]).map((option) => (
              <button
                key={option}
                type="button"
                className={`destino${approvers === option ? ' active' : ''}`}
                aria-pressed={approvers === option}
                disabled={salvando}
                onClick={() => void escolher(option)}
              >
                <ShieldQuestion />
                <span className="t">{QUARANTINE_APPROVERS_LABEL[option]}</span>
                <span className="h">{APPROVERS_HINT[option]}</span>
              </button>
            ))}
          </div>
          <p className="panel-hint mb-0">
            Revisar e corrigir os arquivos de um envio continua sendo de quem o enxerga: o dono, os administradores e os
            editores. Esta escolha vale só para aprovar.
          </p>
        </Panel>
      </Column>
    </div>
  );
}

const APPROVERS_HINT: Record<QuarantineApprovers, string> = {
  admin: 'O portão mais fechado: nenhum editor aprova o que trouxe, nem o que outro trouxe.',
  'admin+owner': 'O padrão. Quem já podia criar a skill pelo formulário também aprova o próprio envio.',
  'admin+editor': 'Qualquer editor aprova qualquer envio da fila, inclusive os de outras pessoas.',
};

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
