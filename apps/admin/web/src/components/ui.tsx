import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { SkillMcpRef } from '../api.js';

export function Button({
  children,
  variant = 'primary',
  size,
  className = '',
  ...props
}: {
  children: ReactNode;
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'lg';
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const classes = ['btn', `btn-${variant}`, size ? `btn-${size}` : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button {...props} className={classes}>
      {children}
    </button>
  );
}

export function Panel({
  children,
  className = '',
  title,
  icon,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  icon?: ReactNode;
}) {
  return (
    <section className={`panel ${className}`.trim()}>
      {title && (
        <h2>
          {icon}
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

/** O site mostra a skill quando ela está em algum vMCP aberto e ligado. */
export const noSite = (skill: { mcps: SkillMcpRef[] }): boolean =>
  skill.mcps.some((mcp) => mcp.isOpen && mcp.isActive);

/**
 * Onde a skill está, em selos: "sem vínculo" (flutuante, exibida em lugar
 * nenhum), "em N MCPs" e, quando algum é aberto e ligado, "no site". Só
 * leitura: quem publica é o painel "Publicada em" da página da skill, ou a
 * página do MCP.
 */
export function McpBadges({ skill }: { skill: { mcps: SkillMcpRef[] } }) {
  if (skill.mcps.length === 0) {
    return (
      <span className="badge private" title="Não está em nenhum MCP virtual: não é exibida no site nem em servidor algum">
        <span className="dot" />
        sem vínculo
      </span>
    );
  }
  const abertos = skill.mcps.filter((mcp) => mcp.isOpen && mcp.isActive).length;
  return (
    <>
      <span
        className="badge public"
        title={`Publicada em: ${skill.mcps.map((mcp) => mcp.name).join(', ')}`}
      >
        <span className="dot" />
        em {skill.mcps.length} MCP{skill.mcps.length === 1 ? '' : 's'}
      </span>
      {abertos > 0 ? (
        <span className="badge surface" title={`${abertos} deles aberto(s) e ligado(s): a skill aparece no site`}>
          no site
        </span>
      ) : (
        <span className="badge surface off" title="Só em MCPs fechados ou desligados: não aparece no site">
          fora do site
        </span>
      )}
    </>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && (
        <span className="mt-1.5 block text-xs" style={{ color: 'var(--text-faint)' }}>
          {hint}
        </span>
      )}
    </label>
  );
}
