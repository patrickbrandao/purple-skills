import { Link } from 'react-router-dom';
import { formatCount, type SkillSummary } from '../api.js';
import { DownloadIcon, EyeIcon, FileIcon } from './Icons.js';

export function SkillCard({ skill, className = '' }: { skill: SkillSummary; className?: string }) {
  return (
    <Link to={`/skills/${skill.slug}`} className={`skill-card ${className}`.trim()}>
      <div className="sk-top">
        {/* Chapéu do mago + slug no mesmo selo: é o nome técnico que o agente usa. */}
        <span className="sk-id">
          <img src="/assets/images/purple-hat-256.png" alt="" />
          <span className="slug mono">{skill.slug}</span>
        </span>

        {/* Diz que a skill não chega só pelas ferramentas: o cliente também a
            vê como slash-command e como endereço skill://. E, quando ela está
            fora das ferramentas, que essas são as únicas portas — buscar por
            ela no agente não a encontraria. */}
        {!skill.useAsSkill && (
          <span
            className="sk-surface off"
            title="Fora das ferramentas do MCP: o agente não a encontra por search_skills"
          >
            sem busca
          </span>
        )}
        {skill.useAsPrompt && (
          <span className="sk-surface" title="Disponível como prompt do MCP — o slug vira um comando no seu agente">
            prompt
          </span>
        )}
        {skill.useAsResource && (
          <span className="sk-surface" title={`Disponível como resource do MCP: skill://${skill.slug}`}>
            resource
          </span>
        )}
      </div>

      <h4>{skill.name}</h4>
      <p>{skill.description || 'Sem descrição.'}</p>

      {skill.tags.length > 0 && (
        <div className="sk-tags">
          {skill.tags.slice(0, 4).map((tag) => (
            <span className="tag" key={tag}>
              {tag}
            </span>
          ))}
          {skill.tags.length > 4 && <span className="tag">+{skill.tags.length - 4}</span>}
        </div>
      )}

      <div className="sk-meta">
        <span title="Acessos">
          <EyeIcon /> {formatCount(skill.viewCount)}
        </span>
        <span className="dl" title="Downloads">
          <DownloadIcon /> {formatCount(skill.downloadCount)}
        </span>
        <span title="Arquivos" style={{ marginLeft: 'auto' }}>
          <FileIcon /> {skill.fileCount}
        </span>
      </div>
    </Link>
  );
}
