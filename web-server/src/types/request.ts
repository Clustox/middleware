import { Features } from '@/constants/feature';

import type { AuthSession } from '@/auth/types';
import type { NextApiRequest, NextApiResponse } from 'next/types';

export type HttpMethods =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS'
  | 'HEAD';

export type ApiRequest<T = {}> = Omit<
  NextApiRequest,
  'body' | 'query' | 'method'
> & {
  /** @deprecated Use `req.payload` instead */
  body: T;
  /** @deprecated Use `req.payload` instead */
  query: T;
  payload: T;
  meta?: {
    features: Partial<Features>;
  };
  // CLUSTOX: stamped by Endpoint.serve() on every authenticated route. Typed
  // here (rather than left as the `(req as any).session` every call site
  // previously had to repeat) because jira-connections/index.ts is the
  // first route to actually read it, for the connection's generated_by.
  session?: AuthSession;
  method: HttpMethods;
};

export type ApiResponse = NextApiResponse;
