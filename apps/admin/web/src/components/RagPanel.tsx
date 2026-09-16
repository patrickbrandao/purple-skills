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
 * A busca semântica na tela de Configurações (`tmp/RAG-GOOGLE.md` §9, futuro
 * `docs/14`).
 *
 * Duas coisas a lembrar ao mexer aqui:
 *
 * 1. **O painel não recebe a chave da API.** Tudo que ele sabe sobre ela vem
 *    de `rag.indexer.status`, que o indexador regrava a cada ciclo. Por isso
 *    "desconhecido" é um estado legítimo, e não um erro a esconder.
 * 2. **O aviso do nível gratuito é fixo.** O painel não tem como saber se a
 *    chave é gratuita ou paga, então ele avisa sempre — errar para o lado de
 *    avisar é barato; o contrário manda conteúdo privado para treinamento sem
 *    ninguém saber.
 */
export function RagPanel() {
  const toast = useToast();
  const [dados, setDados] = useState<RagSettings | null>(null);
  const [driver, setDriver] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const atual = await getRagSettings();
      setDados(atual);
      setDriver(atual.driver.value);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = dados !== null && driver !== dados.driver.value;

  async function salvar() {
    setBusy(true);
    try {
      const salvo = await saveRagSettings({ driver });
      setDados(salvo);
      setDriver(salvo.driver.value);
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
          onChange={(e) => setDriver(e.target.value)}
        >
          <option value="off">Desligada</option>
          <option value="google">Google — {dados.model.value}</option>
        </select>
      </Field>

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
        Fixo de propósito: o painel não sabe o nível da chave, e a consequência
        de não avisar é conteúdo privado indo para treinamento sem ninguém ver.
      */}
      <p className="panel-hint mt-4" style={{ display: 'flex', gap: 8 }}>
        <AlertTriangle size={16} style={{ flexShrink: 0, color: 'var(--warn)' }} />
        <span>{dados.freeTierWarning}</span>
      </p>
    </Panel>
  );
}

const ROTULO_DA_CHAVE: Record<RagSettings['keyState'], string> = {
  presente: 'aceita pelo Google no último ciclo',
  ausente: 'não configurada — as skills são refatiadas, nada é embutido',
  recusada: 'recusada pelo Google',
  'cota-esgotada': 'cota esgotada (a diária zera à meia-noite do Pacífico)',
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
