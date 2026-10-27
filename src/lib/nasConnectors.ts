export type NasTransport = 'webdav' | 'local' | 's3';

export type NasCapabilities = {
  webdav: boolean;
  local: boolean;
  s3: boolean;
};

export type NasConnectorHealth = {
  ok?: boolean;
  status?: string;
  checkedAt?: string;
};

export type NasS3PublicConfig = {
  endpoint?: string | null;
  bucket?: string | null;
  region?: string | null;
  prefix?: string | null;
  forcePathStyle?: boolean | null;
  credentialConfigured?: boolean;
  credentialsConfigured?: boolean;
  health?: NasConnectorHealth | string | null;
  capabilities?: string[] | Record<string, boolean> | null;
};

export type NasS3Display = {
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  pathStyle: 'path' | 'virtual-hosted' | 'unknown';
  credentialConfigured?: boolean;
  health: 'healthy' | 'error' | 'unknown';
  checkedAt?: string;
  capabilities: string[];
};

export const NAS_TRANSPORT_OPTIONS: ReadonlyArray<{ value: NasTransport; label: string }> = [
  { value: 'webdav', label: 'WebDAV' },
  { value: 'local', label: '服务器本地挂载' },
  { value: 's3', label: 'MinIO / S3' },
];

const CAPABILITY_LABELS: Record<string, string> = {
  list: '列出对象',
  listObjects: '列出对象',
  read: '读取对象',
  getObject: '读取对象',
  sync: '同步入库',
  scan: '扫描前缀',
};

function publicText(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 2048) : fallback;
}

function safeEndpoint(value: unknown) {
  const endpoint = publicText(value, 'NAS_S3_ENDPOINT（服务端环境变量）');
  try {
    const parsed = new URL(endpoint);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.href.replace(/\/$/, '');
  } catch {
    // A malformed value containing user-info may itself carry a credential.
    return /@|:\/\/[^/\s]*:[^/\s]*@/.test(endpoint) ? 'NAS_S3_ENDPOINT（服务端环境变量）' : endpoint;
  }
}

function safeCapabilities(value: unknown) {
  const keys = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : value && typeof value === 'object'
      ? Object.entries(value).filter(([, enabled]) => enabled === true).map(([key]) => key)
      : [];
  return [...new Set(keys.map((key) => CAPABILITY_LABELS[key]).filter(Boolean))];
}

/**
 * Converts the server's public S3 summary into a strict display-only model.
 * The allow-list is intentional: access keys, secret keys and arbitrary error
 * payloads are never forwarded to React even if a server response contains them.
 */
export function toNasS3Display(value: unknown): NasS3Display {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const forcePathStyle = typeof input.forcePathStyle === 'boolean' ? input.forcePathStyle : undefined;
  const credentialConfigured = typeof input.credentialConfigured === 'boolean'
    ? input.credentialConfigured
    : typeof input.credentialsConfigured === 'boolean' ? input.credentialsConfigured : undefined;
  const rawHealth = input.health;
  let health: NasS3Display['health'] = 'unknown';
  let checkedAt: string | undefined;
  if (typeof rawHealth === 'string') {
    const normalized = rawHealth.toLowerCase();
    if (['ok', 'ready', 'healthy', 'success'].includes(normalized)) health = 'healthy';
    else if (['error', 'failed', 'unhealthy', 'unavailable'].includes(normalized)) health = 'error';
  } else if (rawHealth && typeof rawHealth === 'object' && !Array.isArray(rawHealth)) {
    const record = rawHealth as Record<string, unknown>;
    if (record.ok === true) health = 'healthy';
    else if (record.ok === false) health = 'error';
    else if (typeof record.status === 'string') {
      const normalized = record.status.toLowerCase();
      if (['ok', 'ready', 'healthy', 'success'].includes(normalized)) health = 'healthy';
      else if (['error', 'failed', 'unhealthy', 'unavailable'].includes(normalized)) health = 'error';
    }
    if (typeof record.checkedAt === 'string' && Number.isFinite(Date.parse(record.checkedAt))) checkedAt = record.checkedAt;
  }
  return {
    endpoint: safeEndpoint(input.endpoint),
    bucket: publicText(input.bucket, 'NAS_S3_BUCKET（服务端环境变量）'),
    region: publicText(input.region, 'NAS_S3_REGION（服务端环境变量）'),
    prefix: publicText(input.prefix, '未设置全局前缀'),
    pathStyle: forcePathStyle === undefined ? 'unknown' : forcePathStyle ? 'path' : 'virtual-hosted',
    credentialConfigured,
    health,
    checkedAt,
    capabilities: safeCapabilities(input.capabilities),
  };
}

export function nasTransportLabel(value: NasTransport | string) {
  return NAS_TRANSPORT_OPTIONS.find((item) => item.value === value)?.label || value;
}

export function nasSourcePathError(transport: NasTransport, sourcePath: string) {
  if (transport === 's3' && !sourcePath.trim()) return 'MinIO / S3 映射必须填写 Bucket 内相对前缀，不能直接映射整个全局根前缀。';
  return null;
}
