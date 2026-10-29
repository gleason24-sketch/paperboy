// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "@/lib/db";

/** Records the email as sent; false if it already was (so two overlapping runs never send twice). */
export async function once(ownerId: string, kind: string): Promise<boolean> {
  return (await sql()`insert into email_log (owner_id, kind) values (${ownerId}, ${kind}) on conflict do nothing returning kind`).length > 0;
}
