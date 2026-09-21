import { useRef, useState, type KeyboardEvent } from 'react';
import { num, plural } from '../api.js';
import {
  ACTIVITY_WEEKDAYS,
  ACTIVITY_WEEKDAY_LABELS,
  activityKeyTarget,
  activitySummary,
  formatActivityDay,
  type ActivityCell,
  type ActivityGrid,
} from '../activity.js';

/* ============================================================
   O HEATMAP DE ATIVIDADE (`docs/18-atividade.md`)

   Uma coluna por semana, domingo a sábado, sete linhas — a grade
   de contribuições que a referência (`tmp/activity-01.png`) pede,
   na paleta do painel: a rampa é o `--accent` misturado ao fundo
   (`styles/activity.css`), nunca o azul da imagem, e nenhuma cor
   é escrita aqui.

   Grade de divs, e não SVG como a `Honeycomb`: aqui cada célula é
   um controle — recebe clique, foco e tecla —, e botão de verdade
   dá isso de graça. O que o SVG traria (medida exata em unidades
   próprias) não faz falta numa grade de quadrados iguais.
   ============================================================ */

/**
 * O `title` nativo da célula. O painel não tem componente de dica — quem
 * explica um alvo pequeno é o `title`, como na colmeia do card de servidor.
 */
function tituloDaCelula(celula: ActivityCell): string {
  const quando = formatActivityDay(celula.day);
  if (celula.total === 0) return `${quando} · sem atividade`;
  const partes = [
    celula.counts.sessions > 0 ? plural(celula.counts.sessions, 'sessão', 'sessões') : null,
    celula.counts.calls > 0 ? plural(celula.counts.calls, 'chamada', 'chamadas') : null,
    celula.counts.reads > 0 ? plural(celula.counts.reads, 'leitura', 'leituras') : null,
    celula.counts.events > 0 ? plural(celula.counts.events, 'evento', 'eventos') : null,
  ].filter(Boolean);
  return `${quando} · ${plural(celula.total, 'atividade', 'atividades')} (${partes.join(', ')})`;
}

