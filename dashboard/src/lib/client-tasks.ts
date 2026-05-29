/**
 * dashboard/src/lib/client-tasks.ts
 *
 * Mutation helpers for client tasks on the client detail page.
 *
 * Keeps fetch/error plumbing out of the React component so the behaviour is
 * unit-testable in a node environment (matching the repo's test convention)
 * and the UI layer only deals with a clean discriminated result.
 */

export type DeleteClientTaskResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Delete a single client task via the API.
 *
 * Never throws — network and server errors are normalised into
 * `{ ok: false, error }` so the caller can show a toast and leave the row in
 * place. On `{ ok: true }` the caller can safely remove the row from local
 * state.
 */
export async function deleteClientTask(
  clientId: string,
  taskId: string,
): Promise<DeleteClientTaskResult> {
  const url = `/api/clients/${encodeURIComponent(clientId)}/tasks/${encodeURIComponent(taskId)}`;

  try {
    const res = await fetch(url, { method: 'DELETE' });

    // 404 means the task is already gone (deleted in another tab/session, or a
    // double-submit landed first). Either way the desired end state — row
    // removed — is achieved, so treat it as success and make delete idempotent.
    if (!res.ok && res.status !== 404) {
      let message = `Failed to delete task (${res.status})`;
      try {
        const body = await res.json();
        if (body && typeof body.error === 'string' && body.error.trim()) {
          message = body.error;
        }
      } catch {
        // Non-JSON error body — keep the generic message.
      }
      return { ok: false, error: message };
    }

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete task';
    return { ok: false, error: message };
  }
}
