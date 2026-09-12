import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getMcps,
  getSettings,
  setDefaultMcp,
  type InstallationSettings,
  type Session,
  type VirtualMcpSummary,
} from '../api.js';
import { Button, Field, Panel } from '../components/ui.js';
import { CopyIcon, ServerIcon } from '../components/Icons.js';
import { useToast } from '../components/Toast.js';

/**
 * Configuração da instalação — por ora, só o MCP padrão
 * (`docs/09-mcp-padrao-e-skills-flutuantes.md`): qual MCP virtual responde em
 * `/mcp`. Só admin chega aqui. O padrão não ganha nenhum tratamento especial:
 * pode ser fechado, desligado ou apagado como qualquer outro, e a raiz passa
 * a responder 404 dizendo a causa.
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
          ? `"/mcp" agora responde pelo MCP virtual "${saved.defaultMcp.slug}".`
          : 'Nenhum MCP padrão: "/mcp" responde 404.',
      );
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return <div className="skel-block" style={{ height: '12rem' }} />;

  const base = session.mcpPublicUrl || 'https://<MCP_PUBLIC_URL>';
  const current = settings.defaultMcp;
  const dirty = chosen !== (current.uuid ?? '');

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="display">Configurações</h1>
          <p className="sub">O que vale para a instalação inteira.</p>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <Panel title="MCP padrão" icon={<ServerIcon />}>
          <p className="panel-hint">
            O MCP público (<code>{base}/mcp</code>) é um MCP virtual escolhido aqui. Ele continua
            respondendo também em <code>/virtual/&lt;slug&gt;/mcp</code>, com as próprias skills,
            chaves e regra de acesso — não há nada de especial nele além de responder na raiz.
          </p>

          <Field label="MCP virtual que responde em /mcp">
            <select
              className="field"
              value={chosen}
              disabled={busy}
              onChange={(event) => setChosen(event.target.value)}
            >
              <option value="">— nenhum: /mcp responde 404 —</option>
              {mcps.map((mcp) => (
                <option key={mcp.uuid} value={mcp.uuid}>
                  {mcp.name} (/virtual/{mcp.slug}) · {mcp.isActive ? 'ligado' : 'desligado'} ·{' '}
                  {mcp.isOpen ? 'aberto' : 'exige chave'} · {mcp.skillCount} skill
                  {mcp.skillCount === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </Field>

          {/* O padrão apagado ainda aparece como escolha inválida: o select
              não tem a opção, então o operador vê o aviso e escolhe outro. */}
          {current.status === 'deleted' && (
            <p className="panel-hint" style={{ color: 'var(--danger)' }}>
              O MCP virtual escolhido foi removido: <code>/mcp</code> responde 404 até você escolher
              outro.
            </p>
          )}
          {current.status === 'inactive' && (
            <p className="panel-hint" style={{ color: 'var(--danger)' }}>
              O MCP padrão <code>{current.slug}</code> está desligado: <code>/mcp</code> responde 404
              até religá-lo ou escolher outro.
            </p>
          )}
          {current.status === 'none' && (
            <p className="panel-hint">
              Nenhum MCP padrão: <code>/mcp</code> responde 404. Os MCPs virtuais continuam
              respondendo nos próprios endereços.
            </p>
          )}
          {current.status === 'ok' && (
            <p className="panel-hint">
              Hoje: <Link to={`/mcps/${current.slug}`}>{current.name}</Link>,{' '}
              {current.isOpen ? 'aberto — qualquer cliente conecta sem chave' : 'exige uma chave psv_ dele'}.
            </p>
          )}

          <div className="mt-4 flex items-center gap-3">
            <Button type="button" disabled={busy || !dirty} onClick={() => void save()}>
              Salvar
            </Button>
            {dirty && <span className="row-sub">Alteração ainda não salva.</span>}
          </div>

          {mcps.length === 0 && (
            <p className="panel-hint mt-3">
              Ainda não há MCP virtual nenhum. <Link to="/mcps">Crie o primeiro</Link> e volte aqui
              para torná-lo o padrão.
            </p>
          )}
        </Panel>

        <ConnectPanel base={base} settings={settings} configured={Boolean(session.mcpPublicUrl)} />
      </div>
    </>
  );
}

function ConnectPanel({
  base,
  settings,
  configured,
}: {
  base: string;
  settings: InstallationSettings;
  configured: boolean;
}) {
  const toast = useToast();
  const current = settings.defaultMcp;
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
    <Panel title="Conectar ao MCP público" icon={<ServerIcon />}>
      <p className="panel-hint">
        O que o site mostra como <code>mcp.json</code> do MCP público.
        {current.status !== 'ok' && ' Enquanto não houver um padrão em pé, este endereço responde 404.'}
        {!configured && (
          <>
            {' '}
            Defina <code>MCP_PUBLIC_URL</code> no <code>.env</code> para o endereço sair completo.
          </>
        )}
      </p>
      <div className="snippet">
        <pre>{snippet}</pre>
        <button
          type="button"
          className="row-action"
          title="Copiar"
          onClick={() => {
            void navigator.clipboard?.writeText(snippet);
            toast.success('Snippet copiado.');
          }}
        >
          <CopyIcon />
        </button>
      </div>
    </Panel>
  );
}
