type ExplorerMode = "wiki" | "versions";

interface ExplorerPageOptions {
  mode: ExplorerMode;
  pageTitle: string;
  heroTitle: string;
  heroDescription: string;
  filterLabel: string;
  filterOptions: Array<{ value: string; label: string }>;
  searchPlaceholder: string;
  listDefaultSubtitle: string;
  primaryPanelTitle: string;
  primaryPanelSubtitle: string;
  secondaryPanelTitle: string;
  secondaryPanelSubtitle: string;
  dataPath: string;
}

const BASE_STYLES = `
      :root {
        color-scheme: light;
        --page: oklch(0.97 0.012 96);
        --page-strong: oklch(0.93 0.02 96);
        --panel: oklch(0.995 0.004 90);
        --panel-muted: oklch(0.985 0.008 96);
        --border: oklch(0.84 0.02 88);
        --text: oklch(0.28 0.03 88);
        --muted: oklch(0.48 0.025 88);
        --accent: oklch(0.58 0.11 145);
        --accent-soft: oklch(0.9 0.05 145);
        --warning: oklch(0.68 0.14 72);
        --warning-soft: oklch(0.93 0.03 72);
        --danger: oklch(0.63 0.16 28);
        --danger-soft: oklch(0.93 0.03 28);
        --shadow: 0 16px 48px color-mix(in oklab, var(--text) 8%, transparent);
        font-family: "Avenir Next", "Segoe UI", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, color-mix(in oklab, var(--accent-soft) 65%, transparent) 0, transparent 32%),
          linear-gradient(180deg, var(--page) 0%, var(--page-strong) 100%);
        color: var(--text);
      }

      a {
        color: inherit;
        text-decoration: none;
      }

      button,
      input,
      select {
        font: inherit;
      }

      .shell {
        min-height: 100vh;
        display: grid;
        grid-template-rows: auto auto auto 1fr;
      }

      .hero {
        padding: clamp(1.25rem, 2vw, 2rem) clamp(1rem, 2.4vw, 2.5rem) 0;
      }

      .top-nav {
        display: flex;
        flex-wrap: wrap;
        gap: 0.6rem;
        margin-bottom: 1rem;
      }

      .nav-link {
        display: inline-flex;
        align-items: center;
        min-height: 2.4rem;
        padding: 0.5rem 0.85rem;
        border-radius: 999px;
        background: color-mix(in oklab, var(--panel) 82%, white 18%);
        border: 1px solid var(--border);
        color: var(--muted);
        box-shadow: var(--shadow);
      }

      .nav-link.is-active {
        background: color-mix(in oklab, var(--accent-soft) 55%, white 45%);
        color: color-mix(in oklab, var(--accent) 72%, black 28%);
        border-color: color-mix(in oklab, var(--accent) 36%, white 64%);
      }

      .hero h1 {
        margin: 0;
        font-size: clamp(1.7rem, 3vw, 2.6rem);
        font-weight: 700;
        letter-spacing: -0.03em;
      }

      .hero p {
        margin: 0.5rem 0 0;
        max-width: 68ch;
        color: var(--muted);
        line-height: 1.5;
      }

      .controls {
        position: sticky;
        top: 0;
        z-index: 10;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
        gap: 0.75rem;
        padding: 1rem clamp(1rem, 2.4vw, 2.5rem);
        background: color-mix(in oklab, var(--page) 85%, white 15%);
        backdrop-filter: blur(14px);
        border-bottom: 1px solid color-mix(in oklab, var(--border) 70%, white 30%);
      }

      .field {
        display: grid;
        gap: 0.35rem;
      }

      .field label {
        font-size: 0.8rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .field select,
      .field input {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 0.9rem;
        background: color-mix(in oklab, var(--panel) 88%, white 12%);
        color: var(--text);
        padding: 0.75rem 0.9rem;
        min-height: 2.8rem;
      }

      .summary,
      .coverage,
      .workspace,
      .landing-grid {
        padding-inline: clamp(1rem, 2.4vw, 2.5rem);
      }

      .summary,
      .landing-grid {
        padding-top: 1rem;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
        gap: 0.8rem;
      }

      .metric,
      .link-card,
      .coverage-group,
      .list-panel,
      .detail-panel {
        background: color-mix(in oklab, var(--panel) 90%, white 10%);
        border: 1px solid var(--border);
        border-radius: 1rem;
        box-shadow: var(--shadow);
      }

      .metric {
        padding: 1rem 1.05rem;
      }

      .metric strong {
        display: block;
        font-size: 1.6rem;
        letter-spacing: -0.04em;
      }

      .metric span {
        display: block;
        margin-top: 0.25rem;
        color: var(--muted);
        line-height: 1.4;
      }

      .coverage {
        padding-top: 0.8rem;
        display: grid;
        gap: 0.75rem;
      }

      .coverage-group {
        padding: 0.95rem 1rem;
      }

      .coverage-group h2,
      .link-card h2 {
        margin: 0 0 0.65rem;
        font-size: 0.95rem;
        letter-spacing: 0.01em;
      }

      .chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.45rem;
      }

      .chip {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        background: var(--panel-muted);
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 0.35rem 0.7rem;
        font-size: 0.86rem;
        color: var(--muted);
      }

      .workspace {
        padding-top: 1rem;
        padding-bottom: 1.4rem;
        display: grid;
        grid-template-columns: minmax(18rem, 22rem) minmax(0, 1fr);
        gap: 1rem;
        align-items: start;
      }

      .list-panel,
      .detail-panel {
        border-radius: 1.15rem;
      }

      .list-panel {
        overflow: hidden;
      }

      .list-panel header,
      .detail-panel header {
        padding: 1rem 1rem 0.75rem;
        border-bottom: 1px solid color-mix(in oklab, var(--border) 72%, white 28%);
      }

      .list-panel h2,
      .detail-panel h2 {
        margin: 0;
        font-size: 1rem;
      }

      .list-panel p,
      .detail-panel p,
      .link-card p {
        margin: 0.35rem 0 0;
        color: var(--muted);
        line-height: 1.45;
      }

      .detail-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 1rem;
      }

      .landing-grid {
        padding-bottom: 2rem;
      }

      .link-card {
        padding: 1rem 1.05rem;
        transition: transform 180ms ease, border-color 180ms ease;
      }

      .link-card:hover,
      .link-card:focus-visible {
        transform: translateY(-2px);
        border-color: color-mix(in oklab, var(--accent) 34%, white 66%);
        outline: none;
      }

      .link-kicker {
        display: inline-flex;
        align-items: center;
        min-height: 2rem;
        margin-top: 1rem;
        color: color-mix(in oklab, var(--accent) 72%, black 28%);
        font-weight: 600;
      }

      .panel-body {
        padding: 0 1rem 1rem;
      }

      .mob-list {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: calc(100vh - 20rem);
        overflow: auto;
      }

      .mob-list li + li {
        border-top: 1px solid color-mix(in oklab, var(--border) 62%, white 38%);
      }

      .mob-button {
        width: 100%;
        border: 0;
        background: transparent;
        color: inherit;
        text-align: left;
        padding: 0.85rem 1rem;
        display: grid;
        gap: 0.35rem;
        cursor: pointer;
      }

      .mob-button:hover,
      .mob-button:focus-visible {
        background: color-mix(in oklab, var(--accent-soft) 38%, white 62%);
        outline: none;
      }

      .mob-button.is-selected {
        background: color-mix(in oklab, var(--accent-soft) 55%, white 45%);
      }

      .mob-topline,
      .info-line {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
      }

      .mob-name {
        font-weight: 600;
      }

      .mob-meta,
      .meta-kicker {
        color: var(--muted);
        font-size: 0.88rem;
      }

      .badge-row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        padding: 0.22rem 0.5rem;
        border-radius: 999px;
        font-size: 0.78rem;
        border: 1px solid transparent;
      }

      .badge-neutral {
        background: var(--panel-muted);
        border-color: var(--border);
        color: var(--muted);
      }

      .badge-added,
      .badge-exact {
        background: var(--accent-soft);
        border-color: color-mix(in oklab, var(--accent) 35%, white 65%);
        color: color-mix(in oklab, var(--accent) 72%, black 28%);
      }

      .badge-changed,
      .badge-partial {
        background: var(--warning-soft);
        border-color: color-mix(in oklab, var(--warning) 38%, white 62%);
        color: color-mix(in oklab, var(--warning) 72%, black 28%);
      }

      .badge-removed,
      .badge-local-only {
        background: var(--danger-soft);
        border-color: color-mix(in oklab, var(--danger) 38%, white 62%);
        color: color-mix(in oklab, var(--danger) 72%, black 28%);
      }

      .badge-unchanged {
        background: var(--panel-muted);
        border-color: var(--border);
        color: var(--muted);
      }

      .section {
        padding-top: 1rem;
        display: grid;
        gap: 0.65rem;
      }

      .section h3 {
        margin: 0;
        font-size: 0.94rem;
      }

      .key-value {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.55rem;
      }

      .kv {
        background: var(--panel-muted);
        border: 1px solid var(--border);
        border-radius: 0.9rem;
        padding: 0.75rem;
      }

      .kv strong {
        display: block;
        font-size: 0.8rem;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .kv span {
        display: block;
        margin-top: 0.35rem;
        line-height: 1.45;
      }

      .details-group {
        border: 1px solid var(--border);
        border-radius: 0.95rem;
        background: var(--panel-muted);
        overflow: hidden;
      }

      .details-group summary {
        cursor: pointer;
        list-style: none;
        padding: 0.8rem 0.95rem;
        font-weight: 600;
      }

      .details-group summary::-webkit-details-marker {
        display: none;
      }

      .details-content {
        border-top: 1px solid color-mix(in oklab, var(--border) 72%, white 28%);
        padding: 0.8rem 0.95rem 0.95rem;
        display: grid;
        gap: 0.75rem;
      }

      .variant-list,
      .simple-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.6rem;
      }

      .variant-item,
      .simple-item {
        background: color-mix(in oklab, var(--panel) 85%, white 15%);
        border: 1px solid var(--border);
        border-radius: 0.9rem;
        padding: 0.75rem;
        display: grid;
        gap: 0.45rem;
      }

      .variant-item audio,
      .simple-item audio {
        width: 100%;
      }

      .empty,
      .status {
        border: 1px dashed var(--border);
        border-radius: 0.95rem;
        padding: 1rem;
        color: var(--muted);
        background: color-mix(in oklab, var(--panel) 78%, white 22%);
      }

      .status.is-error {
        border-style: solid;
        border-color: color-mix(in oklab, var(--danger) 40%, white 60%);
        color: color-mix(in oklab, var(--danger) 70%, black 30%);
        background: var(--danger-soft);
      }

      .status.is-loading {
        border-style: solid;
        background: var(--accent-soft);
        color: color-mix(in oklab, var(--accent) 72%, black 28%);
      }

      .small {
        font-size: 0.86rem;
      }

      @media (max-width: 1100px) {
        .detail-grid {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 820px) {
        .workspace {
          grid-template-columns: 1fr;
        }

        .mob-list {
          max-height: none;
        }
      }
`;

