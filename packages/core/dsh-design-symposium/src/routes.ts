/**
 * Host routes for the live panel.
 *
 * Two read-only endpoints on the shared Connection `/api` channel:
 *
 *   GET /api/plugins/dsh-design-symposium/panel — the chat page itself
 *   GET /api/plugins/dsh-design-symposium/live  — the run as JSON, polled by it
 *
 * Both are inert: neither starts, stops nor mutates a discussion, so a page
 * left open overnight cannot change the record. `connection` is taken as a
 * scoped dependency rather than declared in `inject`, so a profile without the
 * carrier still loads the plugin and only loses the page.
 *
 * @module dsh-design-symposium/routes
 */

import { renderPanelHtml } from './panel.js';
import type { SymposiumEndpoints } from './service.js';

/** Route namespace on the shared Connection `/api` channel. */
export const ROUTE_PREFIX = '/api/plugins/dsh-design-symposium';

/**
 * The one shape this module needs from the Connection carrier. Declared
 * structurally so the plugin keeps zero runtime dependencies on client packages.
 */
export interface RouteCarrier {
  register(options: {
    path: string;
    methods: ('GET' | 'POST' | 'PUT' | 'DELETE')[];
    requestBody: 'buffered';
    fetch: (request: Request) => Promise<Response>;
  }): () => Promise<void>;
}

/** One JSON answer. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Register the panel routes.
 * @param carrier - the Connection carrier's route registration face.
 * @param service - the live endpoints, read for the seat list and run state.
 * @returns the disposer that unregisters both routes.
 */
export function registerSymposiumRoutes(
  carrier: RouteCarrier,
  service: SymposiumEndpoints,
): () => Promise<void> {
  const liveFetch = async (): Promise<Response> => {
    try {
      return json(200, service.liveState());
    } catch (error: unknown) {
      return json(500, { error: (error as Error).message });
    }
  };

  const panelFetch = async (): Promise<Response> => {
    try {
      const seats = service.rosterSnapshot().map((seat) => ({ id: seat.id, name: seat.name }));
      return new Response(renderPanelHtml(seats, service.liveState()), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    } catch (error: unknown) {
      return new Response(`页面渲染失败：${(error as Error).message}`, {
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  };

  const disposers = [
    carrier.register({ path: `${ROUTE_PREFIX}/live`, methods: ['GET'], requestBody: 'buffered', fetch: liveFetch }),
    carrier.register({ path: `${ROUTE_PREFIX}/panel`, methods: ['GET'], requestBody: 'buffered', fetch: panelFetch }),
  ];
  return async () => {
    for (const dispose of disposers) await dispose();
  };
}
