/**
 * Stub for `next/cache`, used only by the integration suite.
 *
 * `revalidatePath` needs a request context and throws `Invariant: static
 * generation store missing` without one. Its real caller is a route handler,
 * which has one; a test has not, and the alternative to this stub is a job
 * whose counting half — the part with the cursor, the window and the SQL — is
 * never exercised at all because the last line of it cannot run.
 *
 * What the stub records is exactly what the production call would do and no
 * more: that it was asked, for which path, and of which type. Nothing here
 * pretends a page was rebuilt.
 */

export interface RevalidateCall {
  readonly path: string;
  readonly type: string | undefined;
}

export const revalidateCalls: RevalidateCall[] = [];

export function revalidatePath(path: string, type?: string): void {
  revalidateCalls.push({ path, type });
}

export function revalidateTag(): void {
  // Unused by any job today; present so an import of it does not fail.
}
