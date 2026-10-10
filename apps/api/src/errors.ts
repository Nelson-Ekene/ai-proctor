import type { z } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const unauthorised = () => new HttpError(401, 'unauthorised');
export const forbidden = () => new HttpError(403, 'forbidden');
export const notFound = (what = 'not found') => new HttpError(404, what);
export const conflict = (message: string) => new HttpError(409, message);

/** Validates input with a zod schema; failures become a 400 with the first issue. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw badRequest(`${where}${issue?.message ?? 'invalid input'}`);
  }
  return result.data;
}