export function renderMobSoundExplorerPage(): string {
  return renderMobSoundExplorerLandingPage();
}

export function renderMobSoundExplorerLandingPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>mc-datahub Mob Sound Explorer</title>
    <style>
${BASE_STYLES}
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="hero">
        ${renderTopNav()}
        <h1>Mob Sound Explorer</h1>
        <p>
          Pick the comparison view you want. The wiki explorer focuses on one processed version against the
          saved minecraft.wiki snapshot, while the version explorer stays entirely local and diffs two
          processed datasets.
        </p>
      </section>

      <section class="landing-grid">
        <a class="link-card" href="/mob-sounds/explorer/wiki">
          <h2>Wiki Comparison</h2>
          <p>
            Inspect one version's extracted mob sounds next to the saved minecraft.wiki category alignment,
            coverage gaps, and playable wiki files.
          </p>
          <span class="link-kicker">Open the wiki explorer</span>
        </a>

        <a class="link-card" href="/mob-sounds/explorer/versions">
          <h2>Version Comparison</h2>
          <p>
            Diff two processed versions locally to see which mobs were added, removed, or changed and how
            their sound events shifted between versions.
          </p>
          <span class="link-kicker">Open the version explorer</span>
        </a>
      </section>
    </div>
  </body>
</html>
`;
}

export function renderMobSoundWikiExplorerPage(): string {
  return renderExplorerPage({
    mode: "wiki",
    pageTitle: "mc-datahub Mob Sound Wiki Explorer",
    heroTitle: "Mob Sound Wiki Explorer",
    heroDescription:
      "Review one processed version against the saved minecraft.wiki snapshot to see matched categories, local-only mobs, and any wiki file coverage gaps.",
    filterLabel: "Coverage Filter",
    filterOptions: [
      { value: "all", label: "All mobs" },
      { value: "exact", label: "Exact matches" },
      { value: "partial", label: "Partial matches" },
      { value: "local-only", label: "No wiki match" },
    ],
    searchPlaceholder: "Search mobs, sound ids, or wiki categories",
    listDefaultSubtitle: "Choose a mob to inspect extracted sounds beside the saved wiki category.",
    primaryPanelTitle: "Extracted Data",
    primaryPanelSubtitle: "Sound events and Mojang asset URLs from the selected dataset.",
    secondaryPanelTitle: "Minecraft Wiki",
    secondaryPanelSubtitle: "Matched category coverage plus playable files from the saved wiki snapshot.",
    dataPath: "/mob-sounds/explorer/wiki/data",
  });
}

export function renderMobSoundVersionExplorerPage(): string {
  return renderExplorerPage({
    mode: "versions",
    pageTitle: "mc-datahub Mob Sound Version Explorer",
    heroTitle: "Mob Sound Version Explorer",
    heroDescription:
      "Compare two processed versions locally to see which mobs were added, removed, or changed and where sound events or variants shifted between versions.",
    filterLabel: "Diff Filter",
    filterOptions: [
      { value: "all", label: "All mobs" },
      { value: "added", label: "Added only" },
      { value: "changed", label: "Changed only" },
      { value: "removed", label: "Removed only" },
      { value: "unchanged", label: "Unchanged only" },
    ],
    searchPlaceholder: "Search mobs or sound ids",
    listDefaultSubtitle: "Choose a mob to inspect the current dataset beside the comparison version.",
    primaryPanelTitle: "Current Version",
    primaryPanelSubtitle: "Sound events and asset URLs from the selected version.",
    secondaryPanelTitle: "Compared Version",
    secondaryPanelSubtitle: "The matching mob from the selected comparison dataset, when one exists.",
    dataPath: "/mob-sounds/explorer/versions/data",
  });
}

function renderExplorerPage(options: ExplorerPageOptions): string {
  const clientConfig = JSON.stringify({
    mode: options.mode,
    dataPath: options.dataPath,
    listDefaultSubtitle: options.listDefaultSubtitle,
  });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${options.pageTitle}</title>
    <style>
${BASE_STYLES}
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="hero">
        ${renderTopNav(options.mode)}
        <h1>${options.heroTitle}</h1>
        <p>${options.heroDescription}</p>
      </section>

      <section class="controls">
        <div class="field">
          <label for="version">Version</label>
          <select id="version"></select>
        </div>
        ${
          options.mode === "versions"
            ? `<div class="field">
          <label for="compareTo">Compare To</label>
          <select id="compareTo"></select>
        </div>`
            : ""
        }
        <div class="field">
          <label for="status">${options.filterLabel}</label>
          <select id="status">
            ${options.filterOptions
              .map((filterOption) => `<option value="${filterOption.value}">${filterOption.label}</option>`)
              .join("")}
          </select>
        </div>
        <div class="field">
          <label for="search">Search</label>
          <input id="search" type="search" placeholder="${options.searchPlaceholder}" />
        </div>
      </section>

      <section id="summary" class="summary"></section>
      <section id="coverage" class="coverage" hidden></section>

      <section class="workspace">
        <aside class="list-panel">
          <header>
            <h2 id="listTitle">Mobs</h2>
            <p id="listSubtitle">${options.listDefaultSubtitle}</p>
          </header>
          <div id="listStatus" class="panel-body"></div>
          <ul id="mobList" class="mob-list"></ul>
        </aside>

        <section class="detail-grid">
          <article class="detail-panel">
            <header>
              <h2>${options.primaryPanelTitle}</h2>
              <p>${options.primaryPanelSubtitle}</p>
            </header>
            <div id="primaryPanel" class="panel-body"></div>
          </article>

          <article class="detail-panel">
            <header>
              <h2>${options.secondaryPanelTitle}</h2>
              <p>${options.secondaryPanelSubtitle}</p>
            </header>
            <div id="secondaryPanel" class="panel-body"></div>
          </article>
        </section>
      </section>
    </div>

    ${renderExplorerClientScript(clientConfig)}
  </body>
</html>
`;
}

