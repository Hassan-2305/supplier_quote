/* Product attribute guessing from a product name / description.
   Shared by the server (website + spreadsheet import) and the browser (auto-suggest).
   Categories are Aekobaba category slugs. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SDGuess = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CATEGORY_RULES = [
    [/\b(caps?|lids?|closures?|stoppers?|corks?)$/i, 'closures'],
    [/dropper|\bvials?\b|roll[- ]?on/i, 'droppers-vials'],
    [/\bpumps?\b|sprayer|trigger spray|airless|mister|foamer/i, 'pumps-sprayers'],
    [/aerosol/i, 'aerosols'],
    [/child[- ]?resistant|\bCR\b|pre[- ]?roll|cannabis|dispensary/i, 'cr-cannabis'],
    [/shrink (sleeve|band)/i, 'shrink-sleeves'],
    [/roll ?stock|flow wrap|film roll|stretch (wrap|film)|shrink film/i, 'rollstock'],
    [/sachet|stick pack/i, 'sachets-stick-packs'],
    [/\btubes?\b/i, 'collapsible-tubes'],
    [/\b(bottles?|jugs?|flasks?|growlers?|carboys?|boston rounds?)\b/i, (t) => (/glass|flint|amber|cobalt/i.test(t) && !/plastic|\bPET\b|HDPE/i.test(t) ? 'glass-bottles' : 'plastic-bottles')],
    [/\b(jars?|canisters?)\b/i, (t) => (/glass|mason|flint|amber/i.test(t) && !/plastic|\bPET\b|\bPP\b/i.test(t) ? 'glass-jars' : 'plastic-jars')],
    [/\btins?\b/i, 'metal-tins'],
    [/\bcans?\b/i, 'metal-cans'],
    [/\b(tubs?|pails?|buckets?|cups?|deli containers?)\b/i, 'tubs-pails'],
    [/blister|clamshell|thermoform|\btrays?\b/i, 'thermoforms'],
    [/pouch|\bbags?\b|mylar/i, 'pouches-bags'],
    [/mailer|poly ?mailer|shipping (box|envelope)|envelope/i, 'mailers'],
    [/corrugated|shipping cartons?|\bRSC\b|shipper/i, 'corrugated'],
    [/rigid box|set[- ]?up box|magnetic (closure )?box|drawer box|gift box/i, 'setup-boxes'],
    [/carton|folding box|tuck|\bboxe?s?\b|sleeve/i, 'folding-cartons'],
    [/hang ?tags?|tissue|\btape\b|stickers?/i, 'brand-accessories'],
    [/\blabels?\b/i, 'labels'],
    [/compostable|biodegradable|plant[- ]based/i, 'compostables'],
  ];
  const MATERIAL_RULES = [
    [/amber glass/i, 'Amber glass'], [/cobalt|blue glass/i, 'Blue glass'], [/flint|clear glass/i, 'Clear glass'], [/\bglass\b/i, 'Glass'],
    [/\bPETG\b/i, 'PETG'], [/\b(r?PET|polyethylene terephthalate)\b/i, 'PET'], [/\bHDPE\b/i, 'HDPE'], [/\bLDPE\b/i, 'LDPE'],
    [/\b(PP|polypropylene)\b/i, 'PP'], [/\bPLA\b/i, 'PLA'], [/\bPVC\b/i, 'PVC'], [/\bBOPP\b/i, 'BOPP'], [/mylar|foil/i, 'Mylar / foil laminate'],
    [/alumin(i)?um/i, 'Aluminum'], [/tinplate|\btin\b/i, 'Tinplate'], [/kraft/i, 'Kraft paper'], [/corrugated/i, 'Corrugated board'],
    [/paperboard|\bSBS\b|cardboard/i, 'Paperboard'], [/bamboo/i, 'Bamboo'], [/silicone/i, 'Silicone'], [/stainless/i, 'Stainless steel'],
    [/\bplastic\b/i, 'Plastic'], [/\bpaper\b/i, 'Paper'], [/\bmetal\b/i, 'Metal'],
  ];
  const FINISH_WORDS = ['clear', 'white', 'black', 'amber', 'cobalt blue', 'blue', 'green', 'red', 'natural', 'frosted', 'matte', 'gloss', 'kraft', 'gold', 'silver', 'translucent'];

  function category(text) {
    for (const [re, cat] of CATEGORY_RULES) if (re.test(text)) return typeof cat === 'function' ? cat(text) : cat;
    return '';
  }
  function material(text) {
    const hits = [];
    const lc = (x) => x.toLowerCase();
    for (const [re, m] of MATERIAL_RULES) if (re.test(text) && !hits.some((h) => lc(h).includes(lc(m)) || lc(m).includes(lc(h)))) hits.push(m);
    return hits.slice(0, 2).join(' / ');
  }
  function capacity(t) {
    const m = String(t).match(/(\d+(?:\.\d+)?)\s?(fl\.?\s?oz|oz|ml|cc|liters?|litres?|L|gallons?|gal)\b/i);
    return m ? `${m[1]} ${m[2]}` : '';
  }
  function dimensions(t) {
    const m = String(t).match(/\d+(?:\.\d+)?(?:\s?(?:"|in|mm|cm))?\s?[x×]\s?\d+(?:\.\d+)?(?:\s?(?:"|in|mm|cm))?(?:\s?[x×]\s?\d+(?:\.\d+)?)?(?:\s?(?:"|in(?:ches)?|mm|cm))?/i);
    return m ? m[0].replace(/\s+/g, ' ').trim() : '';
  }
  function neck(t) {
    const m = String(t).match(/\b(\d{2,3})\s?[-/]\s?(400|405|410|415|425|485|2000)\b/);
    return m ? `${m[1]}-${m[2]}` : '';
  }
  function finish(t) {
    const hits = FINISH_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(t));
    return hits.filter((w, i) => !hits.some((o, j) => j !== i && o.includes(w))).slice(0, 2).map((w) => w[0].toUpperCase() + w.slice(1)).join(', ');
  }
  function thickness(t) {
    const m = String(t).match(/(\d+(?:\.\d+)?)\s?(mil|micron|µm|um|gauge)\b/i);
    return m ? `${m[1]} ${m[2]}` : '';
  }
  /** All suggestions for a product name (+ optional description). */
  function all(name, description) {
    const text = `${name || ''} ${description || ''}`;
    return {
      category: category(name || '') || category(text),
      material: material(name || '') || material(text),
      capacity: capacity(name || ''),
      dimensions: dimensions(name || ''),
      neck_finish: neck(name || ''),
      finish: finish(name || ''),
      thickness: thickness(name || ''),
    };
  }
  return { category, material, capacity, dimensions, neck, finish, thickness, all };
});
