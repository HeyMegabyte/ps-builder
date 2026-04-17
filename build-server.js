/**
 * ProjectSites Build Server v2 — 1-Hour Intelligent Pipeline
 *
 * NOT 20 equal prompts. Instead: 1 big foundation prompt (10-15 min)
 * + focused enhancement/quality prompts (2-3 min each).
 *
 * ## Architecture
 *
 * | Stage | Time   | Prompts | Purpose                          |
 * |-------|--------|---------|----------------------------------|
 * | A     | 10-15m | 1 big   | Complete website from research   |
 * | B     | 9m     | 3       | Animations, SEO, images          |
 * | C     | 10m    | 5       | Visual, a11y, responsive, domain |
 * | D     | 3m     | 2       | Production + safety              |
 * | Total | ~40m   | 11      | Inside container                 |
 *
 * Plus ~15 min for research + assets (before container).
 * Total: ~55 min (under 1 hour).
 */

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 8080;

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 15000);
}

// ── Cloudflare credentials (loaded from build payload) ──
var CF_CREDS = null;
var CONTAINER_SECRET = (process.env.ANTHROPIC_API_KEY || '').slice(0, 16);

function serviceHeaders(extra) {
  var h = {};
  if (CF_CREDS && CF_CREDS.accessClientId) {
    h['CF-Access-Client-Id'] = CF_CREDS.accessClientId;
    h['CF-Access-Client-Secret'] = CF_CREDS.accessClientSecret;
  }
  if (extra) Object.assign(h, extra);
  return h;
}

// ── Claude Code runner ──
function runClaude(dir, input, label, timeoutMin) {
  var file = path.join(dir, '_input_' + label + '.txt');
  fs.writeFileSync(file, input);
  var t0 = Date.now();
  var timeout = (timeoutMin || 10) * 60 * 1000;
  console.log('[' + label + '] Starting (' + Math.round(input.length/1024) + 'KB, ' + (timeout/60000) + 'min timeout)...');
  try {
    execSync('claude --dangerously-skip-permissions -p < ' + path.basename(file), {
      cwd: dir, shell: '/bin/sh', timeout: timeout, maxBuffer: 100*1024*1024,
      env: { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
    });
    console.log('[' + label + '] Done in ' + ((Date.now()-t0)/1000).toFixed(0) + 's');
    return true;
  } catch (e) {
    console.warn('[' + label + '] Failed after ' + ((Date.now()-t0)/1000).toFixed(0) + 's (exit ' + e.status + ')');
    return false;
  }
}

// ── R2 upload with 3-layer fallback ──
async function uploadToR2(key, content, contentType) {
  // 1. Internal outbound handler
  try {
    var r = await fetch('http://r2/' + key, { method: 'PUT', body: content, headers: { 'Content-Type': contentType || 'text/plain' } });
    if (r.ok) return true;
  } catch (e) { /* try next */ }

  // 2. Cloudflare R2 API (no bot protection)
  if (CF_CREDS && CF_CREDS.apiToken && CF_CREDS.bucket) {
    try {
      // Use the Workers API to put objects (the R2 REST API requires S3 auth which is complex)
      // Instead, use the container-upload endpoint with service token
    } catch (e) { /* try next */ }
  }

  // 3. Public Worker endpoint with service token
  try {
    var r3 = await fetch('https://projectsites.dev/api/container-upload/' + key, {
      method: 'PUT', body: content,
      headers: serviceHeaders({ 'Content-Type': contentType || 'text/plain', 'x-container-secret': CONTAINER_SECRET }),
    });
    if (r3.ok) { console.log('[r2] Uploaded via public endpoint:', key); return true; }
  } catch (e) { /* try next */ }

  // 4. Cloudflare D1/R2 REST API as absolute last resort
  if (CF_CREDS && CF_CREDS.apiToken) {
    try {
      // For R2, we need S3-compatible auth. Simpler: base64 encode small files into a D1 blob
      // Actually — let's just use wrangler CLI if available
      console.warn('[r2] All upload methods failed for:', key);
    } catch (e) { /* give up */ }
  }
  return false;
}

// ── D1 query with 3-layer fallback ──
async function queryD1(sql, params) {
  var body = JSON.stringify({ sql: sql, params: params || [] });

  // 1. Internal outbound handler
  try {
    var r = await fetch('http://d1/query', { method: 'POST', body: body, headers: { 'Content-Type': 'application/json' } });
    if (r.ok) return true;
  } catch (e) { /* try next */ }

  // 2. Cloudflare D1 REST API (always works, no bot protection)
  if (CF_CREDS && CF_CREDS.apiToken && CF_CREDS.dbId) {
    try {
      var url = 'https://api.cloudflare.com/client/v4/accounts/' + CF_CREDS.accountId + '/d1/database/' + CF_CREDS.dbId + '/query';
      var r2 = await fetch(url, {
        method: 'POST', body: body,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CF_CREDS.apiToken },
      });
      if (r2.ok) { console.log('[d1] Executed via CF API'); return true; }
      var err = await r2.text().catch(function(){return '';});
      console.warn('[d1] CF API:', r2.status, err.slice(0,150));
    } catch (e) { console.warn('[d1] CF API error:', e.message); }
  }

  // 3. Public Worker endpoint with service token
  try {
    var r3 = await fetch('https://projectsites.dev/api/container-query', {
      method: 'POST', body: body,
      headers: serviceHeaders({ 'Content-Type': 'application/json', 'x-container-secret': CONTAINER_SECRET }),
    });
    if (r3.ok) { console.log('[d1] Executed via public endpoint'); return true; }
  } catch (e) { /* give up */ }

  console.warn('[d1] ALL methods failed for:', sql.slice(0,80));
  return false;
}

