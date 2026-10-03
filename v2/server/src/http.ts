// Errors a route can throw to answer with a status and a message the UI can show as is.
export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const unauthorized = (msg = "Sign in first.") => new HttpError(401, msg);
export const forbidden = (msg = "You can't do that.") => new HttpError(403, msg);
export const notFound = (msg = "Not found.") => new HttpError(404, msg);
export const conflict = (msg: string) => new HttpError(409, msg);
