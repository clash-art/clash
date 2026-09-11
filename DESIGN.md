# Design System

## Direction

Clash separates brand expression from product chrome. Marketing and identity surfaces may use the signature coral prominently. Authenticated product surfaces use neutral white and gray layers, predictable app structure, and restrained motion.

## Color

- Brand signature: `--clash-brand`, currently `#FF6B50`.
- Coral: `--clash-coral`, reserved for errors, destructive attention, keyboard focus, and the Clash signature.
- Information blue: `--clash-blue`, a pale blue counterpart reserved for information, selection, and in-progress state. It is never an ambient page tint.
- Product surfaces: `--clash-warm-page`, `--clash-warm-surface`, `--clash-warm-muted`, `--clash-warm-hover`, and `--clash-warm-border`.
- Text: `--clash-content-primary`, `--clash-content-secondary`, `--clash-content-muted`, and `--clash-content-disabled`.
- Light product chrome follows a Codex-neutral recipe: true white page and surface layers, a `#F7F7F7` muted/sidebar layer, neutral gray borders, and near-black type. Coral never becomes an ambient surface tint.
- Dark mode mirrors the same semantic hierarchy rather than introducing a separate visual style.

## Typography

Authenticated desktop UI uses the native system stack (`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`) for navigation, controls, body copy, and headings. Marketing may continue to use Inter and Space Grotesk. The homepage slogan is the single product exception: it uses Space Grotesk and colors only the word `clash` with the quiet product-accent token. Other product headings use a compact fixed scale with restrained tracking; avoid display-sized or visibly branded typography inside working tools.

## Layout

- Desktop chrome: 40px native window bar and one contextual left sidebar. The sidebar is 16rem when expanded and collapses completely off-canvas. Only an intentional edge hover target may preview it; there is no persistent icon rail.
- Global pages use a compact Clash home lockup, real product navigation, global `⌘K` search, and Settings at the bottom. The lockup disappears with the labels in the collapsed rail.
- Project detail reuses the same sidebar footprint for the current project: return/project identity, project `⌘K` search, real project surfaces, and Settings. Never stack a global sidebar beside a project sidebar.
- Authenticated content pages use one `AppPage` inset contract: `--app-page-block-start` aligns the first content row to the sidebar's first control, `--app-page-inline-inset` supplies the shared responsive gutter, and `--app-page-block-end` reserves the scroll tail.
- Content width is semantic rather than page-specific arithmetic: narrow (64rem) for Billing, standard (76rem) for Home and Settings content, and wide (100rem) for Projects, Assets, and Marketplace. Width may vary with the task; top and side insets may not.
- Settings keeps its full-height secondary sidebar and applies `AppPage` only to the scrollable content pane. Project detail and editor surfaces are full-bleed workspaces and are explicit exceptions to the content-page inset.
- Rhythm: 8–12px within groups, 24–32px between related blocks, and 40–48px between major sections.
- Recent projects use a responsive three-column grid at desktop widths.

## Components

- Surfaces use one neutral fill or one 1px border. Continuous chrome bands such as the sidebar identity row and sticky Composer region do not receive separator rules. Ordinary cards and expanded inputs are flat; `--clash-shadow-raised` is reserved for compact sticky controls and `--clash-shadow-floating` for overlays.
- Cards use 12px radii; controls use 6–10px radii. Pills are reserved for real tags and statuses.
- Motion is limited to 150–200ms state feedback and must respect reduced motion.
- Sidebar width and main-content inset must read from the same semantic width tokens so collapsing cannot cause overlap or a second layout system.
- The home Agent composer is real product input placed directly under the `make some clash` slogan, not a promotional hero.
- The same Composer becomes a compact sticky pill while scrolling down and restores its complete form while scrolling up. Never render a second fake input; preserve its value, focus, and submit behavior across the presentation change.

### Primitive ownership

