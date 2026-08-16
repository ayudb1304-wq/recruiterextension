/**
 * Fixture sanitizer (docs/03 §7 step 2).
 *
 * Replaces every name, company, location, image URL and profile URL with fake
 * equivalents while preserving structure and attributes EXACTLY — the whole
 * point of a fixture is that its shape is real. Only the values change.
 *
 * Usage:
 *   node scripts/sanitize-fixture.mjs <raw.html> [output.html]
 *
 * Then save the result under
 *   extension/fixtures/<profileId>/<yyyy-mm-dd>-<note>.html
 * and commit it. Raw captures (raw-*.html) are gitignored and must never be
 * committed — they contain real people's data.
 *
 * Deterministic: the same input value always maps to the same fake value, so a
 * candidate appearing twice in a fixture still looks like the same person.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const FIRST = [
  'Jane', 'Wei', 'Amara', 'Carlos', 'Priya', 'Tomas', 'Aisha', 'Lars', 'Nina', 'Diego',
  'Yuki', 'Omar', 'Elena', 'Marcus', 'Sofia', 'Ravi', 'Anna', 'Kofi', 'Mei', 'Pierre',
];
const LAST = [
  'Doe', 'Chen', 'Okafor', 'Ruiz', 'Raman', 'Novak', 'Bello', 'Berg', 'Kowalski', 'Santos',
  'Tanaka', 'Farsi', 'Rossi', 'Webb', 'Lindqvist', 'Shankar', 'Muller', 'Mensah', 'Wang', 'Dubois',
];
const COMPANIES = [
  'Acme', 'Globex', 'Initech', 'Umbrella Systems', 'Soylent Labs', 'Hooli', 'Vandelay',
  'Stark Industries', 'Wayne Digital', 'Cyberdyne', 'Massive Dynamic', 'Pied Piper',
];
const LOCATIONS = [
  'Berlin, Germany', 'Austin, Texas', 'London, United Kingdom', 'Toronto, Canada',
  'Lisbon, Portugal', 'Singapore', 'Amsterdam, Netherlands', 'Nairobi, Kenya',
  'Bengaluru, India', 'Sao Paulo, Brazil',
];

function pick(list, seed) {
  const hash = createHash('sha256').update(seed).digest();
  return list[hash.readUInt32BE(0) % list.length];
}

function fakeName(seed) {
  return `${pick(FIRST, `f:${seed}`)} ${pick(LAST, `l:${seed}`)}`;
}

function fakeSlug(seed) {
  return fakeName(seed).toLowerCase().replace(/\s+/g, '-') + '-' +
    createHash('sha256').update(seed).digest('hex').slice(0, 6);
}

/**
 * Attributes whose VALUE identifies a real person or company and must be
 * replaced. Structural attributes (class, data-view-name, aria-*) are left
 * untouched — selectors depend on them.
 */
const VALUE_ATTRS = {
  'data-anonymize': null, // handled by element type below
  alt: 'name',
  title: 'name',
};

function sanitize(html) {
  let out = html;

  // 1. Profile URLs → deterministic fake slugs.
  out = out.replace(/\/in\/([A-Za-z0-9\-_%]+)/g, (_m, slug) => `/in/${fakeSlug(slug)}`);
  out = out.replace(
    /\/sales\/lead\/([A-Za-z0-9\-_%,]+)/g,
    (_m, id) => `/sales/lead/FAKE${createHash('sha256').update(id).digest('hex').slice(0, 10).toUpperCase()}`,
  );
  out = out.replace(
    /\/talent\/profile\/([A-Za-z0-9\-_%]+)/g,
    (_m, id) => `/talent/profile/FAKE${createHash('sha256').update(id).digest('hex').slice(0, 10)}`,
  );
  out = out.replace(
    /\/sales\/company\/([A-Za-z0-9\-_%]+)/g,
    (_m, id) => `/sales/company/fake-${createHash('sha256').update(id).digest('hex').slice(0, 6)}`,
  );

  // 2. Profile photos and any media CDN URL → a blank placeholder.
  out = out.replace(
    /https?:\/\/(?:media|static)[^"'\s)]*\.(?:licdn|linkedin)\.com[^"'\s)]*/g,
    'https://example.invalid/avatar.png',
  );

  // 3. Text content of the elements LinkedIn itself marks as personal.
  out = out.replace(
    /(<([a-z0-9]+)[^>]*data-anonymize="([a-z-]+)"[^>]*>)([\s\S]*?)(<\/\2>)/gi,
    (match, open, _tag, kind, inner, close) => {
      // Only rewrite leaf text; keep nested markup structure intact.
      if (/<[a-z]/i.test(inner)) return match;
      const seed = inner.trim();
      if (!seed) return match;
      switch (kind) {
        case 'person-name':
          return `${open}${fakeName(seed)}${close}`;
        case 'company-name':
          return `${open}${pick(COMPANIES, seed)}${close}`;
        case 'location':
          return `${open}${pick(LOCATIONS, seed)}${close}`;
        case 'headline':
        case 'job-title':
        case 'title':
          return `${open}Senior Engineer at ${pick(COMPANIES, seed)}${close}`;
        default:
          return match;
      }
    },
  );

  // 4. alt/title attributes that echo a person's name.
  for (const attr of Object.keys(VALUE_ATTRS)) {
    if (attr === 'data-anonymize') continue;
    out = out.replace(
      new RegExp(`\\s${attr}="([^"]{2,120})"`, 'gi'),
      (_m, value) => ` ${attr}="${fakeName(value)}"`,
    );
  }

  // 5. Anything that still looks like an email address.
  out = out.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    (email) => `${fakeSlug(email)}@example.invalid`,
  );

  return out;
}

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error('usage: node scripts/sanitize-fixture.mjs <raw.html> [output.html]');
  process.exit(1);
}

const sanitized = sanitize(readFileSync(input, 'utf8'));
const target = output ?? input.replace(/(^|\/)raw-/, '$1').replace(/\.html$/, '.sanitized.html');
writeFileSync(target, sanitized);

console.log(`wrote ${target}`);
console.log(
  '\nBefore committing, EYEBALL THE OUTPUT. This sanitizer is best-effort:\n' +
    '  grep for any real name, company or handle that survived, and fix it by hand.\n' +
    '  A fixture is committed to a public repo — treat it as published.',
);
