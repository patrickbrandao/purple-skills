import { Field } from './ui.js';
import { buildFrontmatter, parseTags } from '../frontmatter.js';

export type SkillMetaValues = {
  name: string;
  slug: string;
  description: string;
  tags: string;
  isPublic: boolean;
};

/**
 * Formulário dos metadados da skill.
 *
 * Estes campos são a **fonte da verdade**: eles é que viram as primeiras
 * linhas do SKILL.md (o frontmatter). Por isso ficam na mesma tela do prompt,
 * acima dele — e não numa aba separada, onde seria fácil salvar um prompt com
 * metadados contraditórios.
 */
export function SkillMetaForm({
  values,
  onChange,
  slugPlaceholder,
  slugRequired = true,
  nameRequired = true,
  publicLabel = 'Skill pública — visível no site, na API e no MCP público',
}: {
  values: SkillMetaValues;
  onChange: (patch: Partial<SkillMetaValues>) => void;
  slugPlaceholder?: string;
  slugRequired?: boolean;
  nameRequired?: boolean;
  publicLabel?: string;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Slug — nome oficial da skill" hint="Identifica a skill no name: do SKILL.md, na URL e nas ferramentas MCP. Só minúsculas, números e hífen.">
          <input
            className="field field-mono"
            value={values.slug}
            onChange={(event) => onChange({ slug: event.target.value })}
            placeholder={slugPlaceholder}
            required={slugRequired}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </Field>

        <Field label="Nome de exibição" hint="Como a skill aparece no catálogo. Aceita maiúsculas, acentos e espaços.">
          <input
            className="field"
            value={values.name}
            onChange={(event) => onChange({ name: event.target.value })}
            placeholder="Conventional Commits"
            required={nameRequired}
          />
        </Field>
      </div>

      <Field label="Descrição" hint="Diz o que a skill faz e quando usá-la — é por ela que o agente decide acionar a skill.">
        <textarea
          className="field resize-y"
          value={values.description}
          onChange={(event) => onChange({ description: event.target.value })}
          rows={3}
          placeholder="O que esta skill faz, em uma frase."
        />
      </Field>

      <div className="grid items-start gap-4 sm:grid-cols-2">
        <Field label="Tags (separadas por vírgula)">
          <input
            className="field"
            value={values.tags}
            onChange={(event) => onChange({ tags: event.target.value })}
            placeholder="git, workflow, produtividade"
          />
        </Field>

        <label
          className="flex cursor-pointer items-center gap-3 rounded-xl px-3.5 py-3 sm:mt-[1.85rem]"
          style={{ border: '1px solid var(--border-strong)', background: 'var(--surface-2)' }}
        >
          <input
            type="checkbox"
            checked={values.isPublic}
            onChange={(event) => onChange({ isPublic: event.target.checked })}
            className="h-4 w-4"
          />
          <span className="text-sm">{publicLabel}</span>
        </label>
      </div>
    </div>
  );
}

/** Pré-visualização das primeiras linhas geradas a partir do formulário. */
export function FrontmatterPreview({ values }: { values: SkillMetaValues }) {
  const yaml = buildFrontmatter({
    // Sem slug ainda: mostra o lugar dele em vez de um nome que não existe.
    slug: values.slug || '<slug>',
    name: values.name,
    description: values.description,
    tags: parseTags(values.tags),
  });

  return (
    <div className="fm-preview">
      <span className="t">Primeiras linhas do SKILL.md, geradas destes campos</span>
      <pre>{yaml}</pre>
    </div>
  );
}
