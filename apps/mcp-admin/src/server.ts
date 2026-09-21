import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TOKEN_CALLER, callerAtual, type Caller } from './auth.js';
import { config } from './config.js';
import { createCatalogHandlers } from './catalogs.js';
import { NAME_MAX, createMcpHandlers } from './mcps.js';
import { createHandlers, guard } from './tools.js';

const INSTRUCTIONS = `Purple Skills administrative MCP server.

Lets you manage the whole catalog: create, edit, publish/unpublish and delete
skills, as well as write and delete files.

Important rules:
- Every skill must have a SKILL.md; it cannot be deleted, only overwritten with
  set_file.
- Metadata (slug, name, description, tags) lives in its own fields and is the
  source of truth: the frontmatter in the first lines of SKILL.md is generated
  from it on read. Do not write frontmatter into the content — it is discarded.
  To change metadata use create_skill/edit_skill.
- The slug is the skill's official name: it is what goes in the name: field of
  the frontmatter.
- set_files_bulk with replace=true treats the zip as the complete desired state:
  files missing from the zip are removed (SKILL.md is always preserved). That
  removal is irreversible and never happens without confirmation: the call is
  refused with the list of what would go and the number to repeat in
  confirm_deletions. For a partial upload, use replace=false instead of
  confirming.
- A skill is a floating element: it exists in the catalog and is only served by
  an MCP server where it is linked to a virtual MCP — the site has its own rule,
  in the next item. A newly created skill is born without links, unless
  create_skill receives mcps; afterwards, link_skill / unlink_skill publish and
  unpublish from the skill side, and set_virtual_mcp_skills sets the whole list
  from the MCP side. Each link picks the three surfaces (asSkill, asPrompt,
  asResource). Publishing to a virtual MCP requires "edit" on it and "view" on
  the skill.
- The site lists whatever is in at least one open and enabled virtual MCP, plus
  the skills and catalogs marked public (is_public) — a public skill stays on the
  site even with no link at all. list_skills and get_skill show, in mcps and
  isPublic, where each skill is.
- delete_skill is irreversible, requires confirm=true and belongs to the owner
  (or an admin).
- Access: skills, catalogs and virtual MCPs have an owner. The credential's role
  decides only who CREATES (editor and admin; a "member" does not create). The
  rest is per-object access: an admin has everything on everything; the owner has
  everything on what is theirs; other accounts have the level granted to them —
  "view" (read; on an MCP or catalog, also read the skills inside), "edit" (skill
  content; catalog members; links, surfaces and canvas of the MCP) or "manage"
  (slug, state, public/open, MCP keys and the grants). Deleting and transferring
  ownership belong only to the owner and to an admin. A credential only lists what
  is its own, what was granted to it and what is public/open (list_* accepts
  scope: mine, shared, public). share_<type>(slug, email, level) / unshare_<type>
  grant and revoke; transfer_<type>(slug, email) changes the owner. A skill inside
  an open MCP or a public catalog is readable by anyone, even when private — the
  tools warn about it.
- Virtual MCPs (tools *_virtual_mcp*): read-only servers at /virtual/<slug>/mcp
  with their own keys (psv_…), or open ones (is_open) — an open MCP is public: the
  site lists it, with its skills. The psv_ key reads the whole tree of the MCP
  (direct skills and catalogs), whatever the access level of each skill.
- The public MCP (/mcp) is the virtual MCP chosen as the default
  (get_default_virtual_mcp / set_default_virtual_mcp, admin only). It keeps
  answering at /virtual/<slug>/mcp and gets no special treatment: it can be
  closed, disabled or deleted like any other, and then /mcp answers 404. With no
  default MCP, /mcp answers 404.
- Catalogs (tools *_catalog*): a catalog is a group of skills with an owner.
  Linked to a virtual MCP (set_virtual_mcp_catalogs), it delivers all of its
  active skills at once, through the surfaces chosen in the link — a single choice
  for the whole group. A skill with a direct link to the same MCP follows the
  direct link, which overrides the catalog; without a direct link, the surfaces
  are the union of the catalogs. Linking requires "edit" on the MCP and "view" on
  the catalog. Three switches, all reversible: is_active of the skill (edit_skill —
  it disappears from every MCP and from the site), isActive of the membership in
  set_catalog_skills (only in that catalog) and is_active of the catalog
  (update_catalog).`;

