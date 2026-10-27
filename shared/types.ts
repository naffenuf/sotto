/** Types shared between the server and the browser UI. */

/** Response body of `GET /api/health`. */
export interface HealthResponse {
  ok: true;
}

/** Error body every route answers a 4xx or 5xx with. */
export interface ApiError {
  error: string;
}