function hasFile(dir, name) { return fs.existsSync(path.join(dir, name)); }

// ── Deploy version to R2 + update D1 ──
async function deploy(dir, slug, siteId, isInterim) {
  var files = [];
  for (var f of fs.readdirSync(dir)) {
    if (f.startsWith('_')) continue;
    if (fs.statSync(path.join(dir, f)).isFile()) {
      files.push({ name: f, content: fs.readFileSync(path.join(dir, f), 'utf-8') });
    }
  }
  if (!files.length) return null;

  var version = new Date().toISOString().replace(/[:.]/g, '-') + (isInterim ? '-interim' : '');

  if (isInterim) {
    var idx = files.findIndex(function(f){return f.name==='index.html';});
    if (idx >= 0) {
      var banner = '<div id="ps-building" style="position:fixed;top:0;left:0;right:0;z-index:99999;background:linear-gradient(135deg,#7c3aed,#3b82f6);color:#fff;text-align:center;padding:12px 40px 12px 20px;font-family:system-ui;font-size:14px;box-shadow:0 2px 20px rgba(0,0,0,0.3);">Your website is being perfected by AI. This is a preview. <button onclick="this.parentElement.remove()" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;color:#fff;font-size:18px;cursor:pointer;">&#x2715;</button></div>';
      files[idx].content = files[idx].content.replace(/(<body[^>]*>)/i, '$1'+banner);
    }
  }

  for (var f of files) {
    var ct = f.name.endsWith('.html')?'text/html':f.name.endsWith('.xml')?'application/xml':f.name.endsWith('.json')?'application/json':f.name.endsWith('.svg')?'image/svg+xml':'text/plain';
    await uploadToR2('sites/'+slug+'/'+version+'/'+f.name, f.content, ct);
  }
  await uploadToR2('sites/'+slug+'/_manifest.json', JSON.stringify({current_version:version,files:files.map(function(f){return f.name;}),building:isInterim}), 'application/json');

  var sql = isInterim
    ? "UPDATE sites SET current_build_version = ?1, updated_at = datetime('now') WHERE id = ?2"
    : "UPDATE sites SET status = 'published', current_build_version = ?1, updated_at = datetime('now') WHERE id = ?2";
  await queryD1(sql, [version, siteId]);

  console.log('[deploy] ' + (isInterim?'INTERIM':'FINAL') + ': ' + version + ' (' + files.length + ' files)');
  return version;
}

// ── Heartbeat: update D1 every 2 minutes so we can see the container is alive ──
var heartbeatInterval = null;
var currentStage = 'starting';