/**
 * Cria uma instância do servidor MCP administrativo para um chamador.
 *
 * O `caller` chega da autenticação (token global ou chave `psk_`) e é ele que
 * decide quais ferramentas podem ser executadas e quem aparece no `audit_log`.
 *
 * Os handlers nascem **a cada chamada**, com a credencial revalidada na
 * requisição em curso (`callerAtual`). Numa sessão este servidor é construído
 * uma única vez, no `initialize`: fechar sobre o `caller` daquele instante
 * congelaria papel, ator, IP e agente até a sessão cair — rebaixar a conta no
 * painel não tiraria o poder de quem já estava conectado. Recriar é barato
 * (só fecha sobre o caller, sem ida ao banco), e o `caller` do `initialize`
 * continua valendo como padrão fora de uma requisição.
 */
export function createMcpServer(caller: Caller = TOKEN_CALLER): McpServer {
  const handlers = () => createHandlers(callerAtual(caller));
  const mcps = () => createMcpHandlers(callerAtual(caller));
  const catalogs = () => createCatalogHandlers(callerAtual(caller));

  const server = new McpServer(
    { name: config.serverName, version: config.version },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'list_skills',
    {
      title: 'List skills',
      description:
        'Lists the skills the credential can see (its own, the ones granted to it and the public or exposed ones; everything for an admin), ' +
        'including unlinked and disabled ones. Each one brings the owner, your access level and, in mcps, the virtual MCPs it is in.',
      inputSchema: {
        query: z.string().describe('Free-text filter.').optional(),
        tag: z.string().describe('Filter by tag.').optional(),
        scope: z
          .enum(['mine', 'shared', 'public'])
          .describe('Only mine, only the ones shared with me or only the public ones. Omitted: everything I can see.')
          .optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .describe('Maximum number of results per page (default 50, cap 100).')
          .optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    (args) => guard(() => handlers().list_skills(args)),
  );

  server.registerTool(
    'get_skill',
    {
      title: 'Read skill',
      description:
        'Returns metadata, the list of files and the body of SKILL.md (without the frontmatter, ' +
        'which is generated from the metadata).',
      inputSchema: { slug: z.string().describe('Skill slug.') },
    },
    (args) => guard(() => handlers().get_skill(args)),
  );

  server.registerTool(
    'get_file',
    {
      title: 'Read file',
      description:
        'Reads the textual content of a skill file. A binary file, or text above the byte cap ' +
        'of the result (MCP_MAX_FILE_TEXT_BYTES), is refused with the size and the type, ' +
        'because there is no download URL to point to here: in that case download the skill ' +
        'package from the admin panel. get_skill follows the same cap and, when SKILL.md goes ' +
        'over it, returns the remaining fields with skillMdBytes and skillMdOmitido instead of the body.',
      inputSchema: {
        slug: z.string(),
        path: z.string().describe('Relative path, e.g. "reference/examples.md".'),
      },
    },
    (args) => guard(() => handlers().get_file(args)),
  );

  server.registerTool(
    'create_skill',
    {
      title: 'Create skill',
      description:
        'Creates a new skill. The SKILL.md content is required. Without mcps the skill is born ' +
        'unlinked: no MCP serves it. It still shows up on the site if it is born public (is_public: true) ' +
        'or later joins a public catalog. The frontmatter is generated from the fields below.',
      inputSchema: {
        name: z.string().describe('Human-readable name of the skill.'),
        description: z.string().describe('One-line summary.').optional(),
        icon: z
          .string()
          .describe('Icon in the admin panel: a single emoji (🐘) or the http(s) URL of an image.')
          .optional(),
        skill_md_content: z
          .string()
          .describe('Body of SKILL.md (markdown), without frontmatter — it is generated from the metadata.'),
        tags: z.array(z.string()).describe('Free-form tags for browsing/filtering.').optional(),
        slug: z
          .string()
          .describe(
            "The skill's official name: lowercase a-z, digits and single hyphens, no hyphen at " +
              'the ends and at most 96 characters — "conventional-commits". A value outside that ' +
              'is refused (the server no longer fixes it silently), so send the slug ready to ' +
              'use. Omitted, it is generated from the name.',
          )
          .optional(),
        mcps: z
          .array(
            z.object({
              slug: z.string().describe('Virtual MCP slug.'),
              asSkill: z.boolean().describe('In the tools (search_skills, get_skill…).'),
              asPrompt: z.boolean().describe('As a prompt, under its slug.'),
              asResource: z.boolean().describe('As the resource skill://<slug>.'),
            }),
          )
          .describe(
            'Where to publish right at creation. Only on virtual MCPs the credential can edit; omitted, the skill is born unlinked.',
          )
          .optional(),
        is_public: z
          .boolean()
          .describe('Readable by any account and by the site, with no grant (default false). Does not publish it on any MCP.')
          .optional(),
      },
    },
    (args) => guard(() => handlers().create_skill(args)),
  );

  server.registerTool(
    'clone_skill',
    {
      title: 'Clone skill',
      description:
        'Copies a skill into a new skill. The copy takes the properties, the files and the tags; ' +
        'it does not take virtual MCP links, catalog membership or the grants of the original. ' +
        'Whoever clones owns the copy, which is born private (is_public false) and floating — no MCP ' +
        'serves it until link_skill. Requires "edit" on the skill and the editor or admin role.',
      inputSchema: {
        slug: z.string().describe('Slug of the skill to copy (the original, which is not changed).'),
        name: z.string().describe("Name of the copy. Omitted, it repeats the original's name.").optional(),
        new_slug: z
          .string()
          .describe(
            'Slug of the copy, with the same rules as the slug at creation. Omitted, it is the ' +
              "original's with the suffix -2, -3… (never fails because the slug is taken); given and already taken, the call is refused.",
          )
          .optional(),
      },
    },
    (args) => guard(() => handlers().clone_skill(args)),
  );

  server.registerTool(
    'edit_skill',
    {
      title: 'Edit metadata',
      description:
        'Changes name, description, icon, tags ("edit") or slug, is_active and is_public ("manage") of a skill. This is ' +
        "how you change the SKILL.md frontmatter, generated from these fields. Where it shows up is link_skill.",
      inputSchema: {
        slug: z.string().describe('Current slug of the skill.'),
        name: z.string().optional(),
        description: z.string().optional(),
        icon: z
          .string()
          .describe('Icon in the admin panel: a single emoji or the http(s) URL of an image. Empty clears it.')
          .optional(),
        tags: z.array(z.string()).describe('Replaces the whole list of tags.').optional(),
        new_slug: z
          .string()
          .describe(
            'New official name (changes the public URL and the `name:` of the frontmatter). Same ' +
              'rules as the slug at creation: lowercase a-z, digits and single hyphens, no hyphen ' +
              'at the ends, up to 96 characters; a value outside that is refused, not fixed.',
          )
          .optional(),
        is_active: z
          .boolean()
          .describe('false disables the skill: it disappears from every virtual MCP and from the site, directly or through a catalog, without losing any link.')
          .optional(),
        is_public: z
          .boolean()
          .describe('Readable by any account and by the site, with no grant. Requires "manage", like new_slug and is_active.')
          .optional(),
      },
    },
    (args) => guard(() => handlers().edit_skill(args)),
  );

  server.registerTool(
    'link_skill',
    {
      title: 'Publish skill on a virtual MCP',
      description:
        'Links the skill to the virtual MCP, choosing the three surfaces; an existing link is ' +
        'rewritten. Requires "edit" on the virtual MCP and "view" on the skill: whoever edits a ' +
        "server can publish on it someone else's skill that they can read, and on an open server that makes it public.",
      inputSchema: {
        skill: z.string().describe('Skill slug.'),
        mcp: z.string().describe('Virtual MCP slug.'),
        asSkill: z.boolean().describe('In the tools (search_skills, get_skill…).'),
        asPrompt: z.boolean().describe('As a prompt, under its slug.'),
        asResource: z.boolean().describe('As the resource skill://<slug>.'),
      },
    },
    (args) => guard(() => mcps().link_skill(args)),
  );

  server.registerTool(
    'unlink_skill',
    {
      title: 'Remove skill from a virtual MCP',
      description:
        'Undoes the link. With no link at all the skill stops being served by any MCP; on the site ' +
        'it stays if it is public (is_public) or belongs to a public, enabled catalog — ' +
        'to take it off the site, check is_public in get_skill and use edit_skill.',
      inputSchema: {
        skill: z.string().describe('Skill slug.'),
        mcp: z.string().describe('Virtual MCP slug.'),
      },
    },
    (args) => guard(() => mcps().unlink_skill(args)),
  );

  server.registerTool(
    'set_file',
    {
      title: 'Write file',
      description:
        'Creates or overwrites a skill file. Use path="SKILL.md" to replace the main content — ' +
        'the body only: any frontmatter sent is discarded.',
      inputSchema: {
        slug: z.string(),
        path: z.string().describe('Relative path inside the skill.'),
        content: z.string().describe('Full textual content of the file.'),
      },
    },
    (args) => guard(() => handlers().set_file(args)),
  );

  server.registerTool(
    'set_files_bulk',
    {
      title: 'Import file tree',
      description:
        'Imports a .zip (base64) with the skill file tree, preserving the paths — the only ' +
        'exception is the wrapper: a single root folder containing SKILL.md (the format of the ' +
        'downloaded package, <slug>/SKILL.md) is unwrapped; a subfolder sent on its own ' +
        '(scripts/a.py, scripts/b.py) goes in with the folder, as it came. ' +
        'By default the zip represents the complete desired state: files missing from it are ' +
        'removed from the skill (SKILL.md is always preserved). Pass replace=false to only add ' +
        'and overwrite, removing nothing. When the zip would in fact remove files, the call is ' +
        'refused with the list of what would go: repeat it with confirm_deletions=<number of ' +
        'files to remove> to confirm, or with replace=false to remove nothing.',
      inputSchema: {
        slug: z.string(),
        zip_base64: z.string().describe('Content of the .zip encoded in base64.'),
        replace: z
          .boolean()
          .describe('false keeps the files omitted from the zip (default true).')
          .optional(),
        confirm_deletions: z
          .number()
          .int()
          .min(0)
          .describe(
            'Confirms the irreversible removal of the files missing from the zip: it must be ' +
              'their exact number, which the refusal of the first call reports. It is only needed ' +
              'when there is a removal — do not invent the value.',
          )
          .optional(),
      },
    },
    (args) => guard(() => handlers().set_files_bulk(args)),
  );

  server.registerTool(
    'delete_file',
    {
      title: 'Delete file',
      description: 'Deletes a file from the skill. SKILL.md cannot be deleted.',
      inputSchema: { slug: z.string(), path: z.string() },
    },
    (args) => guard(() => handlers().delete_file(args)),
  );

  server.registerTool(
    'delete_skill',
    {
      title: 'Delete skill',
      description: 'Deletes the skill and all of its files. Irreversible.',
      inputSchema: {
        slug: z.string(),
        confirm: z.boolean().describe('Must be true for the deletion to happen.'),
      },
    },
    (args) => guard(() => handlers().delete_skill(args)),
  );

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description: 'Lists every tag in the catalog with its skill count.',
      inputSchema: {},
    },
    () => guard(() => handlers().list_tags()),
  );

  server.registerTool(
    'get_stats',
    {
      title: 'Statistics',
      description:
        'Totals scoped to what the credential can see: the skills and tags it sees, plus the skills published on the site. ' +
        'Only an admin credential gets the numbers for the whole installation (files, views, downloads, floating skills and accounts).',
      inputSchema: {},
    },
    () => guard(() => handlers().get_stats()),
  );

  // ------------------------------------------------------- MCPs virtuais ---

  server.registerTool(
    'list_virtual_mcps',
    {
      title: 'List virtual MCPs',
      description:
        'Lists the virtual MCPs the credential can see: all of them for an admin; its own, the ones granted to it and the open ones for everyone else, with the access level on each.',
      inputSchema: {
        scope: z.enum(['mine', 'shared', 'public']).describe('Only mine, only the ones shared with me or only the open ones.').optional(),
      },
    },
    (args) => guard(() => mcps().list_virtual_mcps(args)),
  );

  server.registerTool(
    'get_virtual_mcp',
    {
      title: 'Read virtual MCP',
      description: 'Configuration, linked skills (with the surfaces and counters of the link) and active keys.',
      inputSchema: { slug: z.string().describe('Virtual MCP slug.') },
    },
    (args) => guard(() => mcps().get_virtual_mcp(args)),
  );

  server.registerTool(
    'create_virtual_mcp',
    {
      title: 'Create virtual MCP',
      description:
        'Creates an empty virtual MCP at /virtual/<slug>/mcp. Whoever creates it owns it. It is born enabled and requiring a key.',
      inputSchema: {
        name: z.string().describe(`Display name (up to ${NAME_MAX} characters).`),
        slug: z.string().describe('Slug (a-z, 0-9 and hyphen). Generated from the name if omitted.').optional(),
        description: z
          .string()
          .describe("Goes into the server instructions: it is how the agent knows what this MCP is about.")
          .optional(),
        is_open: z.boolean().describe('No key required (default false).').optional(),
      },
    },
    (args) => guard(() => mcps().create_virtual_mcp(args)),
  );

  server.registerTool(
    'clone_virtual_mcp',
    {
      title: 'Clone virtual MCP',
      description:
        'Copies a virtual MCP into a new virtual MCP. The copy takes the properties, the links to ' +
        'skills and to catalogs (surfaces and canvas positions included) and the grants. It does not take the ' +
        'psv_ keys: the copy is born with no key at all, and nobody connects to it until create_virtual_mcp_key ' +
        'issues one. Whoever clones owns the copy, which is born closed (is_open false). Requires "manage" on the ' +
        'original — the copy takes the ACL, and the ACL is only readable with "manage" — and the editor or admin role.',
      inputSchema: {
        slug: z.string().describe('Slug of the virtual MCP to copy (the original, which is not changed).'),
        name: z.string().describe(`Name of the copy, up to ${NAME_MAX} characters. Omitted, it repeats the original's.`).optional(),
        new_slug: z
          .string()
          .describe(
            'Slug of the copy, which also becomes the address /virtual/<slug>/mcp. Omitted, it is the ' +
              "original's with the suffix -2, -3… (never fails because the slug is taken); given and already taken, the call is refused.",
          )
          .optional(),
      },
    },
    (args) => guard(() => mcps().clone_virtual_mcp(args)),
  );

  server.registerTool(
    'update_virtual_mcp',
    {
      title: 'Update virtual MCP',
      description:
        'Changes name, slug, description, is_open or is_active (requires "manage"). Open (is_open), the MCP is public: the site lists it, with its skills — private ones included.',
      inputSchema: {
        slug: z.string().describe('Current slug.'),
        name: z.string().describe(`New name (up to ${NAME_MAX} characters).`).optional(),
        new_slug: z.string().describe('New slug — changes the address of every configured client.').optional(),
        description: z.string().optional(),
        is_open: z.boolean().optional(),
        is_active: z.boolean().describe('false disables it: everything under /virtual/<slug> answers 404.').optional(),
      },
    },
    (args) => guard(() => mcps().update_virtual_mcp(args)),
  );

  server.registerTool(
    'delete_virtual_mcp',
    {
      title: 'Delete virtual MCP',
      description: 'Deletes the virtual MCP, its links and its keys. Irreversible.',
      inputSchema: {
        slug: z.string(),
        confirm: z.boolean().describe('Must be true for the deletion to happen.'),
      },
    },
    (args) => guard(() => mcps().delete_virtual_mcp(args)),
  );

  server.registerTool(
    'set_virtual_mcp_skills',
    {
      title: 'Set virtual MCP skills',
      description:
        'Replaces the whole list of skills of the virtual MCP: the list is the desired state, and ' +
        'whatever is not in it goes out. Each entry picks the three surfaces. For a single skill, use link_skill.',
      inputSchema: {
        slug: z.string(),
        skills: z
          .array(
            z.object({
              slug: z.string(),
              asSkill: z.boolean().describe('In the tools (search_skills, get_skill…).'),
              asPrompt: z.boolean().describe('As a prompt, under its slug.'),
              asResource: z.boolean().describe('As the resource skill://<slug>.'),
            }),
          )
          .describe('The complete list. An empty one empties the MCP.'),
      },
    },
    (args) => guard(() => mcps().set_virtual_mcp_skills(args)),
  );

  server.registerTool(
    'list_virtual_mcp_keys',
    {
      title: 'List virtual MCP keys',
      description: 'psv_ keys of the virtual MCP, revoked ones included. Never shows the secret.',
      inputSchema: { slug: z.string() },
    },
    (args) => guard(() => mcps().list_virtual_mcp_keys(args)),
  );

  server.registerTool(
    'create_virtual_mcp_key',
    {
      title: 'Issue virtual MCP key',
      description: 'Issues a psv_ key for the virtual MCP. The token appears exactly once, in the response.',
      inputSchema: {
        slug: z.string(),
        name: z.string().describe(`Key name, up to ${NAME_MAX} characters (e.g. "CI of project X").`),
      },
    },
    (args) => guard(() => mcps().create_virtual_mcp_key(args)),
  );

  server.registerTool(
    'revoke_virtual_mcp_key',
    {
      title: 'Revoke virtual MCP key',
      description: 'Revokes a key by id (from list_virtual_mcp_keys). Whoever uses it loses access immediately.',
      inputSchema: { slug: z.string(), key_id: z.string() },
    },
    (args) => guard(() => mcps().revoke_virtual_mcp_key(args)),
  );

  // ----------------------------------------------------------- catálogos ---

  server.registerTool(
    'list_catalogs',
    {
      title: 'List catalogs',
      description:
        'Lists the catalogs the credential can see: all of them for an admin; its own, the ones granted to it and the public ones for everyone else, with the access level on each.',
      inputSchema: {
        scope: z.enum(['mine', 'shared', 'public']).describe('Only mine, only the ones shared with me or only the public ones.').optional(),
      },
    },
    (args) => guard(() => catalogs().list_catalogs(args)),
  );

  server.registerTool(
    'get_catalog',
    {
      title: 'Read catalog',
      description: 'Configuration, skills (with the membership and whether the skill is enabled) and the virtual MCPs the catalog is in.',
      inputSchema: { slug: z.string().describe('Catalog slug.') },
    },
    (args) => guard(() => catalogs().get_catalog(args)),
  );

  server.registerTool(
    'create_catalog',
    {
      title: 'Create catalog',
      description: 'Creates an empty, enabled catalog. Whoever creates it owns it.',
      inputSchema: {
        name: z.string().describe(`Display name (up to ${NAME_MAX} characters).`),
        slug: z.string().describe('Slug (a-z, 0-9 and hyphen). Generated from the name if omitted.').optional(),
        description: z.string().describe('For whoever administers it: what this group is about.').optional(),
        is_public: z
          .boolean()
          .describe('Readable by any account and by the site, which lists the members — private skills included (default false).')
          .optional(),
      },
    },
    (args) => guard(() => catalogs().create_catalog(args)),
  );

  server.registerTool(
    'clone_catalog',
    {
      title: 'Clone catalog',
      description:
        'Copies a catalog into a new catalog. The copy takes the properties and the members, each with the ' +
        'membership state it had; it does not take the virtual MCP links or the grants of the ' +
        'original. Whoever clones owns the copy, which is born private (is_public false). The skills are not ' +
        'duplicated: both catalogs point to the same ones. Requires "edit" on the catalog and the ' +
        'editor or admin role.',
      inputSchema: {
        slug: z.string().describe('Slug of the catalog to copy (the original, which is not changed).'),
        name: z.string().describe(`Name of the copy, up to ${NAME_MAX} characters. Omitted, it repeats the original's.`).optional(),
        new_slug: z
          .string()
          .describe(
            "Slug of the copy. Omitted, it is the original's with the suffix -2, -3… (never fails because the slug is taken); " +
              'given and already taken, the call is refused.',
          )
          .optional(),
      },
    },
    (args) => guard(() => catalogs().clone_catalog(args)),
  );

  server.registerTool(
    'update_catalog',
    {
      title: 'Update catalog',
      description:
        'Changes name, slug, description, is_active or is_public (requires "manage"). Disabled, the catalog delivers nothing to any MCP (members and links stay); public, the site lists it with all of its members.',
      inputSchema: {
        slug: z.string().describe('Current slug.'),
        name: z.string().describe(`New name (up to ${NAME_MAX} characters).`).optional(),
        new_slug: z.string().optional(),
        description: z.string().optional(),
        is_active: z.boolean().optional(),
        is_public: z.boolean().optional(),
      },
    },
    (args) => guard(() => catalogs().update_catalog(args)),
  );

  server.registerTool(
    'delete_catalog',
    {
      title: 'Delete catalog',
      description: 'Deletes the catalog and its links to virtual MCPs. The skills keep existing. Irreversible.',
      inputSchema: {
        slug: z.string(),
        confirm: z.boolean().describe('Must be true for the deletion to happen.'),
      },
    },
    (args) => guard(() => catalogs().delete_catalog(args)),
  );

  server.registerTool(
    'set_catalog_skills',
    {
      title: 'Set catalog skills',
      description:
        'Replaces the whole list of skills of the catalog: the list is the desired state, and whatever is not in it goes out. ' +
        'isActive is the membership: false keeps the skill in the catalog without delivering it; omitted it is true for whoever joins and does not touch whoever stays.',
      inputSchema: {
        slug: z.string(),
        skills: z
          .array(
            z.object({
              slug: z.string(),
              isActive: z.boolean().describe('Membership in the catalog (default true for whoever joins).').optional(),
            }),
          )
          .describe('The complete list. An empty one empties the catalog.'),
      },
    },
    (args) => guard(() => catalogs().set_catalog_skills(args)),
  );

  server.registerTool(
    'set_virtual_mcp_catalogs',
    {
      title: 'Set virtual MCP catalogs',
      description:
        'Replaces the whole list of catalogs of the virtual MCP; each entry picks the three surfaces, which apply to ' +
        'every skill in the catalog. Requires "edit" on the MCP and "view" on each catalog that goes in.',
      inputSchema: {
        slug: z.string().describe('Virtual MCP slug.'),
        catalogs: z
          .array(
            z.object({
              slug: z.string().describe('Catalog slug.'),
              asSkill: z.boolean().describe('In the tools (search_skills, get_skill…).'),
              asPrompt: z.boolean().describe('As a prompt, under its slug.'),
              asResource: z.boolean().describe('As the resource skill://<slug>.'),
            }),
          )
          .describe('The complete list. An empty one removes every catalog from the MCP.'),
      },
    },
    (args) => guard(() => catalogs().set_virtual_mcp_catalogs(args)),
  );

  // ------------------------------------------------------------- acesso ---

  const accessInput = {
    slug: z.string().describe('Slug of the object.'),
    email: z.string().describe('E-mail of the (active) account that receives the access.'),
    level: z
      .enum(['view', 'edit', 'manage'])
      .describe('view: read; edit: content/members/links; manage: properties, keys and grants.'),
  };
  const unshareInput = {
    slug: z.string().describe('Slug of the object.'),
    email: z.string().describe('E-mail of the account that loses the access — active or disabled (the grant of a disabled account stays in the list, inert, until it is revoked).'),
  };
  const transferInput = {
    slug: z.string().describe('Slug of the object.'),
    email: z.string().describe('E-mail of the (active) account that becomes the owner.'),
  };

  server.registerTool(
    'share_skill',
    {
      title: 'Share skill',
      description:
        'Grants (or changes) the access level of an account to a skill. Requires "manage" on the skill. ' +
        'It is not granted to the owner or to an admin — they already have everything.',
      inputSchema: accessInput,
    },
    (args) => guard(() => handlers().share_skill(args)),
  );

  server.registerTool(
    'unshare_skill',
    {
      title: 'Revoke skill access',
      description: 'Removes the grant of an account to a skill. Requires "manage". Links already made by it stay.',
      inputSchema: unshareInput,
    },
    (args) => guard(() => handlers().unshare_skill(args)),
  );

  server.registerTool(
    'transfer_skill',
    {
      title: 'Transfer skill',
      description: 'Changes the owner of the skill. Only the current owner or an admin; whoever transfers it stops being the owner.',
      inputSchema: transferInput,
    },
    (args) => guard(() => handlers().transfer_skill(args)),
  );

  server.registerTool(
    'share_catalog',
    {
      title: 'Share catalog',
      description:
        'Grants (or changes) the access level of an account to a catalog. Requires "manage". "view" includes reading the members.',
      inputSchema: accessInput,
    },
    (args) => guard(() => catalogs().share_catalog(args)),
  );

  server.registerTool(
    'unshare_catalog',
    {
      title: 'Revoke catalog access',
      description: 'Removes the grant of an account to a catalog. Requires "manage".',
      inputSchema: unshareInput,
    },
    (args) => guard(() => catalogs().unshare_catalog(args)),
  );

  server.registerTool(
    'transfer_catalog',
    {
      title: 'Transfer catalog',
      description: 'Changes the owner of the catalog. Only the current owner or an admin.',
      inputSchema: transferInput,
    },
    (args) => guard(() => catalogs().transfer_catalog(args)),
  );

  server.registerTool(
    'share_mcp',
    {
      title: 'Share virtual MCP',
      description:
        'Grants (or changes) the access level of an account to a virtual MCP. Requires "manage". "view" includes reading the skills inside.',
      inputSchema: accessInput,
    },
    (args) => guard(() => mcps().share_mcp(args)),
  );

  server.registerTool(
    'unshare_mcp',
    {
      title: 'Revoke virtual MCP access',
      description: 'Removes the grant of an account to a virtual MCP. Requires "manage".',
      inputSchema: unshareInput,
    },
    (args) => guard(() => mcps().unshare_mcp(args)),
  );

  server.registerTool(
    'transfer_mcp',
    {
      title: 'Transfer virtual MCP',
      description: 'Changes the owner of the virtual MCP. Only the current owner or an admin.',
      inputSchema: transferInput,
    },
    (args) => guard(() => mcps().transfer_mcp(args)),
  );

  // ------------------------------------------------------- MCP padrão ---

  server.registerTool(
    'get_default_virtual_mcp',
    {
      title: 'Read the default MCP',
      description:
        'Which virtual MCP answers at /mcp — the public MCP of this installation — or why none of them does.',
      inputSchema: {},
    },
    () => guard(() => mcps().get_default_virtual_mcp()),
  );

  server.registerTool(
    'set_default_virtual_mcp',
    {
      title: 'Set the default MCP',
      description:
        'Makes a virtual MCP answer at /mcp as well, with its own skills, keys and access rule. ' +
        'A null slug clears it: /mcp starts answering 404. Admin only.',
      inputSchema: {
        slug: z.string().nullable().describe('Virtual MCP slug, or null for none.'),
      },
    },
    (args) => guard(() => mcps().set_default_virtual_mcp(args)),
  );

  return server;
}
