// Central configuration. Categories and fields mirror the Aekobaba packaging
// marketplace (github.com/Hassan-2305/aekobaba, data/seed-schema.ts) so that
// submissions can be exported straight into its seed format.
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// Which extra spec fields to ask for, per category group.
// capacity · dimensions · thickness · neck_finish · closure · board
const SPEC_GROUPS = {
  container: ['capacity', 'neck_finish', 'closure', 'dimensions'],
  closure: ['neck_finish', 'closure'],
  flexible: ['dimensions', 'capacity', 'thickness', 'closure'],
  box: ['dimensions', 'board'],
  label: ['dimensions'],
  other: ['capacity', 'dimensions'],
};

// Aekobaba category tree (slug, name, spec group).
const categories = [
  ['pouches-bags', 'Flexible Pouches & Bags', 'flexible'],
  ['plastic-bottles', 'Plastic Bottles', 'container'],
  ['plastic-jars', 'Plastic Jars & Canisters', 'container'],
  ['tubs-pails', 'Tubs, Cups & Pails', 'container'],
  ['folding-cartons', 'Folding Cartons', 'box'],
  ['labels', 'Labels', 'label'],
  ['closures', 'Closures', 'closure'],
  ['pumps-sprayers', 'Pumps, Sprayers & Airless Dispensers', 'closure'],
  ['corrugated', 'Corrugated Shippers & Secondary Packaging', 'box'],
  ['glass-bottles', 'Glass Bottles', 'container'],
  ['glass-jars', 'Glass Jars', 'container'],
  ['collapsible-tubes', 'Collapsible Tubes', 'container'],
  ['metal-cans', 'Metal Cans — Beverage & Food', 'container'],
  ['metal-tins', 'Metal Tins', 'container'],
  ['sachets-stick-packs', 'Sachets & Stick Packs', 'flexible'],
  ['rollstock', 'Flexible Film Rollstock & Flow Wrap', 'flexible'],
  ['shrink-sleeves', 'Shrink Sleeves', 'label'],
  ['thermoforms', 'Blister Packs, Clamshells & Thermoform Trays', 'other'],
  ['setup-boxes', 'Rigid Setup Boxes', 'box'],
  ['droppers-vials', 'Dropper Assemblies, Vials & Roll-Ons', 'container'],
  ['aerosols', 'Aerosol Cans', 'container'],
  ['mailers', 'Mailers & E-Commerce Shipping', 'box'],
  ['cr-cannabis', 'Child-Resistant & Specialty Packaging', 'other'],
  ['compostables', 'Compostables & Sustainable Structures', 'flexible'],
  ['brand-accessories', 'Branding Accessories: Hang Tags, Stickers, Tissue & Tape', 'label'],
].map(([slug, name, group]) => ({ slug, name, group }));

module.exports = {
  port: Number(process.env.PORT) || 3000,
  dataDir: DATA_DIR,
  uploadDir: path.join(DATA_DIR, 'uploads'),
  dbFile: path.join(DATA_DIR, 'supplydesk.db'),

  // Public base URL used when generating invite / edit links (no trailing slash).
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),

  // If false, suppliers can only submit through an invitation link (/s/<token>).
  allowOpenSubmissions: process.env.ALLOW_OPEN_SUBMISSIONS !== 'false',

  brand: {
    name: process.env.BRAND_NAME || 'Aekobaba',
    tagline: 'Packaging Supplier Portal',
    contactEmail: process.env.BRAND_CONTACT_EMAIL || '',
  },

  refPrefix: process.env.REF_PREFIX || 'SD',

  uploads: {
    maxFileSizeMB: Number(process.env.MAX_FILE_MB) || 25,
    maxFilesPerSubmission: 60,
    allowedExtensions: [
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.xlsm', '.csv', '.ppt', '.pptx', '.txt', '.odt', '.ods',
      '.jpg', '.jpeg', '.png', '.webp', '.gif', '.zip',
    ],
    imageExtensions: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
  },

  categories,
  specGroups: SPEC_GROUPS,
  currencies: ['USD', 'CNY', 'EUR', 'GBP', 'CAD', 'MXN', 'INR'],
  documentTypes: ['Product catalogue', 'Price list', 'Certificate', 'Other'],
  certifications: ['ISO 9001', 'ISO 14001', 'ISO 15378', 'ISO 22000 / FSSC 22000', 'BRCGS Packaging', 'SQF', 'FSC', 'Sedex / SMETA', 'BSCI / amfori', 'GMP'],
  // Countries shown first in the country picker (any country can be typed).
  countries: ['United States', 'China', 'Canada', 'Mexico', 'Vietnam', 'Taiwan', 'Hong Kong', 'India', 'Turkey', 'Germany', 'Italy', 'United Kingdom'],
  priceTerms: [
    ['EXW', 'EXW (ex-works / factory)'],
    ['FOB', 'FOB (loaded at port)'],
    ['CIF', 'CIF (delivered to destination port)'],
    ['DDP', 'DDP (delivered, duties paid)'],
    ['DELIVERED', 'Delivered (domestic shipping included)'],
  ],
  reviewStatuses: ['New', 'Under review', 'Ready to list', 'Listed', 'On hold', 'Rejected'],
};