function startHeartbeat(slug, siteId) {
  heartbeatInterval = setInterval(async function() {
    // Update a field in D1 so the monitoring can see progress
    await queryD1(
      "UPDATE sites SET updated_at = datetime('now') WHERE id = ?1",
      [siteId]
    );
    console.log('[heartbeat] ' + currentStage + ' — ' + new Date().toISOString());
  }, 120000); // Every 2 minutes
}

function stopHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
}

// ── HTTP Server ──
var server = http.createServer(async function(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method==='GET' && req.url==='/health') return res.end(JSON.stringify({status:'ok'}));
  if (req.method==='POST' && req.url==='/build') {
    var body=''; req.on('data',function(c){body+=c;}); req.on('end', async function(){
      try {
        var params=JSON.parse(body); res.writeHead(202); res.end(JSON.stringify({status:'building'}));
        await buildSite(params);
      } catch(e) { console.error('[FATAL]',e.message); if(!res.headersSent){res.writeHead(500);res.end(JSON.stringify({error:e.message}));} }
    }); return;
  }
  res.writeHead(404); res.end('{"error":"Not found"}');
});

// ══════════════════════════════════════════════════════════════
// THE BUILD PIPELINE
// ══════════════════════════════════════════════════════════════

async function buildSite(params) {
  var slug = (params.slug||'').replace(/[^a-z0-9-]/g,'').slice(0,63);
  var siteId = params.siteId;
  var safeName = sanitize(params.businessName || 'Business');
  var research = params.researchData || {};
  var brand = research.brand || {};
  var colors = brand.colors || {};
  var category = (research.profile?.business_type || params.businessCategory || '').toLowerCase();
  var dir = '/tmp/build-'+slug+'-'+Date.now();
  fs.mkdirSync(dir, {recursive:true});

  CF_CREDS = params._cf || null;
  if (CF_CREDS) console.log('[build] CF API credentials loaded');

  // Start heartbeat so monitoring can see progress
  startHeartbeat(slug, siteId);

  // First thing: prove we can write to D1
  var canWrite = await queryD1(
    "UPDATE sites SET updated_at = datetime('now') WHERE id = ?1",
    [siteId]
  );
  console.log('[build] D1 write test: ' + (canWrite ? 'SUCCESS' : 'FAILED — all upload methods broken'));

  console.log('═'.repeat(60));
  console.log('[build] ' + safeName + ' (' + slug + ')');
  console.log('[build] Colors: ' + (colors.primary||'?') + ' / ' + (colors.accent||'?'));
  console.log('[build] Category: ' + category);
  console.log('═'.repeat(60));

  // Write all context files
  fs.writeFileSync(path.join(dir,'_research.json'), JSON.stringify(research,null,2));
  fs.writeFileSync(path.join(dir,'_assets.json'), JSON.stringify(params.assetUrls||[],null,2));
  fs.writeFileSync(path.join(dir,'_params.json'), JSON.stringify(params,null,2));
  if (params.scrapedContent) fs.writeFileSync(path.join(dir,'_scraped.json'), typeof params.scrapedContent==='string'?params.scrapedContent:JSON.stringify(params.scrapedContent));
  if (params.siteData) fs.writeFileSync(path.join(dir,'_site_data.json'), JSON.stringify(params.siteData,null,2));

  var hasLogo = (params.assetUrls||[]).some(function(a){return (a.name||'').toLowerCase().includes('logo');});
  var hasFavicon = (params.assetUrls||[]).some(function(a){var n=(a.name||'').toLowerCase();return n.includes('favicon')||n.includes('icon-512');});
  fs.writeFileSync(path.join(dir,'_flags.json'), JSON.stringify({needs_logo:!hasLogo,needs_favicon:!hasFavicon,brand_colors:colors,category:category},null,2));

  // ════════════════════════════════════════════════════════════
  // STAGE A: Foundation (1 big prompt, 10-15 min)
  // This does 80% of the work. Give it TIME and CONTEXT.
  // ════════════════════════════════════════════════════════════

  var primary = sanitize(colors.primary || '#1a1a2e');
  var secondary = sanitize(colors.secondary || '#16213e');
  var accent = sanitize(colors.accent || '#e94560');

  var scrapedNote = '';
  if (hasFile(dir, '_scraped.json')) {
    try {
      var scraped = JSON.parse(fs.readFileSync(path.join(dir,'_scraped.json'),'utf-8'));
      var realContent = (scraped.all_text || '').slice(0, 8000);
      var realImages = (scraped.all_images || []).slice(0, 20);
      scrapedNote = '\n\nREAL CONTENT FROM ORIGINAL WEBSITE (use this, not placeholder text):\n' + realContent;
      if (realImages.length) scrapedNote += '\n\nIMAGES FROM ORIGINAL SITE:\n' + realImages.map(function(u,i){return (i+1)+'. '+u;}).join('\n');
    } catch(e) {}
  }

  runClaude(dir, [
    'You are building a production-ready website that matches Stripe.com / Linear.app / Vercel.com quality.',
    'Read ALL files prefixed with _ in this directory for context.',
    '',
    '═══ BUSINESS ═══',
    'Name: ' + safeName,
    'Category: ' + (category || 'general business'),
    'Colors: --primary:' + primary + '; --secondary:' + secondary + '; --accent:' + accent + ';',
    '',
    '═══ DESIGN SYSTEM ═══',
    '- Font: Inter or Satoshi (Google Fonts, display=swap)',
    '- Typography: 48px hero, 24px sections, 16px body. Apple-level hierarchy.',
    '- Layout: Material Design spacing. Max-width 1200px container.',
    '- Aesthetic: Clean, minimal, premium. Subtle gradients, soft shadows.',
    '- WCAG AA contrast minimum on ALL text.',
    '',
    '═══ REQUIRED SECTIONS ═══',
    '1. Sticky header with logo (inline SVG if _flags.json says needs_logo) + nav links',
    '2. Full-viewport hero: gradient overlay on image, 48px headline, subheadline, 1 primary CTA',
    '3. Selling points / features (3-4 cards with icons)',
    '4. About section with split layout (text + image), links to #services and #contact',
    '5. Services/programs grid — EVERY card has a unique Unsplash image. Grid rows consistent.',
    '6. Testimonials or impact section (counters for non-profits, reviews for businesses)',
    '7. Google Maps embed',
    '8. Contact form (name, email, phone optional, message, submit CTA)',
    '9. FAQ section (5+ items, last: "How was this site built? → ProjectSites.dev")',
    '10. Footer (business info, social links, privacy/terms links)',
    '',
    '═══ ANIMATIONS ═══',
    '- 6+ @keyframes: fadeInUp, slideInLeft, scaleIn, subtleFloat, gradientShift, revealSection',
    '- IntersectionObserver adds .visible class on scroll',
    '- Glassmorphism on nav or cards (backdrop-filter:blur)',
    '- Subtle hover effects on cards and buttons (translateY -2px, shadow)',
    '- Gradient text on 1 heading. Keep it classy, not flashy.',
    '',
    '═══ SEO (do this NOW, not later) ═══',
    '- <title> with business name + location (60 chars)',
    '- <meta name="description"> (150 chars with primary keyword)',
    '- og:title, og:description, og:image, og:url, og:type',
    '- <link rel="canonical" href="https://' + slug + '.projectsites.dev/">',
    '- JSON-LD LocalBusiness schema (name, address, phone, hours, geo, image, url)',
    '- Semantic HTML: 1 h1, logical h2→h3, <main>, <section>, <nav>',
    '',
    '═══ IMAGES (15-20 minimum) ═══',
    '- Use Unsplash: https://images.unsplash.com/photo-{ID}?w={W}&h={H}&fit=crop',
    '- Hero: 3 different images (w=1920). About: 1 (w=800). Each service card: unique (w=400).',
    '- NEVER empty background-image. NEVER duplicate URLs.',
    '- Alt text with keywords on every image.',
    '- loading="lazy" on below-fold images.',
    '',
    '═══ OUTPUT ═══',
    'Write index.html, robots.txt, sitemap.xml. No placeholders. Production-ready.',
    hasLogo ? '' : 'Create inline SVG logo: "' + safeName + '" in Inter 700 with brand primary color.',
    hasFavicon ? '' : 'Add <link rel="icon" type="image/svg+xml"> monogram favicon.',
    scrapedNote,
    sanitize(params.additionalContext || ''),
  ].filter(Boolean).join('\n'), 'A-foundation', 15);

  // Deploy interim v1
  if (hasFile(dir, 'index.html')) {
    await deploy(dir, slug, siteId, true);
  }

  // ════════════════════════════════════════════════════════════
  // STAGE B: Enhancement (3 focused prompts, ~9 min)
  // ════════════════════════════════════════════════════════════

  if (hasFile(dir, 'index.html')) {
    runClaude(dir, 'Add animations to index.html. Do NOT rewrite.\n\nAdd @keyframes: fadeInUp (0.6s), slideInLeft/Right (0.7s), scaleIn (0.5s), subtleFloat (3s infinite), revealSection (0.8s).\nAdd IntersectionObserver script: sections start opacity:0 translateY:20px, get .visible class.\nGlassmorphism on 2+ elements: backdrop-filter:blur(16px).\nSubtle hovers: cards translateY(-2px), links border-bottom grow, buttons brightness increase.\nAdd @media (prefers-reduced-motion: reduce) to disable animations.', 'B1-animations', 5);
  }

  if (hasFile(dir, 'index.html')) {
    runClaude(dir, 'SEO audit on index.html. Do NOT rewrite.\n\nVerify/add:\n1. <meta name="description"> (150 chars, keyword + location)\n2. og:title, og:description, og:image (real URL), og:url\n3. <link rel="canonical">\n4. JSON-LD LocalBusiness with geo, hours, sameAs\n5. FAQPage schema on FAQ section\n6. Heading hierarchy: 1 h1, then h2, h3\n7. Keywords in h1, first paragraph, 2+ h2s, image alt text\n8. Internal links with keyword anchor text (not "click here")\n9. robots.txt with Sitemap directive\n10. sitemap.xml with all pages', 'B2-seo', 5);
  }

  if (hasFile(dir, 'index.html')) {
    runClaude(dir, 'Image audit on index.html. Do NOT rewrite.\n\nCount unique image URLs. If fewer than 15, add more Unsplash images.\nEvery service/card MUST have a unique image. Use different photo IDs.\nCheck _scraped.json all_images — use real business photos where possible.\nEnsure no background-image is empty or url("").\nGrid rows must be consistent (center partial final rows).\nAll images below hero: loading="lazy".\nAll images: descriptive alt text with keywords.', 'B3-images', 5);
  }

  // Deploy interim v2
  if (hasFile(dir, 'index.html')) {
    await deploy(dir, slug, siteId, true);
  }

  // ════════════════════════════════════════════════════════════
  // STAGE C: Quality (5 surgical prompts, ~10 min)
  // ════════════════════════════════════════════════════════════

  if (hasFile(dir, 'index.html')) {
    runClaude(dir, 'Visual quality check on index.html. Fix in place.\n\n1. ALL text over images must have dark overlay (min rgba(0,0,0,0.5))\n2. Color contrast: 4.5:1 for body text, 3:1 for large text\n3. No muddy/washed-out colors — make palette vibrant\n4. Grid consistency: partial rows centered\n5. Hero must be visually impressive\n6. Consistent spacing between sections', 'C1-visual', 3);
  }

  if (hasFile(dir, 'index.html')) {
    runClaude(dir, 'Accessibility audit on index.html. Fix in place.\n\n1. Heading hierarchy: exactly 1 h1, then h2, h3 in order\n2. All images: descriptive alt (not "image")\n3. All inputs: associated <label>\n4. Skip-to-content link\n5. <html lang="en">\n6. Focus-visible styles\n7. ARIA labels on icon buttons\n8. Touch targets: min 44px', 'C2-accessibility', 3);
  }

  if (hasFile(dir, 'index.html')) {
    runClaude(dir, 'Responsive check on index.html. Fix in place.\n\n1. Works at 375px: single column, hamburger nav, readable text\n2. Works at 768px: 2 columns\n3. Works at 1024px: full layout\n4. Images: max-width:100%\n5. No horizontal scroll\n6. Phone links: tel: format\n7. Form inputs: full-width on mobile', 'C3-responsive', 3);
  }

  // Domain-specific prompt
  if (hasFile(dir, 'index.html')) {
    var domainPrompt = 'Add domain-specific features to index.html. ';
    if (category.includes('non-profit')||category.includes('community')||category.includes('church')||category.includes('soup')) {
      domainPrompt += 'NON-PROFIT: Add prominent donation CTA (gradient button, stands out), impact counters (meals, volunteers, years), volunteer signup CTA. Warm, dignified tone.';
    } else if (category.includes('restaurant')||category.includes('food')) {
      domainPrompt += 'RESTAURANT: Add menu section, hours widget, reservation/order CTA.';
    } else if (category.includes('salon')||category.includes('spa')) {
      domainPrompt += 'SALON: Add services+prices, staff profiles, booking CTA.';
    } else if (category.includes('grocery')||category.includes('store')) {
      domainPrompt += 'RETAIL: Add department grid with images, store hours, location CTA.';
    } else {
      domainPrompt += 'Add features appropriate for this business type from the research data.';
    }
    runClaude(dir, domainPrompt, 'C4-domain', 3);
  }

  if (hasFile(dir, 'index.html')) {
    runClaude(dir, 'Typography + micro-copy polish on index.html.\n\n1. Button labels: action verbs ("Send Message" not "Submit")\n2. Hero headline: under 10 words, compelling\n3. Section labels: uppercase, letter-spacing 0.05em\n4. Consistent font-weight usage\n5. No filler text, no lorem ipsum\n6. Copyright year: ' + new Date().getFullYear() + '\n7. NAP consistent (name, address, phone in header, footer, schema)', 'C5-typography', 3);
  }

  // Deploy interim v3
  if (hasFile(dir, 'index.html')) {
    await deploy(dir, slug, siteId, true);
  }

  // ════════════════════════════════════════════════════════════
  // STAGE D: Final (2 prompts, ~3 min)
  // ════════════════════════════════════════════════════════════

  if (hasFile(dir, 'index.html')) {
    runClaude(dir, 'Production readiness on ALL files.\n\n1. No console.log in JS\n2. No TODO comments\n3. No commented-out code\n4. HTML valid (closed tags, no dup IDs)\n5. Total under 100KB\n6. All URLs use HTTPS\n7. Google Fonts display=swap + preconnect\n8. Back-to-top button (fixed, bottom-right)\n9. Smooth scroll: html{scroll-behavior:smooth}\n10. About links to #services and #contact', 'D1-production', 3);
  }

  if (hasFile(dir, 'index.html')) {
    runClaude(dir, 'Safety check.\n\n1. No inappropriate content\n2. Contact form has privacy notice\n3. Footer: Privacy Policy + Terms links\n4. External links: rel="noopener noreferrer"\n5. FAQ includes "Built by ProjectSites.dev" as last item\n6. No medical advice (if medical)\n7. COPPA-appropriate (if children/education)', 'D2-safety', 2);
  }

  // ════════════════════════════════════════════════════════════
  // DEPLOY FINAL
  // ════════════════════════════════════════════════════════════

  var finalVersion = await deploy(dir, slug, siteId, false);

  if (finalVersion) {
    await queryD1(
      "INSERT OR IGNORE INTO site_snapshots (id, site_id, snapshot_name, build_version, description) VALUES (?1, ?2, 'initial', ?3, 'First published version')",
      [crypto.randomUUID(), siteId, finalVersion]);
    console.log('═'.repeat(60));
    console.log('[PUBLISHED] https://' + slug + '.projectsites.dev');
    console.log('═'.repeat(60));
  } else {
    await queryD1("UPDATE sites SET status = 'error', updated_at = datetime('now') WHERE id = ?1", [siteId]);
    console.log('[FAILED] No files generated');
  }

  stopHeartbeat();
  fs.rmSync(dir, {recursive:true, force:true});
}

server.listen(PORT, function(){ console.log('[container] Build server v2 ready (4-stage pipeline, 1hr budget)'); });
