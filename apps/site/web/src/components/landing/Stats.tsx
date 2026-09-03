import { useEffect, useRef } from 'react';
import { useCatalogSummary } from '../../useCatalogSummary.js';

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

export function Stats() {
  const summary = useCatalogSummary();

  const items = [
    { value: summary?.total ?? 0, suffix: '', label: 'skills no catálogo' },
    { value: summary?.tags.length ?? 0, suffix: '', label: 'tags para navegar' },
    { value: 17, suffix: '', label: 'ferramentas MCP' },
    { value: 100, suffix: '%', label: 'software livre' },
  ];

  return (
    <section className="stats">
      <div className="wrap">
        <div className="stat-grid">
          {items.map((item, index) => (
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
