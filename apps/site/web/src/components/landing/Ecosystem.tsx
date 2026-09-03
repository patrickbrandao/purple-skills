type Tile = { name: string; file: string };

const AGENTS: Tile[] = [
  { name: 'Claude Code', file: 'icon-agent-claude-code-64.png' },
  { name: 'Codex', file: 'icon-agent-codex-64.png' },
  { name: 'Manus', file: 'icon-agent-manus-64.png' },
  { name: 'OpenClaw', file: 'icon-agent-openclaw-64.png' },
  { name: 'OpenCode', file: 'icon-agent-opencode-64.png' },
  { name: 'Pi', file: 'icon-agent-pi-64.png' },
  { name: 'Hermes', file: 'icon-agent-hermes-64.png' },
  { name: 'LM Studio', file: 'icon-lm-studio-agent-64.png' },
];

const IDES: Tile[] = [
  { name: 'Cursor', file: 'icon-cursor-64.png' },
  { name: 'Antigravity', file: 'icon-antigravity-64.png' },
  { name: 'Visual Studio', file: 'icon-vs-studio-64.png' },
  { name: 'LM Studio', file: 'icon-lm-studio-app-64.png' },
];

const MODELS: Tile[] = [
  { name: 'Anthropic', file: 'icon-llm-anthropic-64.png' },
  { name: 'Claude', file: 'icon-llm-claude-64.png' },
  { name: 'OpenAI', file: 'icon-llm-openai-64.png' },
  { name: 'Gemini', file: 'icon-llm-gemini-64.png' },
  { name: 'Gemma', file: 'icon-llm-gemma-64.png' },
  { name: 'Qwen', file: 'icon-llm-qwen-64.png' },
  { name: 'DeepSeek', file: 'icon-llm-deepseek-64.png' },
  { name: 'MiniMax', file: 'icon-llm-minimax-64.png' },
  { name: 'Kimi', file: 'icon-llm-kimi-64.png' },
  { name: 'Mistral', file: 'icon-llm-mistral-64.png' },
  { name: 'Ollama', file: 'icon-llm-ollama-64.png' },
  { name: 'Grok', file: 'icon-llm-grok-64.png' },
];

function Row({ tiles }: { tiles: Tile[] }) {
  return (
    <div className="eco-row">
      {tiles.map((tile) => (
        <span className="eco-tile" data-name={tile.name} key={`${tile.name}-${tile.file}`}>
          <img src={`/assets/images/${tile.file}`} alt={tile.name} />
        </span>
      ))}
    </div>
  );
}

export function Ecosystem() {
  return (
    <section className="eco" id="ecossistema">
      <div className="wrap">
        <div className="head reveal">
          <h2 className="display">
            Plugue no que <span className="grad-text">você já usa.</span>
          </h2>
          <p>
            O Purple Skills é um endpoint MCP nativo. Se a sua ferramenta fala Model Context
            Protocol, ela enxerga o catálogo — sem adaptadores, sem SDK proprietário, sem amarras.
          </p>
          <span className="mcp-badge">
            <img src="/assets/images/icon-mcp-64.png" alt="Model Context Protocol" />
            Compatível com o <b>Model Context Protocol</b>
          </span>
        </div>

        <div className="eco-cats">
          <div className="eco-cat reveal d1">
            <h4>AGENTES</h4>
            <p className="desc">Agentes autônomos que consomem skills via MCP.</p>
            <Row tiles={AGENTS} />
          </div>
          <div className="eco-cat reveal d2">
            <h4>IDEs</h4>
            <p className="desc">Editores com agentes integrados e suporte a MCP.</p>
            <Row tiles={IDES} />
          </div>
          <div className="eco-cat reveal d3">
            <h4>MODELOS</h4>
            <p className="desc">LLMs com tool-use e recursos de MCP.</p>
            <Row tiles={MODELS} />
          </div>
        </div>
      </div>
    </section>
  );
}
