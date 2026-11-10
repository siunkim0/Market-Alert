import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    // 키·쿠키·토큰이 실수로 로그에 들어가지 않도록 가린다.
    redact: {
      paths: [
        'token', '*.token', 'credentials', '*.credentials', 'session', 'signature',
        'apiKey', '*.apiKey', 'secret', '*.secret', 'env', '*.env', 'headers.cookie',
      ],
      censor: '[redacted]',
    },
  });
}
