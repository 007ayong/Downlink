(function initAria2Rpc(global) {
  const DEFAULT_RPC = 'http://localhost:6800/jsonrpc';
  const DEFAULT_PORT = '6800';

  function parseRpcEndpoint(value = DEFAULT_RPC) {
    const raw = String(value || '').trim() || DEFAULT_RPC;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return null;
    return parsed;
  }

  function normalizeRpcEndpoint(value) {
    return parseRpcEndpoint(value)?.toString() || DEFAULT_RPC;
  }

  function rpcParts(value) {
    const parsed = parseRpcEndpoint(value);
    if (!parsed) return null;
    return {
      protocol: parsed.protocol.slice(0, -1),
      host: parsed.hostname.replace(/^\[|\]$/g, ''),
      port: parsed.port || DEFAULT_PORT,
      path: `${parsed.pathname || '/jsonrpc'}${parsed.search}`,
    };
  }

  function buildRpcEndpoint({ protocol = 'http', host = 'localhost', port = DEFAULT_PORT, path = '/jsonrpc' } = {}) {
    const scheme = String(protocol || '').trim().replace(/:$/, '').toLowerCase();
    if (!['http', 'https'].includes(scheme)) throw new Error('RPC protocol must be HTTP or HTTPS');

    let hostname = String(host || '').trim();
    if (!hostname) throw new Error('RPC address is required');
    if (hostname.includes('://')) {
      const parsed = parseRpcEndpoint(hostname);
      if (!parsed) throw new Error('RPC address is invalid');
      hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    }
    if (/[/?#\s]/.test(hostname)) throw new Error('RPC address is invalid');
    if (hostname.includes(':') && !hostname.startsWith('[')) hostname = `[${hostname}]`;

    const portText = String(port || '').trim();
    if (!/^\d+$/.test(portText)) throw new Error('RPC port must be a number');
    const portNumber = Number(portText);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      throw new Error('RPC port must be between 1 and 65535');
    }

    let rpcPath = String(path || '').trim() || '/jsonrpc';
    if (!rpcPath.startsWith('/')) rpcPath = `/${rpcPath}`;
    const parsed = new URL(`${scheme}://${hostname}:${portNumber}${rpcPath}`);
    if (!parsed.hostname) throw new Error('RPC address is invalid');
    return parsed.toString();
  }

  global.Aria2Rpc = {
    DEFAULT_RPC,
    parseRpcEndpoint,
    normalizeRpcEndpoint,
    rpcParts,
    buildRpcEndpoint,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
