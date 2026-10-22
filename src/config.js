// Studio settings (bpmn-studio.config.json). Works in the browser and in Node: the app loads the
// JSON file and calls applyConfig(); tests call applyConfig() with their own values.

const DEFAULTS = {
  // platform of new diagrams: "camunda7" | "camunda8"
  defaultPlatform: 'camunda7',
  camunda7Version: '7.24.0',
  camunda8Version: '8.8.0',
  // editor for Camunda 7 diagrams: "legacy" = the classic stack, bpmn-js 7.4 + properties panel 0.42,
  // "modern" = camunda-bpmn-js
  camunda7Editor: 'legacy',
  // "Отправить схему": POST {url}{path} with { [field]: <diagram XML, base64> }
  deploy: {
    path: '/api/bpmn/deploy',
    field: 'bpmnBase64',
    targets: {}
  }
};

export const config = structuredClone(DEFAULTS);

/** Validate and apply settings (missing keys keep their defaults). Throws on invalid values. */
export function applyConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config: expected a JSON object');
  const next = { ...structuredClone(DEFAULTS), ...raw, deploy: { ...DEFAULTS.deploy, ...(raw.deploy || {}) } };
  if (!['camunda7', 'camunda8'].includes(next.defaultPlatform)) throw new Error('config: defaultPlatform must be camunda7 or camunda8');
  if (!['legacy', 'modern'].includes(next.camunda7Editor)) throw new Error('config: camunda7Editor must be legacy or modern');
  for (const key of ['camunda7Version', 'camunda8Version']) {
    if (!/^\d+\.\d+(\.\d+)?$/.test(String(next[key]))) throw new Error(`config: ${key} must look like 7.24.0`);
  }
  if (typeof next.deploy.path !== 'string' || !next.deploy.path.startsWith('/')) throw new Error('config: deploy.path must start with /');
  if (typeof next.deploy.field !== 'string' || !/^[A-Za-z_][\w-]{0,63}$/.test(next.deploy.field)) throw new Error('config: deploy.field must be a JSON property name');
  const targets = next.deploy.targets;
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) throw new Error('config: deploy.targets must be an object');
  for (const [name, url] of Object.entries(targets)) {
    if (typeof url !== 'string' || !/^https?:\/\/[^\s/@]+(\/|$)/.test(url)) throw new Error(`config: deploy target "${name}" has an invalid URL`);
  }
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, next);
  return config;
}

export const platformVersion = platform => platform === 'camunda7' ? config.camunda7Version : config.camunda8Version;

/** Configured deploy target URL by name (own properties only: "constructor" is not a target). */
export const deployTarget = name => Object.hasOwn(config.deploy.targets, name) ? config.deploy.targets[name] : undefined;

/** Base64 of the UTF-8 XML, exactly like the original modeler's utf8_to_b64(). */
export function toBase64(xml) {
  const bytes = new TextEncoder().encode(xml);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Send a diagram to a deployment server, from the user's browser
 * (the server must allow the studio's origin via CORS).
 * @returns {Promise<{ ok: boolean, status: number, url: string, body: string }>}
 */
export async function deploySchema(baseUrl, xml, { fetchImpl = fetch } = {}) {
  if (!/^https?:\/\/[^\s/@]+/.test(baseUrl || '')) throw new Error(`bad server URL: ${baseUrl}`);
  const url = baseUrl.replace(/\/+$/, '') + config.deploy.path;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ [config.deploy.field]: toBase64(xml) }),
    signal: AbortSignal.timeout(30000)
  });
  const body = (await res.text()).slice(0, 2000);
  return { ok: res.ok, status: res.status, url, body };
}
