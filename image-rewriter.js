// ==UserScript==
// @name         GHFS Card Image Rewriter
// @namespace    https://gloomhaven.smigiel.us/
// @version      0.5.0
// @description  Replace placeholder ability-card and item-card images on Gloomhaven Full Stack with real images from cmlenius/gloomhaven-card-browser (and optionally self-hosted item scans). Covers Gloomhaven 2e, the official Mercenary packs, and (lower priority) other editions. Handles both the full "normal" card view and the compact "zoom" view used in some panels. Hides the title/level/initiative text overlays on rewritten normal-view cards (since the real artwork already contains them), but leaves the compact label bar visible in zoom view. Tested with Tampermonkey/Violentmonkey on desktop and the "Userscripts" Safari extension on iPad/iOS.
// @match        https://gloomhaven.smigiel.us/*
// @run-at       document-start
// @grant        none
// @homepageURL  https://github.com/earlybard/ghfs-image-rewriter
// @updateURL    https://raw.githubusercontent.com/earlybard/ghfs-image-rewriter/refs/heads/main/image-rewriter.js
// @downloadURL  https://raw.githubusercontent.com/earlybard/ghfs-image-rewriter/refs/heads/main/image-rewriter.js
// ==/UserScript==

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const DEBUG = false; // set true to log every rewrite attempt to the console

  // When true, hide the SVG <text> labels (title, level, initiative) on cards
  // we've rewritten. The placeholder image is blank so GHFS draws those as
  // SVG overlays, but the real cmlenius artwork already has them baked in, so
  // leaving the overlays visible causes the text to render twice. Turn off
  // if you ever find the real artwork hard to read and want the overlay
  // labels back as a fallback.
  const HIDE_OVERLAY_TEXT = true;

  // We use jsDelivr as a CDN front for the cmlenius `images` branch, rather
  // than hitting raw.githubusercontent.com directly. This avoids GitHub's
  // raw-content soft rate limits, gets us proper edge caching, and is faster
  // from outside North America.
  //
  // The GitHub API is still used once (per device, every 7 days) to enumerate
  // every ability-card filename in the branch — that's well within GitHub's
  // 60-requests-per-hour unauthenticated API limit.
  const CMLENIUS_TREE_URL =
    'https://api.github.com/repos/cmlenius/gloomhaven-card-browser/git/trees/images?recursive=1';
  const CMLENIUS_IMG_BASE =
    'https://cdn.jsdelivr.net/gh/cmlenius/gloomhaven-card-browser@images';

  // Where your own GH2e item scans live, once you've hosted them.
  // Example: 'https://your-github-user.github.io/gh2e-items'
  // Files should be named with the slugified card name, e.g. 'weathered-boots.jpg'.
  // Leave empty until you've actually got images up there.
  const ITEMS_BASE = '';
  const ITEMS_EXT = 'jpg';
  // Optional explicit allow-list of item slugs you've scanned. If empty, every
  // unknown slug will be tried against ITEMS_BASE (a 404 is harmless but noisy).
  const ITEM_SLUGS = new Set([
    // 'weathered-boots',
    // 'minor-stamina-potion',
  ]);

  // Cache settings (slug map is fetched from GitHub once and reused).
  const CACHE_KEY = 'ghfs-rewriter-cmlenius-map-v3';
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  // Editions to pull ability-card images from, in priority order. When the
  // same slug appears in multiple editions, the earlier one wins. The default
  // covers Gloomhaven 2e plus the official Mercenary character packs (which
  // is what GHFS currently uses for GH2e campaigns).
  //
  // Other editions are included at lower priority as harmless fallbacks: their
  // filenames are prefixed (e.g. `gh-`, `jl-`, `fh-`) so they will only match
  // if the tracker happens to display the card name with that prefix, which
  // it doesn't in the GH2e-campaign codepath. Drop or reorder this list if
  // you ever play a different edition through GHFS.
  const EDITION_PRIORITY = [
    'gloomhaven-2nd-edition',
    'mercenary',
    'frosthaven',
    'gloomhaven',
    'jaws-of-the-lion',
    'forgotten-circles',
    'crimson-scales',
    'trail-of-ashes',
    'custom-content',
  ];

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------
  const log = (...a) => { if (DEBUG) console.log('[GHFS-rewrite]', ...a); };

  // Matches the placeholder URL pattern: /public/images/byid/9126.image.webp
  const PLACEHOLDER_RE = /\/public\/images\/byid\/\d+\.image\.webp(\?.*)?$/;

  // slug -> absolute image URL (built from cmlenius file tree)
  const slugMap = new Map();
  // Track elements we've already rewritten so attribute mutations don't loop.
  const handled = new WeakSet();

  // Slugify a card name to match cmlenius's filenames.
  // Their convention: lowercase, alphanumerics + hyphens, apostrophes stripped.
  const slugify = (name) =>
    name
      .toLowerCase()
      .replace(/['\u2018\u2019]/g, '')      // strip straight and curly apostrophes
      .replace(/[^a-z0-9]+/g, '-')          // non-alnum runs -> single hyphen
      .replace(/^-|-$/g, '');               // trim leading/trailing hyphens

  // -------------------- Build the ability-card slug map --------------------
  async function buildAbilityMap() {
    // Try localStorage cache first.
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached && Date.now() - cached.ts < CACHE_TTL_MS && Array.isArray(cached.entries)) {
          for (const [slug, url] of cached.entries) slugMap.set(slug, url);
          log('Loaded', cached.entries.length, 'cached entries');
          return;
        }
      }
    } catch (e) { /* fall through to fetch */ }

    // Fetch fresh.
    try {
      const res = await fetch(CMLENIUS_TREE_URL, { credentials: 'omit' });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const data = await res.json();

      // Matches: images/character-ability-cards/<edition>/<CLASS>/<slug>.(jpeg|jpg|png|webp)
      // Captures: edition, class code (unused), slug, extension (unused).
      const pathRe =
        /^images\/character-ability-cards\/([a-z0-9-]+)\/[A-Z0-9]+\/([a-z0-9-]+)\.(jpeg|jpg|png|webp)$/;

      // Bucket matches by edition so we can apply priority order.
      const byEdition = new Map(); // edition -> Array<[slug, url]>
      for (const entry of data.tree || []) {
        if (entry.type !== 'blob') continue;
        const m = entry.path.match(pathRe);
        if (!m) continue;
        const [, edition, slug] = m;
        const url = `${CMLENIUS_IMG_BASE}/${entry.path}`;
        if (!byEdition.has(edition)) byEdition.set(edition, []);
        byEdition.get(edition).push([slug, url, entry.path]);
      }

      // Walk editions in priority order; first slug-write wins.
      const entries = [];
      const collisions = new Map(); // slug -> [{edition, path}, ...] for visibility
      const order = [
        ...EDITION_PRIORITY,
        // Catch any editions that exist in the repo but weren't in the priority list.
        ...[...byEdition.keys()].filter((e) => !EDITION_PRIORITY.includes(e)),
      ];
      for (const edition of order) {
        const bucket = byEdition.get(edition);
        if (!bucket) continue;
        for (const [slug, url, path] of bucket) {
          if (slugMap.has(slug)) {
            if (!collisions.has(slug)) {
              collisions.set(slug, [{ edition: '(winner)', path: slugMap.get(slug) }]);
            }
            collisions.get(slug).push({ edition, path });
            continue;
          }
          slugMap.set(slug, url);
          entries.push([slug, url]);
        }
      }
      if (collisions.size) {
        console.warn(
          '[GHFS-rewrite] slug collisions across editions (winner kept, others ignored):',
          Object.fromEntries(collisions),
        );
      }
      log('Built map with', entries.length, 'ability-card entries across',
          byEdition.size, 'editions');
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), entries }));
    } catch (e) {
      console.warn('[GHFS-rewrite] Failed to build cmlenius map:', e);
    }
  }

  // -------------------- Item URL resolver --------------------
  function maybeItemUrl(slug) {
    if (!ITEMS_BASE) return null;
    if (ITEM_SLUGS.size && !ITEM_SLUGS.has(slug)) return null;
    return `${ITEMS_BASE}/${slug}.${ITEMS_EXT}`;
  }

  // -------------------- DOM rewriting --------------------
  function findCardName(svgImage) {
    const svg = svgImage.ownerSVGElement || svgImage.closest('svg');
    if (!svg) return null;

    // Only consider direct-child <text> elements. Nested <text> inside
    // enhancement stickers (<svg class="icon"> with a numeric label) or
    // status badges (zoom view's "D" indicator etc.) is never the card title.
    const directTexts = [...svg.children].filter((c) => c.localName === 'text');

    // Preferred path: the full "normal" card view styles the title with
    // font-family: GermaniaOne. That's the unambiguous title.
    for (const t of directTexts) {
      const ff = (t.getAttribute('style') || '').match(/font-family:\s*([^;]+)/i);
      if (ff && /GermaniaOne/i.test(ff[1])) {
        const txt = t.textContent.trim();
        if (txt) return txt;
      }
    }

    // Fallback path: the compact "zoom" view renders the name in a header
    // strip without GermaniaOne styling, typically as "<level> <name>" (e.g.
    // "5 Arresting March"). Skip pure-numeric/level-marker text (the standalone
    // level and initiative texts in normal view), then strip any leading
    // "<digits> " or "X " prefix before returning.
    for (const t of directTexts) {
      let txt = t.textContent.trim();
      if (!txt || txt.length < 2) continue;
      if (/^(\d+|X)$/i.test(txt)) continue;
      txt = txt.replace(/^(\d+|X)\s+/i, '');
      if (txt) return txt;
    }

    return null;
  }

  function tryRewrite(el) {
    if (handled.has(el)) return;
    const href =
      el.getAttribute('href') ||
      el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (!href || !PLACEHOLDER_RE.test(href)) return;

    const svg = el.ownerSVGElement || el.closest('svg');
    const name = findCardName(el);
    if (!name) { log('no name for', href); return; }

    const slug = slugify(name);
    const url = slugMap.get(slug) || maybeItemUrl(slug);
    if (!url) {
      log('no mapping for', name, '(slug:', slug, ')');
      // If this SVG was previously rewritten to a different card, make sure
      // the text overlay is visible again now that we're back to a placeholder
      // we can't resolve.
      if (svg) svg.removeAttribute('data-ghfs-rewritten');
      return;
    }

    handled.add(el);
    el.setAttribute('href', url);
    if (svg) svg.setAttribute('data-ghfs-rewritten', '1');
    log('rewrote', name, '->', url);
  }

  function scanSubtree(root) {
    if (!root || root.nodeType !== 1) return;
    // Match SVG <image> elements only.
    if (root.localName === 'image' && root.namespaceURI === 'http://www.w3.org/2000/svg') {
      tryRewrite(root);
    }
    if (root.querySelectorAll) {
      // Querying by tag matches both HTML and SVG <image>; tryRewrite ignores non-SVG.
      root.querySelectorAll('image').forEach(tryRewrite);
    }
  }

  // -------------------- Observer wiring --------------------
  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') {
        m.addedNodes.forEach(scanSubtree);
      } else if (m.type === 'attributes' && m.target.localName === 'image') {
        // href just changed; allow re-evaluation in case the element is reused.
        handled.delete(m.target);
        tryRewrite(m.target);
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href'],
  });

  // -------------------- Kick off --------------------

  // Inject the overlay-hiding stylesheet. Marked SVGs (data-ghfs-rewritten="1")
  // get their direct-child <text> elements hidden -- those are the title,
  // level, and initiative overlays drawn over the placeholder. The selector
  // is scoped to `svg.normal` so it only hides overlays in the full card view;
  // the compact "zoom" view's header label (e.g. "5 Arresting March") stays
  // visible because it conveys level info that's useful at small sizes.
  //
  // The direct-child combinator (`>`) is important: it prevents the rule from
  // hiding <text> inside nested SVGs (enhancement stickers, status icons),
  // which we always want to keep visible.
  //
  // Uses !important so it wins against any inline style Svelte sets on the
  // text elements during re-render.
  if (HIDE_OVERLAY_TEXT) {
    const overlayStyle = document.createElement('style');
    overlayStyle.textContent =
      'svg.normal[data-ghfs-rewritten="1"] > text { display: none !important; }';
    document.documentElement.appendChild(overlayStyle);
  }

  buildAbilityMap().then(() => {
    // The app may have inserted card SVGs while we were fetching the map.
    scanSubtree(document.documentElement);
  });
})();
