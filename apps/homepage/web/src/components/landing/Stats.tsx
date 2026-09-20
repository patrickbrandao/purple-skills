import { useEffect, useRef } from 'react';

function Counter({ value, suffix = '' }: { value: number; suffix?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const settle = () => {
      el.textContent = `${value}${suffix}`;
    };

    if (
      !('IntersectionObserver' in window) ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      settle();
      return;
    }

    let frame = 0;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);

          const start = performance.now();
          const tick = (now: number) => {
            const t = Math.min(1, (now - start) / 1400);
            const eased = 1 - Math.pow(1 - t, 3);
            el.textContent = `${Math.round(value * eased)}${suffix}`;
            if (t < 1) frame = requestAnimationFrame(tick);
          };
          frame = requestAnimationFrame(tick);
        });
      },
      { threshold: 0.5 },
    );

    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [value, suffix]);

  return (
    <div className="n" ref={ref}>
      0
    </div>
  );
}

/**
 * Números do projeto, não do catálogo: a homepage não fala com banco nenhum,
 * então tudo aqui é constante de código.
 *
 * De onde saem — `apps/homepage/src/afirmacoes.test.ts` confere as ferramentas
 * e as imagens contra o código, e falha quando ele passa a desmenti-las:
 *
 * - ferramentas: é **piso**, não contagem. São os `registerTool` de
 *   `apps/mcp-admin/src/server.ts` (40) mais os de
 *   `apps/mcp-public/src/server.ts` (5), e "40+" vale por qualquer critério: a
 *   soma bruta dá 45, por nome distinto 43 (`get_skill` e `list_tags` existem
 *   nos dois) e o admin sozinho 40. O número exato já envelheceu uma vez em
 *   três dias (17 → 45), daí o "+";
 * - imagens: as `tmsoftbrasil/purple-skills-*` dos dois composes — `homepage`,
 *   `site`, `admin`, `mcp-public`, `mcp-admin`, `indexer` e `db` (a do
 *   `migrate` e do `seed`) —, a mesma conta do README ("Imagens no Docker
 *   Hub"). Container não se conta aqui: o `up -d` também sobe o Postgres e o
 *   MCP Inspector, que não são imagem do projeto.
 */
const ITEMS = [
  { value: 40, suffix: '+', label: 'ferramentas MCP' },
  { value: 3, suffix: '', label: 'transportes MCP' },
  { value: 7, suffix: '', label: 'imagens Docker' },
  { value: 100, suffix: '%', label: 'software livre' },
];

export function Stats() {
  return (
    <section className="stats">
      <div className="wrap">
        <div className="stat-grid">
          {ITEMS.map((item, index) => (
            <div className={`stat reveal d${index + 1}`} key={item.label}>
              <Counter value={item.value} suffix={item.suffix} />
              <div className="l">{item.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
