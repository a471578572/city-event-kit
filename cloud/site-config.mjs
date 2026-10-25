import { readFileSync } from 'node:fs';

const FIELDS = ['name', 'city', 'date', 'subtitle', 'logos', 'registrationUrl', 'handbookUrl', 'publicPlayerWall', 'certificateIssuer'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function safeText(value, minimum, maximum) {
  if (typeof value !== 'string' || value !== value.trim() || Array.from(value).length < minimum
      || Array.from(value).length > maximum || /[\x00-\x1f\x7f]/u.test(value)) throw new Error('SITE_CONFIG_INVALID');
  return value;
}
function publicLink(value) {
  if (value === '') return '';
  safeText(value, 1, 2048);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('SITE_CONFIG_INVALID'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('SITE_CONFIG_INVALID');
  return value;
}
export function validateSiteConfig(value) {
  if (!record(value) || Object.keys(value).sort().join('|') !== [...FIELDS].sort().join('|')) throw new Error('SITE_CONFIG_INVALID');
  if (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value.date)) throw new Error('SITE_CONFIG_INVALID');
  const date = new Date(value.date + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.date) throw new Error('SITE_CONFIG_INVALID');
  if (typeof value.publicPlayerWall !== 'boolean' || !Array.isArray(value.logos) || value.logos.length < 1 || value.logos.length > 30) throw new Error('SITE_CONFIG_INVALID');
  const logos = value.logos.map(logo => {
    if (!record(logo) || Object.keys(logo).sort().join('|') !== 'name|src') throw new Error('SITE_CONFIG_INVALID');
    const src = safeText(logo.src, 1, 200);
    if (!/^assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:svg|png|jpe?g|webp)$/u.test(src)
        || src.split('/').some(part => part === '..' || part.startsWith('.'))) throw new Error('SITE_CONFIG_INVALID');
    return { name: safeText(logo.name, 1, 100), src };
  });
  return {
    name: safeText(value.name, 1, 100), city: safeText(value.city, 1, 60), date: value.date,
    subtitle: safeText(value.subtitle, 0, 200), logos,
    registrationUrl: publicLink(value.registrationUrl), handbookUrl: publicLink(value.handbookUrl),
    publicPlayerWall: value.publicPlayerWall, certificateIssuer: safeText(value.certificateIssuer, 1, 100),
  };
}
export function loadSiteConfig(path = new URL('../web/site-config.json', import.meta.url)) {
  try { return validateSiteConfig(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { throw new Error('SITE_CONFIG_INVALID'); }
}
const config = loadSiteConfig();
config.logos.forEach(Object.freeze); Object.freeze(config.logos);
export const SITE_CONFIG = Object.freeze(config);
