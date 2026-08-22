const EXACT_HEAD = /^[0-9a-f]{40}$/u;
const SAFE_REF = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u;
const API_ROOT = 'https://api.github.com/repos/iteathen/DevBridge';
const RUNNER_PATH = 'devbridge.mjs';
const MAX_RUNNER_BYTES = 512 * 1024;

function fail(message) { throw new Error(message); }

function exactHead(value) {
  const head = String(value ?? '').toLowerCase();
  if (!EXACT_HEAD.test(head)) fail('runner source did not produce an exact 40-hex commit');
  return head;
}

function safeRef(value) {
  const ref = String(value ?? '');
  if (!ref || ref.length > 240 || ref.startsWith('-') || !SAFE_REF.test(ref) || ref.includes('..') || ref.includes('@{') || ref.endsWith('.lock')) {
    fail('runner source ref selector is invalid');
  }
  return ref;
}

async function responseJson(response, action) {
  if (!response || typeof response !== 'object' || response.ok !== true || typeof response.json !== 'function') {
    fail(`fixed runner source ${action} failed`);
  }
  return response.json();
}

function requestOptions() {
  return {
    method: 'GET',
    redirect: 'error',
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'DevBridge-Permanent-Entry',
    },
  };
}

export class GitHubRunnerSource {
  #request;

  constructor({ request = globalThis.fetch } = {}) {
    if (typeof request !== 'function') throw new TypeError('runner source request must be a function');
    this.#request = request;
  }

  async resolve(ref) {
    const selector = safeRef(ref);
    const response = await this.#request(`${API_ROOT}/commits/${encodeURIComponent(selector)}`, requestOptions());
    const body = await responseJson(response, 'ref resolution');
    return exactHead(body?.sha);
  }

  async read(head) {
    const exact = exactHead(head);
    const response = await this.#request(`${API_ROOT}/contents/${RUNNER_PATH}?ref=${exact}`, requestOptions());
    const body = await responseJson(response, 'artifact read');
    if (body?.type !== 'file' || body?.path !== RUNNER_PATH || body?.encoding !== 'base64' || typeof body?.content !== 'string') {
      fail('fixed runner source returned an invalid artifact record');
    }
    if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > MAX_RUNNER_BYTES) {
      fail('fixed runner source artifact size is invalid');
    }
    const canonical = body.content.replace(/\s/gu, '');
    const bytes = Buffer.from(canonical, 'base64');
    if (bytes.length !== body.size || bytes.length > MAX_RUNNER_BYTES || bytes.toString('base64') !== canonical) {
      fail('fixed runner source artifact encoding is invalid');
    }
    return bytes;
  }
}
