import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, Sparkles } from 'lucide-react';
import {
  clearRagRefusals,
  getRagSettings,
  reindexRag,
  saveRagSettings,
  type RagCoverage,
  type RagSettings,
  type RagValue,
} from '../api.js';
import { Button, Field, Panel, Skel, useConfirm } from './ui.js';
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
 * 4. **"Tentar de novo" os recusados não é "Reindexar".** Reindexar é de graça
 *    por contrato; devolver à fila o que o provedor recusou custa requisições.
 *    Por isso são dois botões, e este pede confirmação.
 */
export function RagPanel() {
  const toast = useToast();
  const confirm = useConfirm();
  const [dados, setDados] = useState<RagSettings | null>(null);
  const [driver, setDriver] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const atual = await getRagSettings();
      setDados(atual);
      setDriver(atual.driver.value);
      setModel(modeloDaTela(atual));
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
   * O par gravado não combina (modelo de outro driver): o indexador recusa a
   * configuração a cada ciclo. A tela já abre com o primeiro modelo do driver
   * escolhido (`modeloDaTela`), então basta salvar — sem isso o select de um
   * driver com um modelo só nunca dispararia `onChange`, e o "Salvar" ficaria
   * desabilitado para sempre.
   */
  const parInvalido =
    dados !== null && driver === dados.driver.value && modeloDaTela(dados) !== dados.model.value;

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
      setModel(modeloDaTela(salvo));
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

  /**
   * O reparo da recusa gravada por engano: a marca é permanente, e "Reindexar"
   * não a desfaz — o texto volta sob o mesmo hash e reencontra a mesma linha.
   */
  async function tentarRecusados(quantos: number) {
    const ok = await confirm({
      title: `Tentar de novo ${quantos} texto(s) recusado(s)?`,
      description:
        'Eles voltam à fila do indexador no próximo ciclo. Diferente de "Reindexar", isto ' +
        'custa requisições ao provedor: o que ele recusar de novo volta a ser marcado. Serve ' +
        'para depois de corrigir a causa — URL base, intermediário ou conta do provedor.',
      confirmLabel: 'Tentar de novo',
    });
    if (!ok) return;

    setBusy(true);
    try {
      const { refusals } = await clearRagRefusals();
      toast.success(
        refusals === 0
          ? 'Nenhuma recusa a desfazer neste espaço.'
          : `${refusals} texto(s) devolvido(s) à fila. O indexador os tenta no próximo ciclo.`,
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
  const pendencias = cobertura === null ? null : pendenciasDe(cobertura);
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
            parInvalido
              ? `o modelo gravado (${dados.model.value}) não é deste driver, e o indexador recusa a combinação — salve para gravar o escolhido`
              : model === dados.model.value
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

      {dados.model.ambienteIgnorado !== null && dados.driver.value !== 'off' && (
        <p className="panel-hint mt-2" style={{ color: 'var(--warn)' }}>
          O <code>.env</code> define <code>RAG_MODEL={dados.model.ambienteIgnorado}</code>, que
          está sendo ignorado:{' '}
          {dados.model.origem === 'banco'
            ? 'quem decide é o valor gravado aqui.'
            : 'ele não é modelo do driver gravado aqui, e vale o padrão desse driver.'}
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
        <dd>{cobertura === null ? '—' : resumoDasPendencias(cobertura)}</dd>

        {pendencias !== null && pendencias.travadas > 0 && (
          <>
            <dt>Skills travadas</dt>
            <dd style={{ color: 'var(--warn)' }}>
              {pendencias.travadas} skill(s) que o indexador não consegue refatiar: a leitura
              delas começou três vezes e nenhuma terminou, e ele deixou de tentar sozinho. Edite-as
              ou clique em Reindexar para dar uma chance nova.
            </dd>
          </>
        )}

        {pendencias !== null && pendencias.recusados > 0 && (
          <>
            <dt>Textos recusados</dt>
            <dd>
              {pendencias.recusados} texto(s) que o provedor recusou neste espaço, e que o
              indexador não tenta mais. "Reindexar" não os traz de volta.{' '}
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void tentarRecusados(pendencias.recusados)}
              >
                Tentar de novo
              </Button>
            </dd>
          </>
        )}

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

/**
 * O resumo da chave. Ele fica logo acima do "Último erro", e não pode
 * desmenti-lo: só `presente` afirma que o provedor aceitou a chave, e o
 * servidor só o devolve para ciclo sem erro. Erro que não fala da chave —
 * provedor fora do ar, prazo, configuração, origem recusada — é
 * `nao-confirmada`, que manda ler a linha de baixo em vez de concluir por ela.
 */
export const ROTULO_DA_CHAVE: Record<RagSettings['keyState'], string> = {
  presente: 'aceita pelo provedor no último ciclo',
  ausente: 'não configurada — as skills são refatiadas, nada é embutido',
  recusada: 'recusada pelo provedor',
  // Limite de taxa passa sozinho, e é nele que a cota diária do Google cai.
  'cota-esgotada':
    'limite de taxa ou cota do provedor atingido — o indexador tenta de novo sozinho ' +
    '(no Google, a cota diária zera à meia-noite do Pacífico)',
  'sem-credito': 'conta do provedor sem crédito — esperar não resolve, é preciso regularizar o faturamento',
  'nao-confirmada':
    'não confirmada — o último ciclo terminou com um erro que não fala da chave (veja o último erro)',
  desconhecido: 'ainda não se sabe — o indexador não publicou estado nenhum',
};

/**
 * As pendências, separando o que o indexador **vai** fazer do que ele não faz
 * sozinho. `refusedTexts` está dentro de `pendingTexts` e `stuckSkills` dentro de
 * `staleSkills` (é assim que o banco conta: a pendência é real, e o segundo
 * número é a explicação dela); somados numa linha só, "5 textos a embutir" com 2
 * recusados prometia um trabalho que não vai acontecer.
 *
 * Os dois campos novos entram com `?? 0`: `stuckSkills` é opcional no tipo, e uma
 * resposta em cache de antes da atualização não traz nenhum dos dois.
 */
export function pendenciasDe(cobertura: RagCoverage): {
  aRefatiar: number;
  travadas: number;
  aEmbutir: number;
  recusados: number;
} {
  const travadas = cobertura.stuckSkills ?? 0;
  const recusados = cobertura.refusedTexts ?? 0;
  return {
    aRefatiar: Math.max(0, cobertura.staleSkills - travadas),
    travadas,
    aEmbutir: Math.max(0, cobertura.pendingTexts - recusados),
    recusados,
  };
}

/** A linha "Pendências". O que não anda sozinho só aparece quando existe. */
export function resumoDasPendencias(cobertura: RagCoverage): string {
  const { aRefatiar, travadas, aEmbutir, recusados } = pendenciasDe(cobertura);
  return [
    `${aRefatiar} skill(s) a refatiar`,
    travadas > 0 ? `${travadas} travada(s)` : null,
    `${aEmbutir} texto(s) a embutir`,
    recusados > 0 ? `${recusados} recusado(s) pelo provedor` : null,
  ]
    .filter((parte) => parte !== null)
    .join(', ');
}

/**
 * O modelo com que a tela abre: o gravado, ou o primeiro do driver gravado
 * quando o par não combina (o `.env` de outro driver já semeou modelo errado, e
 * a linha ficou no banco). Com o driver desligado não há o que conferir.
 */
export function modeloDaTela(
  dados: Pick<RagSettings, 'driver' | 'model' | 'driverOptions'>,
): string {
  const doDriver = dados.driverOptions.find((d) => d.id === dados.driver.value)?.models ?? [];
  if (doDriver.length === 0 || doDriver.includes(dados.model.value)) return dados.model.value;
  return doDriver[0] ?? dados.model.value;
}

function origemDe(valor: RagValue): string {
  if (valor.origem === 'banco') {
    const quando = valor.updatedAt ? new Date(valor.updatedAt).toLocaleString('pt-BR') : null;
    return quando ? `gravado no painel em ${quando}` : 'gravado no painel';
  }
  if (valor.origem === 'ambiente') return 'veio do .env e ainda não foi gravado';
  return 'padrão do código';
}