export function ActivityHeatmap({
  grid,
  selected,
  onSelect,
}: {
  grid: ActivityGrid;
  /** O dia aberto no relatório de baixo; `null` enquanto ninguém clicou. */
  selected: string | null;
  onSelect: (day: string) => void;
}) {
  const grade = useRef<HTMLDivElement>(null);
  /** O dia que o cursor do teclado ocupa — foco, não seleção; veja `focar`. */
  const [focado, setFocado] = useState<string | null>(null);

  /**
   * Uma só célula entra na ordem de tabulação: 365 botões em fila fariam do
   * `Tab` a viagem mais longa do painel, e quem só quer chegar ao relatório
   * teria de atravessar o ano inteiro. Dentro da grade quem anda são as setas
   * (o *roving tabindex* do WAI-ARIA).
   *
   * A porta de entrada é onde o cursor parou; se ninguém andou ainda, o dia
   * aberto e, sem ele, o de maior movimento, que é o que alguém quer ver
   * primeiro. Trocar a janela do seletor remonta a grade: o dia guardado pode
   * não existir mais na faixa, e aí o `tabIndex=0` sumiria da grade inteira —
   * por isso a conferência antes de usá-lo.
   */
  const cursor = focado !== null && grid.days.some((celula) => celula.day === focado) ? focado : null;
  const entrada = cursor ?? selected ?? grid.busiest?.day ?? grid.days[grid.days.length - 1]?.day ?? null;

  /**
   * Move o cursor — **e só ele**. Foco e seleção são coisas separadas aqui,
   * como o WAI-ARIA manda quando selecionar é caro: cada seleção busca
   * `GET /api/activity/<dia>`, que roda sete agregados no banco. Enquanto a
   * seta selecionava, segurar ArrowDown por dois segundos (a repetição do
   * teclado é de ~30 por segundo) disparava dezenas dessas buscas, todas em
   * voo — o efeito da página ignora a resposta velha, mas não a cancela —, e
   * atravessar o ano com ArrowRight custava ~52. De quebra, a página zera o
   * relatório a cada dia novo, então a área de baixo piscava entre esqueleto e
   * relatório a cada tecla. Agora a seta anda, o `Enter` (ou o espaço, que o
   * botão traduz em clique sozinho) abre, e sai uma busca por dia escolhido.
   */
  const focar = (day: string | null) => {
    if (!day) return;
    setFocado(day);
    // O nó já está na tela (o cursor só troca de `tabIndex`, nada remonta),
    // então o foco pode ir agora — e precisa ir por aqui, porque a célula
    // alvo ainda está com `tabIndex=-1` neste render.
    grade.current?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)?.focus();
  };

  const aoTeclar = (event: KeyboardEvent<HTMLButtonElement>, day: string) => {
    const alvo = activityKeyTarget(grid.days, day, event.key);
    // `null` é tecla que não anda — `Enter`, espaço e `Tab` inclusive. Elas
    // seguem para o comportamento nativo do botão, que é o que abre o dia.
    if (alvo === null) return;
    event.preventDefault();
    focar(alvo);
  };

  /** Clicar escolhe o dia e leva o cursor junto: o `Tab` seguinte volta para cá. */
  const escolher = (day: string) => {
    setFocado(day);
    onSelect(day);
  };

  // O número de colunas é dado — vem da faixa —, então o gabarito da grade sai
  // em `style`: `repeat()` não aceita uma variável CSS na contagem.
  const colunas = { gridTemplateColumns: `repeat(${grid.weeks.length}, var(--heat-cell))` };

  return (
    // `role="group"`, e não `role="img"` como na colmeia: ali o desenho é
    // inerte, aqui cada célula é um botão, e `img` esconderia todos eles do
    // leitor de tela. O rótulo do grupo é o mesmo resumo que a imagem daria.
    <div className="heat" role="group" aria-label={activitySummary(grid)}>
      <div className="heat-scroll">
        <div className="heat-track">
          <div className="heat-months" style={colunas} aria-hidden>
            {grid.months.map((mes) => (
              <span key={mes.key} style={{ gridColumnStart: mes.column + 1 }}>
                {mes.label}
              </span>
            ))}
          </div>
          <div className="heat-weekdays" aria-hidden>
            {ACTIVITY_WEEKDAYS.map((nome, linha) => (
              <span key={nome}>{ACTIVITY_WEEKDAY_LABELS.includes(linha) ? nome : ''}</span>
            ))}
          </div>
          <div className="heat-grid" style={colunas} ref={grade}>
            {grid.weeks.map((semana) =>
              semana.days.map((celula, linha) =>
                celula ? (
                  <button
                    key={celula.day}
                    type="button"
                    className={`heat-cell${celula.day === selected ? ' sel' : ''}`}
                    data-day={celula.day}
                    data-level={celula.level}
                    title={tituloDaCelula(celula)}
                    aria-label={tituloDaCelula(celula)}
                    aria-pressed={celula.day === selected}
                    tabIndex={celula.day === entrada ? 0 : -1}
                    onClick={() => escolher(celula.day)}
                    onKeyDown={(event) => aoTeclar(event, celula.day)}
                  />
                ) : (
                  // Dia de fora da faixa: o buraco da semana parcial. Ocupa a
                  // posição para a coluna não escorregar, e some do teclado.
                  <span key={`${semana.key}:${linha}`} className="heat-cell gap" aria-hidden />
                ),
              ),
            )}
          </div>
        </div>
      </div>

      <p className="heat-legend">
        <span>Menos</span>
        {[0, 1, 2, 3, 4].map((nivel) => (
          <span key={nivel} className="heat-cell" data-level={nivel} aria-hidden />
        ))}
        <span>Mais</span>
        <span className="heat-legend-note">
          o nível é relativo ao período: {num(grid.activeDays)} de {num(grid.days.length)} dias
        </span>
      </p>
    </div>
  );
}
