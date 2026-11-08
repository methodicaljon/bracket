export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function takenError() {
  const err = new Error('USERNAME_TAKEN');
  err.code = 'USERNAME_TAKEN';
  return err;
}

export function isTaken(err) {
  return !!err && (err.code === 'USERNAME_TAKEN' || err.message === 'USERNAME_TAKEN');
}
