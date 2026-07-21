import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Structured logging and request correlation.
 *
 * Console strings are unusable at volume: when a customer reports that "some
 * reports went missing yesterday", the only workable question is "show me every
 * log line for project X between 14:00 and 15:00 with status >= 400", and that
 * requires machine-readable fields rather than prose.
 *
 * JSON lines, because every log aggregator ingests them without a parser, and
 * because this core is designed to be mounted inside someone else's product
 * whose logging stack we do not control.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: string | number | boolean | null | undefined;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that stamps every line with the given fields. */
  child(fields: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  /** Lines below this are dropped. */
  level?: LogLevel;
  /** Injected for tests; defaults to stdout/stderr. */
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const minimum = LEVEL_ORDER[options.level ?? (process.env.LOG_LEVEL as LogLevel) ?? 'info'];
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  function emit(level: LogLevel, bound: LogFields, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < minimum) return;

    const entry = {
      time: new Date().toISOString(),
      level,
      msg: message,
      ...bound,
      ...fields,
    };

    // Never let logging throw into a request path. A circular value in a
    // caller-supplied field must not take down the handler that logged it.
    try {
      sink(JSON.stringify(entry));
    } catch {
      sink(JSON.stringify({ time: entry.time, level, msg: message, logSerializationFailed: true }));
    }
  }

  function build(bound: LogFields): Logger {
    return {
      debug: (message, fields) => emit('debug', bound, message, fields),
      info: (message, fields) => emit('info', bound, message, fields),
      warn: (message, fields) => emit('warn', bound, message, fields),
      error: (message, fields) => emit('error', bound, message, fields),
      child: (fields) => build({ ...bound, ...fields }),
    };
  }

  return build({});
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Correlates every log line emitted while handling this request. */
    requestId: string;
    log: Logger;
  }
}

/**
 * Assigns a request id, logs one line per completed request, and exposes a
 * bound logger on the request.
 *
 * An inbound `x-request-id` is honoured so a trace started by the host product
 * — or by a load balancer — stays joined up rather than restarting here.
 */
export function requestLogging(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const inbound = req.header('x-request-id');
    // Length-capped: an unbounded caller-supplied id would flow into every log
    // line and every downstream index.
    const requestId = inbound && inbound.length <= 200 ? inbound : randomUUID();

    req.requestId = requestId;
    req.log = logger.child({ requestId });
    res.setHeader('x-request-id', requestId);

    const startedAt = process.hrtime.bigint();

    // 'finish' rather than 'close': close also fires when the client hangs up,
    // and logging those as completed requests would misreport the error rate.
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      const fields: LogFields = {
        method: req.method,
        // The matched route pattern, not the raw URL: `/v1/reports/:id` groups
        // in a dashboard where `/v1/reports/<uuid>` produces one bucket per id.
        route: req.route?.path ?? req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        projectId: req.header('x-project-id') ?? null,
      };

      if (res.statusCode >= 500) req.log.error('request failed', fields);
      else if (res.statusCode >= 400) req.log.warn('request rejected', fields);
      else req.log.info('request', fields);
    });

    next();
  };
}

/**
 * Counters for the operations worth alerting on.
 *
 * Deliberately not a Prometheus client: the host product already has one, and
 * an SDK core that drags in a metrics library forces its choice on every
 * integrator. This exposes plain numbers they can publish however they like.
 */
export class Metrics {
  private readonly counters = new Map<string, number>();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  reset(): void {
    this.counters.clear();
  }
}
