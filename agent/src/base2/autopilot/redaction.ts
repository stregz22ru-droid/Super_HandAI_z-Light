// base2/autopilot/redaction.ts — B3 (П-3): redaction-фильтр PER-AGENT.
// У разных агентов разные секреты и лимиты — карта config.redaction.agents[agentId]
// поверх глобальных токенов. Вырезаются: токены (agent.token + конфиг),
// абсолютные пути (Windows/POSIX), внутренние URL/адреса (127.0.0.1/localhost).
export interface RedactionProfile {
  tokens: string[];
  quotaChars: number;
}

export interface RedactionConfigLike {
  tokens?: string[];
  agents?: Record<string, { tokens?: string[]; quotaChars?: number }>;
}

export interface RedactResult {
  text: string;
  hits: { tokens: number; paths: number; urls: number };
  truncated: boolean;
}

const ABS_PATH_RE = /(?:[A-Za-z]:[\\/][^\s'"`<>|]{2,})|(?:\/(?:home|Users|root|mnt|media|opt|var|etc|tmp|srv)\/[^\s'"`<>]{2,})/g;
const INTERNAL_URL_RE = /\b(?:wss?|https?):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/[^\s'"<>]*)?/g;
const INTERNAL_HOST_RE = /(?:127\.0\.0\.1|localhost):\d{2,5}/g;

/** Собрать профиль агента: глобальные токены + per-agent, квота (дефолт 12000). */
export function profileFor(cfg: RedactionConfigLike | undefined, agentId: string, agentToken: string, defaultQuota: number): RedactionProfile {
  const per = cfg?.agents?.[agentId];
  const tokens = [...new Set([agentToken, ...(cfg?.tokens ?? []), ...(per?.tokens ?? [])].filter((t) => typeof t === 'string' && t.trim().length >= 8))];
  return { tokens, quotaChars: per?.quotaChars ?? defaultQuota };
}

/** Применить фильтр. Квота — ОБРЕЗАНИЕ с пометкой (журналирование — в outflow). */
export function redact(text: string, profile: RedactionProfile): RedactResult {
  let out = String(text ?? '');
  const hits = { tokens: 0, paths: 0, urls: 0 };

  for (const token of profile.tokens) {
    if (!token) continue;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'g');
    out = out.replace(re, () => {
      hits.tokens++;
      return '<TOKEN>';
    });
  }

  out = out.replace(INTERNAL_URL_RE, () => {
    hits.urls++;
    return '<ВНУТРЕННИЙ-URL>';
  });
  out = out.replace(INTERNAL_HOST_RE, () => {
    hits.urls++;
    return '<ВНУТРЕННИЙ-АДРЕС>';
  });
  out = out.replace(ABS_PATH_RE, () => {
    hits.paths++;
    return '<ПУТЬ>';
  });

  let truncated = false;
  if (profile.quotaChars > 0 && out.length > profile.quotaChars) {
    out = out.slice(0, profile.quotaChars) +
      `\n\n[ОБРЕЗАНО: отчёт превышает квоту ${profile.quotaChars} символов — полный текст в data/reports; журнальная запись об обрезке добавлена]`;
    truncated = true;
  }
  return { text: out, hits, truncated };
}
