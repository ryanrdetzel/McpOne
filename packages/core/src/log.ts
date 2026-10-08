export interface LogFields {
  msg: string;
  req_id?: string;
  route?: string;
  method?: string;
  status?: number;
  dur_ms?: number;
  err?: Error;
}

export interface Logger {
  info(fields: LogFields): void;
  error(fields: LogFields): void;
}

/** JSON preserves the log contract without Node streams, bindings, or env globals. */
export function createLogger(release: string): Logger {
  function emit(level: "info" | "error", fields: LogFields): void {
    const { err, ...context } = fields;
    const record = {
      level,
      time: new Date().toISOString(),
      release,
      ...context,
      ...(err
        ? { err: { type: err.name, message: err.message, stack: err.stack } }
        : {}),
    };
    // Only explicit operational fields are accepted: never bodies, cookies, or bindings.
    const line = JSON.stringify(record);
    if (level === "error") console.error(line);
    else console.log(line);
  }

  return {
    info: (fields) => emit("info", fields),
    error: (fields) => emit("error", fields),
  };
}