function renderTopNav(active?: ExplorerMode): string {
  return `<nav class="top-nav">
          <a class="nav-link${!active ? " is-active" : ""}" href="/mob-sounds/explorer">Pick a page</a>
          <a class="nav-link${active === "wiki" ? " is-active" : ""}" href="/mob-sounds/explorer/wiki">Wiki comparison</a>
          <a class="nav-link${active === "versions" ? " is-active" : ""}" href="/mob-sounds/explorer/versions">Version comparison</a>
        </nav>`;
}

function renderExplorerClientScript(clientConfig: string): string {
  return `<script type="module">
      const explorerConfig = ${clientConfig};
      const listTitle = document.getElementById('listTitle');
      const listSubtitle = document.getElementById('listSubtitle');
      const listStatus = document.getElementById('listStatus');
      const versionSelect = document.getElementById('version');
      const compareToSelect = document.getElementById('compareTo');
      const statusSelect = document.getElementById('status');
      const searchInput = document.getElementById('search');
      const summary = document.getElementById('summary');
      const coverage = document.getElementById('coverage');
      const mobList = document.getElementById('mobList');
      const primaryPanel = document.getElementById('primaryPanel');
      const secondaryPanel = document.getElementById('secondaryPanel');

      const params = new URLSearchParams(window.location.search);
      const state = {
        loading: false,
        error: '',
        data: null,
        version: params.get('version') || '',
        compareTo: explorerConfig.mode === 'versions' ? params.get('compareTo') || '' : '',
        status: params.get('status') || 'all',
        search: params.get('q') || '',
        selectedId: params.get('mob') || '',
      };

      statusSelect.value = state.status;
      searchInput.value = state.search;

      versionSelect.addEventListener('change', async function () {
        state.version = versionSelect.value;
        if (state.compareTo === state.version) {
          state.compareTo = '';
        }
        await loadData();
      });

      if (compareToSelect) {
        compareToSelect.addEventListener('change', async function () {
          state.compareTo = compareToSelect.value;
          await loadData();
        });
      }

      statusSelect.addEventListener('change', function () {
        state.status = statusSelect.value;
        render();
      });

      searchInput.addEventListener('input', function () {
        state.search = searchInput.value;
        render();
      });

      async function loadData() {
        state.loading = true;
        state.error = '';
        render();

        const query = new URLSearchParams();
        if (state.version) {
          query.set('version', state.version);
        }
        if (explorerConfig.mode === 'versions' && state.compareTo) {
          query.set('compareTo', state.compareTo);
        }

        try {
          const url = explorerConfig.dataPath + (query.toString() ? '?' + query.toString() : '');
          const response = await fetch(url);
          if (!response.ok) {
            let message = 'Unable to load explorer data.';
            try {
              const body = await response.json();
              if (body && body.error) {
                message = body.error;
              }
            } catch (_error) {
            }
            throw new Error(message);
          }

          state.data = await response.json();
          state.version = state.data.version;
          state.compareTo = explorerConfig.mode === 'versions' ? state.data.compareToVersion || '' : '';
          if (!Array.isArray(state.data.rows)) {
            state.data.rows = [];
          }
          if (!Array.isArray(state.data.localOnlyMobs)) {
            state.data.localOnlyMobs = [];
          }
          if (!Array.isArray(state.data.wikiOnlyCategories)) {
            state.data.wikiOnlyCategories = [];
          }
          ensureSelectedRow();
        } catch (error) {
          state.data = null;
          state.error = error instanceof Error ? error.message : String(error);
        } finally {
          state.loading = false;
          render();
        }
      }

      function render() {
        renderControls();
        renderSummary();
        renderCoverage();
        renderList();
        renderDetails();
        syncUrl();
      }

      function renderControls() {
        const versions = state.data ? state.data.availableVersions : [];
        versionSelect.innerHTML = versions
          .map(function (version) {
            return '<option value="' + escapeAttribute(version) + '">' + escapeHtml(version) + '</option>';
          })
          .join('');
        versionSelect.value = state.version;

        if (compareToSelect) {
          const compareOptions = ['<option value="">Auto previous version</option>']
            .concat(
              versions.map(function (version) {
                return '<option value="' + escapeAttribute(version) + '">' + escapeHtml(version) + '</option>';
              }),
            )
            .join('');
          compareToSelect.innerHTML = compareOptions;
          compareToSelect.value = state.compareTo;
        }

        statusSelect.value = state.status;
        searchInput.value = state.search;
      }

      function renderSummary() {
        if (state.loading) {
          summary.innerHTML = '<div class="status is-loading">Loading explorer data...</div>';
          return;
        }

        if (state.error) {
          summary.innerHTML = '<div class="status is-error">' + escapeHtml(state.error) + '</div>';
          return;
        }

        if (!state.data) {
          summary.innerHTML = '<div class="status">No explorer data loaded.</div>';
          return;
        }

        summary.innerHTML =
          explorerConfig.mode === 'wiki'
            ? renderSummaryCards(buildWikiSummaryCards())
            : renderSummaryCards(buildVersionSummaryCards());
      }

      function buildWikiSummaryCards() {
        return [
          {
            label: 'Extracted mobs',
            value: state.data.summary.mobCount,
            text:
              state.data.summary.soundEventCount +
              ' sound events and ' +
              state.data.summary.soundVariantCount +
              ' sound variants in ' +
              state.data.version,
          },
          {
            label: 'Wiki coverage',
            value: state.data.summary.wikiCategoryCount,
            text:
              state.data.summary.exactCategoryCount +
              ' exact, ' +
              state.data.summary.partialCategoryCount +
              ' partial, ' +
              state.data.summary.wikiOnlyCategoryCount +
              ' wiki-only categories',
          },
          {
            label: 'Coverage gaps',
            value: state.data.summary.localOnlyMobCount,
            text:
              state.data.summary.localOnlyMobCount +
              ' local-only mobs and ' +
              state.data.summary.wikiOnlyCategoryCount +
              ' wiki-only categories',
          },
          {
            label: 'Snapshot',
            value: state.data.rows.length,
            text: state.data.wikiSnapshotFetchedAt
              ? 'Wiki snapshot saved at ' + formatDate(state.data.wikiSnapshotFetchedAt)
              : 'No saved wiki snapshot for this version',
          },
        ];
      }

      function buildVersionSummaryCards() {
        const diff = state.data.summary.diff;
        const compareSummary = summarizeCollection(function (row) {
          return row.compareTo;
        });
        const changedMobCount = diff
          ? diff.addedMobCount + diff.changedMobCount + diff.removedMobCount
          : 0;

        return [
          {
            label: state.data.version,
            value: state.data.summary.mobCount,
            text:
              state.data.summary.soundEventCount +
              ' sound events and ' +
              state.data.summary.soundVariantCount +
              ' sound variants in the selected version',
          },
          {
            label: state.data.compareToVersion || 'Compared version',
            value: state.data.compareToVersion ? compareSummary.mobCount : 0,
            text: state.data.compareToVersion
              ? compareSummary.soundEventCount +
                ' sound events and ' +
                compareSummary.soundVariantCount +
                ' sound variants in ' +
                state.data.compareToVersion
              : 'No earlier processed version is available to compare.',
          },
          {
            label: 'Changed mobs',
            value: changedMobCount,
            text: diff
              ? diff.addedMobCount +
                ' added, ' +
                diff.changedMobCount +
                ' changed, ' +
                diff.removedMobCount +
                ' removed, ' +
                diff.unchangedMobCount +
                ' unchanged'
              : 'Select another processed version to diff against.',
          },
          {
            label: 'Variant delta',
            value: diff ? diff.addedSoundVariantCount + diff.removedSoundVariantCount : 0,
            text: diff
              ? '+' +
                diff.addedSoundVariantCount +
                ' added and -' +
                diff.removedSoundVariantCount +
                ' removed sound variants'
              : 'No version diff is active.',
          },
        ];
      }

      function summarizeCollection(selectMob) {
        if (!state.data) {
          return {
            mobCount: 0,
            soundEventCount: 0,
            soundVariantCount: 0,
          };
        }

        return state.data.rows.reduce(
          function (summaryState, row) {
            const mob = selectMob(row);
            if (!mob) {
              return summaryState;
            }

            summaryState.mobCount += 1;
            summaryState.soundEventCount += mob.soundEventCount;
            summaryState.soundVariantCount += mob.soundVariantCount;
            return summaryState;
          },
          {
            mobCount: 0,
            soundEventCount: 0,
            soundVariantCount: 0,
          },
        );
      }

      function renderSummaryCards(items) {
        return items
          .map(function (item) {
            return (
              '<article class="metric">' +
              '<strong>' + escapeHtml(String(item.value)) + '</strong>' +
              '<span>' + escapeHtml(item.label) + '</span>' +
              '<span>' + escapeHtml(item.text) + '</span>' +
              '</article>'
            );
          })
          .join('');
      }

      function renderCoverage() {
        if (explorerConfig.mode !== 'wiki' || !state.data || state.loading || state.error) {
          coverage.hidden = true;
          coverage.innerHTML = '';
          return;
        }

        coverage.hidden = false;
        coverage.innerHTML =
          renderCoverageGroup(
            'Local-only mobs',
            state.data.localOnlyMobs.map(function (mob) {
              return mob.displayName + ' (' + mob.soundVariantCount + ' variants)';
            }),
          ) +
          renderCoverageGroup(
            'Wiki-only categories',
            state.data.wikiOnlyCategories.map(function (category) {
              return category.displayName + ' (' + category.wikiFileCount + ' files)';
            }),
          );
      }

      function renderCoverageGroup(title, entries) {
        return (
          '<article class="coverage-group">' +
          '<h2>' + escapeHtml(title) + '</h2>' +
          (entries.length
            ? '<div class="chip-row">' +
              entries
                .map(function (entry) {
                  return '<span class="chip">' + escapeHtml(entry) + '</span>';
                })
                .join('') +
              '</div>'
            : '<div class="empty small">None for the selected version.</div>') +
          '</article>'
        );
      }

      function renderList() {
        const filteredRows = getFilteredRows();
        ensureSelectedRow(filteredRows);

        listTitle.textContent = state.data
          ? explorerConfig.mode === 'versions' && state.data.compareToVersion
            ? 'Mobs in ' + state.data.version + ' vs ' + state.data.compareToVersion
            : 'Mobs in ' + state.data.version
          : 'Mobs';
        listSubtitle.textContent = state.data
          ? filteredRows.length + ' of ' + state.data.rows.length + ' rows shown'
          : explorerConfig.listDefaultSubtitle;

        if (state.loading) {
          listStatus.innerHTML = '<div class="status is-loading">Loading rows...</div>';
          mobList.innerHTML = '';
          return;
        }

        if (state.error) {
          listStatus.innerHTML = '<div class="status is-error">' + escapeHtml(state.error) + '</div>';
          mobList.innerHTML = '';
          return;
        }

        listStatus.innerHTML = '';

        if (!filteredRows.length) {
          mobList.innerHTML = '';
          listStatus.innerHTML = '<div class="empty">No mobs match the current filters.</div>';
          return;
        }

        mobList.innerHTML = filteredRows
          .map(function (row) {
            return explorerConfig.mode === 'wiki' ? renderWikiListRow(row) : renderVersionListRow(row);
          })
          .join('');

        Array.from(document.querySelectorAll('[data-row-id]')).forEach(function (element) {
          element.addEventListener('click', function () {
            state.selectedId = element.getAttribute('data-row-id') || '';
            render();
          });
        });
      }

      function renderWikiListRow(row) {
        const selectedClass = row.id === state.selectedId ? ' is-selected' : '';
        const mob = row.current || row.compareTo;
        const wikiStatus = getWikiStatus(row);

        return (
          '<li>' +
          '<button class="mob-button' + selectedClass + '" data-row-id="' + escapeAttribute(row.id) + '">' +
          '<div class="mob-topline">' +
          '<span class="mob-name">' + escapeHtml(row.displayName) + '</span>' +
          renderStatusBadge(wikiStatus, getWikiStatusLabel(wikiStatus)) +
          '</div>' +
          '<div class="mob-meta">' +
          escapeHtml(mob ? mob.localId : row.id) +
          ' · ' +
          escapeHtml(
            mob
              ? mob.soundEventCount + ' events / ' + mob.soundVariantCount + ' variants'
              : 'no extracted sounds',
          ) +
          '</div>' +
          '<div class="badge-row">' +
          (row.wiki
            ? renderNeutralBadge(row.wiki.matchType + ' mapping') +
              renderNeutralBadge(row.wiki.wikiFileCount + ' wiki files') +
              (row.wiki.unmatchedLocalSoundPaths.length
                ? renderNeutralBadge(row.wiki.unmatchedLocalSoundPaths.length + ' local-only sounds')
                : '')
            : renderNeutralBadge('no wiki category')) +
          '</div>' +
          '</button>' +
          '</li>'
        );
      }

      function renderVersionListRow(row) {
        const selectedClass = row.id === state.selectedId ? ' is-selected' : '';
        const mob = row.current || row.compareTo;

        return (
          '<li>' +
          '<button class="mob-button' + selectedClass + '" data-row-id="' + escapeAttribute(row.id) + '">' +
          '<div class="mob-topline">' +
          '<span class="mob-name">' + escapeHtml(row.displayName) + '</span>' +
          renderStatusBadge(row.status, row.status) +
          '</div>' +
          '<div class="mob-meta">' +
          escapeHtml(mob ? mob.localId : row.id) +
          ' · ' +
          escapeHtml(
            row.current
              ? row.current.soundEventCount + ' events / ' + row.current.soundVariantCount + ' variants'
              : row.compareTo
                ? 'missing in ' + state.data.version
                : 'no extracted sounds',
          ) +
          '</div>' +
          '<div class="badge-row">' +
          (row.diff && row.diff.addedSoundPaths.length
            ? renderNeutralBadge('+' + row.diff.addedSoundPaths.length + ' sounds')
            : '') +
          (row.diff && row.diff.removedSoundPaths.length
            ? renderNeutralBadge('-' + row.diff.removedSoundPaths.length + ' sounds')
            : '') +
          (row.diff && row.diff.metadataChanged ? renderNeutralBadge('metadata changed') : '') +
          '</div>' +
          '</button>' +
          '</li>'
        );
      }

      function renderDetails() {
        if (state.loading) {
          primaryPanel.innerHTML = '<div class="status is-loading">Loading details...</div>';
          secondaryPanel.innerHTML = '<div class="status is-loading">Loading details...</div>';
          return;
        }

        if (state.error) {
          primaryPanel.innerHTML = '<div class="status is-error">' + escapeHtml(state.error) + '</div>';
          secondaryPanel.innerHTML = '<div class="status is-error">' + escapeHtml(state.error) + '</div>';
          return;
        }

        const row = getSelectedRow();
        if (!row) {
          primaryPanel.innerHTML = '<div class="empty">Select a mob from the left to inspect it.</div>';
          secondaryPanel.innerHTML =
            explorerConfig.mode === 'wiki'
              ? '<div class="empty">Select a mob from the left to inspect its matched wiki category.</div>'
              : '<div class="empty">Select a mob from the left to inspect the comparison version.</div>';
          return;
        }

        primaryPanel.innerHTML =
          explorerConfig.mode === 'wiki' ? renderWikiPrimaryPanel(row) : renderVersionPrimaryPanel(row);
        secondaryPanel.innerHTML =
          explorerConfig.mode === 'wiki' ? renderWikiSecondaryPanel(row) : renderVersionSecondaryPanel(row);
      }

      function renderWikiPrimaryPanel(row) {
        const mob = row.current || row.compareTo;
        if (!mob) {
          return '<div class="empty">No extracted sound metadata is available for this mob.</div>';
        }

        return (
          '<section class="section">' +
          '<div class="info-line"><div>' +
          '<h3>' + escapeHtml(row.displayName) + '</h3>' +
          '<p class="meta-kicker">' + escapeHtml(mob.id) + '</p>' +
          '</div>' +
          renderStatusBadge(getWikiStatus(row), getWikiStatusLabel(getWikiStatus(row))) +
          '</div>' +
          '</section>' +
          '<section class="section">' +
          '<h3>' + escapeHtml(state.data.version) + '</h3>' +
          renderMobMeta(mob) +
          renderSoundEventGroups(mob.soundEvents) +
          '</section>'
        );
      }

      function renderVersionPrimaryPanel(row) {
        const parts = [];
        parts.push('<section class="section">');
        parts.push('<div class="info-line"><div>');
        parts.push('<h3>' + escapeHtml(row.displayName) + '</h3>');
        parts.push(
          '<p class="meta-kicker">' +
            escapeHtml(row.current ? row.current.id : row.compareTo ? row.compareTo.id : row.id) +
            '</p>',
        );
        parts.push('</div>' + renderStatusBadge(row.status, row.status) + '</div>');
        parts.push('</section>');

        if (row.diff && state.data.compareToVersion) {
          parts.push('<section class="section">');
          parts.push('<h3>Diff</h3>');
          parts.push('<div class="chip-row">');
          parts.push(
            renderNeutralChip('+' + row.diff.addedEventIds.length + ' events') +
              renderNeutralChip('-' + row.diff.removedEventIds.length + ' events') +
              renderNeutralChip('+' + row.diff.addedSoundPaths.length + ' sounds') +
              renderNeutralChip('-' + row.diff.removedSoundPaths.length + ' sounds') +
              (row.diff.metadataChanged ? renderNeutralChip('metadata changed') : ''),
          );
          parts.push('</div>');
          parts.push('</section>');
        }

        if (row.current) {
          parts.push('<section class="section">');
          parts.push('<h3>' + escapeHtml(state.data.version) + '</h3>');
          parts.push(renderMobMeta(row.current));
          parts.push(renderSoundEventGroups(row.current.soundEvents));
          parts.push('</section>');
        } else {
          parts.push(
            '<section class="section"><div class="empty">This mob is not present in ' +
              escapeHtml(state.data.version) +
              '.</div></section>',
          );
        }

        return parts.join('');
      }

      function renderWikiSecondaryPanel(row) {
        const parts = [];

        if (!row.wiki) {
          parts.push('<section class="section">');
          parts.push(
            '<div class="empty">No matched minecraft.wiki category is saved for this mob in ' +
              escapeHtml(state.data.version) +
              '.</div>',
          );
          parts.push('</section>');
          return parts.join('');
        }

        parts.push('<section class="section">');
        parts.push('<div class="info-line"><div>');
        parts.push('<h3>' + escapeHtml(row.wiki.displayName) + '</h3>');
        parts.push(
          '<p class="meta-kicker"><a href="' +
            escapeAttribute(row.wiki.url) +
            '" target="_blank" rel="noreferrer">Open wiki category</a></p>',
        );
        parts.push('</div>' + renderNeutralBadge(row.wiki.coverage + ' coverage') + '</div>');
        parts.push('</section>');

        parts.push('<section class="section">');
        parts.push('<h3>Coverage</h3>');
        parts.push(
          '<div class="key-value">' +
            renderKv('Files', row.wiki.wikiFileCount + ' wiki / ' + row.wiki.matchedFileCount + ' matched') +
            renderKv('Match type', row.wiki.matchType) +
            renderKv('Mapped mobs', row.wiki.mappedMobDisplayNames.join(', ') || 'None') +
            renderKv('Snapshot', state.data.wikiSnapshotFetchedAt ? formatDate(state.data.wikiSnapshotFetchedAt) : 'Missing') +
          '</div>',
        );
        parts.push('</section>');

        parts.push('<section class="section">');
        parts.push('<h3>Wiki Files</h3>');
        parts.push(
          row.wiki.files.length
            ? '<ul class="simple-list">' +
                row.wiki.files
                  .map(function (file) {
                    return (
                      '<li class="simple-item">' +
                      '<div class="mob-topline"><strong>' + escapeHtml(file.fileName) + '</strong>' +
                      '<span class="meta-kicker">' +
                      escapeHtml(
                        [
                          file.durationSeconds ? file.durationSeconds + 's' : '',
                          typeof file.size === 'number' ? formatBytes(file.size) : '',
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'wiki file',
                      ) +
                      '</span></div>' +
                      '<audio controls preload="none" src="' + escapeAttribute(file.url) + '"></audio>' +
                      '<a class="small" href="' +
                        escapeAttribute(file.descriptionUrl) +
                        '" target="_blank" rel="noreferrer">Open file page</a>' +
                      '</li>'
                    );
                  })
                  .join('') +
              '</ul>'
            : '<div class="empty">No saved wiki files for this category.</div>',
        );
        parts.push('</section>');

        parts.push('<section class="section">');
        parts.push('<h3>Unmatched</h3>');
        parts.push(
          '<div class="key-value">' +
            renderKv('Wiki-only files', row.wiki.unmatchedWikiFileTitles.join(', ') || 'None') +
            renderKv('Local-only sounds', row.wiki.unmatchedLocalSoundPaths.join(', ') || 'None') +
          '</div>',
        );
        parts.push('</section>');

        return parts.join('');
      }

      function renderVersionSecondaryPanel(row) {
        if (!state.data.compareToVersion) {
          return '<div class="empty">No comparison version is active for this request.</div>';
        }

        if (!row.compareTo) {
          return (
            '<div class="empty">This mob does not exist in ' +
            escapeHtml(state.data.compareToVersion) +
            '.</div>'
          );
        }

        return (
          '<section class="section">' +
          '<div class="info-line"><div>' +
          '<h3>' + escapeHtml(row.displayName) + '</h3>' +
          '<p class="meta-kicker">' + escapeHtml(row.compareTo.id) + '</p>' +
          '</div>' +
          renderNeutralBadge(state.data.compareToVersion) +
          '</div>' +
          '</section>' +
          '<section class="section">' +
          '<h3>' + escapeHtml(state.data.compareToVersion) + '</h3>' +
          renderMobMeta(row.compareTo) +
          renderSoundEventGroups(row.compareTo.soundEvents) +
          '</section>'
        );
      }

      function renderMobMeta(mob) {
        return (
          '<div class="key-value">' +
          renderKv('Display name', mob.displayName) +
          renderKv('Sound id', mob.soundId) +
          renderKv('Category', mob.category) +
          renderKv('Mob category', mob.mobCategory) +
          renderKv('Events', String(mob.soundEventCount)) +
          renderKv('Variants', String(mob.soundVariantCount)) +
          '</div>'
        );
      }

      function renderSoundEventGroups(soundEvents) {
        if (!soundEvents.length) {
          return '<div class="empty">No sound events are available for this mob.</div>';
        }

        return soundEvents
          .map(function (soundEvent) {
            return (
              '<details class="details-group">' +
              '<summary>' +
              escapeHtml(soundEvent.id) +
              ' <span class="meta-kicker">(' +
              escapeHtml(String(soundEvent.variants.length)) +
              ' variants)</span></summary>' +
              '<div class="details-content">' +
              (soundEvent.subtitle ? '<div class="small">Subtitle: ' + escapeHtml(soundEvent.subtitle) + '</div>' : '') +
              '<ul class="variant-list">' +
              soundEvent.variants
                .map(function (variant) {
                  return (
                    '<li class="variant-item">' +
                    '<div class="mob-topline"><strong>' + escapeHtml(variant.soundPath) + '</strong>' +
                    '<span class="meta-kicker">' +
                    escapeHtml(
                      [
                        typeof variant.size === 'number' ? formatBytes(variant.size) : '',
                        variant.volume !== undefined ? 'vol ' + variant.volume : '',
                        variant.pitch !== undefined ? 'pitch ' + variant.pitch : '',
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    ) +
                    '</span></div>' +
                    '<audio controls preload="none" src="' + escapeAttribute(variant.url) + '"></audio>' +
                    '<div class="small">' + escapeHtml(variant.assetPath) + '</div>' +
                    '</li>'
                  );
                })
                .join('') +
              '</ul>' +
              '</div>' +
              '</details>'
            );
          })
          .join('');
      }

      function renderKv(label, value) {
        return (
          '<div class="kv"><strong>' +
          escapeHtml(label) +
          '</strong><span>' +
          escapeHtml(value || 'None') +
          '</span></div>'
        );
      }

      function getFilteredRows() {
        if (!state.data) {
          return [];
        }

        const query = state.search.trim().toLowerCase();
        return state.data.rows.filter(function (row) {
          const rowStatus = explorerConfig.mode === 'wiki' ? getWikiStatus(row) : row.status;
          if (state.status !== 'all' && rowStatus !== state.status) {
            return false;
          }

          if (!query) {
            return true;
          }

          const values =
            explorerConfig.mode === 'wiki'
              ? [
                  row.displayName,
                  row.id,
                  row.current ? row.current.localId : '',
                  row.current ? row.current.soundId : '',
                  row.wiki ? row.wiki.displayName : '',
                  row.wiki ? row.wiki.id : '',
                  row.wiki ? row.wiki.title : '',
                ]
              : [
                  row.displayName,
                  row.id,
                  row.current ? row.current.localId : '',
                  row.current ? row.current.soundId : '',
                  row.compareTo ? row.compareTo.localId : '',
                  row.compareTo ? row.compareTo.soundId : '',
                ];

          return values.join(' ').toLowerCase().includes(query);
        });
      }

      function getSelectedRow() {
        if (!state.data) {
          return null;
        }

        const filteredRows = getFilteredRows();
        return filteredRows.find(function (row) {
          return row.id === state.selectedId;
        }) || filteredRows[0] || null;
      }

      function ensureSelectedRow(filteredRows) {
        const rows = filteredRows || getFilteredRows();
        if (!rows.length) {
          state.selectedId = '';
          return;
        }

        const selectedStillVisible = rows.some(function (row) {
          return row.id === state.selectedId;
        });
        if (!selectedStillVisible) {
          state.selectedId = rows[0].id;
        }
      }

      function getWikiStatus(row) {
        if (!row.wiki) {
          return 'local-only';
        }

        return row.wiki.coverage === 'partial' ? 'partial' : 'exact';
      }

      function getWikiStatusLabel(status) {
        if (status === 'local-only') {
          return 'no wiki match';
        }

        return status;
      }

      function syncUrl() {
        const query = new URLSearchParams();
        if (state.version) {
          query.set('version', state.version);
        }
        if (explorerConfig.mode === 'versions' && state.compareTo) {
          query.set('compareTo', state.compareTo);
        }
        if (state.status && state.status !== 'all') {
          query.set('status', state.status);
        }
        if (state.search) {
          query.set('q', state.search);
        }
        if (state.selectedId) {
          query.set('mob', state.selectedId);
        }
        const next = window.location.pathname + (query.toString() ? '?' + query.toString() : '');
        window.history.replaceState(null, '', next);
      }

      function renderStatusBadge(status, label) {
        return '<span class="badge badge-' + escapeAttribute(status) + '">' + escapeHtml(label || status) + '</span>';
      }

      function renderNeutralBadge(label) {
        return '<span class="badge badge-neutral">' + escapeHtml(label) + '</span>';
      }

      function renderNeutralChip(label) {
        return '<span class="chip">' + escapeHtml(label) + '</span>';
      }

      function formatBytes(value) {
        if (value < 1024) {
          return value + ' B';
        }
        if (value < 1024 * 1024) {
          return (value / 1024).toFixed(1) + ' KB';
        }
        return (value / (1024 * 1024)).toFixed(1) + ' MB';
      }

      function formatDate(value) {
        try {
          return new Date(value).toLocaleString();
        } catch (_error) {
          return value;
        }
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function escapeAttribute(value) {
        return escapeHtml(value);
      }

      loadData();
    </script>`;
}
