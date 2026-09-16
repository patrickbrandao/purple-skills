import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, Sparkles } from 'lucide-react';
import {
  getRagSettings,
  reindexRag,
  saveRagSettings,
  type RagSettings,
  type RagValue,
} from '../api.js';
import { Button, Field, Panel, Skel } from './ui.js';
import { useToast } from './Toast.js';

/**
 * A busca semântica na tela de Configurações (`docs/14-rag.md` §9).
 *
 * Duas coisas a lembrar ao mexer aqui:
 *
 * 1. **O painel não recebe a chave da API.** Tudo que ele sabe sobre ela vem
 *    de `rag.indexer.status`, que o indexador regrava a cada ciclo. Por isso
 *    "desconhecido" é um estado legítimo, e não um erro a esconder.
 * 2. **O aviso do nível gratuito é do Google.** Com esse driver o painel avisa
 *    sempre, porque não tem como saber se a chave é gratuita ou paga — errar
 *    para o lado de avisar é barato; o contrário manda conteúdo privado para
 *    treinamento sem ninguém saber. Quem decide é o servidor, que manda `null`
 *    nos outros drivers.
 * 3. **Driver e modelo andam juntos.** O par identifica o espaço de embedding:
 *    trocar qualquer um aponta a busca para outro espaço, com a cobertura
 *    dele. Nada é apagado — os vetores do espaço anterior ficam lá, prontos
 *    para quando alguém voltar atrás.
 */