- Radix owns select, dropdown, popover, dialog, tabs, collapsible, switch, and avatar interaction semantics. Ariakit owns composite tab behavior where already established. `cmdk` owns searchable command/combobox filtering and active-item navigation. `dnd-kit` owns sortable and drag interactions.
- Clash adapters add stable `data-slot`, size, variant, and context contracts. They must not reimplement focus loops, escape handling, click-outside, roving focus, keyboard navigation, or popup exclusivity.
- `Input`, `Textarea`, `Button`, `SelectMenu`, `SearchableSelect`, `Badge`, and `Avatar` are the shared control families. A feature must use them instead of recreating their borders, focus state, disabled state, and open state.
- `Card` owns neutral product-card material, radius, focus, and the `border` / `surface` interaction variants. Feature cards provide layout and content only; they do not repeat surface utilities.
- `ArtworkSlot` is a transparent alignment primitive for brand marks and generated artwork. It must not add a backplate. Use `IconSurface` only when a semantic tone or status surface is meaningful.
- `ProductNavIcon` owns Clash's global navigation symbols. These are product concepts (`home`, `projects`, `assets`, `store`), not feature-selected library glyphs; global navigation must not fall back to generic house, folder, photo, or storefront icons.
- `AppPage` owns authenticated page width, top alignment, responsive side gutter, and bottom scroll tail. `AppPageInset` reuses only the width and side gutter for sticky bands such as Billing's header. Pages must not restate `px-*`, `pt-*`, or private max-width values around their primary content.
- `AppPageHeader` owns the title, explanatory copy, standard block gap, and optional right-side action for authenticated content pages. Projects, Assets, and Marketplace use this contract instead of restating heading typography and spacing.
- `BrandAsset` is the registry-backed renderer for Clash-owned image files. Every entry declares one role: `identity` for the canonical mark, `feature` for product concepts such as Assets and Plugins, or `state` for empty/error communication. Feature and state artwork may use the Avatar; 16px navigation and third-party provider marks may not.
- `FeedbackSurface` owns feedback tone, border, surface, radius, and live-region semantics. `InlineAlert` is its standard title/message/action composition for local errors, warnings, information, and success states; feature code must not recreate colored alert panels.
- `AppFeedback` is the only transient notification queue and `ToastViewport` owner. Collaboration activity and other event sources adapt into `notify`; they do not render another fixed viewport or choose private timeout behavior. Errors and actionable notices persist until dismissed, warnings receive the longer shared timeout, and hover/focus pauses expiry.
- Dialogs are reserved for choices or blocking workflows with a real action contract. They are not a second notification channel, and `AppFeedback` deliberately exposes no generic `showDialog` escape hatch.
- Overlay actions on project previews use the ghost `IconButton` material. Delete keeps destructive hover/focus semantics, but neither add nor delete receives a nested white card, border, shadow, or blur backplate.

### Token hierarchy

Tokens are resolved in four layers; components never read raw palette values from a page.

1. Foundation: Clash coral, Clash blue, neutral black/white/gray.
2. Semantic: background, foreground, card, popover, primary, muted, destructive, info, border, input, ring.
3. Component: control height/radius/surface, select item states, overlay elevation, avatar ink/status.
4. Context: Settings, Director, Timeline, and Composer remap component tokens for their real density and material needs without forking component behavior.

Product cards read `--surface-card-*`; artwork alignment reads `--artwork-slot-*`; short interaction feedback reads `--motion-feedback-*`. Consumers should not restate those values with Tailwind palette, radius, or duration utilities.
Input placeholder contrast reads `--input-placeholder`; pages must not override it with palette utilities. The default maps to the AA-readable `--muted-foreground` semantic level in both themes.

Feedback reads the `--feedback-{tone}-{ink|surface|border}` semantic mappings and the shared inline/panel/toast radius tokens. A consumer selects tone and density; it does not choose palette colors, shadows, or live-region urgency directly.

Authenticated page layout reads `--app-page-inline-inset`, `--app-page-block-start`, `--app-page-block-end`, and one of the three `--app-page-content-*` width tokens. Home-specific padding tokens are not part of the system.
Authenticated page headings read the shared `--app-page-header-gap` through `AppPageHeader`; page implementations do not choose a private title-to-content gap.

Settings is calm and form-readable; Director is compact technical chrome around a dark viewport; Timeline is dense workbench chrome; Composer is compact conversational input. Sharing a primitive does not mean flattening those contexts into one density.

### Settings information architecture

- A Settings page has one page title. The selected sidebar label, workspace tab, and first section must not repeat the same title as additional decoration.
- All pages share the same content width, page header rhythm, section gap, panel surface, border, radius, and row density through `SettingsSection`, `SettingsPanel`, `SettingsRow`, and `SettingsFieldGroup`.
- Pages may differ structurally: Media Analysis is a form; Providers is a navigable list. That difference is content structure, not permission to invent another material system.
- Settings collections have no enclosing card or continuous outer wire. Each actionable item is its own lightly floating row surface, rows are separated by a small gap, and groups are separated by headings and whitespace. Form sections use panels; list collections do not masquerade as form panels.
- Navigation icons must encode distinct concepts. Provider connection/routing and model capability/catalog cannot reuse the same glyph.

### Agent identity layers

- `AgentMotion` is the Clash persona/avatar and may express Clash-specific motion and status.
- `AcpAgentLogo` identifies the selected provider or harness. It must not masquerade as the Clash persona.
- Radix `Avatar` represents people/presence and image/fallback identity. Provider marks and Clash AgentMotion do not replace it.

## Brand Usage

Clash coral may appear on the logo, primary actions, focus rings, selected states, unread dots, and meaningful status details. It must not tint the page background, card grid, empty previews, or inactive navigation.