export function RagPanel() {
  const toast = useToast();
  const [dados, setDados] = useState<RagSettings | null>(null);
  const [driver, setDriver] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const atual = await getRagSettings();
      setDados(atual);
      setDriver(atual.driver.value);
      setModel(atual.model.value);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Os modelos do driver escolhido na tela, que pode não ser o gravado. */
  const modelos = dados?.driverOptions.find((d) => d.id === driver)?.models ?? [];
  const dirty =
    dados !== null && (driver !== dados.driver.value || model !== dados.model.value);

  /**
   * Trocar de driver troca o modelo junto: um modelo do driver anterior não
   * existe no novo, e deixá-lo na tela ofereceria salvar uma combinação que o
   * servidor recusa.
   */
  function trocarDriver(novo: string) {
    setDriver(novo);
    const doNovo = dados?.driverOptions.find((d) => d.id === novo)?.models ?? [];
    if (!doNovo.includes(model)) setModel(doNovo[0] ?? '');
  }

  async function salvar() {
    setBusy(true);
    try {
      const salvo = await saveRagSettings(
        driver === 'off' ? { driver } : { driver, model },
      );
      setDados(salvo);
      setDriver(salvo.driver.value);
      setModel(salvo.model.value);
      toast.success(
        salvo.driver.value === 'off'
          ? 'Busca semântica desligada. A busca volta ao modo textual em até 10 segundos.'
          : 'Busca semântica ligada. O indexador começa no próximo ciclo.',
      );
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reindexar() {
    setBusy(true);
    try {
      const { skills } = await reindexRag();
      toast.success(
        skills === 0
          ? 'Nada a refatiar: todas as skills já estavam pendentes.'
          : `${skills} skill(s) marcadas para refatiar. Nenhum vetor foi apagado.`,
      );
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (dados === null) {
    return (
      <Panel title="Busca semântica" icon={<Sparkles />}>
        <Skel />
      </Panel>
    );
  }

  const cobertura = dados.coverage;
  const pct =
    cobertura && cobertura.texts > 0
      ? Math.round((cobertura.withVector / cobertura.texts) * 100)
      : null;

  return (
    <Panel
      title="Busca semântica"
      icon={<Sparkles />}
      actions={
        <Button
          variant="ghost"
          disabled={busy || !dados.schemaReady}
          onClick={() => void reindexar()}
        >
          <RefreshCw size={14} /> Reindexar
        </Button>
      }
    >
      <p className="panel-hint">
        Funde a busca por significado com a busca textual de sempre. Desligada, tudo
        responde exatamente como antes.
      </p>

      {!dados.schemaReady && (
        <p className="panel-hint mt-3" style={{ color: 'var(--warn)' }}>
          A migration do RAG ainda não foi aplicada nesta instalação. Rode o{' '}
          <code>migrate</code> — o indexador espera por ela sem cair.
        </p>
      )}

      <Field label="Driver" hint={origemDe(dados.driver)}>
        <select
          className="input"
          value={driver}
          disabled={busy}
          onChange={(e) => trocarDriver(e.target.value)}
        >
          <option value="off">Desligada</option>
          {dados.driverOptions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </Field>

      {driver !== 'off' && (
        <Field
          label="Modelo"
          hint={
            model === dados.model.value
              ? origemDe(dados.model)
              : 'trocar o modelo cria outro espaço; os vetores do atual continuam onde estão'
          }
        >
          <select
            className="input"
            value={model}
            disabled={busy}
            onChange={(e) => setModel(e.target.value)}
          >
            {modelos.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
      )}

      {dados.driver.ambienteIgnorado !== null && (
        <p className="panel-hint mt-2" style={{ color: 'var(--warn)' }}>
          O <code>.env</code> define <code>RAG_DRIVER={dados.driver.ambienteIgnorado}</code>, que
          está sendo ignorado: quem decide é o valor gravado aqui.
        </p>
      )}

      <div className="row gap-2 mt-3">
        <Button disabled={busy || !dirty} onClick={() => void salvar()}>
          Salvar
        </Button>
        {dirty && <span className="row-sub">Alteração ainda não salva.</span>}
      </div>

      <dl className="kv mt-4">
        <dt>Chave da API</dt>
        <dd>{ROTULO_DA_CHAVE[dados.keyState]}</dd>

        <dt>Cobertura</dt>
        <dd>
          {cobertura === null
            ? '—'
            : `${cobertura.withVector} de ${cobertura.texts} textos${
                pct === null ? '' : ` (${pct}%)`
              }`}
        </dd>

        <dt>Pendências</dt>
        <dd>
          {cobertura === null
            ? '—'
            : `${cobertura.staleSkills} skill(s) a refatiar, ${cobertura.pendingTexts} texto(s) a embutir`}
        </dd>

        <dt>Último ciclo</dt>
        <dd className="mono">
          {dados.indexer?.at ? new Date(dados.indexer.at).toLocaleString('pt-BR') : 'o indexador ainda não rodou'}
        </dd>

        {dados.indexer?.lastError ? (
          <>
            <dt>Último erro</dt>
            <dd style={{ color: 'var(--danger)' }}>{dados.indexer.lastError}</dd>
          </>
        ) : null}
      </dl>

      {/*
        Só o Google tem nível gratuito que lê o conteúdo enviado, e o painel não
        sabe se a chave é gratuita ou paga: com esse driver ele avisa sempre,
        porque a consequência de não avisar é conteúdo de skill privada indo
        para treinamento sem ninguém ver. Nos outros drivers o servidor manda
        `null`, e repetir o aviso ali só ensinaria a ignorá-lo.
      */}
      {dados.freeTierWarning !== null && (
        <p className="panel-hint mt-4" style={{ display: 'flex', gap: 8 }}>
          <AlertTriangle size={16} style={{ flexShrink: 0, color: 'var(--warn)' }} />
          <span>{dados.freeTierWarning}</span>
        </p>
      )}
    </Panel>
  );
}

const ROTULO_DA_CHAVE: Record<RagSettings['keyState'], string> = {
  presente: 'aceita pelo provedor no último ciclo',
  ausente: 'não configurada — as skills são refatiadas, nada é embutido',
  recusada: 'recusada pelo provedor',
  'cota-esgotada': 'cota esgotada (no Google, a diária zera à meia-noite do Pacífico)',
  desconhecido: 'ainda não se sabe — o indexador não publicou estado nenhum',
};

function origemDe(valor: RagValue): string {
  if (valor.origem === 'banco') {
    const quando = valor.updatedAt ? new Date(valor.updatedAt).toLocaleString('pt-BR') : null;
    return quando ? `gravado no painel em ${quando}` : 'gravado no painel';
  }
  if (valor.origem === 'ambiente') return 'veio do .env e ainda não foi gravado';
  return 'padrão do código';
}
